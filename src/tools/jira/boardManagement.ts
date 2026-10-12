/**
 * Jira Software board management: create and delete boards (public agile API), and change a board's
 * saved filter, columns and status mapping, swimlanes, quick filters and card colors (internal
 * Jira Software API).
 *
 * The internal routes are the ones the board configuration screens of Jira 11.3.7 send (taken from
 * the shipped `gh-rapid-config` script) and their paths were confirmed on 11.3.7 with GET only:
 *   PUT  /rest/greenhopper/1.0/rapidviewconfig/filter             {id, savedFilterId}
 *   PUT  /rest/greenhopper/1.0/rapidviewconfig/columns            {rapidViewId, currentStatisticsField:{id}, mappedColumns}
 *   PUT  /rest/greenhopper/1.0/rapidviewconfig/swimlaneStrategy   {id, swimlaneStrategyId}
 *   AJS.RestfulTable /rest/greenhopper/1.0/swimlanes/{board}       POST, PUT/DELETE /{id}, POST /{id}/move
 *   AJS.RestfulTable /rest/greenhopper/1.0/quickfilters/{board}    GET, POST, PUT/DELETE /{id}
 *   PUT  /rest/greenhopper/1.0/cardcolors/{board}/strategy         {id, cardColorStrategyId}
 *   GET  /rest/greenhopper/1.0/cardcolors/{board}/strategy/{s}?preloadValues=true
 *   AJS.RestfulTable /rest/greenhopper/1.0/cardcolors/{board}/color POST, PUT/DELETE /{id}
 * Writes are internal, verified for the 11.3 structure only: they are gated to Jira 11.3.x and every
 * change is read back from the board edit model (`rapidviewconfig/editmodel`).
 */

import { z } from "zod";
import type { AtlassianClient } from "../../client.js";
import { isHttpStatusError, PermissionError, ValidationError, VerificationError } from "../../errors.js";
import { requireJiraVersion } from "../../jiraVersion.js";
import type { ToolDef } from "../types.js";
import { alreadySatisfied, boolArg, dryRunShape, jsonArg, pageShape, paginate } from "../util.js";
import { AGILE } from "./shape.js";

const GH = "/rest/greenhopper/1.0";
const NOTE = "Nothing was changed. Confirm with the user, then re-run with dry_run=false.";
const INTERNAL = "internal Jira Software API, verified for the Jira 11.3 structure only";

const boardShape = { board_id: z.coerce.number().int().positive() };

// -- shared helpers -------------------------------------------------------------------------

async function editModel(c: AtlassianClient, board: number): Promise<any> {
  return c.get(`${GH}/rapidviewconfig/editmodel`, { rapidViewId: board });
}

/** Version gate and board admin check before any internal change; returns the edit model. */
async function editableModel(c: AtlassianClient, board: number, feature: string, section?: string): Promise<any> {
  await requireJiraVersion(c, feature);
  const m = await editModel(c, board);
  const canEdit = section ? m?.[section]?.canEdit ?? m?.canEdit : m?.canEdit;
  if (!canEdit) throw new PermissionError(`This account cannot edit board ${board} (not a board administrator)`);
  return m;
}

interface Step {
  method: "POST" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  label: string;
}

const echo = (c: AtlassianClient, s: Step) => ({ method: s.method, url: c.url(s.path), ...(s.body !== undefined ? { body: s.body } : {}), label: s.label });

function planned(c: AtlassianClient, summary: string, steps: Step[], extra: Record<string, unknown> = {}) {
  return { dry_run: true, product: c.product, summary, request: echo(c, steps[0]), followUps: steps.slice(1).map((s) => echo(c, s)), ...extra, note: NOTE };
}

async function send(c: AtlassianClient, s: Step): Promise<any> {
  return c.request(s.method, s.path, s.body !== undefined ? { json: s.body as any } : {});
}

