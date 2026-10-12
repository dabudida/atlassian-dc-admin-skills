/**
 * Scoped, completeness-aware Jira configuration evidence; all remote access is read-only.
 *
 * Components are selected explicitly: JSM request-type forms, queues and SLAs for one service
 * desk, and scheme, field configuration and screen areas for one project. Every component and
 * area carries its own coverage status; component content is normalized (stable ordering, no
 * timestamps) so two captures of an unchanged instance have identical components.
 */
import { z } from "zod";
import { seg, type AtlassianClient } from "../../client.js";
import { HttpStatusError, UnsupportedError, ValidationError } from "../../errors.js";
import { EXIT } from "../../format.js";
import { jiraVersion, requireJsmVersion } from "../../jiraVersion.js";
import type { ToolContext, ToolDef } from "../types.js";
import { listArg } from "../util.js";
import { jiraFieldConfigurationTools } from "./fieldConfigurations.js";
import { resolveProjectConfig } from "./projects.js";
import { listQueues } from "./queues.js";
import { allScreens, parseWhereIsMyField, probeField, readScreen, whereIsMyField } from "./screens.js";
import { jiraSlaTools } from "./sla.js";
import { readRawRequestTypeFields, resolveServiceDesk, type ServiceDesk } from "./requestTypes.js";
import { SD, sdGet } from "./servicedesk.js";
import { localTarget, sha256, writeLocal } from "./scriptRoot.js";

type Status = "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
interface Source { status: Status; reason?: string }
interface Identity { id: string; name: string; issueTypeId: string | null; portalVisibility: "VISIBLE" | "HIDDEN" | "UNKNOWN" }
interface Diagnostic { requestTypeId?: string; fieldId?: string; reason: string }
const flag = (value: unknown): boolean | null => typeof value === "boolean" ? value : null;
const numericId = (value: unknown): string | null => typeof value === "string" || typeof value === "number" ? (/^\d+$/.test(String(value)) ? String(value) : null) : null;

