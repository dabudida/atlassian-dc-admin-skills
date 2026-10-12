/**
 * Jira DC permission diagnostics (read-only).
 *
 * `jira_explain_permission` answers "why can (or can't) this user do X in this project/issue": it asks Jira for
 * the ground truth (`/user/permission/search`) and explains it from the project's permission scheme grants,
 * the user's groups and application access, project role actors, issue roles and the issue security level.
 * `jira_user_access_summary` lists one user's groups, application access and project roles across a bounded
 * page of projects.
 *
 * The readers in users.ts, schemes.ts and projects.ts are module-private (readUser, schemeGrants, holderLabel,
 * roleActors), so small local equivalents live here instead of changing those files.
 */

import { z } from "zod";
import { boundedAll, isJiraUserKey, seg, type AtlassianClient } from "../../client.js";
import { isHttpStatusError, ValidationError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { capList, fullListsShape, listArg, pageShape, paginate } from "../util.js";

const API = "/rest/api/2";

// -- permission keys ----------------------------------------------------------

/**
 * Permission scheme key → legacy name. Jira DC 11.3 `/user/permission/search` accepts only the legacy names
 * (BROWSE, CREATE_ISSUE...) and answers 400 for the scheme keys; both spellings are accepted as input.
 */
const LEGACY_NAMES: Record<string, string> = {
  BROWSE_PROJECTS: "BROWSE",
  CREATE_ISSUES: "CREATE_ISSUE",
  EDIT_ISSUES: "EDIT_ISSUE",
  ASSIGN_ISSUES: "ASSIGN_ISSUE",
  ASSIGNABLE_USER: "ASSIGNABLE_USER",
  RESOLVE_ISSUES: "RESOLVE_ISSUE",
  CLOSE_ISSUES: "CLOSE_ISSUE",
  TRANSITION_ISSUES: "TRANSITION_ISSUE",
  ADD_COMMENTS: "COMMENT_ISSUE",
  DELETE_ISSUES: "DELETE_ISSUE",
  WORK_ON_ISSUES: "WORK_ISSUE",
  LINK_ISSUES: "LINK_ISSUE",
  MOVE_ISSUES: "MOVE_ISSUE",
  SCHEDULE_ISSUES: "SCHEDULE_ISSUE",
  CREATE_ATTACHMENTS: "CREATE_ATTACHMENT",
  MANAGE_WATCHERS: "MANAGE_WATCHER_LIST",
  MODIFY_REPORTER: "MODIFY_REPORTER",
  SET_ISSUE_SECURITY: "SET_ISSUE_SECURITY",
  VIEW_VOTERS_AND_WATCHERS: "VIEW_VOTERS_AND_WATCHERS",
  VIEW_READONLY_WORKFLOW: "VIEW_WORKFLOW_READONLY",
  VIEW_DEV_TOOLS: "VIEW_VERSION_CONTROL",
  ADMINISTER_PROJECTS: "PROJECT_ADMIN",
  EDIT_ALL_COMMENTS: "COMMENT_EDIT_ALL",
  EDIT_OWN_COMMENTS: "COMMENT_EDIT_OWN",
  DELETE_ALL_COMMENTS: "COMMENT_DELETE_ALL",
  DELETE_OWN_COMMENTS: "COMMENT_DELETE_OWN",
  DELETE_ALL_ATTACHMENTS: "ATTACHMENT_DELETE_ALL",
  DELETE_OWN_ATTACHMENTS: "ATTACHMENT_DELETE_OWN",
  EDIT_OWN_WORKLOGS: "WORKLOG_EDIT_OWN",
  EDIT_ALL_WORKLOGS: "WORKLOG_EDIT_ALL",
  DELETE_OWN_WORKLOGS: "WORKLOG_DELETE_OWN",
  DELETE_ALL_WORKLOGS: "WORKLOG_DELETE_ALL",
};
const SCHEME_KEYS: Record<string, string> = Object.fromEntries(Object.entries(LEGACY_NAMES).map(([k, v]) => [v, k]));

/** The scheme key and the name the search endpoint understands (plugin permissions keep their key). */
export function normalizePermission(input: string): { key: string; searchName: string; known: boolean } {
  const trimmed = input.trim();
  const upper = trimmed.toUpperCase();
  // only built-in keys are case-folded; plugin permission keys are case-sensitive and pass unchanged
  const key = LEGACY_NAMES[upper] ? upper : (SCHEME_KEYS[upper] ?? trimmed);
  return { key, searchName: LEGACY_NAMES[key] ?? key, known: key in LEGACY_NAMES };
}

// -- small readers ------------------------------------------------------------

function userParams(user: string): Record<string, string> {
  return isJiraUserKey(user) ? { key: user } : { username: user };
}

async function requireUser(client: AtlassianClient, user: string): Promise<any> {
  try {
    return await client.get(`${API}/user`, { ...userParams(user), expand: "groups,applicationRoles" });
  } catch (e) {
    if (isHttpStatusError(e) && e.status === 404) throw new ValidationError(`No Jira user '${user}'`);
    throw e;
  }
}

interface UserFacts {
  name: string;
  key: string;
  active: boolean;
  groups: Set<string>;
  groupsComplete: boolean;
  apps: string[];
}

function userFacts(u: any): UserFacts {
  const items: any[] = u?.groups?.items ?? [];
  return {
    name: String(u?.name ?? ""),
    key: String(u?.key ?? ""),
    active: u?.active !== false,
    groups: new Set(items.map((g) => String(g.name).toLowerCase())),
    groupsComplete: u?.groups?.size === undefined || items.length >= Number(u.groups.size),
    apps: (u?.applicationRoles?.items ?? []).map((r: any) => String(r.key)).sort(),
  };
}

const same = (a: unknown, b: unknown) => a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase();
/** Whether a user reference ({name,key}, a name or a key) is this user. */
const isUser = (ref: any, u: UserFacts) =>
  ref != null && (typeof ref === "string" ? same(ref, u.name) || same(ref, u.key) : same(ref.name, u.name) || same(ref.key, u.key));

/** Human-readable holder: "group:devs", "projectRole:Developers", "reporter". */
function holderLabel(h: any): string {
  const param =
    (h?.type === "projectRole" && h.projectRole?.name) ||
    (h?.type === "user" && h.user?.name) ||
    ((h?.type === "userCustomField" || h?.type === "groupCustomField") && h.field?.name) ||
    h?.parameter;
  return param ? `${h.type}:${param}` : String(h?.type);
}

/** The permission scheme of a project with its grants expanded enough to evaluate them. */
async function projectPermissionScheme(client: AtlassianClient, projectKey: string): Promise<any> {
  const expand = "permissions,user,group,projectRole,field";
  const s = await client.get(`${API}/project/${seg(projectKey)}/permissionscheme`, { expand });
  if (Array.isArray(s?.permissions) || s?.id == null) return s;
  return client.get(`${API}/permissionscheme/${s.id}`, { expand });
}

// -- grant evaluation ---------------------------------------------------------

type Match = "yes" | "no" | "conditional" | "unknown";

interface EvalContext {
  user: UserFacts;
  lead: any;
  roles: Map<string, any[] | { error: string }>;
  issue: any | null;
}

function inGroups(group: string, u: UserFacts): Match {
  if (u.groups.has(group.toLowerCase())) return "yes";
  return u.groupsComplete ? "no" : "unknown";
}

/** Values of a user or group picker field as a list of references. */
const fieldValues = (v: any): any[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

function evaluate(h: any, ctx: EvalContext): { matches: Match; why: string } {
  const { user, issue } = ctx;
  switch (h?.type) {
    case "anyone":
      return { matches: "yes", why: "granted to anyone, including anonymous users" };
    case "applicationRole": {
      if (!h.parameter) {
        return user.apps.length
          ? { matches: "yes", why: "any logged-in user; the user has application access" }
          : { matches: "no", why: "any logged-in user, but the user has no application access" };
      }
      const has = user.apps.includes(String(h.parameter));
      return { matches: has ? "yes" : "no", why: has ? `user has application access ${h.parameter}` : `user lacks application access ${h.parameter}` };
    }
    case "group": {
      if (!h.parameter) return { matches: "yes", why: "group holder without a group means anyone" };
      const m = inGroups(String(h.parameter), user);
      const why = m === "yes" ? `user is in group ${h.parameter}` : m === "no" ? `user is not in group ${h.parameter}` : `group list of the user is partial; membership of ${h.parameter} not shown`;
      return { matches: m, why };
    }
    case "user": {
      const yes = isUser(h.user ?? h.parameter, user) || same(h.parameter, user.key) || same(h.parameter, user.name);
      return { matches: yes ? "yes" : "no", why: yes ? "granted to this user directly" : "granted to another single user" };
    }
    case "projectLead": {
      const yes = isUser(ctx.lead, user);
      return { matches: yes ? "yes" : "no", why: yes ? "user is the project lead" : "user is not the project lead" };
    }
    case "projectRole": {
      const roleName = h.projectRole?.name ?? h.parameter;
      const actors = ctx.roles.get(String(h.parameter));
      if (!actors || !Array.isArray(actors)) return { matches: "unknown", why: `role ${roleName} actors could not be read${actors ? ` (${(actors as any).error})` : ""}` };
      if (actors.some((a) => a.type === "atlassian-user-role-actor" && isUser({ name: a.name, key: a.userKey }, user))) {
        return { matches: "yes", why: `user is a member of role ${roleName} directly` };
      }
      const groups = actors.filter((a) => a.type === "atlassian-group-role-actor").map((a) => String(a.name));
      const via = groups.find((g) => user.groups.has(g.toLowerCase()));
      if (via) return { matches: "yes", why: `user is in role ${roleName} via group ${via}` };
      if (!user.groupsComplete && groups.length) return { matches: "unknown", why: `role ${roleName} has groups and the user's group list is partial` };
      return { matches: "no", why: `user is not in role ${roleName} (${groups.length} group actor(s) checked)` };
    }
    case "reporter":
    case "assignee": {
      if (!issue) return { matches: "conditional", why: `only on issues where the user is the ${h.type}` };
      const yes = isUser(issue.fields?.[h.type], user);
      return { matches: yes ? "yes" : "no", why: yes ? `user is the ${h.type} of ${issue.key}` : `user is not the ${h.type} of ${issue.key}` };
    }
    case "userCustomField":
    case "groupCustomField": {
      const label = h.field?.name ?? h.parameter;
      if (!issue) return { matches: "conditional", why: `only on issues whose field ${label} contains the user${h.type === "groupCustomField" ? "'s group" : ""}` };
      const values = fieldValues(issue.fields?.[h.parameter]);
      if (h.type === "userCustomField") {
        const yes = values.some((v) => isUser(v, user));
        return { matches: yes ? "yes" : "no", why: yes ? `user is in field ${label} of ${issue.key}` : `field ${label} of ${issue.key} does not contain the user` };
      }
      const names = values.map((v) => (typeof v === "string" ? v : (v?.name ?? v?.value))).filter(Boolean).map(String);
      const via = names.find((g) => user.groups.has(g.toLowerCase()));
      if (via) return { matches: "yes", why: `field ${label} of ${issue.key} names group ${via}, which contains the user` };
      return { matches: user.groupsComplete ? "no" : "unknown", why: `field ${label} of ${issue.key} names no group of the user` };
    }
    default:
      return { matches: "unknown", why: `holder type ${h?.type} is not evaluated by this tool` };
  }
}

// -- ground truth -------------------------------------------------------------

const SEARCH_PAGE = 100;
const SEARCH_PAGES = 5;

interface GroundTruth {
  status: "granted" | "denied" | "unknown" | "unavailable";
  checkedAs: string;
  detail?: string;
}

/** Whether `/user/permission/search` returns this exact user (the username parameter is a search text). */
async function groundTruth(client: AtlassianClient, user: UserFacts, searchName: string, scope: Record<string, string>): Promise<GroundTruth> {
  for (let page = 0; page < SEARCH_PAGES; page++) {
    let users: any[];
    try {
      users = (await client.get(`${API}/user/permission/search`, { permissions: searchName, username: user.name, ...scope, startAt: page * SEARCH_PAGE, maxResults: SEARCH_PAGE })) ?? [];
    } catch (e) {
      if (isHttpStatusError(e) && (e.status === 400 || e.status === 404)) {
        return { status: "unavailable", checkedAs: searchName, detail: `Jira answered HTTP ${e.status} (the search endpoint does not know this permission name)` };
      }
      throw e;
    }
    if (users.some((u) => isUser(u, user))) return { status: "granted", checkedAs: searchName };
    if (users.length < SEARCH_PAGE) return { status: "denied", checkedAs: searchName };
  }
  return { status: "unknown", checkedAs: searchName, detail: `the user was not among the first ${SEARCH_PAGE * SEARCH_PAGES} users matching the username` };
}

// -- access summary limits ----------------------------------------------------

/** Role reads (projects x roles) one jira_user_access_summary call may send; the page shrinks to stay under it. */
const MAX_ROLE_READS = 200;
const ACCESS_DEFAULT_LIMIT = 20;
const ACCESS_MAX_LIMIT = 50;

export const jiraPermissionDiagnosticTools: ToolDef[] = [
  {
    name: "jira_explain_permission",
    aliases: { user: "username" },
    product: "jira",
    description:
      "Explain whether a user has a project permission (BROWSE_PROJECTS, CREATE_ISSUES, TRANSITION_ISSUES, ASSIGNABLE_USER...; " +
      "legacy names such as BROWSE are accepted) in a project or on one issue. Returns the verdict from Jira's own check " +
      "(/user/permission/search), every scheme grant of that permission with whether it matches the user and why, the " +
      "user's active state and application access, and for an issue its security level. Says so when the explanation " +
      "and Jira's answer disagree. Read-only.",
    inputShape: {
      username: z.string().describe("Username, or user key (JIRAUSER10000)"),
      permission: z.string().describe("Permission key, e.g. BROWSE_PROJECTS (or legacy BROWSE)"),
      project_key: z.string().optional().describe("Project key; optional when issue_key is given"),
      issue_key: z.string().optional().describe("Check on this issue (issue roles, custom-field holders, security level)"),
    },
    async handler({ client }, args) {
      if (!args.project_key && !args.issue_key) throw new ValidationError("Pass project_key or issue_key");
      const c = client("jira");
      const perm = normalizePermission(args.permission);
      const raw = await requireUser(c, args.username);
      const user = userFacts(raw);
      const notes: string[] = [];

      // the issue decides the project (a moved issue keeps its old key); custom-field values are read only when needed
      let projectKey: string = args.project_key ? String(args.project_key).toUpperCase() : "";
      let issue: any = null;
      let issueKey: string | undefined;
      if (args.issue_key) {
        issue = await c.get(`${API}/issue/${seg(args.issue_key)}`, { fields: "project,reporter,assignee,security" });
        issueKey = String(issue?.key ?? args.issue_key).toUpperCase();
        const issueProject = issue?.fields?.project?.key;
        if (projectKey && issueProject && !same(issueProject, projectKey)) {
          throw new ValidationError(`Issue ${issueKey} belongs to project ${issueProject}, not ${projectKey}`);
        }
        projectKey = String(issueProject ?? (projectKey || issueKey.replace(/-\d+$/, "")));
      }

      const [project, scheme] = await Promise.all([
        c.get(`${API}/project/${seg(projectKey)}`, { expand: "lead" }),
        projectPermissionScheme(c, projectKey),
      ]);
      const grants: any[] = (scheme?.permissions ?? []).filter((g: any) => String(g.permission).toUpperCase() === perm.key);

      const fieldIds = [...new Set(grants.filter((g) => /CustomField$/.test(String(g.holder?.type)) && g.holder?.parameter).map((g) => String(g.holder.parameter)))];
      if (issue && fieldIds.length) {
        const extra = await c.get(`${API}/issue/${seg(issueKey!)}`, { fields: fieldIds.join(",") });
        issue = { ...issue, fields: { ...issue.fields, ...(extra?.fields ?? {}) } };
      }

      // actors only of the roles this permission is granted to
      const roleIds = [...new Set(grants.filter((g) => g.holder?.type === "projectRole" && g.holder?.parameter).map((g) => String(g.holder.parameter)))];
      const roleReads = await boundedAll(roleIds.map((id) => async () => {
        try {
          return (await c.get(`${API}/project/${seg(projectKey)}/role/${seg(id)}`))?.actors ?? [];
        } catch (e) {
          if (isHttpStatusError(e)) return { error: `HTTP ${e.status}` };
          throw e;
        }
      }));
      const roles = new Map<string, any[] | { error: string }>(roleIds.map((id, i) => [id, roleReads[i]]));

      const ctx: EvalContext = { user, lead: project?.lead, roles, issue };
      const rows = grants.map((g) => ({ holder: holderLabel(g.holder), ...evaluate(g.holder, ctx) }));

      const gt = await groundTruth(c, user, perm.searchName, issueKey ? { issueKey } : { projectKey });

      const any = (m: Match) => rows.some((r) => r.matches === m);
      const computed = !user.active ? "denied" : any("yes") ? "granted" : any("conditional") ? "conditional" : any("unknown") ? "unknown" : "denied";
      const definite = (s: string) => s === "granted" || s === "denied";
      const verdict = definite(gt.status) ? gt.status : definite(computed) ? computed : "unknown";
      const agreement = !definite(gt.status) ? "unavailable" : !definite(computed) ? "computed-inconclusive" : gt.status === computed ? "agree" : "disagree";

      if (!user.active) notes.push("The user is inactive and cannot log in, whatever the grants say.");
      if (raw?.deleted) notes.push("The user is marked deleted.");
      if (!user.apps.length) notes.push("The user has no application access (no Jira license); only portal or anonymous access can apply.");
      if (!user.groupsComplete) notes.push("Jira returned only part of the user's groups; group-based matches may be missing.");
      if (!grants.length) notes.push(perm.known ? `The permission scheme has no grant for ${perm.key}.` : `No grant for '${perm.key}' in the scheme; check the permission key.`);
      if (gt.status === "unavailable" || gt.status === "unknown") notes.push(`Jira's own check could not be used: ${gt.detail}; the verdict comes from the grants alone.`);

      let issueOut: Record<string, unknown> | undefined;
      if (issue) {
        const level = issue.fields?.security ? { id: String(issue.fields.security.id), name: issue.fields.security.name } : null;
        let inLevel = "no-level";
        if (level) {
          inLevel = gt.status === "granted" ? "granted-by-ground-truth" : gt.status === "denied" && computed === "granted" ? "likely-not" : "unknown";
          if (inLevel === "likely-not") {
            notes.push(`The scheme grants ${perm.key} but Jira denies it on ${issueKey}: the issue security level '${level.name}' most likely excludes the user (level members are not readable via REST).`);
          } else if (inLevel === "unknown") {
            notes.push(`Issue security level '${level.name}' applies; its members are not readable via REST, so membership is not evaluated.`);
          }
        }
        issueOut = { key: issueKey, securityLevel: level, userInSecurityLevel: inLevel };
      }

      if (agreement === "disagree" && !(issueOut?.userInSecurityLevel === "likely-not")) {
        const unknownHolders = rows.filter((r) => r.matches === "unknown").map((r) => r.holder);
        notes.push(
          `The computed explanation (${computed}) disagrees with Jira's own check (${gt.status}).` +
            (unknownHolders.length ? ` Holders this tool cannot evaluate may explain it: ${unknownHolders.join(", ")}.` : " The cause is outside the evaluated grants (e.g. plugin permission logic or caching)."),
        );
      }
      if (agreement === "computed-inconclusive") {
        notes.push(`The grants alone are ${computed} (issue-dependent or unevaluated holders); Jira's own check decides.`);
      }

      return {
        verdict,
        permission: perm.key,
        project: projectKey,
        user: { name: user.name, key: user.key, active: user.active, applications: user.apps, groupCount: user.groups.size },
        groundTruth: gt,
        computed,
        agreement,
        permissionScheme: { id: scheme?.id ?? null, name: scheme?.name ?? null },
        grants: rows,
        ...(issueOut ? { issue: issueOut } : {}),
        notes,
      };
    },
  },
  {
    name: "jira_user_access_summary",
    aliases: { user: "username" },
    product: "jira",
    description:
      "One user's access: active state, last login, groups, application access, and project roles (direct or via group) " +
      `across a page of projects (all projects, or the given keys). Costs one request per project and role; the page ` +
      `shrinks so that projects x roles stays within ${MAX_ROLE_READS} requests, and roles=... narrows it. Read-only.`,
    narrowing: ["projects", "roles", "limit"],
    inputShape: {
      username: z.string().describe("Username, or user key (JIRAUSER10000)"),
      projects: listArg.optional().describe("Project keys (default: all non-archived projects, paged)"),
      roles: listArg.optional().describe("Only these project roles (names or ids)"),
      ...pageShape(ACCESS_DEFAULT_LIMIT, ACCESS_MAX_LIMIT),
      ...fullListsShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const raw = await requireUser(c, args.username);
      const user = userFacts(raw);

      const allRoles: any[] = (await c.get(`${API}/role`)) ?? [];
      const wanted: string[] | undefined = args.roles?.map((r: string) => r.toLowerCase());
      const roles = wanted ? allRoles.filter((r) => wanted.includes(String(r.id)) || wanted.includes(String(r.name).toLowerCase())) : allRoles;
      if (wanted) {
        const known = new Set(roles.flatMap((r) => [String(r.id), String(r.name).toLowerCase()]));
        const unknown = args.roles.filter((r: string) => !known.has(r.toLowerCase()));
        if (unknown.length) throw new ValidationError(`Unknown project role(s): ${unknown.join(", ")}`);
      }

      const keys: string[] = args.projects
        ? [...new Set<string>(args.projects.map((k: string) => k.toUpperCase()))]
        : ((await c.get(`${API}/project`)) ?? []).map((p: any) => String(p.key));

      const asked = args.limit ?? ACCESS_DEFAULT_LIMIT;
      const budgeted = Math.max(1, Math.floor(MAX_ROLE_READS / Math.max(1, roles.length)));
      const limit = Math.min(asked, budgeted);
      const page = paginate(keys, { offset: args.offset, limit }, limit);

      const reads = page.items.flatMap((key) => roles.map((role) => ({ key, role })));
      const results = await boundedAll(reads.map(({ key, role }) => async () => {
        try {
          return { actors: ((await c.get(`${API}/project/${seg(key)}/role/${seg(role.id)}`))?.actors ?? []) as any[] };
        } catch (e) {
          if (isHttpStatusError(e)) return { error: `HTTP ${e.status}` };
          throw e;
        }
      }));

      const items = page.items.map((key) => {
        const out: { project: string; roles: Array<{ role: string; via: string[] }>; error?: string } = { project: key, roles: [] };
        reads.forEach((r, i) => {
          if (r.key !== key) return;
          const res: any = results[i];
          if (res.error) {
            out.error ??= `role read failed (${res.error})`;
            return;
          }
          const via: string[] = [];
          for (const a of res.actors) {
            if (a.type === "atlassian-user-role-actor" && isUser({ name: a.name, key: a.userKey }, user)) via.push("direct");
            else if (a.type === "atlassian-group-role-actor" && user.groups.has(String(a.name).toLowerCase())) via.push(`group:${a.name}`);
          }
          if (via.length) out.roles.push({ role: String(r.role.name), via: via.sort() });
        });
        out.roles.sort((a, b) => a.role.localeCompare(b.role));
        return out;
      });

      const userOut: Record<string, unknown> = {
        name: user.name,
        key: user.key,
        displayName: raw?.displayName,
        active: user.active,
        deleted: raw?.deleted ?? false,
        lastLoginTime: raw?.lastLoginTime ?? null,
        applications: user.apps,
      };
      capList(userOut, "groups", [...(raw?.groups?.items ?? [])].map((g: any) => String(g.name)).sort(), args.full_lists);
      if (!user.groupsComplete) userOut.groupsPartial = true;

      const limits: Record<string, unknown> = { rolesChecked: roles.length, roleReads: reads.length, maxRoleReads: MAX_ROLE_READS };
      if (limit < asked) limits.note = `Page reduced from ${asked} to ${limit} projects to stay within ${MAX_ROLE_READS} role reads; use nextOffset or roles=... .`;

      return { user: userOut, projectRoles: { ...page, items }, limits };
    },
  },
];
