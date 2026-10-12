/**
 * Compare two local Jira configuration snapshots written by jira_export_config.
 *
 * Purely local: no Jira request is made. Each component is flattened into items keyed by stable
 * identities (array elements by `key`, `id`, `fieldId` or `name`; top-level areas by property
 * name), so reordering by the server does not show as a difference while a changed `position`
 * does. Output is bounded: item and field lists are capped with totals, strings are shortened to a
 * preview, and hidden preset values are never printed. Schema v1 (request forms only) is read
 * through a compatibility view of schema v2.
 */
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { z } from "zod";
import { ValidationError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { listArg } from "../util.js";
import { COMPONENT_KEYS, COMPONENTS, SNAPSHOT_KIND } from "./configSnapshot.js";

type Leaf = string | number | boolean | null;
interface Snapshot {
  schemaVersion: number;
  capturedAt: string | null;
  baseUrl: string | null;
  scope: { serviceDeskId: string | null; projectKey: string | null; components: string[] };
  components: Record<string, any>;
}

const SUPPORTED = [1, 2];
const MAX_FILE_BYTES = 210 * 1024 * 1024;
const PREVIEW = 60;
const KEY_PREVIEW = 80;
const HIDDEN = "[hidden]";
const ROOT = "";
const NAMES: Record<string, string> = Object.fromEntries(Object.entries(COMPONENT_KEYS).map(([name, key]) => [key, name]));
const isObject = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === "string" || typeof v === "number" ? String(v) : null);

