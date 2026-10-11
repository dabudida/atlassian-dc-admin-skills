/** Scoped, completeness-aware JSM configuration evidence; all remote access is read-only. */
import { z } from "zod";
import type { AtlassianClient } from "../../client.js";
import { HttpStatusError, UnsupportedError, ValidationError } from "../../errors.js";
import { EXIT } from "../../format.js";
import { jiraVersion, requireJsmVersion } from "../../jiraVersion.js";
import type { ToolDef } from "../types.js";
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

export const jiraConfigSnapshotTools: ToolDef[] = [{
  name: "jira_export_config", product: "jira",
  description: "Export ordered JSM request-type forms for one service desk to a local Jira-config JSON snapshot. GET-only; explicit coverage and unknown flags. Other configuration areas are not captured.",
  inputShape: {
    service_desk: z.coerce.string().min(1).describe("Service desk id or project key"),
    output_dir: z.string().min(1).describe("Existing local output directory"),
    request_types: z.array(z.coerce.string().min(1)).min(1).max(1000).optional().describe("Request type ids or exact names; default all inventoried types"),
    include_presets: z.boolean().default(false).describe("Include sensitive hidden preset values in the local artifact only"),
    overwrite: z.boolean().default(false).describe("Back up and replace a conflicting local artifact"),
    max_request_types: z.number().int().min(1).max(1000).default(100),
    max_total_bytes: z.number().int().min(1).max(200 * 1024 * 1024).default(20 * 1024 * 1024),
  },
  exitCode: (value) => (value?.outcome === "CONFLICT" ? EXIT.CONFLICT : EXIT.OK),
  handler: async (ctx, args) => {
    const client = ctx.client("jira");
    const start = new Date().toISOString();
    const version = await safeRead("JSM version", () => requireJsmVersion(client, "Request-form snapshots"));
    const jira = await safeRead("Jira version", () => jiraVersion(client));
    const sd = await safeRead("service desk identity", () => resolveServiceDesk(client, args.service_desk));
    if (!numericId(sd.id) || !numericId(sd.projectId)) throw new ValidationError("Malformed service desk identity");
    const diagnostics: Diagnostic[] = [];
    let diagnosticTotal = 0;
    const warn = (d: Diagnostic) => { diagnosticTotal++; if (diagnostics.length < 50) diagnostics.push(d); };
    const discovered = await inventory(client, sd, args.max_request_types, warn);
    const chosen = select(discovered.types, args.request_types);
    const requestTypes = [];
    for (const rt of chosen) requestTypes.push({ ...rt, form: await form(client, rt, args.include_presets, warn) });
    const counts = { complete: 0, partial: 0, unavailable: 0 };
    for (const rt of requestTypes) counts[rt.form.status.toLowerCase() as keyof typeof counts]++;
    const coverage = {
      status: Object.values(discovered.sources).every(s => s.status === "COMPLETE") && counts.partial === 0 && counts.unavailable === 0 ? "COMPLETE" : "PARTIAL",
      inventory: discovered.sources, inventoried: discovered.types.length, selected: chosen.length, forms: counts,
    };
    const url = new URL(client.url(SD));
    url.username = ""; url.password = ""; url.search = ""; url.hash = "";
    url.pathname = url.pathname.replace(/\/rest\/servicedeskapi\/?$/, "").replace(/\/$/, "");
    const snapshot = {
      schemaVersion: 1, source: { baseUrl: url.toString().replace(/\/$/, ""), jiraVersion: jira, jsmVersion: version },
      capture: { start, end: new Date().toISOString(), atomic: false },
      scope: { serviceDeskId: sd.id, projectId: sd.projectId, projectKey: sd.projectKey, components: ["request-type-forms"], selection: args.request_types ?? "ALL_INVENTORIED", note: "Other Jira configuration areas are not captured" },
      coverage, components: { requestTypeForms: { requestTypes } }, diagnostics: { total: diagnosticTotal, items: diagnostics },
    };
    const bytes = Buffer.from(JSON.stringify(snapshot, null, 2) + "\n", "utf8");
    if (bytes.length > args.max_total_bytes) throw new ValidationError(`Snapshot byte budget exceeded (${args.max_total_bytes}); select fewer request_types or raise max_total_bytes (up to 209715200)`);
    const relativePath = `jira-config-${sd.id}.json`;
    const target = await localTarget(args.output_dir, relativePath);
    const written = await writeLocal(target, bytes, args.overwrite);
    return { ...written, path: target, relativePath, sha256: sha256(bytes), bytes: bytes.length, capture: snapshot.capture, coverage, diagnostics: { total: diagnosticTotal, items: diagnostics } };
  },
}];
