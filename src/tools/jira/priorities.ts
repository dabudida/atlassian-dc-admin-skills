/**
 * Jira DC priorities, resolutions and priority schemes.
 *
 * Paths checked in the Jira DC 11.3 WADL (`/rest/api/2/application.wadl`): `GET /priority`,
 * `GET /resolution`, `GET|POST /priorityschemes`, `GET|PUT|DELETE /priorityschemes/{id}` and
 * `GET|PUT /project/{key}/priorityscheme`. There is no POST for `/priority` or `/resolution`, so
 * new priorities and resolutions are manual changes on the websudo-protected admin pages.
 * Jira refuses priority scheme changes that would need an issue migration; this tool never migrates
 * issues and turns such an assignment into a manual change.
 */

import { z } from "zod";
import { seg, type AtlassianClient } from "../../client.js";
import { ValidationError, VerificationError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { alreadySatisfied, capList, dryRunShape, filterByName, fullListsShape, guardedWrite, listArg, nameFilterShape, pageShape, paginate } from "../util.js";
import { manualStep, WEBSUDO_ONLY } from "./manualSteps.js";

const API = "/rest/api/2";
/** Priority schemes read at most (an instance has few; the list is filtered and paged locally). */
const MAX_SCHEMES = 1000;

interface Priority { id: string; name: string; description?: string; statusColor?: string }
interface Scheme { id: number; name: string; description: string; defaultOptionId: string | null; optionIds: string[]; defaultScheme: boolean; projectKeys?: string[] }

async function priorities(c: AtlassianClient): Promise<Priority[]> {
  return ((await c.get(`${API}/priority`)) as any[]) ?? [];
}

const toScheme = (s: any): Scheme => ({
  id: Number(s.id),
  name: String(s.name ?? ""),
  description: s.description ?? "",
  defaultOptionId: s.defaultOptionId != null ? String(s.defaultOptionId) : null,
  optionIds: (s.optionIds ?? []).map(String),
  defaultScheme: s.defaultScheme === true,
  ...(Array.isArray(s.projectKeys) ? { projectKeys: s.projectKeys.map(String) } : {}),
});

async function allSchemes(c: AtlassianClient): Promise<Scheme[]> {
  const items = await c.getPaged(`${API}/priorityschemes`, "schemes", { expand: "schemes.projectKeys" }, 50, MAX_SCHEMES);
  return items.map(toScheme);
}

/** A scheme by id or exact name (case-insensitive); undefined when there is none. */
function pickScheme(schemes: Scheme[], given: string): Scheme | undefined {
  const v = String(given).trim();
  const byId = schemes.find((s) => String(s.id) === v);
  if (byId) return byId;
  const byName = schemes.filter((s) => s.name.toLowerCase() === v.toLowerCase());
  if (byName.length > 1) throw new ValidationError(`Priority scheme name '${v}' is ambiguous; pass the id`);
  return byName[0];
}

async function requireScheme(c: AtlassianClient, given: string): Promise<Scheme> {
  const s = pickScheme(await allSchemes(c), given);
  if (!s) throw new ValidationError(`No priority scheme '${given}'`);
  return s;
}

/** Priority ids for ids or exact names (case-insensitive), in the given order. */
function resolvePriorities(all: Priority[], given: string[]): string[] {
  const ids = given.map((g) => {
    const v = g.trim();
    const hit = all.find((p) => String(p.id) === v) ?? all.find((p) => p.name.toLowerCase() === v.toLowerCase());
    if (!hit) throw new ValidationError(`Priority '${v}' does not exist (known: ${all.map((p) => p.name).join(", ")})`);
    return String(hit.id);
  });
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new ValidationError(`Priority ${dup} is listed twice`);
  return ids;
}

const nameOf = (all: Priority[], id: string | null) => (id === null ? null : (all.find((p) => String(p.id) === id)?.name ?? id));

/** The body PUT/POST /priorityschemes takes, as the scheme reads back. */
const body = (s: { name: string; description: string; defaultOptionId: string | null; optionIds: string[] }) => ({
  name: s.name,
  description: s.description,
  ...(s.defaultOptionId !== null ? { defaultOptionId: s.defaultOptionId } : {}),
  optionIds: s.optionIds,
});
const same = (a: Scheme, b: ReturnType<typeof body>) => JSON.stringify(body(a)) === JSON.stringify(b);
const view = (all: Priority[], s: { name: string; description: string; defaultOptionId: string | null; optionIds: string[] }) => ({
  name: s.name,
  description: s.description,
  defaultPriority: nameOf(all, s.defaultOptionId),
  priorities: s.optionIds.map((id) => nameOf(all, id)),
});

function checkDefault(defaultId: string | null, optionIds: string[]) {
  if (defaultId !== null && !optionIds.includes(defaultId)) throw new ValidationError(`The default priority ${defaultId} is not in the scheme's priorities`);
}

const schemeArg = z.coerce.string().min(1).describe("Priority scheme id or exact name");
const prioritiesArg = listArg.describe("Priorities in order: ids or exact names, comma-separated or array");
const defaultArg = z.coerce.string().min(1).describe("Default priority: id or exact name (must be in the scheme)");

export const jiraPriorityTools: ToolDef[] = [
  {
    name: "jira_list_priorities",
    product: "jira",
    description: "Priorities with id, name, description and status colour, in Jira's order.",
    inputShape: { ...nameFilterShape, ...pageShape(100) },
    async handler({ client }, args) {
      const items = filterByName(await priorities(client("jira")), args.name_contains).map((p) => ({ id: String(p.id), name: p.name, description: p.description ?? "", statusColor: p.statusColor }));
      return paginate(items, args, 100);
    },
  },
  {
    name: "jira_list_resolutions",
    product: "jira",
    description: "Resolutions with id, name and description, in Jira's order.",
    inputShape: { ...nameFilterShape, ...pageShape(100) },
    async handler({ client }, args) {
      const all: any[] = ((await client("jira").get(`${API}/resolution`)) as any[]) ?? [];
      const items = filterByName(all, args.name_contains).map((r) => ({ id: String(r.id), name: r.name, description: r.description ?? "" }));
      return paginate(items, args, 100);
    },
  },
  {
    name: "jira_list_priority_schemes",
    product: "jira",
    description: "Priority schemes: default flag, default priority, number of priorities and the projects that use each (first 10 keys unless full_lists=true).",
    inputShape: { ...nameFilterShape, ...fullListsShape, ...pageShape(50) },
    async handler({ client }, args) {
      const c = client("jira");
      const [schemes, all] = await Promise.all([allSchemes(c), priorities(c)]);
      const items = filterByName(schemes, args.name_contains).map((s) => {
        const row: Record<string, unknown> = {
          id: s.id,
          name: s.name,
          description: s.description || undefined,
          default: s.defaultScheme,
          defaultPriority: s.defaultOptionId === null ? null : { id: s.defaultOptionId, name: nameOf(all, s.defaultOptionId) },
          priorityCount: s.optionIds.length,
          projectCount: s.projectKeys?.length ?? 0,
        };
        capList(row, "projectKeys", s.projectKeys, args.full_lists);
        return row;
      });
      return paginate(items, args, 50);
    },
  },
  {
    name: "jira_get_priority_scheme",
    product: "jira",
    description: "One priority scheme (id or exact name): its priorities in order, default priority and the projects that use it.",
    inputShape: { scheme: schemeArg, ...fullListsShape },
    async handler({ client }, args) {
      const c = client("jira");
      const [s, all] = await Promise.all([requireScheme(c, args.scheme), priorities(c)]);
      const out: Record<string, unknown> = {
        id: s.id,
        name: s.name,
        description: s.description,
        default: s.defaultScheme,
        defaultPriority: s.defaultOptionId === null ? null : { id: s.defaultOptionId, name: nameOf(all, s.defaultOptionId) },
        priorities: s.optionIds.map((id) => ({ id, name: nameOf(all, id) })),
        projectCount: s.projectKeys?.length ?? 0,
      };
      capList(out, "projectKeys", s.projectKeys, args.full_lists);
      return out;
    },
  },
  {
    name: "jira_create_priority_scheme",
    product: "jira",
    write: true,
    invalidates: [],
    description:
      "Create a priority scheme with ordered priorities (ids or exact names) and an optional default. " +
      "Same name and settings → already-satisfied; same name otherwise → error (use jira_update_priority_scheme).",
    inputShape: { name: z.string().trim().min(1), description: z.string().optional(), priorities: prioritiesArg, default_priority: defaultArg.optional(), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const [schemes, all] = await Promise.all([allSchemes(c), priorities(c)]);
      const optionIds = resolvePriorities(all, args.priorities);
      if (!optionIds.length) throw new ValidationError("Pass at least one priority");
      const defaultOptionId = args.default_priority !== undefined ? resolvePriorities(all, [args.default_priority])[0]! : null;
      checkDefault(defaultOptionId, optionIds);
      const json = body({ name: args.name, description: args.description ?? "", defaultOptionId, optionIds });
      const summary = `Create priority scheme '${args.name}' (${optionIds.map((id) => nameOf(all, id)).join(", ")})`;
      const existing = schemes.find((s) => s.name.toLowerCase() === args.name.toLowerCase());
      if (existing && same(existing, json)) return alreadySatisfied(summary, `priority scheme ${existing.id} already has these settings`, { id: existing.id });
      if (existing) throw new ValidationError(`Priority scheme ${existing.id} '${existing.name}' already exists with other settings; use jira_update_priority_scheme`);
      const req = { method: "POST" as const, path: `${API}/priorityschemes`, json, summary };
      if (args.dry_run !== false) return guardedWrite(c, args, req);
      const result = await guardedWrite(c, args, req);
      const back = (await allSchemes(c)).find((s) => s.name === args.name);
      if (!back || !same(back, json)) throw new VerificationError(`${summary}: the scheme does not read back as created`, back ?? null);
      return { ...result, result: { id: back.id, ...view(all, back) }, created: { type: "priority-scheme", name: back.name, id: String(back.id) } };
    },
  },
  {
    name: "jira_update_priority_scheme",
    product: "jira",
    write: true,
    invalidates: [],
    description:
      "Change a priority scheme's name, description, ordered priorities and/or default (ids or exact names); " +
      "unspecified fields stay. The dry run shows old and new values. Jira refuses a change that would migrate " +
      "issues (do that in the UI); the default scheme cannot be changed.",
    inputShape: {
      scheme: schemeArg,
      name: z.string().trim().min(1).optional(),
      description: z.string().optional(),
      priorities: prioritiesArg.optional(),
      default_priority: defaultArg.optional(),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const [s, all] = await Promise.all([requireScheme(c, args.scheme), priorities(c)]);
      if (s.defaultScheme) throw new ValidationError(`'${s.name}' is the default priority scheme; Jira keeps it with all priorities and does not let it be changed`);
      const optionIds = args.priorities ? resolvePriorities(all, args.priorities) : s.optionIds;
      if (!optionIds.length) throw new ValidationError("Pass at least one priority");
      const defaultOptionId = args.default_priority !== undefined ? resolvePriorities(all, [args.default_priority])[0]! : s.defaultOptionId;
      checkDefault(defaultOptionId, optionIds);
      const json = body({ name: args.name ?? s.name, description: args.description ?? s.description, defaultOptionId, optionIds });
      const summary = `Update priority scheme ${s.id} '${s.name}'`;
      if (same(s, json)) return alreadySatisfied(summary, "it already has these settings");
      const req = { method: "PUT" as const, path: `${API}/priorityschemes/${s.id}`, json, summary };
      const before = view(all, s);
      const after = view(all, { name: json.name, description: json.description, defaultOptionId, optionIds });
      if (args.dry_run !== false) {
        return { ...(await guardedWrite(c, args, req)), before, after, identity: { op: "update-priority-scheme", scheme: s.id, ...json }, state: body(s) };
      }
      const result = await guardedWrite(c, args, req);
      const back = toScheme(await c.get(`${API}/priorityschemes/${s.id}`));
      if (!same(back, json)) throw new VerificationError(`${summary}: the scheme does not read back as updated`, view(all, back));
      return { ...result, result: { id: back.id, ...view(all, back) } };
    },
  },
  {
    name: "jira_delete_priority_scheme",
    product: "jira",
    write: true,
    invalidates: [],
    description: "Delete a priority scheme; its projects fall back to the default priority scheme. Already gone → already-satisfied. The default scheme cannot be deleted.",
    inputShape: { scheme: schemeArg, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const s = pickScheme(await allSchemes(c), args.scheme);
      if (!s) return alreadySatisfied(`Delete priority scheme '${args.scheme}'`, "no such priority scheme");
      if (s.defaultScheme) throw new ValidationError(`'${s.name}' is the default priority scheme and cannot be deleted`);
      const keys = s.projectKeys ?? [];
      const fallBack = keys.length ? `; ${keys.length} project(s) fall back to the default scheme: ${keys.slice(0, 10).join(", ")}${keys.length > 10 ? ", ..." : ""}` : "";
      const req = { method: "DELETE" as const, path: `${API}/priorityschemes/${s.id}`, summary: `Delete priority scheme ${s.id} '${s.name}'${fallBack}` };
      if (args.dry_run !== false) return { ...(await guardedWrite(c, args, req)), identity: { op: "delete-priority-scheme", scheme: s.id }, state: { projects: keys } };
      const result = await guardedWrite(c, args, req);
      if (pickScheme(await allSchemes(c), String(s.id))) throw new VerificationError(`${req.summary}: the scheme is still listed`, { id: s.id });
      return result;
    },
  },
  {
    name: "jira_assign_priority_scheme",
    product: "jira",
    write: true,
    invalidates: [],
    description:
      "Assign a priority scheme (id or exact name) to a project and read it back. Already assigned → already-satisfied. " +
      "When issues of the project have priorities the scheme lacks, Jira would migrate them: that is a manual change in the UI.",
    inputShape: { project_key: z.string().trim().min(1), scheme: schemeArg, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const key = args.project_key;
      const [target, current, all] = await Promise.all([requireScheme(c, args.scheme), c.get(`${API}/project/${seg(key)}/priorityscheme`), priorities(c)]);
      const summary = `Assign priority scheme ${target.id} '${target.name}' to project ${key}`;
      const before = current?.id != null ? { id: Number(current.id), name: current.name } : null;
      if (before?.id === target.id) return alreadySatisfied(summary, `project ${key} already uses priority scheme '${target.name}'`);
      const identity = { op: "assign-priority-scheme", project: key, scheme: target.id };
      const jql = `project = "${key}" AND priority not in (${target.optionIds.join(",")})`;
      const foreign = target.optionIds.length ? Number((await c.get(`${API}/search`, { jql, maxResults: 0, fields: "none" }))?.total ?? 0) : 0;
      if (foreign > 0) {
        const project = await c.get(`${API}/project/${seg(key)}`);
        return manualStep(c, args, {
          summary,
          reason: `${foreign} issues of ${key} have priorities that '${target.name}' lacks, so Jira would migrate them; this tool never migrates issues`,
          page: "/secure/admin/AssociatePriorityScheme!default.jspa",
          params: { projectId: project?.id },
          steps: [`Select priority scheme '${target.name}'`, "Map the priorities the scheme lacks to ones it has", "Confirm the association"],
          identity,
          state: { current: before?.id ?? null, foreign },
          extra: { before, after: { id: target.id, name: target.name, priorities: target.optionIds.map((id) => nameOf(all, id)) } },
        });
      }
      const req = { method: "PUT" as const, path: `${API}/project/${seg(key)}/priorityscheme`, json: { id: target.id }, summary };
      if (args.dry_run !== false) return { ...(await guardedWrite(c, args, req)), before, after: { id: target.id, name: target.name }, identity, state: { current: before?.id ?? null } };
      const result = await guardedWrite(c, args, req);
      const back = await c.get(`${API}/project/${seg(key)}/priorityscheme`);
      if (Number(back?.id) !== target.id) throw new VerificationError(`${summary}: the project reads back with priority scheme ${back?.id ?? "(none)"}`, back);
      return { ...result, result: { project: key, scheme: { id: target.id, name: target.name } } };
    },
  },
  {
    name: "jira_create_priority",
    product: "jira",
    write: true,
    invalidates: [],
    description:
      "Add a priority. Jira DC has no REST endpoint for it, so this is a manual change on the Priorities admin page " +
      "(re-run to verify). Exists (exact name, case-insensitive) → already-satisfied.",
    inputShape: {
      name: z.string().trim().min(1).max(60),
      description: z.string().optional(),
      status_color: z.string().regex(/^#[0-9a-fA-F]{3,6}$/).optional().describe("Colour, e.g. #ff0000"),
      icon_url: z.string().optional().describe("Icon URL or path"),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const all = await priorities(c);
      const summary = `Create priority '${args.name}'`;
      const hit = all.find((p) => p.name.toLowerCase() === args.name.toLowerCase());
      if (hit) return alreadySatisfied(summary, `priority ${hit.id} '${hit.name}' exists`, { id: String(hit.id) });
      const steps = [
        `In 'Add New Priority' enter name '${args.name}'`,
        ...(args.description ? [`Description: '${args.description}'`] : []),
        ...(args.icon_url ? [`Icon URL: '${args.icon_url}'`] : []),
        ...(args.status_color ? [`Priority colour: ${args.status_color}`] : []),
        "Click Add",
        "Add the priority to the priority schemes that should offer it (jira_update_priority_scheme)",
      ];
      return manualStep(c, args, { summary, reason: WEBSUDO_ONLY, page: "/secure/admin/ViewPriorities.jspa", steps, identity: { op: "create-priority", name: args.name }, state: { exists: false } });
    },
  },
  {
    name: "jira_create_resolution",
    product: "jira",
    write: true,
    invalidates: [],
    description:
      "Add a resolution. Jira DC has no REST endpoint for it, so this is a manual change on the Resolutions admin page " +
      "(re-run to verify). Exists (exact name, case-insensitive) → already-satisfied.",
    inputShape: { name: z.string().trim().min(1).max(60), description: z.string().optional(), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const all: any[] = ((await c.get(`${API}/resolution`)) as any[]) ?? [];
      const summary = `Create resolution '${args.name}'`;
      const hit = all.find((r) => String(r.name).toLowerCase() === args.name.toLowerCase());
      if (hit) return alreadySatisfied(summary, `resolution ${hit.id} '${hit.name}' exists`, { id: String(hit.id) });
      const steps = [`In 'Add New Resolution' enter name '${args.name}'`, ...(args.description ? [`Description: '${args.description}'`] : []), "Click Add"];
      return manualStep(c, args, { summary, reason: WEBSUDO_ONLY, page: "/secure/admin/ViewResolutions.jspa", steps, identity: { op: "create-resolution", name: args.name }, state: { exists: false } });
    },
  },
];