/** Do not allow upstream error bodies to leak form defaults or scripts. */
async function safeRead<T>(label: string, read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch (e) {
    if (e instanceof HttpStatusError) throw new HttpStatusError(e.status, "", label);
    if (e instanceof UnsupportedError) throw e;
    if (e instanceof ValidationError) throw e;
    throw new ValidationError(`${label}: read failed (${e instanceof Error ? e.name : "unknown error"})`);
  }
}
async function optionalRead(label: string, read: () => Promise<unknown>): Promise<{ source: Source; data?: unknown }> {
  try { return { source: { status: "COMPLETE" }, data: await safeRead(label, read) }; }
  catch (e) {
    if (e instanceof UnsupportedError || (e instanceof HttpStatusError && [404, 405, 501].includes(e.status))) {
      return { source: { status: "UNAVAILABLE", reason: e instanceof HttpStatusError ? `HTTP ${e.status}` : "Unsupported" } };
    }
    throw e;
  }
}
function identity(raw: any, hidden: boolean): Identity {
  const id = numericId(raw?.id);
  if (!id || typeof raw?.name !== "string" || !raw.name.trim()) throw new ValidationError("Malformed request-type identity in inventory");
  return { id, name: raw.name, issueTypeId: numericId(raw.issueTypeId ?? raw.issueType?.id), portalVisibility: hidden ? "HIDDEN" : "VISIBLE" };
}
async function inventory(client: AtlassianClient, sd: ServiceDesk, cap: number, warn: (d: Diagnostic) => void) {
  const types = new Map<string, Identity>();
  for (let start = 0; ; ) {
    const page: any = await safeRead("public request-type inventory", () => sdGet(client, `/servicedesk/${sd.id}/requesttype`, { start, limit: 50 }));
    if (!Array.isArray(page?.values) || typeof page.isLastPage !== "boolean") throw new ValidationError("Malformed public request-type inventory");
    for (const raw of page.values) {
      const row = identity(raw, false);
      if (types.has(row.id)) throw new ValidationError(`Non-progressing request-type inventory at id ${row.id}`);
      types.set(row.id, row);
      if (types.size > cap) throw new ValidationError(`Request-type budget exceeded (${cap}); raise max_request_types (up to 1000)`);
    }
    if (page.isLastPage) break;
    if (!page.values.length) throw new ValidationError("Non-progressing empty request-type inventory page");
    start += page.values.length;
  }
  const hidden = await optionalRead("hidden request-type inventory", () => client.get(`/rest/servicedesk/1/servicedesk/${sd.projectId}/request-type-groups/hidden/request-types`));
  if (hidden.source.status === "COMPLETE") {
    if (!Array.isArray(hidden.data)) throw new ValidationError("Malformed hidden request-type inventory");
    const seen = new Set<string>();
    for (const raw of hidden.data) {
      const row = identity(raw, true);
      if (seen.has(row.id)) throw new ValidationError(`Duplicate hidden request-type identity ${row.id}`);
      seen.add(row.id);
      const previous = types.get(row.id);
      if (previous) {
        previous.portalVisibility = "HIDDEN";
        if (previous.name !== row.name || (previous.issueTypeId && row.issueTypeId && previous.issueTypeId !== row.issueTypeId)) {
          warn({ requestTypeId: row.id, reason: "Conflicting inventory identity" });
          hidden.source.status = "PARTIAL";
        }
        previous.issueTypeId ??= row.issueTypeId;
      } else types.set(row.id, row);
      if (types.size > cap) throw new ValidationError(`Request-type budget exceeded (${cap}); raise max_request_types (up to 1000)`);
    }
  } else {
    for (const row of types.values()) row.portalVisibility = "UNKNOWN";
  }
  return { types: [...types.values()], sources: { public: { status: "COMPLETE" as Status }, hidden: hidden.source } };
}
function select(types: Identity[], given?: string[]): Identity[] {
  if (!given) return types;
  const selected = new Map<string, Identity>();
  for (const value of given) {
    const byId = types.find(t => t.id === value);
    const hits = byId ? [byId] : types.filter(t => t.name === value);
    if (hits.length !== 1) throw new ValidationError(hits.length ? "Request-type selection is ambiguous; pass a stable id" : "Requested request type not found in inventory");
    selected.set(hits[0].id, hits[0]);
  }
  return [...selected.values()];
}
async function form(client: AtlassianClient, rt: Identity, presets: boolean, warn: (d: Diagnostic) => void) {
  const sources: Record<string, Source> = {};
  const fields: Record<string, any[]> = {};
  for (const kind of ["visible", "hidden"] as const) {
    const result = await optionalRead(`request type ${rt.id} ${kind} fields`, () => readRawRequestTypeFields(client, rt.id, kind));
    const data = result.data;
    if (result.source.status === "COMPLETE" && (!Array.isArray(data) || data.some(r => typeof r?.fieldId !== "string" || !r.fieldId || !numericId(r.id)))) {
      result.source = { status: "UNAVAILABLE", reason: "Malformed form source" };
    }
    sources[kind] = result.source;
    fields[kind] = [];
    if (result.source.status !== "COMPLETE") {
      warn({ requestTypeId: rt.id, reason: `${kind}: ${result.source.reason}` });
      continue;
    }
    fields[kind] = (data as any[]).map((r, i) => {
      const sdRequired = flag(r.sdRequired), jiraRequired = flag(r.jiraRequired);
      if (sdRequired === null || jiraRequired === null) {
        result.source.status = "PARTIAL";
        warn({ requestTypeId: rt.id, fieldId: r.fieldId, reason: "Unknown mandatory flag" });
      }
      return {
        rowId: String(r.id), fieldId: r.fieldId, name: String(r.jiraName ?? r.label ?? r.fieldId), label: String(r.label ?? ""),
        description: String(r.description ?? ""), visibility: kind === "visible" ? "VISIBLE" : "HIDDEN", position: i + 1,
        sdRequired, jiraRequired, required: sdRequired === true || jiraRequired === true ? true : sdRequired === false && jiraRequired === false ? false : null,
        ...(kind === "hidden" ? presets ? { presetOmitted: false, values: r.values ?? {} } : { presetOmitted: true } : {}),
      };
    });
  }
  const statuses = Object.values(sources).map(s => s.status);
  const status: Status = statuses.every(s => s === "COMPLETE") ? "COMPLETE" : statuses.every(s => s === "UNAVAILABLE") ? "UNAVAILABLE" : "PARTIAL";
  return { status, sources, ...fields };
}

// -- additional components ------------------------------------------------------------------

const API = "/rest/api/2";
/** Marker that identifies a snapshot file (schema v2 and later). */
export const SNAPSHOT_KIND = "jira-config-snapshot";
export const SCHEMA_VERSION = 2;
export const COMPONENTS = ["jsm-queues", "jsm-sla", "project-fields", "project-schemes", "project-screens", "request-type-forms"] as const;
type Component = (typeof COMPONENTS)[number];
const SD_COMPONENTS: ReadonlySet<Component> = new Set(["request-type-forms", "jsm-queues", "jsm-sla"]);
/** Component name → key under `components` in the snapshot file. */
export const COMPONENT_KEYS: Record<Component, string> = {
  "request-type-forms": "requestTypeForms", "jsm-queues": "jsmQueues", "jsm-sla": "jsmSla",
  "project-schemes": "projectSchemes", "project-fields": "projectFields", "project-screens": "projectScreens",
};
const MAX_QUEUES = 500;
const MAX_ISSUE_TYPES = 200;
const MAX_SCREENS = 200;
const MAX_FIELD_PAGES = 40;
const FIELD_PAGE = 500;
const MIB = 1024 * 1024;

