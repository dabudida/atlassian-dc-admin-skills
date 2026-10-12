/**
 * Jira DC project lifecycle: create and change projects, project categories and components,
 * and create a project with the shared configuration of an existing one.
 *
 * Routes (checked in the Jira 11.3 application.wadl): `POST /project`, `PUT /project/{key}`,
 * `GET /projectvalidate/key`, `/projectCategory[/{id}]`, `POST /component`,
 * `PUT|DELETE /component/{id}` (`moveIssuesTo`), `GET /component/{id}/relatedIssueCounts`.
 *
 * Shared configuration uses the project-templates plugin route the "Create with shared
 * configuration" dialog calls: `POST /rest/project-templates/1.0/createshared/{existingProjectId}`
 * with JSON `{key, name, lead}`, answering `{projectId, projectKey, projectName, returnUrl}`
 * (route in the plugin's application.wadl; body and answer in the dialog's web resource).
 *
 * Archive/restore, scheme assignment and versions live in projects.ts, projectSchemes.ts and
 * projectMeta.ts. Project deletion is deliberately not offered (irreversible, removes all issues).
 */

import { z } from "zod";
import { seg, type AtlassianClient } from "../../client.js";
import { isHttpStatusError, ValidationError, VerificationError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { alreadySatisfied, capList, dryRunShape, guardedWrite, pageShape, paginate } from "../util.js";

const API = "/rest/api/2";
const SHARED = "/rest/project-templates/1.0/createshared";

const PROJECT_ASSIGNEE = ["PROJECT_LEAD", "UNASSIGNED"] as const;
const COMPONENT_ASSIGNEE = ["PROJECT_DEFAULT", "COMPONENT_LEAD", "PROJECT_LEAD", "UNASSIGNED"] as const;

// -- reads ---------------------------------------------------------------------

/** GET that answers null on 404 (absent) and rethrows anything else. */
async function getOrNull(c: AtlassianClient, path: string, params?: Record<string, any>): Promise<any> {
  try {
    return await c.get(path, params);
  } catch (e) {
    if (isHttpStatusError(e) && e.status === 404) return null;
    throw e;
  }
}

const getProject = (c: AtlassianClient, key: string) => getOrNull(c, `${API}/project/${seg(key)}`, { expand: "lead,description,url,projectCategory" });

/** Usernames are case-insensitive in Jira DC; empty and absent are the same (no user). */
function sameUser(a: unknown, b: unknown): boolean {
  return String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
}

/**
 * The project that owns exactly this key, or null. `GET /project/{key}` also answers for a former key of a
 * renamed project; such a key is not free (Jira keeps it reserved for that project), so it is an error.
 */
async function projectWithKey(c: AtlassianClient, key: string): Promise<any> {
  const p = await getProject(c, key);
  if (p && String(p.key).toUpperCase() !== key.toUpperCase()) {
    throw new ValidationError(`Project key '${key}' is a former key of project ${p.key} '${p.name}'; Jira keeps it reserved for that project, so choose another key (or work with ${p.key})`);
  }
  return p;
}

interface SchemeIds {
  permissionScheme: number | null;
  notificationScheme: number | null;
  issueSecurityScheme: number | null;
  workflowScheme: number | null;
}

/** The scheme ids a project uses; null where Jira reports none (404). */
async function schemeIds(c: AtlassianClient, key: string): Promise<SchemeIds> {
  const id = async (sub: string) => {
    const s = await getOrNull(c, `${API}/project/${seg(key)}/${sub}`);
    return s?.id !== undefined && s?.id !== null ? Number(s.id) : null;
  };
  const [permissionScheme, notificationScheme, issueSecurityScheme, workflowScheme] = await Promise.all([
    id("permissionscheme"), id("notificationscheme"), id("issuesecuritylevelscheme"), id("workflowscheme"),
  ]);
  return { permissionScheme, notificationScheme, issueSecurityScheme, workflowScheme };
}

/**
 * The issue type scheme of each project: its id, "default" when no scheme lists the project (the default
 * scheme), or null when a read failed. Jira DC has no per-project route, so scheme associations are scanned.
 */
async function issueTypeSchemes(c: AtlassianClient, keys: string[]): Promise<Record<string, number | "default" | null>> {
  const out: Record<string, number | "default" | null> = {};
  try {
    const data = await c.get(`${API}/issuetypescheme`);
    const schemes: any[] = Array.isArray(data) ? data : (data?.schemes ?? []);
    let failed = false;
    for (const s of schemes) {
      let assoc: any[] = [];
      try {
        assoc = ((await c.get(`${API}/issuetypescheme/${seg(s.id)}/associations`)) as any[]) ?? [];
      } catch {
        failed = true;
        continue;
      }
      for (const a of Array.isArray(assoc) ? assoc : []) {
        const k = String(a?.key ?? a);
        if (keys.includes(k) && out[k] === undefined) out[k] = Number(s.id);
      }
    }
    for (const k of keys) if (out[k] === undefined) out[k] = failed ? null : "default";
  } catch {
    for (const k of keys) out[k] = null;
  }
  return out;
}

function projectView(p: any): Record<string, unknown> {
  return {
    id: p?.id,
    key: p?.key,
    name: p?.name,
    type: p?.projectTypeKey,
    lead: p?.lead?.name ?? null,
    description: p?.description || null,
    url: p?.url || null,
    assigneeType: p?.assigneeType ?? null,
    category: p?.projectCategory?.name ?? null,
  };
}

async function listCategories(c: AtlassianClient): Promise<any[]> {
  return ((await c.get(`${API}/projectCategory`)) as any[]) ?? [];
}

/** A category by id or exact name (case-insensitive); undefined when absent. */
function pickByIdOrName<T extends { id?: unknown; name?: unknown }>(items: T[], given: string, what: string): T | undefined {
  const v = String(given).trim();
  const byId = items.find((x) => String(x.id) === v);
  if (byId) return byId;
  const byName = items.filter((x) => String(x.name).toLowerCase() === v.toLowerCase());
  if (byName.length > 1) throw new ValidationError(`${what} name '${v}' is ambiguous; pass the id`);
  return byName[0];
}

async function resolveCategory(c: AtlassianClient, given: string): Promise<any> {
  const cat = pickByIdOrName(await listCategories(c), given, "Category");
  if (!cat) throw new ValidationError(`No project category '${given}' (see jira_list_project_categories)`);
  return cat;
}

async function allProjects(c: AtlassianClient): Promise<any[]> {
  return ((await c.get(`${API}/project`, { expand: "projectCategory", includeArchived: true })) as any[]) ?? [];
}

/** Components of a project (same read as jira_get_project_components: one unpaged call). */
async function listComponents(c: AtlassianClient, projectKey: string): Promise<any[]> {
  return ((await c.get(`${API}/project/${seg(projectKey)}/components`)) as any[]) ?? [];
}

function componentView(cp: any): Record<string, unknown> {
  return { id: cp?.id, name: cp?.name, description: cp?.description || null, lead: cp?.lead?.name ?? cp?.leadUserName ?? null, assigneeType: cp?.assigneeType ?? null };
}

// -- validation ----------------------------------------------------------------

/** Jira's own key check (pattern, length, reserved words, already used). */
async function validateKey(c: AtlassianClient, key: string): Promise<void> {
  const res = await c.get(`${API}/projectvalidate/key`, { key });
  const msgs = [...Object.values(res?.errors ?? {}), ...(res?.errorMessages ?? [])].map(String);
  if (msgs.length) throw new ValidationError(`Project key '${key}' is not usable: ${msgs.join("; ")}`);
}

async function validateName(c: AtlassianClient, name: string, exceptKey?: string): Promise<void> {
  const clash = (await allProjects(c)).find((p) => String(p.name).toLowerCase() === name.toLowerCase() && p.key !== exceptKey);
  if (clash) throw new ValidationError(`Project ${clash.key} already uses the name '${clash.name}'`);
}

async function validateUser(c: AtlassianClient, username: string): Promise<void> {
  if (!(await getOrNull(c, `${API}/user`, { username }))) throw new ValidationError(`User '${username}' not found`);
}

async function validateType(c: AtlassianClient, type: string): Promise<void> {
  const types: any[] = ((await c.get(`${API}/project/type`)) as any[]) ?? [];
  const keys = types.map((t) => String(t.key));
  if (!keys.includes(type)) throw new ValidationError(`Project type '${type}' is not available (${keys.join(", ")})`);
}

const keyArg = z.string().trim().min(1).describe("Project key");
const categoryArg = z.coerce.string().min(1).describe("Project category id or exact name");
const componentArg = z.coerce.string().min(1).describe("Component id or exact name");
const schemeIdArg = (what: string) => z.coerce.number().int().min(0).optional().describe(`${what} scheme id`);

// -- tools ---------------------------------------------------------------------

export const jiraProjectLifecycleTools: ToolDef[] = [
  {
    name: "jira_create_project",
    product: "jira",
    write: true,
    invalidates: ["workflow-usage", "screen-usage"],
    description:
      "Create a project: project_key, name, project_type (business/software/service_desk), lead, optional template " +
      "(projectTemplateKey), description, url, assignee_type, category and permission/notification/issue security scheme ids. " +
      "from_project copies those scheme ids, the category and the type from an existing project (explicit values win); " +
      "workflow, issue type, screen and field configuration schemes are not settable here (use jira_create_project_shared " +
      "or jira_assign_project_scheme). The dry run validates key, name, lead and type. Same key/name/type/lead and the requested " +
      "category and schemes → already-satisfied; other category or schemes → error naming jira_update_project / jira_assign_project_scheme.",
    inputShape: {
      project_key: keyArg,
      name: z.string().trim().min(1),
      project_type: z.string().trim().min(1).optional().describe("projectTypeKey; defaults to from_project's type"),
      lead: z.string().trim().min(1).describe("Project lead username"),
      template: z.string().trim().min(1).optional().describe("projectTemplateKey (e.g. com.pyxis.greenhopper.jira:gh-simplified-kanban-classic)"),
      description: z.string().optional(),
      url: z.string().optional(),
      assignee_type: z.enum(PROJECT_ASSIGNEE).optional(),
      category: categoryArg.optional(),
      permission_scheme: schemeIdArg("Permission"),
      notification_scheme: schemeIdArg("Notification"),
      issue_security_scheme: schemeIdArg("Issue security"),
      from_project: keyArg.optional().describe("Copy scheme ids, category and type from this project"),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const key = String(args.project_key).trim();
      const summary = `Create project ${key} '${args.name}'`;

      let copied: SchemeIds | undefined;
      let source: any;
      if (args.from_project) {
        source = await getProject(c, args.from_project);
        if (!source) throw new ValidationError(`No project '${args.from_project}' to copy from`);
        copied = await schemeIds(c, source.key);
      }
      const type: string | undefined = args.project_type ?? source?.projectTypeKey;
      if (!type) throw new ValidationError("Pass project_type (or from_project)");

      const categoryId = args.category ? Number((await resolveCategory(c, args.category)).id) : source?.projectCategory?.id != null ? Number(source.projectCategory.id) : undefined;
      const schemes: Array<[string, keyof SchemeIds, number | undefined]> = [
        ["permissionScheme", "permissionScheme", args.permission_scheme],
        ["notificationScheme", "notificationScheme", args.notification_scheme],
        ["issueSecurityScheme", "issueSecurityScheme", args.issue_security_scheme],
      ];
      const wantSchemes: Partial<Record<keyof SchemeIds, number>> = {};
      for (const [, k, given] of schemes) {
        const v = given ?? copied?.[k] ?? undefined;
        if (v !== undefined && v !== null) wantSchemes[k] = v;
      }

      const existing = await projectWithKey(c, key);
      if (existing) {
        if (existing.name !== args.name || existing.projectTypeKey !== type || !sameUser(existing.lead?.name, args.lead)) {
          throw new ValidationError(`Project ${existing.key} already exists as '${existing.name}' (${existing.projectTypeKey}, lead ${existing.lead?.name ?? "?"}); use jira_update_project`);
        }
        // the requested category and schemes must hold too, or the create would silently not apply them
        const diffs: string[] = [];
        if (categoryId !== undefined && String(existing.projectCategory?.id ?? "") !== String(categoryId)) {
          diffs.push(`category is ${existing.projectCategory?.name ?? "(none)"}, not ${categoryId} (change it with jira_update_project)`);
        }
        const wantKeys = Object.keys(wantSchemes) as Array<keyof SchemeIds>;
        if (wantKeys.length) {
          const now = await schemeIds(c, existing.key);
          const wrong = wantKeys.filter((k) => now[k] !== wantSchemes[k]);
          if (wrong.length) diffs.push(`${wrong.map((k) => `${k} is ${now[k] ?? "(none)"}, not ${wantSchemes[k]}`).join(", ")} (change it with jira_assign_project_scheme)`);
        }
        if (diffs.length) throw new ValidationError(`Project ${existing.key} already exists with this name, type and lead, but ${diffs.join("; ")}`);
        return alreadySatisfied(summary, `project ${existing.key} already exists with this name, type and lead${categoryId !== undefined || wantKeys.length ? " and the requested category and schemes" : ""}`, { project: projectView(existing) });
      }
      await validateKey(c, key);
      await validateName(c, args.name);
      await Promise.all([validateUser(c, args.lead), validateType(c, type)]);

      const body: Record<string, unknown> = { key, name: args.name, projectTypeKey: type, lead: args.lead };
      if (args.template) body.projectTemplateKey = args.template;
      if (args.description !== undefined) body.description = args.description;
      if (args.url !== undefined) body.url = args.url;
      if (args.assignee_type) body.assigneeType = args.assignee_type;
      if (categoryId !== undefined) body.categoryId = categoryId;
      for (const [field, k] of schemes) if (wantSchemes[k] !== undefined) body[field] = wantSchemes[k];
      const extra = copied
        ? {
            copiedFrom: { project: source.key, ...copied },
            notCopied: {
              schemes: ["workflow", "issue type", "issue type screen", "field configuration"],
              hint: `jira_create_project_shared from_project=${source.key} shares all of them; or assign each afterwards with jira_assign_project_scheme`,
            },
          }
        : {};

      const req = { method: "POST" as const, path: `${API}/project`, json: body, summary };
      if (args.dry_run !== false) return { ...(await guardedWrite(c, args, req)), ...extra, identity: { op: "create-project", key }, state: { exists: false } };
      const result = await guardedWrite(c, args, req);
      const back = await getProject(c, key);
      if (!back) throw new VerificationError(`${summary}: the project does not exist afterwards`, null);
      const now = await schemeIds(c, key);
      const wrong = schemes.filter(([field, k]) => body[field] !== undefined && now[k] !== body[field]).map(([field]) => field);
      if (back.name !== args.name || back.projectTypeKey !== type || !sameUser(back.lead?.name, args.lead) || wrong.length) {
        throw new VerificationError(`${summary}: the project reads back differently${wrong.length ? ` (${wrong.join(", ")})` : ""}`, { project: projectView(back), schemes: now });
      }
      return { ...result, ...extra, result: { ...projectView(back), schemes: now } };
    },
  },
  {
    name: "jira_update_project",
    product: "jira",
    write: true,
    invalidates: [],
    description:
      "Change a project's name, lead, description, url, assignee_type or category (only changed fields are sent). " +
      "The dry run shows old and new values; read back after the write. Same values → already-satisfied.",
    inputShape: {
      project_key: keyArg,
      name: z.string().trim().min(1).optional(),
      lead: z.string().trim().min(1).optional().describe("Lead username"),
      description: z.string().optional(),
      url: z.string().optional(),
      assignee_type: z.enum(PROJECT_ASSIGNEE).optional(),
      category: categoryArg.optional(),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const fields = ["name", "lead", "description", "url", "assignee_type", "category"];
      if (!fields.some((f) => args[f] !== undefined)) throw new ValidationError(`Pass at least one of ${fields.join(", ")}`);
      const c = client("jira");
      const cur = await getProject(c, args.project_key);
      if (!cur) throw new ValidationError(`No project '${args.project_key}'`);
      const cat = args.category ? await resolveCategory(c, args.category) : undefined;
      const body: Record<string, unknown> = {};
      if (args.name !== undefined && args.name !== cur.name) body.name = args.name;
      if (args.lead !== undefined && !sameUser(args.lead, cur.lead?.name)) body.lead = args.lead;
      if (args.description !== undefined && args.description !== (cur.description ?? "")) body.description = args.description;
      if (args.url !== undefined && args.url !== (cur.url ?? "")) body.url = args.url;
      if (args.assignee_type !== undefined && args.assignee_type !== cur.assigneeType) body.assigneeType = args.assignee_type;
      if (cat && String(cat.id) !== String(cur.projectCategory?.id ?? "")) body.categoryId = Number(cat.id);
      const summary = `Update project ${cur.key}`;
      if (!Object.keys(body).length) return alreadySatisfied(summary, "the project already has these values");
      if (body.name) await validateName(c, String(body.name), cur.key);
      if (body.lead) await validateUser(c, String(body.lead));
      const before = projectView(cur);
      const after = {
        ...before,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.lead !== undefined ? { lead: body.lead } : {}),
        ...(body.description !== undefined ? { description: body.description || null } : {}),
        ...(body.url !== undefined ? { url: body.url || null } : {}),
        ...(body.assigneeType !== undefined ? { assigneeType: body.assigneeType } : {}),
        ...(body.categoryId !== undefined ? { category: cat.name } : {}),
      };
      const req = { method: "PUT" as const, path: `${API}/project/${seg(cur.key)}`, json: body, summary: `${summary}: ${Object.keys(body).join(", ")}` };
      if (args.dry_run !== false) return { ...(await guardedWrite(c, args, req)), before, after, identity: { op: "update-project", key: cur.key, ...body }, state: before };
      const result = await guardedWrite(c, args, req);
      const back = projectView(await getProject(c, cur.key));
      const mismatch = Object.keys(after).filter((k) =>
        k === "lead" ? !sameUser(after.lead, back.lead) : JSON.stringify(after[k as keyof typeof after]) !== JSON.stringify(back[k]));
      if (mismatch.length) throw new VerificationError(`${summary}: ${mismatch.join(", ")} read back differently`, back);
      return { ...result, before, result: back };
    },
  },
  {
    name: "jira_list_project_categories",
    product: "jira",
    description: "Project categories: id, name, description and how many projects (archived included) use each.",
    inputShape: { ...pageShape(100) },
    async handler({ client }, args) {
      const c = client("jira");
      const [cats, projects] = await Promise.all([listCategories(c), allProjects(c)]);
      const items = cats.map((cat) => ({
        id: cat.id,
        name: cat.name,
        description: cat.description || null,
        projects: projects.filter((p) => String(p.projectCategory?.id ?? "") === String(cat.id)).length,
      }));
      return paginate(items, args, 100);
    },
  },
  {
    name: "jira_create_project_category",
    product: "jira",
    write: true,
    invalidates: [],
    description: "Create a project category. Same name (case-insensitive) and description → already-satisfied; same name otherwise → error.",
    inputShape: { name: z.string().trim().min(1), description: z.string().optional(), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const summary = `Create project category '${args.name}'`;
      const existing = (await listCategories(c)).find((x) => String(x.name).toLowerCase() === args.name.toLowerCase());
      if (existing && (existing.description ?? "") === (args.description ?? "")) return alreadySatisfied(summary, `category ${existing.id} already exists`, { category: { id: existing.id, name: existing.name } });
      if (existing) throw new ValidationError(`Category ${existing.id} '${existing.name}' already exists with another description; use jira_update_project_category`);
      const body: Record<string, unknown> = { name: args.name };
      if (args.description !== undefined) body.description = args.description;
      const req = { method: "POST" as const, path: `${API}/projectCategory`, json: body, summary };
      if (args.dry_run !== false) return guardedWrite(c, args, req);
      const result = await guardedWrite(c, args, req);
      const back = (await listCategories(c)).find((x) => x.name === args.name);
      if (!back) throw new VerificationError(`${summary}: the category does not exist afterwards`, null);
      return { ...result, result: { id: back.id, name: back.name, description: back.description || null } };
    },
  },
  {
    name: "jira_update_project_category",
    product: "jira",
    write: true,
    invalidates: [],
    description: "Rename a project category or change its description. Same values → already-satisfied.",
    inputShape: { category: categoryArg, name: z.string().trim().min(1).optional(), description: z.string().optional(), ...dryRunShape },
    async handler({ client }, args) {
      if (args.name === undefined && args.description === undefined) throw new ValidationError("Pass name and/or description");
      const c = client("jira");
      const cats = await listCategories(c);
      const cur = pickByIdOrName(cats, args.category, "Category");
      if (!cur) throw new ValidationError(`No project category '${args.category}'`);
      const want = { name: args.name ?? cur.name, description: args.description ?? cur.description ?? "" };
      const summary = `Update project category ${cur.id} '${cur.name}'`;
      if (want.name === cur.name && want.description === (cur.description ?? "")) return alreadySatisfied(summary, "it already has these values");
      const clash = cats.find((x) => x.id !== cur.id && String(x.name).toLowerCase() === want.name.toLowerCase());
      if (clash) throw new ValidationError(`Category ${clash.id} already uses the name '${clash.name}'`);
      const before = { name: cur.name, description: cur.description ?? "" };
      const req = { method: "PUT" as const, path: `${API}/projectCategory/${seg(cur.id)}`, json: want, summary };
      if (args.dry_run !== false) return { ...(await guardedWrite(c, args, req)), before, after: want };
      const result = await guardedWrite(c, args, req);
      const back = await c.get(`${API}/projectCategory/${seg(cur.id)}`);
      if (back?.name !== want.name || (back?.description ?? "") !== want.description) throw new VerificationError(`${summary}: the category reads back differently`, back);
      return { ...result, before, result: { id: back.id, name: back.name, description: back.description || null } };
    },
  },
  {
    name: "jira_delete_project_category",
    product: "jira",
    write: true,
    invalidates: [],
    description: "Delete a project category; the dry run names the projects that lose it (they keep everything else). Already gone → already-satisfied.",
    inputShape: { category: categoryArg, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const cur = pickByIdOrName(await listCategories(c), args.category, "Category");
      if (!cur) return alreadySatisfied(`Delete project category '${args.category}'`, "no such category");
      const users = (await allProjects(c)).filter((p) => String(p.projectCategory?.id ?? "") === String(cur.id)).map((p) => String(p.key));
      const summary = `Delete project category ${cur.id} '${cur.name}' (${users.length} project${users.length === 1 ? "" : "s"} lose${users.length === 1 ? "s" : ""} the category)`;
      const req = { method: "DELETE" as const, path: `${API}/projectCategory/${seg(cur.id)}`, summary };
      const extra: Record<string, unknown> = {};
      capList(extra, "projects", users);
      if (args.dry_run !== false) return { ...(await guardedWrite(c, args, req)), ...extra, identity: { op: "delete-project-category", category: cur.id }, state: { exists: true } };
      const result = await guardedWrite(c, args, req);
      if (await getOrNull(c, `${API}/projectCategory/${seg(cur.id)}`)) throw new VerificationError(`${summary}: the category still exists`, { id: cur.id });
      return { ...result, ...extra };
    },
  },
  {
    name: "jira_create_component",
    product: "jira",
    write: true,
    invalidates: [],
    description:
      "Create a component in a project: name, optional description, lead (username) and assignee_type. " +
      "Same name with the same given settings → already-satisfied; same name otherwise → error (use jira_update_component).",
    inputShape: {
      project_key: keyArg,
      name: z.string().trim().min(1),
      description: z.string().optional(),
      lead: z.string().trim().min(1).optional().describe("Component lead username"),
      assignee_type: z.enum(COMPONENT_ASSIGNEE).optional(),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const summary = `Create component '${args.name}' in ${args.project_key}`;
      const matches = (cp: any) =>
        (args.description === undefined || (cp.description ?? "") === args.description) &&
        (args.lead === undefined || sameUser(cp.lead?.name, args.lead)) &&
        (args.assignee_type === undefined || cp.assigneeType === args.assignee_type);
      const existing = (await listComponents(c, args.project_key)).find((cp) => String(cp.name).toLowerCase() === args.name.toLowerCase());
      if (existing && matches(existing)) return alreadySatisfied(summary, `component ${existing.id} already exists with these settings`, { component: componentView(existing) });
      if (existing) throw new ValidationError(`Component ${existing.id} '${existing.name}' already exists with other settings; use jira_update_component`);
      if (args.lead) await validateUser(c, args.lead);
      const body: Record<string, unknown> = { project: args.project_key, name: args.name };
      if (args.description !== undefined) body.description = args.description;
      if (args.lead) body.leadUserName = args.lead;
      if (args.assignee_type) body.assigneeType = args.assignee_type;
      const req = { method: "POST" as const, path: `${API}/component`, json: body, summary };
      if (args.dry_run !== false) return guardedWrite(c, args, req);
      const result = await guardedWrite(c, args, req);
      const back = (await listComponents(c, args.project_key)).find((cp) => cp.name === args.name);
      if (!back || !matches(back)) throw new VerificationError(`${summary}: the component does not read back as created`, back ? componentView(back) : null);
      return { ...result, result: componentView(back) };
    },
  },
  {
    name: "jira_update_component",
    product: "jira",
    write: true,
    invalidates: [],
    description: "Change a component's name, description, lead (empty string removes it) or assignee_type. Same values → already-satisfied.",
    inputShape: {
      project_key: keyArg,
      component: componentArg,
      name: z.string().trim().min(1).optional(),
      description: z.string().optional(),
      lead: z.string().trim().optional().describe("Lead username; empty string removes the lead"),
      assignee_type: z.enum(COMPONENT_ASSIGNEE).optional(),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const fields = ["name", "description", "lead", "assignee_type"];
      if (!fields.some((f) => args[f] !== undefined)) throw new ValidationError(`Pass at least one of ${fields.join(", ")}`);
      const c = client("jira");
      const comps = await listComponents(c, args.project_key);
      const cur = pickByIdOrName(comps, args.component, "Component");
      if (!cur) throw new ValidationError(`No component '${args.component}' in ${args.project_key}`);
      const body: Record<string, unknown> = {};
      if (args.name !== undefined && args.name !== cur.name) body.name = args.name;
      if (args.description !== undefined && args.description !== (cur.description ?? "")) body.description = args.description;
      if (args.lead !== undefined && !sameUser(args.lead, cur.lead?.name)) body.leadUserName = args.lead;
      if (args.assignee_type !== undefined && args.assignee_type !== cur.assigneeType) body.assigneeType = args.assignee_type;
      const summary = `Update component ${cur.id} '${cur.name}' in ${args.project_key}`;
      if (!Object.keys(body).length) return alreadySatisfied(summary, "it already has these values");
      if (body.name && comps.some((x) => x.id !== cur.id && String(x.name).toLowerCase() === String(body.name).toLowerCase())) {
        throw new ValidationError(`Another component in ${args.project_key} is already named '${body.name}'`);
      }
      if (body.leadUserName) await validateUser(c, String(body.leadUserName));
      const before = componentView(cur);
      const after = {
        ...before,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description || null } : {}),
        ...(body.leadUserName !== undefined ? { lead: body.leadUserName || null } : {}),
        ...(body.assigneeType !== undefined ? { assigneeType: body.assigneeType } : {}),
      };
      const req = { method: "PUT" as const, path: `${API}/component/${seg(cur.id)}`, json: body, summary: `${summary}: ${Object.keys(body).join(", ")}` };
      if (args.dry_run !== false) return { ...(await guardedWrite(c, args, req)), before, after };
      const result = await guardedWrite(c, args, req);
      const back = componentView(await c.get(`${API}/component/${seg(cur.id)}`));
      const differs = Object.keys(after).some((k) => (k === "lead" ? !sameUser(after.lead, back.lead) : JSON.stringify((after as any)[k]) !== JSON.stringify(back[k])));
      if (differs) throw new VerificationError(`${summary}: the component reads back differently`, back);
      return { ...result, before, result: back };
    },
  },
  {
    name: "jira_delete_component",
    product: "jira",
    write: true,
    invalidates: [],
    description:
      "Delete a component; move_issues_to (component id or name in the same project) reassigns its issues, otherwise " +
      "they just lose the component. The dry run states the issue count. Already gone → already-satisfied.",
    inputShape: { project_key: keyArg, component: componentArg, move_issues_to: componentArg.optional(), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const comps = await listComponents(c, args.project_key);
      const cur = pickByIdOrName(comps, args.component, "Component");
      if (!cur) return alreadySatisfied(`Delete component '${args.component}' in ${args.project_key}`, "no such component");
      let target: any;
      if (args.move_issues_to !== undefined) {
        target = pickByIdOrName(comps, args.move_issues_to, "Component");
        if (!target) throw new ValidationError(`No component '${args.move_issues_to}' in ${args.project_key}`);
        if (String(target.id) === String(cur.id)) throw new ValidationError("move_issues_to is the component being deleted");
      }
      const count = Number((await getOrNull(c, `${API}/component/${seg(cur.id)}/relatedIssueCounts`))?.issueCount ?? NaN);
      const issues = Number.isFinite(count) ? `${count} issues` : "an unknown number of issues";
      const summary = `Delete component ${cur.id} '${cur.name}' in ${args.project_key} (${issues} ${target ? `move to '${target.name}'` : "lose the component"})`;
      const req = { method: "DELETE" as const, path: `${API}/component/${seg(cur.id)}`, params: target ? { moveIssuesTo: String(target.id) } : undefined, summary };
      if (args.dry_run !== false) return { ...(await guardedWrite(c, args, req)), component: componentView(cur), identity: { op: "delete-component", project: args.project_key, component: cur.id }, state: { exists: true } };
      const result = await guardedWrite(c, args, req);
      if (await getOrNull(c, `${API}/component/${seg(cur.id)}`)) throw new VerificationError(`${summary}: the component still exists`, { id: cur.id });
      return result;
    },
  },
  {
    name: "jira_create_project_shared",
    product: "jira",
    write: true,
    invalidates: ["workflow-usage", "screen-usage"],
    description:
      "Create a project that shares the configuration (all schemes, project type; for JSM the service desk setup) of " +
      "from_project, as Jira's \"Create with shared configuration\" does (internal project-templates route). " +
      "Validates key, name and lead in the dry run; verifies that the new project uses the source's permission, notification, " +
      "issue type and workflow schemes (verification: partial when a scheme cannot be read on either side). " +
      "Same key, name and shared schemes → already-satisfied.",
    inputShape: {
      from_project: keyArg.describe("Existing project whose configuration is shared"),
      project_key: keyArg,
      name: z.string().trim().min(1),
      lead: z.string().trim().min(1).describe("Project lead username"),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const key = String(args.project_key).trim();
      const source = await getProject(c, args.from_project);
      if (!source) throw new ValidationError(`No project '${args.from_project}' to share configuration with`);
      const summary = `Create project ${key} '${args.name}' with the shared configuration of ${source.key}`;
      const srcSchemes = await schemeIds(c, source.key);
      /**
       * Compare a project's schemes with the source's. Permission, notification and issue type schemes must
       * match; the workflow scheme counts only when it can be read on both sides, otherwise the check is partial.
       */
      const compare = async (k: string, s: SchemeIds) => {
        const its = await issueTypeSchemes(c, [source.key, k]);
        const wrong: string[] = [];
        const unverified: string[] = [];
        if (s.permissionScheme !== srcSchemes.permissionScheme) wrong.push("permissionScheme");
        if (s.notificationScheme !== srcSchemes.notificationScheme) wrong.push("notificationScheme");
        if (its[source.key] === null || its[k] === null) unverified.push("issueTypeScheme");
        else if (its[source.key] !== its[k]) wrong.push("issueTypeScheme");
        if (s.workflowScheme === null || srcSchemes.workflowScheme === null) unverified.push("workflowScheme");
        else if (s.workflowScheme !== srcSchemes.workflowScheme) wrong.push("workflowScheme");
        const verification = unverified.length
          ? { status: "partial", unverified, reason: `${unverified.join(", ")} could not be read for ${source.key} or ${k}; check them in the project settings` }
          : { status: "full" };
        return { wrong, verification, issueTypeScheme: its[k] };
      };
      const existing = await projectWithKey(c, key);
      if (existing) {
        if (existing.name === args.name && existing.projectTypeKey === source.projectTypeKey) {
          const cmp = await compare(existing.key, await schemeIds(c, existing.key));
          if (!cmp.wrong.length) {
            return alreadySatisfied(summary, `project ${existing.key} already exists with this name and the schemes of ${source.key}`, { project: projectView(existing), verification: cmp.verification });
          }
        }
        throw new ValidationError(`Project ${existing.key} already exists as '${existing.name}' with other settings`);
      }
      await validateKey(c, key);
      await validateName(c, args.name);
      await validateUser(c, args.lead);
      const req = { method: "POST" as const, path: `${SHARED}/${seg(source.id)}`, json: { key, name: args.name, lead: args.lead }, summary };
      const extra = { source: { ...projectView(source), schemes: srcSchemes } };
      if (args.dry_run !== false) return { ...(await guardedWrite(c, args, req)), ...extra, identity: { op: "create-project-shared", key, from: source.key }, state: { exists: false } };
      const result = await guardedWrite(c, args, req);
      const back = await getProject(c, key);
      if (!back) throw new VerificationError(`${summary}: the project does not exist afterwards`, null);
      const now = await schemeIds(c, key);
      const cmp = await compare(key, now);
      if (back.name !== args.name || cmp.wrong.length) {
        throw new VerificationError(`${summary}: the project does not read back with the shared schemes${cmp.wrong.length ? ` (${cmp.wrong.join(", ")})` : ""}`, { project: projectView(back), schemes: now, expected: srcSchemes });
      }
      return { ...result, ...extra, result: { ...projectView(back), schemes: { ...now, issueTypeScheme: cmp.issueTypeScheme } }, verification: cmp.verification };
    },
  },
];