/** Shorten long text to a preview; never return a long value verbatim. */
function preview(value: Leaf, max = PREVIEW): Leaf {
  if (typeof value !== "string" || value.length <= max) return value;
  return `${value.slice(0, max)}…(+${value.length - max} chars)`;
}
/** Component whose `values` (hidden preset values of form rows) are never printed, only reported as changed. */
const FORMS_KEY = "requestTypeForms";
/** A `values` field relative to its item: always an opaque digest leaf (see flatten), never shown. */
const sensitive = (field: string) => /(^|\.)values$/.test(field) || field.startsWith("values.") || field.startsWith("values[");
/** Opaque stand-in for a hidden preset value: a digest, so changes are detected without keeping the content. */
const opaque = (value: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex")}`;

async function load(label: string, path: string): Promise<Snapshot> {
  let raw: string;
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw new ValidationError(`${label}: not a regular file`);
    if (info.size > MAX_FILE_BYTES) throw new ValidationError(`${label}: file exceeds ${MAX_FILE_BYTES} bytes`);
    raw = await readFile(path, "utf8");
  } catch (e) {
    if (e instanceof ValidationError) throw e;
    throw new ValidationError(`${label}: cannot read the file (${(e as NodeJS.ErrnoException).code ?? "error"})`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new ValidationError(`${label}: not a JSON file`);
  }
  if (!isObject(data) || typeof data.schemaVersion !== "number" || !isObject(data.components) || !isObject(data.scope)) {
    throw new ValidationError(`${label}: not a Jira configuration snapshot`);
  }
  if (!SUPPORTED.includes(data.schemaVersion)) {
    throw new ValidationError(`${label}: unsupported snapshot schemaVersion ${data.schemaVersion} (supported: ${SUPPORTED.join(", ")})`);
  }
  const scope = data.scope;
  if (data.schemaVersion === 1) {
    // v1 held only request forms; its form coverage was the snapshot coverage
    const forms = data.components.requestTypeForms;
    if (!isObject(forms) || !Array.isArray(forms.requestTypes)) throw new ValidationError(`${label}: not a Jira configuration snapshot`);
    const status = data.coverage?.status === "COMPLETE" ? "COMPLETE" : "PARTIAL";
    return {
      schemaVersion: 1, capturedAt: text(data.capture?.start), baseUrl: text(data.source?.baseUrl),
      scope: { serviceDeskId: text(scope.serviceDeskId), projectKey: text(scope.projectKey), components: ["request-type-forms"] },
      components: { requestTypeForms: { status, ...forms } },
    };
  }
  if (data.kind !== SNAPSHOT_KIND || !Array.isArray(scope.components)) throw new ValidationError(`${label}: not a Jira configuration snapshot`);
  return {
    schemaVersion: 2, capturedAt: text(data.capture?.start), baseUrl: text(data.source?.baseUrl),
    scope: { serviceDeskId: text(scope.serviceDeskId), projectKey: text(scope.projectKey), components: scope.components.map(String) },
    components: data.components,
  };
}

interface Flat {
  items: Map<string, Map<string, Leaf>>;
  parent: Map<string, string>;
}

function identity(el: Record<string, any>): string | null {
  for (const k of ["key", "id", "fieldId", "name"]) {
    const v = text(el[k]);
    if (v !== null) return v.length > KEY_PREVIEW ? `${v.slice(0, KEY_PREVIEW)}…` : v;
  }
  return null;
}

/**
 * Items (objects with a stable identity) and their leaf fields, relative to the owning item. With `opaqueValues`,
 * every `values` property is stored as one digest leaf and never walked, so no part of it becomes a key, a name
 * preview or a printed field.
 */
function flatten(component: unknown, opaqueValues = false): Flat {
  const items = new Map<string, Map<string, Leaf>>([[ROOT, new Map()]]);
  const parent = new Map<string, string>();
  const set = (item: string, path: string, value: Leaf) => {
    const field = item === ROOT ? path : path.slice(item.length).replace(/^\./, "");
    items.get(item)!.set(field || "(value)", value);
  };
  const open = (path: string, owner: string) => {
    items.set(path, new Map());
    parent.set(path, owner);
  };
  const walk = (value: unknown, path: string, item: string): void => {
    if (Array.isArray(value)) {
      if (value.every(v => v === null || typeof v !== "object")) return set(item, path, JSON.stringify(value));
      const seen = new Map<string, number>();
      value.forEach((el, i) => {
        if (!isObject(el)) return walk(el, `${path}[${i}]`, item);
        let id = identity(el) ?? String(i);
        const n = (seen.get(id) ?? 0) + 1;
        seen.set(id, n);
        if (n > 1) id = `${id}#${n}`;
        const child = `${path}[${id}]`;
        open(child, item);
        walk(el, child, child);
      });
      return;
    }
    if (isObject(value)) {
      const keys = Object.keys(value).sort();
      if (!keys.length) return set(item, path, "{}");
      for (const k of keys) {
        const p = path ? `${path}.${k}` : k;
        if (opaqueValues && k === "values") {
          set(item, p, opaque(value[k]));
          continue;
        }
        // top-level areas of a component (a scheme, the sources) are items of their own
        if (path === ROOT && isObject(value[k])) {
          open(p, ROOT);
          walk(value[k], p, p);
        } else walk(value[k], p, item);
      }
      return;
    }
    set(item, path, (value ?? null) as Leaf);
  };
  walk(component, ROOT, ROOT);
  return { items, parent };
}

function hasAncestor(key: string, flat: Flat, test: (k: string) => boolean): boolean {
  for (let p = flat.parent.get(key); p !== undefined && p !== ROOT; p = flat.parent.get(p)) if (test(p)) return true;
  return false;
}
const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function capped<T>(all: T[], max: number) {
  return { total: all.length, items: all.slice(0, max), ...(all.length > max ? { truncated: true } : {}) };
}

function compare(before: unknown, after: unknown, maxItems: number, maxFields: number, opaqueValues: boolean) {
  const a = flatten(before, opaqueValues), b = flatten(after, opaqueValues);
  const only = (x: Flat, y: Flat) => [...x.items.keys()]
    .filter(k => !y.items.has(k) && !hasAncestor(k, x, p => !y.items.has(p)))
    .sort(byString)
    .map(k => {
      const name = x.items.get(k)!.get("name");
      return typeof name === "string" ? { key: k, name: preview(name) } : { key: k };
    });
  const added = only(b, a);
  const removed = only(a, b);
  const changed: Array<Record<string, unknown>> = [];
  for (const key of [...a.items.keys()].filter(k => b.items.has(k)).sort(byString)) {
    const x = a.items.get(key)!, y = b.items.get(key)!;
    const fields: Array<{ field: string; before: Leaf; after: Leaf }> = [];
    let hidden = false;
    for (const field of [...new Set([...x.keys(), ...y.keys()])].sort(byString)) {
      const p = x.has(field) ? x.get(field)! : null, q = y.has(field) ? y.get(field)! : null;
      if (p === q && x.has(field) === y.has(field)) continue;
      if (sensitive(field)) hidden = true;
      else fields.push({ field, before: preview(p), after: preview(q) });
    }
    if (hidden) fields.push({ field: "values", before: HIDDEN, after: HIDDEN });
    if (!fields.length) continue;
    fields.sort((m, n) => byString(m.field, n.field));
    changed.push({ key: key || "(component)", fields: fields.slice(0, maxFields), ...(fields.length > maxFields ? { fieldsTotal: fields.length } : {}) });
  }
  return { added: capped(added, maxItems), removed: capped(removed, maxItems), changed: capped(changed, maxItems) };
}

const describeSide = (path: string, s: Snapshot) => ({ path, schemaVersion: s.schemaVersion, capturedAt: s.capturedAt, scope: s.scope });

export const jiraConfigDiffTools: ToolDef[] = [{
  name: "jira_diff_config",
  product: "jira",
  description:
    "Compare two local snapshots from jira_export_config (schema v1 or v2): per component, added/removed items by stable key and " +
    "changed items with field-level before→after, capped with totals. Local files only (no Jira request); long text is shortened " +
    "and hidden preset values are never printed. identical is false when a component is in one snapshot only, null when a " +
    "requested component is in neither.",
  inputShape: {
    before: z.string().min(1).describe("Path of the earlier snapshot file"),
    after: z.string().min(1).describe("Path of the later snapshot file"),
    components: listArg.pipe(z.array(z.enum(COMPONENTS)).min(1)).optional().describe(`Only these components, comma-separated: ${COMPONENTS.join(", ")}`),
    max_items: z.coerce.number().int().min(1).max(500).default(25).describe("Items listed per added/removed/changed list (totals are always given)"),
    max_fields: z.coerce.number().int().min(1).max(100).default(10).describe("Changed fields listed per item"),
  },
  async handler(_ctx, args) {
    const [before, after] = [await load("before", args.before), await load("after", args.after)];
    const warnings: string[] = [];
    if (before.scope.serviceDeskId !== after.scope.serviceDeskId || before.scope.projectKey !== after.scope.projectKey) {
      warnings.push(`Snapshots have different scopes (before ${before.scope.projectKey ?? "-"}/${before.scope.serviceDeskId ?? "-"}, after ${after.scope.projectKey ?? "-"}/${after.scope.serviceDeskId ?? "-"}); ids may differ between them`);
    }
    if (before.baseUrl && after.baseUrl && before.baseUrl !== after.baseUrl) warnings.push("Snapshots come from different instances; ids may differ between them");
    const wanted = args.components ? new Set((args.components as string[]).map(c => COMPONENT_KEYS[c as keyof typeof COMPONENT_KEYS])) : undefined;
    const keys = [...new Set([...Object.keys(before.components), ...Object.keys(after.components)])].filter(k => !wanted || wanted.has(k)).sort(byString);
    const components: Record<string, unknown> = {};
    // components that cannot be compared: present on one side only (a difference) or in neither file (undecided)
    let oneSided = false;
    const neither = wanted ? [...wanted].filter(k => !(k in before.components) && !(k in after.components)).sort(byString) : [];
    for (const key of neither) {
      warnings.push(`Component ${NAMES[key] ?? key} was requested but is in neither snapshot`);
      components[key] = { captured: "neither", status: { before: null, after: null } };
    }
    const summary = { added: 0, removed: 0, changed: 0 };
    for (const key of keys) {
      const name = NAMES[key] ?? key;
      const x = before.components[key], y = after.components[key];
      const status = { before: isObject(x) ? (x.status ?? null) : null, after: isObject(y) ? (y.status ?? null) : null };
      if (x === undefined || y === undefined) {
        const side = x === undefined ? "after" : "before";
        warnings.push(`Component ${name} was captured only in the ${side} snapshot`);
        components[key] = { captured: `${side}-only`, status };
        oneSided = true;
        continue;
      }
      if (status.before !== status.after) {
        warnings.push(`Component ${name} coverage differs (before ${status.before ?? "unknown"}, after ${status.after ?? "unknown"}); unavailable areas can show as differences`);
      } else if (status.before !== "COMPLETE") {
        warnings.push(`Component ${name} coverage is ${status.before ?? "unknown"} in both snapshots; areas that were not captured are not compared`);
      }
      const d = compare(x, y, args.max_items, args.max_fields, key === FORMS_KEY);
      summary.added += d.added.total;
      summary.removed += d.removed.total;
      summary.changed += d.changed.total;
      components[key] = { captured: "both", status, ...d };
    }
    const identical = oneSided ? false : neither.length ? null : summary.added + summary.removed + summary.changed === 0;
    return {
      identical,
      ...(identical === null ? { identicalReason: `Requested component(s) in neither snapshot: ${neither.map(k => NAMES[k] ?? k).join(", ")}` } : {}),
      summary,
      before: describeSide(args.before, before),
      after: describeSide(args.after, after),
      warnings,
      components,
    };
  },
}];