/** A response that does not have the expected shape: the area is unavailable, never an empty success. */
class Malformed extends Error {}
type Area = Record<string, unknown> & { status: Status; reason?: string };
const unavailable = (reason: string): Area => ({ status: "UNAVAILABLE", reason });
const str = (v: unknown): string | null => (v === undefined || v === null || v === "" ? null : String(v));
/** Numeric-aware, locale-independent order so repeated captures serialize identically. */
function cmp(a: string, b: string): number {
  if (/^-?\d+$/.test(a) && /^-?\d+$/.test(b)) return Number(a) - Number(b);
  return a < b ? -1 : a > b ? 1 : 0;
}
const sortBy = <T>(list: T[], key: (t: T) => string): T[] => [...list].sort((a, b) => cmp(key(a), key(b)));
function aggregate(statuses: Status[]): Status {
  if (statuses.every(s => s === "COMPLETE")) return "COMPLETE";
  return statuses.every(s => s === "UNAVAILABLE") ? "UNAVAILABLE" : "PARTIAL";
}
const unreadable = (e: unknown, codes: number[]) => e instanceof UnsupportedError || (e instanceof HttpStatusError && codes.includes(e.status));

/** Read one area: unsupported/missing routes and malformed shapes are unavailable; 401/403 fail without the raw body. */
async function area(label: string, read: () => Promise<Record<string, unknown>>, unavailableCodes = [404, 405, 501]): Promise<Area> {
  try {
    return { status: "COMPLETE", ...(await read()) } as Area;
  } catch (e) {
    if (e instanceof Malformed) return unavailable(`Malformed ${label} response`);
    if (unreadable(e, unavailableCodes)) return unavailable(e instanceof HttpStatusError ? `HTTP ${e.status}` : "Unsupported");
    if (e instanceof HttpStatusError) throw new HttpStatusError(e.status, "", label);
    if (e instanceof ValidationError || e instanceof UnsupportedError) throw e;
    throw new ValidationError(`${label}: read failed (${e instanceof Error ? e.name : "unknown error"})`);
  }
}
const source = (a: Area): Source => (a.reason ? { status: a.status, reason: a.reason } : { status: a.status });

/** Run an existing read tool's handler so the snapshot reuses its routes and normalization. */
function callTool(ctx: ToolContext, tools: ToolDef[], name: string, args: Record<string, unknown>): Promise<any> {
  const tool = tools.find(t => t.name === name);
  if (!tool) throw new ValidationError(`Internal reader ${name} is not available`);
  return tool.handler(ctx, args);
}

/** Holder label as jira_get_permission_scheme prints it: "group:jira-users", "projectRole:Developers", "reporter". */
function holderLabel(h: any): string {
  if (!h) return "";
  const param = (h.type === "projectRole" && h.projectRole?.name) || (h.type === "user" && h.user?.name)
    || ((h.type === "userCustomField" || h.type === "groupCustomField") && h.field?.name) || h.parameter;
  return param ? `${h.type}:${param}` : String(h.type);
}
/** A scheme reference from resolveProjectConfig that could not be read. */
function refError(ref: any): Area | undefined {
  if (!ref?.error) return undefined;
  return unavailable(/^HTTP \d+$/.test(String(ref.error)) ? `scheme reference unreadable (${ref.error})` : "scheme reference unreadable");
}