function done(c: AtlassianClient, summary: string, steps: Step[], result: unknown) {
  return { dry_run: false, product: c.product, summary, request: echo(c, steps[0]), followUps: steps.slice(1).map((s) => echo(c, s)), result };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const eqi = (a: unknown, b: unknown) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

/** Pick one item by id or exact (case-insensitive) name; ambiguous names are refused. */
function pickByIdOrName<T extends { id: unknown; name: unknown }>(items: T[], given: string, what: string): T | undefined {
  const v = String(given).trim();
  const byId = items.find((x) => String(x.id) === v);
  if (byId) return byId;
  const byName = items.filter((x) => eqi(x.name, v));
  if (byName.length > 1) throw new ValidationError(`${what} name '${v}' is ambiguous (${byName.map((x) => x.id).join(", ")}); pass the id`);
  return byName[0];
}

/** Absolute URL of a RestfulTable row, as the `after` value of a move. */
const rowUrl = (c: AtlassianClient, path: string) => c.url(path);

/**
 * Moves that order the members `current` and `target` share as in `target`. Members of only one list
 * (lanes added or removed meanwhile) are left out, so a missing member never drives a splice.
 */
export function plannedMoves<T>(current: T[], target: T[]): Array<{ id: T; after: T | null }> {
  const common = target.filter((id, i) => current.includes(id) && target.indexOf(id) === i);
  const sim = current.filter((id, i) => common.includes(id) && current.indexOf(id) === i);
  const moves: Array<{ id: T; after: T | null }> = [];
  common.forEach((id, i) => {
    if (sim[i] === id) return;
    sim.splice(sim.indexOf(id), 1);
    sim.splice(i, 0, id);
    moves.push({ id, after: i === 0 ? null : common[i - 1] });
  });
  return moves;
}

// -- filters ---------------------------------------------------------------------------------

/** A saved filter by numeric id, or by exact name among the caller's favourites (Jira DC cannot search all filters). */
async function resolveFilter(c: AtlassianClient, given: string): Promise<{ id: number; name: string }> {
  const v = String(given).trim();
  if (/^\d+$/.test(v)) {
    try {
      const f: any = await c.get(`/rest/api/2/filter/${v}`);
      return { id: Number(f.id), name: String(f.name) };
    } catch (e) {
      if (isHttpStatusError(e) && (e.status === 404 || e.status === 400)) throw new ValidationError(`Filter ${v} does not exist or is not visible to this account`);
      throw e;
    }
  }
  const favs: any[] = ((await c.get("/rest/api/2/filter/favourite")) as any[]) ?? [];
  const hits = favs.filter((f) => eqi(f.name, v));
  if (hits.length > 1) throw new ValidationError(`Filter name '${v}' is ambiguous among favourite filters (${hits.map((f) => f.id).join(", ")}); pass the id`);
  if (!hits.length) throw new ValidationError(`'${v}' is not one of this account's favourite filters (Jira DC cannot search all filters); pass the filter id`);
  return { id: Number(hits[0].id), name: String(hits[0].name) };
}

const BOARD_SEARCH_MAX = 500;

/**
 * Boards with exactly this name (case-insensitive). Jira's name search matches substrings; when it
 * returns more than BOARD_SEARCH_MAX boards, a duplicate could hide beyond the cap, so the caller is
 * asked for a more specific name instead of deciding there is none.
 */
async function boardsNamed(c: AtlassianClient, name: string): Promise<any[]> {
  const out: any[] = [];
  for (let startAt = 0; ; ) {
    const page: any = await c.get(`${AGILE}/board`, { name, startAt, maxResults: 50 });
    const values: any[] = page?.values ?? [];
    out.push(...values);
    if (!values.length || page?.isLast !== false) break;
    if (out.length >= BOARD_SEARCH_MAX) {
      throw new ValidationError(`More than ${BOARD_SEARCH_MAX} boards match the name '${name}', so a board with exactly this name cannot be ruled out; use a more specific name`);
    }
    startAt += values.length;
  }
  return out.filter((b) => eqi(b.name, name));
}

/** A board's location project (key and id), from the list item or GET /board/{id}; null when Jira shows none. */
async function boardLocation(c: AtlassianClient, b: any): Promise<{ key?: string; id?: string } | null> {
  const loc = b?.location ?? (await findBoard(c, Number(b.id)))?.location;
  if (!loc || (loc.projectKey === undefined && loc.projectId === undefined)) return null;
  return { key: loc.projectKey === undefined ? undefined : String(loc.projectKey), id: loc.projectId === undefined ? undefined : String(loc.projectId) };
}

async function findBoard(c: AtlassianClient, board: number): Promise<any | null> {
  try {
    return await c.get(`${AGILE}/board/${board}`);
  } catch (e) {
    if (isHttpStatusError(e) && e.status === 404) return null;
    throw e;
  }
}

// -- columns ---------------------------------------------------------------------------------

const CONSTRAINTS = ["none", "issueCount", "issueCountExclSubs"] as const;
const constraintName = (id: unknown) => String(id ?? "none_").replace(/_$/, "") || "none";
const limit = (v: unknown) => (v === "" || v === null || v === undefined ? null : Number(v));
const statusView = (s: any) => ({ id: String(s.id), name: String(s.name), category: s.statusCategory?.key });

const columnSpec = z.object({
  id: z.coerce.number().int().optional().describe("Existing column id (as jira_get_board_columns lists it); default: matched by name"),
  name: z.string().trim().min(1),
  statuses: z.array(z.coerce.string()).default([]),
  min: z.coerce.number().int().min(0).nullable().optional(),
  max: z.coerce.number().int().min(0).nullable().optional(),
});
const COLUMNS_EXAMPLE = '[{"name":"To Do","statuses":["Open"]},{"name":"In Progress","statuses":["In Progress"],"max":5},{"name":"Done","statuses":["Done"]}]';

/** Columns as compared: names, status ids, min/max, plus the constraint. */
function columnsView(list: any) {
  return {
    constraint: constraintName(list?.currentStatisticsField?.id),
    columns: (list?.mappedColumns ?? []).map((c: any) => ({ name: String(c.name), statuses: (c.mappedStatuses ?? []).map((s: any) => String(s.id)), min: limit(c.min), max: limit(c.max) })),
  };
}

// -- swimlanes -------------------------------------------------------------------------------

const SWIMLANE_STRATEGIES = ["custom", "parentChild", "assignee", "assigneeUnassignedFirst", "epic", "project", "none"] as const;
const laneSpec = z.object({ name: z.string().trim().min(1), query: z.string().trim().min(1), description: z.string().optional() });
const LANES_EXAMPLE = '[{"name":"Expedite","query":"priority = Highest"},{"name":"Bugs","query":"type = Bug"}]';
// Jira keeps JQL as typed (trailing blanks included); names and queries are compared trimmed
const laneView = (l: any) => ({ name: String(l.name).trim(), query: String(l.query ?? "").trim(), description: String(l.description ?? "") });

// -- quick filters ---------------------------------------------------------------------------

async function quickFilters(c: AtlassianClient, board: number): Promise<{ canEdit: boolean; items: any[] }> {
  const d: any = await c.get(`${GH}/quickfilters/${board}`);
  return { canEdit: !!d?.canEdit, items: (d?.quickFilters ?? []).map((q: any) => ({ id: Number(q.id), name: String(q.name), query: String(q.query ?? "").trim(), description: String(q.description ?? "") })) };
}

async function editableQuickFilters(c: AtlassianClient, board: number) {
  await requireJiraVersion(c, "Board quick filter changes");
  const qf = await quickFilters(c, board);
  if (!qf.canEdit) throw new PermissionError(`This account cannot edit board ${board} (not a board administrator)`);
  return qf;
}

// -- card colors -----------------------------------------------------------------------------

const CARD_STRATEGIES = ["issuetype", "priority", "assignee", "custom", "none"] as const;
const colorSpec = z.object({ value: z.coerce.string().trim().min(1), color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, "color must be #rrggbb") });
const COLORS_EXAMPLE = '[{"value":"High","color":"#ff8800"}]';