async function projectSchemes(client: AtlassianClient, key: string) {
  const cfg: any = await safeRead("project configuration", () => resolveProjectConfig(client, key));
  if (!cfg || typeof cfg.key !== "string" || !cfg.schemes) throw new ValidationError("Malformed project configuration");
  const issueTypes = sortBy((cfg.issueTypes ?? []).map((t: any) => ({ id: String(t.id), name: String(t.name), subtask: !!t.subtask })), (t: any) => t.id);
  const typeName = new Map(issueTypes.map((t: any) => [t.id, t.name]));
  const s = cfg.schemes;
  const project: Area = { status: "COMPLETE", id: str(cfg.id), key: cfg.key, name: str(cfg.name), type: str(cfg.type), lead: str(cfg.lead), category: str(cfg.category), issueTypes };

  const permRef = s.permissionScheme;
  const permissionScheme = refError(permRef) ?? (permRef?.id == null ? { status: "COMPLETE" as Status, id: null, name: str(permRef?.name), grants: [] } : await area("permission scheme", async () => {
    const d: any = await client.get(`${API}/permissionscheme/${seg(String(permRef.id))}`, { expand: "permissions,user,projectRole,field" });
    if (!Array.isArray(d?.permissions)) throw new Malformed();
    const grants = new Map<string, { key: string; permission: string; holder: string }>();
    for (const g of d.permissions) {
      const holder = holderLabel(g?.holder);
      const k = `${g?.permission}|${holder}`;
      grants.set(k, { key: k, permission: String(g?.permission), holder });
    }
    return { id: str(d.id), name: str(d.name), description: String(d.description ?? ""), grants: sortBy([...grants.values()], g => g.key) };
  }));

  const notifRef = s.notificationScheme;
  const notificationScheme = refError(notifRef) ?? (notifRef?.id == null ? { status: "COMPLETE" as Status, id: null, name: str(notifRef?.name), events: [] } : await area("notification scheme", async () => {
    const d: any = await client.get(`${API}/notificationscheme/${seg(String(notifRef.id))}`, { expand: "notificationSchemeEvents" });
    if (!Array.isArray(d?.notificationSchemeEvents)) throw new Malformed();
    const events = d.notificationSchemeEvents.map((e: any) => ({
      id: String(e?.event?.id), name: str(e?.event?.name),
      notifications: [...new Set<string>((e?.notifications ?? []).map((n: any) => (n?.parameter ? `${n.notificationType}:${n.parameter}` : String(n?.notificationType))))].sort(cmp),
    }));
    return { id: str(d.id), name: str(d.name), description: String(d.description ?? ""), events: sortBy(events, (e: any) => e.id) };
  }));

  const secRef = s.issueSecurityScheme;
  const issueSecurityScheme = refError(secRef) ?? (secRef?.id == null ? { status: "COMPLETE" as Status, id: null, name: null, defaultSecurityLevelId: null, levels: [] } : await area("issue security scheme", async () => {
    const d: any = await client.get(`${API}/issuesecurityschemes/${seg(String(secRef.id))}`);
    if (!d || !Array.isArray(d.levels ?? [])) throw new Malformed();
    const levels = (d.levels ?? []).map((l: any) => ({ id: String(l.id), name: str(l.name), description: String(l.description ?? "") }));
    return { id: str(d.id), name: str(d.name), defaultSecurityLevelId: str(d.defaultSecurityLevelId), levels: sortBy(levels, (l: any) => l.id) };
  }));

  const wfRef = s.workflowScheme;
  const workflowScheme = refError(wfRef) ?? {
    status: "COMPLETE" as Status, id: str(wfRef?.id), name: str(wfRef?.name), defaultWorkflow: str(wfRef?.defaultWorkflow),
    mappings: sortBy(Object.entries(wfRef?.issueTypeMappings ?? {}).map(([id, workflow]) => ({ key: id, issueTypeId: id, issueTypeName: typeName.get(id) ?? null, workflow: String(workflow) })), m => m.key),
  };

  const itRef = s.issueTypeScheme;
  const issueTypeScheme = refError(itRef) ?? (itRef?.id == null
    ? { status: "COMPLETE" as Status, id: null, name: str(itRef?.name), defaultIssueTypeId: null, issueTypes: issueTypes.map((t: any) => ({ id: t.id, name: t.name })) }
    : await area("issue type scheme", async () => {
      const d: any = await client.get(`${API}/issuetypescheme/${seg(String(itRef.id))}`, { expand: "issueTypes,defaultIssueType" });
      if (!Array.isArray(d?.issueTypes)) throw new Malformed();
      return { id: str(d.id ?? itRef.id), name: str(d.name), description: String(d.description ?? ""), defaultIssueTypeId: str(d.defaultIssueType?.id),
        issueTypes: d.issueTypes.map((t: any, i: number) => ({ id: String(t.id), name: str(t.name), position: i + 1 })) };
    }));

  const priorityScheme = await area("priority scheme", async () => {
    const d: any = await client.get(`${API}/project/${seg(key)}/priorityscheme`);
    if (!d || !Array.isArray(d.optionIds)) throw new Malformed();
    const all: any = await client.get(`${API}/priority`);
    if (!Array.isArray(all)) throw new Malformed();
    const names = new Map(all.map((p: any) => [String(p.id), str(p.name)]));
    return { id: str(d.id), name: str(d.name), description: String(d.description ?? ""), defaultScheme: d.defaultScheme === true, defaultPriorityId: str(d.defaultOptionId),
      priorities: d.optionIds.map((id: unknown, i: number) => ({ id: String(id), name: names.get(String(id)) ?? null, position: i + 1 })) };
  });

  const areas = { project, permissionScheme, notificationScheme, issueSecurityScheme, workflowScheme, issueTypeScheme, priorityScheme };
  return { status: aggregate(Object.values(areas).map(a => a.status)), ...areas };
}

async function projectFields(ctx: ToolContext, key: string) {
  const read = (args: Record<string, unknown>) => callTool(ctx, jiraFieldConfigurationTools, "jira_get_field_configuration", { project_key: key, full_lists: true, ...args });
  const scheme = unavailable("Field configuration schemes have no REST resource on Jira 11.3");
  const found = await area("field configurations", async () => {
    const overview: any = await read({ limit: 1 });
    if (!Array.isArray(overview?.configurations)) throw new Malformed();
    const configurations: Area[] = [];
    for (const c of overview.configurations) {
      const issueTypes = [...(c?.issueTypes ?? [])].map(String).sort(cmp);
      if (c?.id === null || c?.id === undefined) {
        configurations.push({ key: `unresolved:${issueTypes.join(",")}`, id: null, name: str(c?.name), status: "UNAVAILABLE", reason: "Field configuration id could not be resolved", issueTypes });
        continue;
      }
      const fields: any[] = [];
      let complete = false;
      for (let offset = 0, pages = 0; pages < MAX_FIELD_PAGES; pages++) {
        const page: any = await read({ field_configuration_id: Number(c.id), offset, limit: FIELD_PAGE });
        const f = page?.configurations?.[0]?.fields;
        if (!Array.isArray(f?.items)) throw new Malformed();
        fields.push(...f.items);
        if (f.nextOffset === null || f.nextOffset === undefined || !f.items.length) { complete = true; break; }
        offset = f.nextOffset;
      }
      configurations.push({
        key: String(c.id), id: String(c.id), name: str(c.name), default: c.default === true,
        status: complete ? "COMPLETE" : "PARTIAL", ...(complete ? {} : { reason: `Field page cap (${MAX_FIELD_PAGES * FIELD_PAGE}) reached` }),
        issueTypes, sharedWith: [...(c.sharedWith ?? [])].map(String).sort(cmp),
        fields: sortBy(fields.map((x: any) => ({ id: String(x.id), name: str(x.name), description: String(x.description ?? ""), hidden: x.hidden === true, required: x.required === true })), x => x.id),
      });
    }
    return { status: configurations.length ? aggregate(configurations.map(c => c.status)) : "COMPLETE", configurations: sortBy(configurations, c => String(c.key)) };
  });
  const sources = { fieldConfigurationScheme: scheme, configurations: source(found) };
  return { status: aggregate(Object.values(sources).map(s => s.status)), sources, configurations: (found.configurations as Area[] | undefined) ?? [] };
}