async function cardRows(c: AtlassianClient, board: number, strategy: string): Promise<any[]> {
  if (strategy === "none") return [];
  const d: any = await c.get(`${GH}/cardcolors/${board}/strategy/${strategy}`, { preloadValues: true });
  return d?.cardColors ?? [];
}
const rowView = (r: any) => ({ id: r.id, value: String(r.value ?? ""), name: String(r.displayValue ?? r.value ?? ""), color: String(r.color ?? "") });

// -- tools -----------------------------------------------------------------------------------

export const jiraBoardManagementTools: ToolDef[] = [
  {
    name: "jira_create_board",
    product: "jira",
    write: true,
    invalidates: [],
    description:
      "Create a Jira Software board (scrum or kanban) on a saved filter: `filter` = filter id or exact name of one of " +
      "this account's favourite filters; optional `project_key` sets the board location. Same name, type and filter → " +
      "already-satisfied; same name otherwise → error. The new board is read back.",
    inputShape: {
      name: z.string().trim().min(1),
      type: z.enum(["scrum", "kanban"]),
      filter: z.coerce.string().min(1).describe("Saved filter id or exact favourite filter name"),
      project_key: z.string().trim().min(1).optional().describe("Project key or id for the board location"),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const filter = await resolveFilter(c, args.filter);
      const summary = `Create ${args.type} board '${args.name}' on filter ${filter.id} '${filter.name}'`;
      const named = await boardsNamed(c, args.name);
      const filters = await Promise.all(named.map(async (b) => Number(((await c.get(`${AGILE}/board/${b.id}/configuration`)) as any)?.filter?.id)));
      const match = named.findIndex((b, i) => b.type === args.type && filters[i] === filter.id);
      if (match >= 0) {
        const b = named[match];
        if (args.project_key) {
          // the requested location must hold too; a location that cannot be read is not assumed to match
          const loc = await boardLocation(c, b);
          const want = String(args.project_key).trim();
          if (!loc) {
            throw new ValidationError(`Board ${b.id} '${b.name}' has this name, type and filter, but its location cannot be read to compare it with '${want}'; check it in Jira or pick another name`);
          }
          if (!eqi(loc.key, want) && loc.id !== want) {
            throw new ValidationError(`Board ${b.id} '${b.name}' already exists with this name, type and filter but location ${loc.key ?? loc.id}, not '${want}'; pick another name or change that board`);
          }
        }
        return alreadySatisfied(summary, `board ${b.id} already has this name, type and filter${args.project_key ? " and location" : ""}`, { id: b.id });
      }
      if (named.length) throw new ValidationError(`Board ${named[0].id} '${named[0].name}' already exists (${named[0].type}, filter ${filters[0]}); pick another name or change that board`);
      const body: Record<string, unknown> = { name: args.name, type: args.type, filterId: filter.id };
      if (args.project_key) body.location = { type: "project", projectKeyOrId: args.project_key };
      const steps: Step[] = [{ method: "POST", path: `${AGILE}/board`, body, label: summary }];
      if (args.dry_run !== false) return planned(c, summary, steps, { identity: { op: "create-board", ...body }, state: { exists: false } });
      const created: any = await send(c, steps[0]);
      const id = Number(created?.id);
      const back: any = id ? await findBoard(c, id) : null;
      const cfg: any = back ? await c.get(`${AGILE}/board/${id}/configuration`) : null;
      const result = { id, name: back?.name, type: back?.type, filterId: Number(cfg?.filter?.id) };
      if (!back || result.name !== args.name || result.type !== args.type || result.filterId !== filter.id) {
        throw new VerificationError(`${summary}: the board does not read back as created`, result);
      }
      return done(c, summary, steps, result);
    },
  },
  {
    name: "jira_delete_board",
    product: "jira",
    write: true,
    invalidates: [],
    description:
      "Delete a Jira Software board and its configuration (columns, swimlanes, quick filters, card colors). " +
      "Irreversible. Issues, the saved filter and the issues' sprint values are not deleted. The dry run names the " +
      "board and what goes with it; already gone → already-satisfied.",
    inputShape: { ...boardShape, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const b = await findBoard(c, args.board_id);
      if (!b) return alreadySatisfied(`Delete board ${args.board_id}`, "no such board");
      let parts = "";
      let filterText = "";
      try {
        const m = await editModel(c, args.board_id);
        const cols = m?.rapidListConfig?.mappedColumns?.length ?? 0;
        const qfs = m?.quickFilterConfig?.quickFilters?.length ?? 0;
        const lanes = (m?.swimlanesConfig?.swimlanes ?? []).filter((l: any) => !l.isDefault).length;
        filterText = m?.filterConfig ? `, filter ${m.filterConfig.id} '${m.filterConfig.name}'` : "";
        parts = `its ${cols} columns, ${qfs} quick filters, ${lanes} query swimlanes and other settings are deleted; `;
      } catch (e) {
        if (!isHttpStatusError(e)) throw e;
      }
      const summary =
        `Delete board ${b.id} '${b.name}' (${b.type}${filterText}) — irreversible: ${parts}` +
        "issues, the saved filter and the issues' sprint values are not deleted";
      const steps: Step[] = [{ method: "DELETE", path: `${AGILE}/board/${b.id}`, label: `delete board ${b.id}` }];
      if (args.dry_run !== false) return planned(c, summary, steps, { identity: { op: "delete-board", board: b.id, name: b.name }, state: { exists: true } });
      await send(c, steps[0]);
      if (await findBoard(c, b.id)) throw new VerificationError(`${summary}: the board still exists after the delete`);
      return done(c, summary, steps, { deleted: { id: b.id, name: b.name } });
    },
  },
  {
    name: "jira_set_board_filter",
    product: "jira",
    write: true,
    invalidates: [],
    description:
      `Switch a board's saved filter (filter id or exact favourite filter name). Board admin; ${INTERNAL}. The filter is read back.`,
    inputShape: { ...boardShape, filter: z.coerce.string().min(1).describe("Saved filter id or exact favourite filter name"), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const m = await editableModel(c, args.board_id, "Board filter changes");
      const filter = await resolveFilter(c, args.filter);
      const before = { id: Number(m?.filterConfig?.id), name: m?.filterConfig?.name };
      const summary = `Board ${args.board_id} filter: ${before.id} '${before.name}' → ${filter.id} '${filter.name}'`;
      if (before.id === filter.id) return alreadySatisfied(`Board ${args.board_id} filter`, `the board already uses filter ${filter.id}`);
      const steps: Step[] = [{ method: "PUT", path: `${GH}/rapidviewconfig/filter`, body: { id: args.board_id, savedFilterId: filter.id }, label: summary }];
      if (args.dry_run !== false) return planned(c, summary, steps, { before, after: filter, identity: { op: "board-filter", board: args.board_id, filter: filter.id }, state: before.id });
      await send(c, steps[0]);
      const back = Number((await editModel(c, args.board_id))?.filterConfig?.id);
      if (back !== filter.id) throw new VerificationError(`${summary}: the board reads back filter ${back}`, { expected: filter.id, actual: back });
      return done(c, summary, steps, { filter });
    },
  },
  {
    name: "jira_get_board_columns",
    product: "jira",
    description:
      "A board's columns in order with ids, min/max and mapped statuses (id, name, category), the statuses of the " +
      "board's workflows that no column shows, and the column constraint (none, issueCount, issueCountExclSubs).",
    inputShape: boardShape,
    async handler({ client }, args) {
      const m = await editModel(client("jira"), args.board_id);
      const l = m?.rapidListConfig ?? {};
      return {
        board: { id: args.board_id, name: m?.name },
        canEdit: !!l.canEdit,
        constraint: constraintName(l.currentStatisticsField?.id),
        columns: (l.mappedColumns ?? []).map((col: any) => ({
          id: col.id,
          name: col.name,
          min: limit(col.min),
          max: limit(col.max),
          ...(col.isKanPlanColumn ? { kanbanBacklog: true } : {}),
          statuses: (col.mappedStatuses ?? []).map(statusView),
        })),
        unmappedStatuses: (l.unmappedStatuses ?? []).map(statusView),
      };
    },
  },
  {
    name: "jira_set_board_columns",
    product: "jira",
    write: true,
    invalidates: [],
    description:
      "Set a board's columns: `columns` = complete ordered JSON list of {id?, name, statuses:[status id or exact name], min?, max?} " +
      "(min/max omitted keep the value of the same-named column, null clears). Every status must belong to the board's " +
      "workflows and appear in at most one column; a currently mapped status left out is refused unless allow_unmapped=true. " +
      `Columns keep their ids (explicit id, else the first unused column of the same name). Optional constraint: none | issueCount | issueCountExclSubs. Board admin; ${INTERNAL}.`,
    inputShape: {
      ...boardShape,
      columns: jsonArg(z.array(columnSpec).min(1), COLUMNS_EXAMPLE),
      constraint: z.enum(CONSTRAINTS).optional(),
      allow_unmapped: boolArg.optional().describe("Allow statuses that are mapped now to become unmapped"),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const m = await editableModel(c, args.board_id, "Board column changes", "rapidListConfig");
      const l = m?.rapidListConfig ?? {};
      const current: any[] = l.mappedColumns ?? [];
      const known = [...current.flatMap((col) => col.mappedStatuses ?? []), ...(l.unmappedStatuses ?? [])].map(statusView);
      const nameOf = (id: string) => known.find((s) => s.id === id)?.name ?? id;
      const resolve = (g: string) => {
        const hit = pickByIdOrName(known, g, "Status");
        if (!hit) throw new ValidationError(`Status '${g}' is not in the board's workflows (known: ${known.slice(0, 30).map((s) => s.name).join(", ")}${known.length > 30 ? ", …" : ""})`);
        return hit.id;
      };
      const spec: Array<z.infer<typeof columnSpec>> = args.columns;
      const seen = new Map<string, string>();
      // Jira allows several columns with one name: an explicit id wins, otherwise the first unused same-named column
      const used = new Set<number>();
      for (const col of spec) {
        if (col.id === undefined) continue;
        if (!current.some((x) => Number(x.id) === col.id)) throw new ValidationError(`Column id ${col.id} is not a column of board ${args.board_id}`);
        if (used.has(col.id)) throw new ValidationError(`Column id ${col.id} is given twice`);
        used.add(col.id);
      }
      const target = spec.map((col) => {
        const ex = col.id !== undefined ? current.find((x) => Number(x.id) === col.id) : current.find((x) => !used.has(Number(x.id)) && eqi(x.name, col.name));
        if (ex && col.id === undefined) used.add(Number(ex.id));
        const ids = col.statuses.map(resolve);
        for (const id of ids) {
          if (seen.has(id)) throw new ValidationError(`Status '${nameOf(id)}' is in more than one column ('${seen.get(id)}' and '${col.name}')`);
          seen.set(id, col.name);
        }
        const min = col.min === undefined ? limit(ex?.min) : col.min;
        const max = col.max === undefined ? limit(ex?.max) : col.max;
        if (min !== null && max !== null && min > max) throw new ValidationError(`Column '${col.name}': min ${min} is greater than max ${max}`);
        return { ...(ex ? { id: ex.id } : {}), name: col.name, min: min === null ? "" : String(min), max: max === null ? "" : String(max), isKanPlanColumn: !!ex?.isKanPlanColumn, mappedStatuses: ids.map((id) => ({ id })) };
      });
      const constraint = args.constraint ?? constraintName(l.currentStatisticsField?.id);
      const body = { rapidViewId: args.board_id, currentStatisticsField: { id: `${constraint}_` }, mappedColumns: target };
      const before = columnsView(l);
      const after = columnsView(body);
      const mappedNow = new Set(before.columns.flatMap((col: any) => col.statuses as string[]));
      const unmappedAfter = known.filter((s) => !seen.has(s.id));
      const dropped = unmappedAfter.filter((s) => mappedNow.has(s.id));
      if (dropped.length && args.allow_unmapped !== true) {
        throw new ValidationError(`These statuses are mapped now and would become unmapped: ${dropped.map((s) => s.name).join(", ")}; add them to a column or pass allow_unmapped=true`);
      }
      const show = (v: ReturnType<typeof columnsView>) => ({ constraint: v.constraint, columns: v.columns.map((col: any) => ({ ...col, statuses: col.statuses.map(nameOf) })) });
      if (same(before, after)) return alreadySatisfied(`Columns of board ${args.board_id}`, "the columns already match");
      const summary = `Columns of board ${args.board_id}: ${before.columns.map((x: any) => x.name).join(", ")} → ${after.columns.map((x: any) => x.name).join(", ")}`;
      const steps: Step[] = [{ method: "PUT", path: `${GH}/rapidviewconfig/columns`, body, label: summary }];
      if (args.dry_run !== false) {
        return planned(c, summary, steps, { before: show(before), after: show(after), unmappedAfter: unmappedAfter.map((s) => s.name), identity: { op: "board-columns", board: args.board_id, ...after }, state: before });
      }
      await send(c, steps[0]);
      const back = columnsView((await editModel(c, args.board_id))?.rapidListConfig);
      if (!same(back, after)) throw new VerificationError(`${summary}: the columns read back differently`, { expected: show(after), actual: show(back) });
      return done(c, summary, steps, show(back));
    },
  },
  {
    name: "jira_get_board_swimlanes",
    product: "jira",
    description: "A board's swimlane strategy and its query swimlanes in order (id, name, JQL, description, default lane).",
    inputShape: boardShape,
    async handler({ client }, args) {
      const m = await editModel(client("jira"), args.board_id);
      const sw = m?.swimlanesConfig ?? {};
      return {
        board: { id: args.board_id, name: m?.name },
        canEdit: !!sw.canEdit,
        strategy: sw.swimlaneStrategy,
        strategies: SWIMLANE_STRATEGIES,
        lanes: (sw.swimlanes ?? []).map((x: any) => ({ id: x.id, ...laneView(x), isDefault: !!x.isDefault })),
      };
    },
  },
  {
    name: "jira_set_board_swimlanes",
    product: "jira",
    write: true,
    invalidates: [],
    description:
      `Set a board's swimlane strategy (${SWIMLANE_STRATEGIES.join(", ")}) and/or its query swimlanes (custom strategy only): \`lanes\` = complete ` +
      "ordered JSON list of {name, query, description?}. Lanes are matched by name (missing ones deleted, changed ones updated, " +
      `new ones created, then ordered); the default lane stays last. Board admin; ${INTERNAL}. Read back after the change.`,
    inputShape: {
      ...boardShape,
      strategy: z.enum(SWIMLANE_STRATEGIES).optional(),
      lanes: jsonArg(z.array(laneSpec), LANES_EXAMPLE).optional(),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      if (!args.strategy && !args.lanes) throw new ValidationError("Pass strategy and/or lanes");
      const c = client("jira");
      const m = await editableModel(c, args.board_id, "Board swimlane changes", "swimlanesConfig");
      const sw = m?.swimlanesConfig ?? {};
      const all: any[] = sw.swimlanes ?? [];
      const lanes = all.filter((x) => !x.isDefault);
      const defaults = all.filter((x) => x.isDefault);
      const spec: Array<z.infer<typeof laneSpec>> | undefined = args.lanes;
      if (spec) {
        // query swimlanes only take effect with the custom strategy
        const resulting = args.strategy ?? sw.swimlaneStrategy;
        if (resulting !== "custom") {
          throw new ValidationError(`Query lanes apply only to the custom swimlane strategy; the board would use '${resulting}'. Pass strategy=custom with lanes, or change only the strategy`);
        }
        const names = spec.map((s) => s.name.toLowerCase());
        if (new Set(names).size !== names.length) throw new ValidationError("Two lanes have the same name");
        if (spec.some((s) => defaults.some((d) => eqi(d.name, s.name)))) throw new ValidationError("A lane has the name of the default lane, which cannot be changed here");
      }
      const steps: Step[] = [];
      if (args.strategy && args.strategy !== sw.swimlaneStrategy) {
        steps.push({ method: "PUT", path: `${GH}/rapidviewconfig/swimlaneStrategy`, body: { id: args.board_id, swimlaneStrategyId: args.strategy }, label: `strategy ${sw.swimlaneStrategy} → ${args.strategy}` });
      }
      const target = spec?.map((s) => {
        const ex = lanes.find((x) => eqi(x.name, s.name));
        return { ex, view: { name: s.name, query: s.query, description: s.description ?? (ex ? String(ex.description ?? "") : "") } };
      });
      const lanePath = (id: unknown) => `${GH}/swimlanes/${args.board_id}/${id}`;
      if (target) {
        for (const x of lanes.filter((l) => !target.some((t) => t.ex === l))) steps.push({ method: "DELETE", path: lanePath(x.id), label: `delete lane '${x.name}'` });
        for (const t of target.filter((t) => t.ex && !same(laneView(t.ex), t.view))) steps.push({ method: "PUT", path: lanePath(t.ex.id), body: { id: t.ex.id, ...t.view }, label: `update lane '${t.view.name}'` });
        for (const t of target.filter((t) => !t.ex)) steps.push({ method: "POST", path: `${GH}/swimlanes/${args.board_id}`, body: t.view, label: `create lane '${t.view.name}'` });
      }
      const order = target?.map((t) => t.view.name.toLowerCase());
      const keptOrder = lanes.filter((l) => target?.some((t) => t.ex === l)).map((l) => String(l.name).toLowerCase());
      const afterAdd = order ? [...keptOrder, ...order.filter((n) => !keptOrder.includes(n))] : [];
      const moves = order ? plannedMoves(afterAdd, order) : [];
      for (const mv of moves) steps.push({ method: "POST", path: `${GH}/swimlanes/${args.board_id}/{${mv.id}}/move`, body: mv.after ? { after: `{${mv.after}}` } : { position: "First" }, label: `move lane '${mv.id}' ${mv.after ? `after '${mv.after}'` : "first"}` });

      const before = { strategy: sw.swimlaneStrategy, lanes: all.map((x) => x.name) };
      const after = { strategy: args.strategy ?? sw.swimlaneStrategy, lanes: target ? [...target.map((t) => t.view.name), ...defaults.map((d) => d.name)] : before.lanes };
      const wantLanes = target?.map((t) => t.view);
      const summary = `Swimlanes of board ${args.board_id}: ${before.strategy} [${before.lanes.join(", ")}] → ${after.strategy} [${after.lanes.join(", ")}]`;
      if (!steps.length) return alreadySatisfied(`Swimlanes of board ${args.board_id}`, "the strategy and lanes already match");
      if (args.dry_run !== false) {
        return planned(c, summary, steps, { before, after, identity: { op: "board-swimlanes", board: args.board_id, strategy: args.strategy ?? null, lanes: wantLanes ?? null }, state: { strategy: sw.swimlaneStrategy, lanes: all.map(laneView) } });
      }
      // structural steps first; moves need the ids of new lanes, so they are computed from a fresh read
      for (const s of steps.filter((s) => !s.path.endsWith("/move"))) await send(c, s);
      if (order) {
        let cur = ((await editModel(c, args.board_id))?.swimlanesConfig?.swimlanes ?? []).filter((x: any) => !x.isDefault);
        for (const mv of plannedMoves(cur.map((x: any) => String(x.name).toLowerCase()), order)) {
          const row = cur.find((x: any) => eqi(x.name, mv.id));
          const prev = mv.after ? cur.find((x: any) => eqi(x.name, mv.after)) : undefined;
          if (!row || (mv.after && !prev)) break;
          await c.request("POST", `${lanePath(row.id)}/move`, { json: prev ? { after: rowUrl(c, lanePath(prev.id)) } : { position: "First" } });
          cur = ((await editModel(c, args.board_id))?.swimlanesConfig?.swimlanes ?? []).filter((x: any) => !x.isDefault);
        }
      }
      const back = (await editModel(c, args.board_id))?.swimlanesConfig ?? {};
      const backLanes = (back.swimlanes ?? []).filter((x: any) => !x.isDefault).map(laneView);
      if (back.swimlaneStrategy !== after.strategy || (wantLanes && !same(backLanes, wantLanes))) {
        throw new VerificationError(`${summary}: the swimlanes read back differently`, { expected: { strategy: after.strategy, lanes: wantLanes }, actual: { strategy: back.swimlaneStrategy, lanes: backLanes } });
      }
      return done(c, summary, steps, { strategy: back.swimlaneStrategy, lanes: (back.swimlanes ?? []).map((x: any) => ({ id: x.id, ...laneView(x), isDefault: !!x.isDefault })) });
    },
  },
  {
    name: "jira_get_board_quick_filters",
    product: "jira",
    description: "A board's quick filters in order: id, name, JQL, description.",
    inputShape: { ...boardShape, ...pageShape(50) },
    async handler({ client }, args) {
      const qf = await quickFilters(client("jira"), args.board_id);
      return { canEdit: qf.canEdit, ...paginate(qf.items, args, 50) };
    },
  },
  {
    name: "jira_create_board_quick_filter",
    product: "jira",
    write: true,
    invalidates: [],
    description: `Add a quick filter (name, JQL, description) to a board. Same name and JQL → already-satisfied; same name otherwise → error. Board admin; ${INTERNAL}.`,
    inputShape: { ...boardShape, name: z.string().trim().min(1), query: z.string().trim().min(1), description: z.string().optional(), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const qf = await editableQuickFilters(c, args.board_id);
      const summary = `Create quick filter '${args.name}' on board ${args.board_id}`;
      const ex = qf.items.find((q) => eqi(q.name, args.name));
      if (ex && ex.query === args.query && (args.description === undefined || ex.description === args.description)) return alreadySatisfied(summary, `quick filter ${ex.id} already has this JQL`, { id: ex.id });
      if (ex) throw new ValidationError(`Quick filter ${ex.id} '${ex.name}' already exists with other settings; use jira_update_board_quick_filter`);
      const body = { name: args.name, query: args.query, description: args.description ?? "" };
      const steps: Step[] = [{ method: "POST", path: `${GH}/quickfilters/${args.board_id}`, body, label: summary }];
      if (args.dry_run !== false) return planned(c, summary, steps, { identity: { op: "create-quick-filter", board: args.board_id, ...body }, state: { exists: false } });
      await send(c, steps[0]);
      const back = (await quickFilters(c, args.board_id)).items.find((q) => q.name === args.name);
      if (!back || back.query !== body.query || back.description !== body.description) throw new VerificationError(`${summary}: the quick filter does not read back as created`, back);
      return done(c, summary, steps, back);
    },
  },
  {
    name: "jira_update_board_quick_filter",
    product: "jira",
    write: true,
    invalidates: [],
    description: `Change a board quick filter's name, JQL and/or description (quick filter id or exact name). The dry run shows old and new values. Board admin; ${INTERNAL}.`,
    inputShape: {
      ...boardShape,
      quick_filter: z.coerce.string().min(1).describe("Quick filter id or exact name"),
      name: z.string().trim().min(1).optional(),
      query: z.string().trim().min(1).optional(),
      description: z.string().optional(),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      if (args.name === undefined && args.query === undefined && args.description === undefined) throw new ValidationError("Nothing to update: pass name, query and/or description");
      const c = client("jira");
      const qf = await editableQuickFilters(c, args.board_id);
      const q = pickByIdOrName(qf.items, args.quick_filter, "Quick filter");
      if (!q) throw new ValidationError(`No quick filter '${args.quick_filter}' on board ${args.board_id}`);
      if (args.name && !eqi(args.name, q.name) && qf.items.some((x) => x.id !== q.id && eqi(x.name, args.name))) throw new ValidationError(`Another quick filter is already named '${args.name}'`);
      const before = { name: q.name, query: q.query, description: q.description };
      const after = { name: args.name ?? q.name, query: args.query ?? q.query, description: args.description ?? q.description };
      const summary = `Update quick filter ${q.id} '${q.name}' on board ${args.board_id}`;
      if (same(before, after)) return alreadySatisfied(summary, "it already has these settings");
      const steps: Step[] = [{ method: "PUT", path: `${GH}/quickfilters/${args.board_id}/${q.id}`, body: { id: q.id, ...after }, label: summary }];
      if (args.dry_run !== false) return planned(c, summary, steps, { before, after, identity: { op: "update-quick-filter", board: args.board_id, quickFilter: args.quick_filter, ...after }, state: before });
      await send(c, steps[0]);
      const back = (await quickFilters(c, args.board_id)).items.find((x) => x.id === q.id);
      if (!back || !same({ name: back.name, query: back.query, description: back.description }, after)) throw new VerificationError(`${summary}: the quick filter does not read back as updated`, back);
      return done(c, summary, steps, back);
    },
  },
  {
    name: "jira_delete_board_quick_filter",
    product: "jira",
    write: true,
    invalidates: [],
    description: `Delete a board quick filter (id or exact name). Already gone → already-satisfied. Board admin; ${INTERNAL}.`,
    inputShape: { ...boardShape, quick_filter: z.coerce.string().min(1).describe("Quick filter id or exact name"), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const qf = await editableQuickFilters(c, args.board_id);
      const q = pickByIdOrName(qf.items, args.quick_filter, "Quick filter");
      if (!q) return alreadySatisfied(`Delete quick filter '${args.quick_filter}' on board ${args.board_id}`, "no such quick filter");
      const summary = `Delete quick filter ${q.id} '${q.name}' (${q.query}) on board ${args.board_id}`;
      const steps: Step[] = [{ method: "DELETE", path: `${GH}/quickfilters/${args.board_id}/${q.id}`, label: summary }];
      if (args.dry_run !== false) return planned(c, summary, steps, { identity: { op: "delete-quick-filter", board: args.board_id, quickFilter: args.quick_filter }, state: { exists: true, id: q.id, query: q.query } });
      await send(c, steps[0]);
      if ((await quickFilters(c, args.board_id)).items.some((x) => x.id === q.id)) throw new VerificationError(`${summary}: the quick filter still exists`);
      return done(c, summary, steps, { deleted: { id: q.id, name: q.name } });
    },
  },
  {
    name: "jira_get_board_card_colors",
    product: "jira",
    description: "A board's card color strategy (issuetype, priority, assignee, custom, none) and its colors: id, value (id or JQL), name, color.",
    inputShape: { ...boardShape, ...pageShape(100) },
    async handler({ client }, args) {
      const c = client("jira");
      const m = await editModel(c, args.board_id);
      const strategy = String(m?.cardColorConfig?.cardColorStrategy ?? "none");
      const rows = (await cardRows(c, args.board_id, strategy)).map(rowView);
      return { canEdit: !!m?.cardColorConfig?.canEdit, strategy, ...paginate(rows, args, 100) };
    },
  },
  {
    name: "jira_set_board_card_colors",
    product: "jira",
    write: true,
    invalidates: [],
    description:
      `Set a board's card color strategy (${CARD_STRATEGIES.join(", ")}) and/or colors: \`colors\` = JSON list of {value, color:"#rrggbb"}. ` +
      "For issuetype/priority/assignee, value is the id or exact name and only named rows change. For custom, colors is " +
      `the complete list of JQL rows (missing rows deleted; order is not changed). Board admin; ${INTERNAL}. Read back after the change.`,
    inputShape: {
      ...boardShape,
      strategy: z.enum(CARD_STRATEGIES).optional(),
      colors: jsonArg(z.array(colorSpec), COLORS_EXAMPLE).optional(),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      if (!args.strategy && !args.colors) throw new ValidationError("Pass strategy and/or colors");
      const c = client("jira");
      const m = await editableModel(c, args.board_id, "Board card color changes", "cardColorConfig");
      const current = String(m?.cardColorConfig?.cardColorStrategy ?? "none");
      const strategy: string = args.strategy ?? current;
      const colors: Array<z.infer<typeof colorSpec>> | undefined = args.colors;
      if (strategy === "none" && colors?.length) throw new ValidationError("The none strategy has no colors");
      const rows = await cardRows(c, args.board_id, strategy);
      const colorPath = (id?: unknown) => `${GH}/cardcolors/${args.board_id}/color${id === undefined ? "" : `/${id}`}`;
      /** Row changes against a list of rows; returns steps and the expected value → color map. */
      const planRows = (list: any[]) => {
        const steps: Step[] = [];
        const want = new Map<string, string>();
        if (!colors) return { steps, want };
        if (strategy === "custom") {
          const values = colors.map((x) => x.value);
          if (new Set(values).size !== values.length) throw new ValidationError("A JQL value appears more than once");
          for (const r of list.filter((r) => !values.includes(String(r.value).trim()))) steps.push({ method: "DELETE", path: colorPath(r.id), label: `delete color for '${r.value}'` });
          for (const x of colors) {
            const r = list.find((r) => String(r.value).trim() === x.value);
            want.set(x.value, x.color.toLowerCase());
            if (!r) steps.push({ method: "POST", path: colorPath(), body: { strategy: "custom", value: x.value, color: x.color }, label: `add ${x.color} for '${x.value}'` });
            else if (!eqi(r.color, x.color)) steps.push({ method: "PUT", path: colorPath(r.id), body: { id: r.id, strategy, value: r.value, displayValue: r.displayValue, color: x.color }, label: `'${x.value}' ${r.color} → ${x.color}` });
          }
          return { steps, want };
        }
        for (const x of colors) {
          const r = list.find((r) => String(r.value) === x.value) ?? list.find((r) => eqi(r.displayValue, x.value));
          if (!r) throw new ValidationError(`'${x.value}' is not a ${strategy} value of this board's card colors (known: ${list.slice(0, 20).map((r) => r.displayValue ?? r.value).join(", ")}${list.length > 20 ? ", …" : ""})`);
          want.set(String(r.value), x.color.toLowerCase());
          if (!eqi(r.color, x.color)) steps.push({ method: "PUT", path: colorPath(r.id), body: { id: r.id, strategy, value: r.value, displayValue: r.displayValue, color: x.color }, label: `${r.displayValue ?? r.value} ${r.color} → ${x.color}` });
        }
        return { steps, want };
      };
      const strategyStep: Step[] = strategy !== current ? [{ method: "PUT", path: `${GH}/cardcolors/${args.board_id}/strategy`, body: { id: args.board_id, cardColorStrategyId: strategy }, label: `strategy ${current} → ${strategy}` }] : [];
      const { steps: rowSteps, want } = planRows(rows);
      const steps = [...strategyStep, ...rowSteps];
      const summary = `Card colors of board ${args.board_id}: ${strategy !== current ? `${current} → ${strategy}, ` : ""}${rowSteps.length} color change(s)`;
      if (!steps.length) return alreadySatisfied(`Card colors of board ${args.board_id}`, "the strategy and colors already match");
      if (args.dry_run !== false) {
        return planned(c, summary, steps, { before: { strategy: current }, after: { strategy, colors: Object.fromEntries(want) }, identity: { op: "board-card-colors", board: args.board_id, strategy, colors: colors ?? null }, state: { strategy: current, rows: rows.map(rowView) } });
      }
      for (const s of strategyStep) await send(c, s);
      // row ids are taken from a fresh read once the strategy is active
      const fresh = strategyStep.length ? planRows(await cardRows(c, args.board_id, strategy)).steps : rowSteps;
      for (const s of fresh) await send(c, s);
      const backStrategy = String((await editModel(c, args.board_id))?.cardColorConfig?.cardColorStrategy ?? "none");
      const backRows = await cardRows(c, args.board_id, strategy);
      const mismatch = [...want].filter(([v, col]) => !backRows.some((r) => String(r.value).trim() === v && eqi(r.color, col)));
      const extra = strategy === "custom" && colors ? backRows.filter((r) => !want.has(String(r.value).trim())) : [];
      if (backStrategy !== strategy || mismatch.length || extra.length) {
        throw new VerificationError(`${summary}: the card colors read back differently`, { strategy: backStrategy, mismatched: mismatch.map(([v]) => v), unexpected: extra.map((r) => r.value) });
      }
      return done(c, summary, [...strategyStep, ...fresh], { strategy: backStrategy, colors: backRows.map(rowView) });
    },
  },
];