async function projectScreens(client: AtlassianClient, key: string) {
  const screenSchemes = unavailable("Screen schemes and issue type screen schemes have no REST resource on Jira 11.3; their ids are recorded per usage row where readable");
  const project: any = await safeRead("project", () => client.get(`${API}/project/${seg(key)}`));
  if (!Array.isArray(project?.issueTypes)) throw new ValidationError("Malformed project issue types");
  const allTypes = sortBy(project.issueTypes.map((t: any) => ({ id: String(t.id), name: String(t.name) })), (t: any) => t.id);
  const types = allTypes.slice(0, MAX_ISSUE_TYPES);
  const probe = await area("probe field", async () => ({ id: await probeField(client) }));
  let names: Map<string, number> | undefined;
  const screenByName = async (name: string) => {
    names ??= new Map((await allScreens(client)).map(s => [s.name, s.id]));
    return names.get(name);
  };
  const usage: Area[] = [];
  for (const t of types) {
    const base = { issueTypeId: t.id, issueTypeName: t.name };
    for (const op of [{ name: "create", id: 0 }, { name: "edit", id: 1 }] as const) {
      const k = `${t.id}:${op.name}`;
      if (probe.status !== "COMPLETE" || !probe.id) { usage.push({ key: k, ...base, operation: op.name, ...unavailable("No custom field to ask 'Where is my field' about") }); continue; }
      usage.push({ key: k, ...base, operation: op.name, ...(await area(`${op.name} screen of issue type ${t.id}`, async () => {
        const w = parseWhereIsMyField(await whereIsMyField(client, String(probe.id), key, t.id, op.id));
        const id = w.screenId ?? (w.screenName ? str(await screenByName(w.screenName)) : null);
        if (!id) return { status: "UNAVAILABLE" as Status, reason: "Screen not named by 'Where is my field'" };
        return { screenId: String(id), screenName: str(w.screenName), screenSchemeId: str(w.screenSchemeId), issueTypeScreenSchemeId: str(w.issueTypeScreenSchemeId) };
      }, [403, 404, 405, 501])) });
    }
    usage.push({ key: `${t.id}:view`, ...base, operation: "view", ...(await area(`view screen of issue type ${t.id}`, async () => {
      const v: any = await client.get(`/rest/projectconfig/1/issuetype/${seg(key)}/${seg(t.id)}/fields`);
      if (!v?.viewScreen?.screenId) return { status: "UNAVAILABLE" as Status, reason: "No view screen reported" };
      return { screenId: String(v.viewScreen.screenId), screenName: str(v.viewScreen.screenName) };
    }, [403, 404, 405, 501])) });
  }
  const screenNames = new Map<string, string | null>();
  for (const u of usage) if (typeof u.screenId === "string" && !screenNames.has(u.screenId)) screenNames.set(u.screenId, (u.screenName as string | null) ?? null);
  const ids = [...screenNames.keys()].sort(cmp);
  const screens: Area[] = [];
  for (const id of ids.slice(0, MAX_SCREENS)) {
    screens.push({ id, name: screenNames.get(id) ?? null, ...(await area(`screen ${id}`, async () => {
      const tabs = await readScreen(client, Number(id));
      if (!Array.isArray(tabs)) throw new Malformed();
      return { tabs: tabs.map((tab, i) => ({ id: String(tab.id), name: str(tab.name), position: i + 1, fields: tab.fields.map((f, j) => ({ id: String(f.id), name: str(f.name), position: j + 1 })) })) };
    })) });
  }
  const usageSource: Source = types.length < allTypes.length
    ? { status: "PARTIAL", reason: `Issue type cap (${MAX_ISSUE_TYPES}) reached` }
    : { status: usage.length ? aggregate(usage.map(u => u.status)) : "COMPLETE" };
  const screensSource: Source = ids.length > MAX_SCREENS
    ? { status: "PARTIAL", reason: `Screen cap (${MAX_SCREENS}) reached` }
    : { status: screens.length ? aggregate(screens.map(s => s.status)) : "COMPLETE" };
  const sources = { screenSchemes: source(screenSchemes), usage: usageSource, screens: screensSource };
  return { status: aggregate(Object.values(sources).map(s => s.status)), sources, usage, screens };
}

async function jsmQueues(client: AtlassianClient, sd: ServiceDesk) {
  const found = await area("queues", async () => {
    const list = await listQueues(client, sd);
    if (list.some(q => !numericId(q?.id))) throw new Malformed();
    const capped = list.length >= MAX_QUEUES;
    return {
      status: capped ? "PARTIAL" as Status : "COMPLETE" as Status, ...(capped ? { reason: `Queue cap (${MAX_QUEUES}) reached` } : {}),
      queues: list.map((q, i) => ({ id: String(q.id), name: str(q.name), jql: String(q.jql ?? ""), fields: (q.fields ?? []).map(String), position: i + 1 })),
    };
  });
  return { status: found.status, sources: { queues: source(found) }, queues: (found.queues as unknown[] | undefined) ?? [] };
}

async function jsmSla(ctx: ToolContext, sd: ServiceDesk) {
  const metrics = await area("SLA metrics", async () => {
    const page: any = await callTool(ctx, jiraSlaTools, "jira_get_sla_configuration", { service_desk: sd.id, offset: 0, limit: 500 });
    if (!Array.isArray(page?.items)) throw new Malformed();
    const capped = page.nextOffset !== null && page.nextOffset !== undefined;
    return {
      status: capped ? "PARTIAL" as Status : "COMPLETE" as Status,
      metrics: sortBy(page.items.map((m: any) => ({
        id: String(m.id), name: str(m.name), customerVisible: m.customerVisible === true,
        start: (m.start ?? []).map(String), pause: (m.pause ?? []).map(String), stop: (m.stop ?? []).map(String),
        goals: (m.goals ?? []).map((g: any, i: number) => ({ position: i + 1, jql: String(g.jql ?? ""), target: String(g.target ?? ""), calendar: str(g.calendar) })),
      })), (m: any) => m.id),
    };
  });
  const calendars = await area("SLA calendars", async () => {
    const list: any = await callTool(ctx, jiraSlaTools, "jira_list_sla_calendars", { service_desk: sd.id });
    if (!Array.isArray(list)) throw new Malformed();
    return {
      calendars: sortBy(list.map((c: any) => ({
        id: String(c.id ?? -1), name: str(c.name), timeZone: str(c.timeZone), workingHours: str(c.workingHours), holidays: Number(c.holidays ?? 0),
        usedBy: [...(c.usedBy ?? [])].map(String).sort(cmp), deletable: c.deletable === true,
      })), (c: any) => c.id),
    };
  });
  const sources = { metrics: source(metrics), calendars: source(calendars) };
  return { status: aggregate(Object.values(sources).map(s => s.status)), sources, metrics: (metrics.metrics as unknown[] | undefined) ?? [], calendars: (calendars.calendars as unknown[] | undefined) ?? [] };
}

/**
 * The id of the snapshot's project: the service desk's project when the key is that project, the id read by
 * project-schemes, or one project read; null when unreadable.
 */
async function projectIdOf(client: AtlassianClient, projectKey: string | null, sd: ServiceDesk | undefined, out: Record<string, any>): Promise<string | null> {
  if (!projectKey) return null;
  if (sd && projectKey.toUpperCase() === sd.projectKey.toUpperCase()) return sd.projectId;
  const fromSchemes = out.projectSchemes?.project;
  if (typeof fromSchemes?.key === "string" && fromSchemes.key.toUpperCase() === projectKey.toUpperCase() && fromSchemes.id) return String(fromSchemes.id);
  try {
    const project: any = await client.get(`${API}/project/${seg(projectKey)}`);
    return numericId(project?.id);
  } catch (e) {
    if (e instanceof HttpStatusError) return null;
    throw e;
  }
}

/** Predictable, scope-bearing artifact name; the request-form-only export keeps its original name. */
function artifactName(components: Component[], sd: ServiceDesk | undefined, projectKey: string | null, explicitProject: string | undefined): string {
  if (components.length === 1 && components[0] === "request-type-forms" && sd) return `jira-config-${sd.id}.json`;
  const extra = sd && explicitProject && explicitProject.toUpperCase() !== sd.projectKey.toUpperCase() ? `-${explicitProject.toUpperCase()}` : "";
  return `jira-config-${sd ? `sd${sd.id}` : String(projectKey).toUpperCase()}${extra}-${components.join("+")}.json`;
}

export const jiraConfigSnapshotTools: ToolDef[] = [{
  name: "jira_export_config", product: "jira",
  description:
    "Export Jira configuration components to a local JSON snapshot (schema v2) for later jira_diff_config. GET-only; explicit per-component coverage. " +
    "components (default request-type-forms): request-type-forms, jsm-queues, jsm-sla (need service_desk); project-schemes (permission/notification/" +
    "issue security/workflow/issue type/priority schemes), project-fields (field configurations), project-screens (create/edit/view screens) " +
    "(need project_key, or the service desk's project). Screen schemes and field configuration schemes are recorded as unavailable.",
  inputShape: {
    service_desk: z.coerce.string().min(1).optional().describe("Service desk id or project key (required for request-type-forms, jsm-queues, jsm-sla)"),
    project_key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/).optional().describe("Project key for project-* components (default: the service desk's project)"),
    components: listArg.pipe(z.array(z.enum(COMPONENTS)).min(1).max(COMPONENTS.length)).optional()
      .describe(`Components to capture, comma-separated: ${COMPONENTS.join(", ")} (default request-type-forms)`),
    output_dir: z.string().min(1).describe("Existing local output directory"),
    request_types: z.array(z.coerce.string().min(1)).min(1).max(1000).optional().describe("Request type ids or exact names; default all inventoried types"),
    include_presets: z.boolean().default(false).describe("Include sensitive hidden preset values in the local artifact only"),
    overwrite: z.boolean().default(false).describe("Back up and replace a conflicting local artifact"),
    max_request_types: z.number().int().min(1).max(1000).default(100),
    max_component_bytes: z.number().int().min(1).max(50 * MIB).default(5 * MIB).describe("Serialized size budget of each component"),
    max_total_bytes: z.number().int().min(1).max(200 * MIB).default(20 * MIB),
  },
  exitCode: (value) => (value?.outcome === "CONFLICT" ? EXIT.CONFLICT : EXIT.OK),
  handler: async (ctx, args) => {
    const components = [...new Set<Component>(args.components ?? ["request-type-forms"])].sort() as Component[];
    const sdComponents = components.filter(c => SD_COMPONENTS.has(c));
    const projectComponents = components.filter(c => !SD_COMPONENTS.has(c));
    if (sdComponents.length && !args.service_desk) throw new ValidationError(`service_desk is required for ${sdComponents.join(", ")}`);
    if (projectComponents.length && !args.project_key && !args.service_desk) throw new ValidationError(`project_key (or service_desk) is required for ${projectComponents.join(", ")}`);
    if (args.request_types && !components.includes("request-type-forms")) throw new ValidationError("request_types applies only to the request-type-forms component");
    const client = ctx.client("jira");
    const start = new Date().toISOString();
    const version = sdComponents.length ? await safeRead("JSM version", () => requireJsmVersion(client, "JSM configuration snapshots")) : null;
    const jira = await safeRead("Jira version", () => jiraVersion(client));
    const sd = args.service_desk ? await safeRead("service desk identity", () => resolveServiceDesk(client, args.service_desk)) : undefined;
    if (sd && (!numericId(sd.id) || !numericId(sd.projectId))) throw new ValidationError("Malformed service desk identity");
    const projectKey: string | null = args.project_key ?? sd?.projectKey ?? null;
    if (projectComponents.length && !/^[A-Za-z][A-Za-z0-9_]*$/.test(String(projectKey))) throw new ValidationError("Malformed project key");
    const diagnostics: Diagnostic[] = [];
    let diagnosticTotal = 0;
    const warn = (d: Diagnostic) => { diagnosticTotal++; if (diagnostics.length < 50) diagnostics.push(d); };

    const out: Record<string, any> = {};
    let forms: Record<string, unknown> = {};
    if (components.includes("request-type-forms")) {
      const discovered = await inventory(client, sd!, args.max_request_types, warn);
      const chosen = select(discovered.types, args.request_types);
      const requestTypes = [];
      for (const rt of chosen) requestTypes.push({ ...rt, form: await form(client, rt, args.include_presets, warn) });
      const counts = { complete: 0, partial: 0, unavailable: 0 };
      for (const rt of requestTypes) counts[rt.form.status.toLowerCase() as keyof typeof counts]++;
      const status: Status = Object.values(discovered.sources).every(s => s.status === "COMPLETE") && counts.partial === 0 && counts.unavailable === 0 ? "COMPLETE" : "PARTIAL";
      forms = { inventory: discovered.sources, inventoried: discovered.types.length, selected: chosen.length, forms: counts };
      out.requestTypeForms = { status, requestTypes };
    }
    if (components.includes("jsm-queues")) out.jsmQueues = await jsmQueues(client, sd!);
    if (components.includes("jsm-sla")) out.jsmSla = await jsmSla(ctx, sd!);
    if (components.includes("project-schemes")) out.projectSchemes = await projectSchemes(client, projectKey!);
    if (components.includes("project-fields")) out.projectFields = await projectFields(ctx, projectKey!);
    if (components.includes("project-screens")) out.projectScreens = await projectScreens(client, projectKey!);
    for (const c of components) {
      const size = Buffer.byteLength(JSON.stringify(out[COMPONENT_KEYS[c]]), "utf8");
      if (size > args.max_component_bytes) throw new ValidationError(`Component ${c} exceeds its byte budget (${args.max_component_bytes}); narrow the scope or raise max_component_bytes (up to ${50 * MIB})`);
    }
    const statuses = Object.fromEntries(components.map(c => [c, out[COMPONENT_KEYS[c]].status as Status]));
    const coverage = { status: Object.values(statuses).every(s => s === "COMPLETE") ? "COMPLETE" : "PARTIAL", components: statuses, ...forms };
    const projectId = await projectIdOf(client, projectKey, sd, out);
    const url = new URL(client.url(SD));
    url.username = ""; url.password = ""; url.search = ""; url.hash = "";
    url.pathname = url.pathname.replace(/\/rest\/servicedeskapi\/?$/, "").replace(/\/$/, "");
    const snapshot = {
      kind: SNAPSHOT_KIND, schemaVersion: SCHEMA_VERSION,
      source: { baseUrl: url.toString().replace(/\/$/, ""), jiraVersion: jira, jsmVersion: version },
      capture: { start, end: new Date().toISOString(), atomic: false },
      scope: {
        serviceDeskId: sd?.id ?? null, serviceDeskProjectId: sd?.projectId ?? null, projectId, projectKey, components,
        ...(components.includes("request-type-forms") ? { selection: args.request_types ?? "ALL_INVENTORIED" } : {}),
        note: "Configuration areas outside the listed components are not captured",
      },
      coverage, components: out, diagnostics: { total: diagnosticTotal, items: diagnostics },
    };
    const bytes = Buffer.from(JSON.stringify(snapshot, null, 2) + "\n", "utf8");
    if (bytes.length > args.max_total_bytes) throw new ValidationError(`Snapshot byte budget exceeded (${args.max_total_bytes}); select fewer request_types or components, or raise max_total_bytes (up to 209715200)`);
    const relativePath = artifactName(components, sd, projectKey, args.project_key);
    const target = await localTarget(args.output_dir, relativePath);
    const written = await writeLocal(target, bytes, args.overwrite);
    return { ...written, path: target, relativePath, sha256: sha256(bytes), bytes: bytes.length, capture: snapshot.capture, coverage, diagnostics: { total: diagnosticTotal, items: diagnostics } };
  },
}];
