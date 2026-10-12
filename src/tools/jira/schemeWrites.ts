/**
 * Jira DC notification scheme and issue security scheme changes.
 *
 * Jira DC 11.3 publishes no REST write for either scheme type: the WADL (`/rest/api/2/application.wadl`)
 * has only `GET /notificationscheme[/{id}]`, `GET /issuesecurityschemes[/{id}]`, `GET /securitylevel/{id}`
 * and the project reads `GET /project/{key}/notificationscheme|issuesecuritylevelscheme|securitylevel`.
 * Their admin pages (AddNotification, DeleteNotification, AddNotificationScheme, AddIssueSecurityScheme,
 * EditIssueSecurities, AddIssueSecurity, SelectProjectIssueSecurityScheme) all sit behind websudo, which a
 * personal access token cannot pass. So scheme contents are manual changes with exact steps, verified on a
 * re-run where a REST read exists (issue security level members have none).
 *
 * The one REST write is assigning an issue security scheme to a project: `PUT /project/{key}` with
 * `issueSecurityScheme` (documented ProjectInputBean field), read back through
 * `GET /project/{key}/issuesecuritylevelscheme`, and only for a project without a scheme. A switch from
 * an existing scheme may need Jira's level remapping (a search count cannot see issues hidden from the
 * caller), so it is always a manual change. Assigning a notification scheme is
 * `jira_assign_project_scheme scheme_type=notification`.
 */

import { z } from "zod";
import { seg, type AtlassianClient } from "../../client.js";
import { isHttpStatusError, ValidationError, VerificationError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { alreadySatisfied, boolArg, dryRunShape, guardedWrite } from "../util.js";
import { manualStep, WEBSUDO_ONLY } from "./manualSteps.js";

const API = "/rest/api/2";
const MAX_SCHEMES = 1000;

/** Notification recipient types of Jira DC, with their UI label and whether they take a parameter. */
const RECIPIENTS = {
  CurrentAssignee: { label: "Current Assignee", param: false },
  Reporter: { label: "Reporter", param: false },
  CurrentUser: { label: "Current User", param: false },
  ProjectLead: { label: "Project Lead", param: false },
  ComponentLead: { label: "Component Lead", param: false },
  AllWatchers: { label: "All Watchers", param: false },
  User: { label: "Single User", param: true },
  Group: { label: "Group", param: true },
  ProjectRole: { label: "Project Role", param: true },
  EmailAddress: { label: "Single Email Address", param: true },
  UserCustomField: { label: "User Custom Field Value", param: true },
  GroupCustomField: { label: "Group Custom Field Value", param: true },
} as const;
type RecipientType = keyof typeof RECIPIENTS;
const RECIPIENT_TYPES = Object.keys(RECIPIENTS) as [RecipientType, ...RecipientType[]];

/** Issue security level member types as the "Add User/Group/Project Role to Issue Security Level" page names them. */
const MEMBERS = {
  reporter: { label: "Reporter", param: false },
  current_assignee: { label: "Current Assignee", param: false },
  project_lead: { label: "Project Lead", param: false },
  application_role: { label: "Application access", param: false },
  user: { label: "Single User", param: true },
  group: { label: "Group", param: true },
  project_role: { label: "Project Role", param: true },
  user_custom_field: { label: "User Custom Field Value", param: true },
  group_custom_field: { label: "Group Custom Field Value", param: true },
} as const;
type MemberType = keyof typeof MEMBERS;

// -- reads -------------------------------------------------------------------------

function pickByIdOrName<T extends { id: unknown; name?: unknown }>(items: T[], given: string, what: string): T | undefined {
  const v = String(given).trim();
  const byId = items.find((x) => String(x.id) === v);
  if (byId) return byId;
  const byName = items.filter((x) => String(x.name ?? "").toLowerCase() === v.toLowerCase());
  if (byName.length > 1) throw new ValidationError(`${what} name '${v}' is ambiguous; pass the id`);
  return byName[0];
}

async function notificationSchemes(c: AtlassianClient): Promise<Array<{ id: number; name: string }>> {
  const items = await c.getPaged(`${API}/notificationscheme`, "values", {}, 50, MAX_SCHEMES);
  return items.map((s: any) => ({ id: Number(s.id), name: String(s.name ?? "") }));
}

async function notificationScheme(c: AtlassianClient, given: string): Promise<any> {
  const hit = pickByIdOrName(await notificationSchemes(c), given, "Notification scheme");
  if (!hit) throw new ValidationError(`No notification scheme '${given}'`);
  return c.get(`${API}/notificationscheme/${hit.id}`, { expand: "all" });
}

/** An event of the scheme by id or exact name; a bare id the scheme does not list yet is accepted as is. */
function pickEvent(scheme: any, given: string): { id: number; name: string; notifications: any[] } {
  const events = (scheme?.notificationSchemeEvents ?? []).map((e: any) => ({ id: Number(e.event?.id), name: String(e.event?.name ?? ""), notifications: e.notifications ?? [] }));
  const hit = pickByIdOrName<{ id: number; name: string; notifications: any[] }>(events, given, "Event");
  if (hit) return hit;
  if (/^\d+$/.test(String(given).trim())) return { id: Number(given), name: `event ${given}`, notifications: [] };
  throw new ValidationError(`Event '${given}' is not in notification scheme '${scheme?.name}' (known: ${events.map((e: any) => e.name).join(", ")}); pass the event id`);
}

/** A recipient as Jira stores it: `param` is the stored parameter, `username` the given name of a Single User. */
interface Recipient {
  param: string | undefined;
  username?: string;
}

/**
 * The stored parameter for a recipient: a project role by id or exact name becomes its id, and a
 * Single User becomes the user KEY (Jira DC stores `User` recipients by key, e.g. JIRAUSER10100).
 */
async function recipientParameter(c: AtlassianClient, type: RecipientType, given: string | undefined): Promise<Recipient> {
  const spec = RECIPIENTS[type];
  if (spec.param && (given === undefined || given === "")) throw new ValidationError(`recipient_type ${type} needs a recipient (${spec.label})`);
  if (!spec.param && given !== undefined && given !== "") throw new ValidationError(`recipient_type ${type} takes no recipient`);
  if (type === "User") {
    let user: any;
    try {
      user = await c.get(`${API}/user`, { username: String(given) });
    } catch (e) {
      if (isHttpStatusError(e) && e.status === 404) throw new ValidationError(`User '${given}' does not exist`);
      throw e;
    }
    if (!user?.key) throw new ValidationError(`User '${given}' does not exist`);
    return { param: String(user.key), username: String(given) };
  }
  if (type !== "ProjectRole") return { param: spec.param ? String(given) : undefined };
  const roles: any[] = ((await c.get(`${API}/role`)) as any[]) ?? [];
  const role = pickByIdOrName(roles, String(given), "Project role");
  if (!role) throw new ValidationError(`Project role '${given}' does not exist`);
  return { param: String(role.id) };
}

/** Whether a stored notification is this recipient; Single Users match by key (or by a returned user name). */
function matches(n: any, type: string, who: Recipient): boolean {
  if (n.notificationType !== type) return false;
  if (who.param === undefined || String(n.parameter ?? "") === who.param) return true;
  if (type !== "User") return false;
  if (n.user?.key !== undefined && String(n.user.key) === who.param) return true;
  return !!who.username && n.user?.name !== undefined && String(n.user.name).toLowerCase() === who.username.toLowerCase();
}
const recipientLabel = (type: RecipientType, shown: string | undefined) => (shown ? `${type}:${shown}` : type);

async function securitySchemes(c: AtlassianClient): Promise<Array<{ id: number; name: string }>> {
  const data = await c.get(`${API}/issuesecurityschemes`);
  return (data?.issueSecuritySchemes ?? []).map((s: any) => ({ id: Number(s.id), name: String(s.name ?? "") }));
}

async function securityScheme(c: AtlassianClient, given: string): Promise<any> {
  const hit = pickByIdOrName(await securitySchemes(c), given, "Issue security scheme");
  if (!hit) throw new ValidationError(`No issue security scheme '${given}'`);
  return c.get(`${API}/issuesecurityschemes/${hit.id}`);
}

/** The project's issue security scheme as {id, name}, or null (Jira answers 404 when there is none). */
async function projectSecurityScheme(c: AtlassianClient, key: string): Promise<{ id: number; name?: string } | null> {
  try {
    const s = await c.get(`${API}/project/${seg(key)}/issuesecuritylevelscheme`);
    return s?.id != null ? { id: Number(s.id), name: s.name } : null;
  } catch (e) {
    if (isHttpStatusError(e) && e.status === 404) return null;
    throw e;
  }
}

// -- tools -------------------------------------------------------------------------

const notificationArgs = {
  scheme: z.coerce.string().min(1).describe("Notification scheme id or exact name"),
  event: z.coerce.string().min(1).describe("Event id or exact name (e.g. Issue Created)"),
  recipient_type: z.enum(RECIPIENT_TYPES),
  recipient: z.coerce.string().optional().describe("Username, group name, project role id or name, email address or customfield_N (types that take one)"),
};

export const jiraSchemeWriteTools: ToolDef[] = [
  {
    name: "jira_create_notification_scheme",
    product: "jira",
    write: true,
    invalidates: [],
    description:
      "Create an empty notification scheme. Jira DC has no REST write for notification schemes, so this is a manual change " +
      "on the admin page (re-run to verify). Same name exists → already-satisfied.",
    inputShape: { name: z.string().trim().min(1), description: z.string().optional(), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const summary = `Create notification scheme '${args.name}'`;
      const hit = (await notificationSchemes(c)).find((s) => s.name.toLowerCase() === args.name.toLowerCase());
      if (hit) return alreadySatisfied(summary, `notification scheme ${hit.id} '${hit.name}' exists`, { id: hit.id });
      const steps = [`Name: '${args.name}'`, ...(args.description ? [`Description: '${args.description}'`] : []), "Click Add", "Add notifications with jira_add_notification"];
      return manualStep(c, args, { summary, reason: WEBSUDO_ONLY, page: "/secure/admin/AddNotificationScheme!default.jspa", steps, identity: { op: "create-notification-scheme", name: args.name }, state: { exists: false } });
    },
  },
  {
    name: "jira_add_notification",
    product: "jira",
    write: true,
    invalidates: [],
    description:
      "Notify a recipient on an event of a notification scheme. Jira DC has no REST write for it, so this is a manual change " +
      "with the admin page and steps (re-run to verify). Already notified → already-satisfied.",
    inputShape: { ...notificationArgs, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const type = args.recipient_type as RecipientType;
      const scheme = await notificationScheme(c, args.scheme);
      const event = pickEvent(scheme, args.event);
      const recipient = await recipientParameter(c, type, args.recipient);
      const param = recipient.param;
      const who = recipientLabel(type, args.recipient);
      const summary = `Notify ${who} on '${event.name}' in notification scheme '${scheme.name}'`;
      if (event.notifications.some((n) => matches(n, type, recipient))) return alreadySatisfied(summary, "the scheme already notifies this recipient on this event");
      const steps = [`Events: select '${event.name}'`, `Choose '${RECIPIENTS[type].label}'${args.recipient ? ` and enter '${args.recipient}'` : ""}`, "Click Add"];
      return manualStep(c, args, {
        summary,
        reason: WEBSUDO_ONLY,
        page: "/secure/admin/AddNotification!default.jspa",
        params: { schemeId: scheme.id },
        steps,
        identity: { op: "add-notification", scheme: scheme.id, event: event.id, type, parameter: param ?? null },
        state: { present: false },
      });
    },
  },
  {
    name: "jira_remove_notification",
    product: "jira",
    write: true,
    invalidates: [],
    description:
      "Stop notifying a recipient on an event of a notification scheme: a manual change with the delete link " +
      "(Jira DC has no REST write; re-run to verify). Not notified → already-satisfied.",
    inputShape: { ...notificationArgs, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const type = args.recipient_type as RecipientType;
      const scheme = await notificationScheme(c, args.scheme);
      const event = pickEvent(scheme, args.event);
      const recipient = await recipientParameter(c, type, args.recipient);
      const param = recipient.param;
      const summary = `Stop notifying ${recipientLabel(type, args.recipient)} on '${event.name}' in notification scheme '${scheme.name}'`;
      const hit = event.notifications.find((n) => matches(n, type, recipient));
      if (!hit) return alreadySatisfied(summary, "the scheme does not notify this recipient on this event");
      return manualStep(c, args, {
        summary,
        reason: WEBSUDO_ONLY,
        page: "/secure/admin/DeleteNotification!default.jspa",
        params: { id: hit.id, schemeId: scheme.id },
        steps: [`Confirm deleting notification ${hit.id} ('${RECIPIENTS[type].label}'${args.recipient ? ` '${args.recipient}'` : ""} on '${event.name}')`],
        identity: { op: "remove-notification", scheme: scheme.id, event: event.id, type, parameter: param ?? null },
        state: { notificationId: Number(hit.id) },
      });
    },
  },
  {
    name: "jira_create_issue_security_scheme",
    product: "jira",
    write: true,
    invalidates: [],
    description:
      "Create an issue security scheme. Jira DC has no REST write for it, so this is a manual change on the admin page " +
      "(re-run to verify). Same name exists → already-satisfied.",
    inputShape: { name: z.string().trim().min(1), description: z.string().optional(), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const summary = `Create issue security scheme '${args.name}'`;
      const hit = (await securitySchemes(c)).find((s) => s.name.toLowerCase() === args.name.toLowerCase());
      if (hit) return alreadySatisfied(summary, `issue security scheme ${hit.id} '${hit.name}' exists`, { id: hit.id });
      const steps = [`Name: '${args.name}'`, ...(args.description ? [`Description: '${args.description}'`] : []), "Click Add", "Add levels with jira_add_issue_security_level"];
      return manualStep(c, args, { summary, reason: WEBSUDO_ONLY, page: "/secure/admin/AddIssueSecurityScheme!default.jspa", steps, identity: { op: "create-issue-security-scheme", name: args.name }, state: { exists: false } });
    },
  },
  {
    name: "jira_add_issue_security_level",
    product: "jira",
    write: true,
    invalidates: [],
    description:
      "Add a security level to an issue security scheme: a manual change on the scheme's levels page (Jira DC has no " +
      "REST write; re-run to verify). Level exists → already-satisfied.",
    inputShape: {
      scheme: z.coerce.string().min(1).describe("Issue security scheme id or exact name"),
      name: z.string().trim().min(1),
      description: z.string().optional(),
      make_default: boolArg.optional().describe("Also make it the scheme's default level"),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const s = await securityScheme(c, args.scheme);
      const summary = `Add security level '${args.name}' to issue security scheme '${s.name}'`;
      const hit = (s.levels ?? []).find((l: any) => String(l.name).toLowerCase() === args.name.toLowerCase());
      if (hit && (!args.make_default || Number(s.defaultSecurityLevelId) === Number(hit.id))) return alreadySatisfied(summary, `level ${hit.id} '${hit.name}' exists`, { id: Number(hit.id) });
      const steps = [
        ...(hit ? [] : [`In 'Add Security Level' enter name '${args.name}'`, ...(args.description ? [`Description: '${args.description}'`] : []), "Click Add Security Level"]),
        ...(args.make_default ? [`Click 'Default' next to '${args.name}'`] : []),
        "Add members with jira_add_issue_security_level_member",
      ];
      return manualStep(c, args, {
        summary,
        reason: WEBSUDO_ONLY,
        page: "/secure/admin/EditIssueSecurities!default.jspa",
        params: { schemeId: s.id },
        steps,
        identity: { op: "add-issue-security-level", scheme: Number(s.id), name: args.name, default: !!args.make_default },
        state: { exists: !!hit, default: s.defaultSecurityLevelId ?? null },
      });
    },
  },
  {
    name: "jira_add_issue_security_level_member",
    product: "jira",
    write: true,
    invalidates: [],
    unverifiable: "Jira DC has no REST read of issue security level members, so the tool cannot detect an existing member or verify the change",
    description:
      "Give a user, group, project role or other holder an issue security level: a manual change with the admin page and steps. " +
      "Jira DC has neither a REST write nor a REST read of level members, so check the result in the UI.",
    inputShape: {
      scheme: z.coerce.string().min(1).describe("Issue security scheme id or exact name"),
      level: z.coerce.string().min(1).describe("Security level id or exact name"),
      member_type: z.enum(Object.keys(MEMBERS) as [MemberType, ...MemberType[]]),
      member: z.coerce.string().optional().describe("Username, group name, project role name or customfield_N (types that take one)"),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const type = args.member_type as MemberType;
      const spec = MEMBERS[type];
      if (spec.param && !args.member) throw new ValidationError(`member_type ${type} needs a member (${spec.label})`);
      if (!spec.param && args.member) throw new ValidationError(`member_type ${type} takes no member`);
      const s = await securityScheme(c, args.scheme);
      const level = pickByIdOrName<any>(s.levels ?? [], args.level, "Security level");
      if (!level) throw new ValidationError(`Security level '${args.level}' is not in issue security scheme '${s.name}' (known: ${(s.levels ?? []).map((l: any) => l.name).join(", ")})`);
      const who = args.member ? `${type}:${args.member}` : type;
      return manualStep(c, args, {
        summary: `Add ${who} to security level '${level.name}' of issue security scheme '${s.name}'`,
        reason: `${WEBSUDO_ONLY}; Jira DC also has no REST read of level members`,
        page: "/secure/admin/AddIssueSecurity!default.jspa",
        params: { schemeId: s.id },
        steps: [`Security level: '${level.name}'`, `Choose '${spec.label}'${args.member ? ` and enter '${args.member}'` : ""}`, "Click Add"],
        identity: { op: "add-issue-security-level-member", scheme: Number(s.id), level: Number(level.id), type, member: args.member ?? null },
        state: null,
        unverifiable: true,
      });
    },
  },
  {
    name: "jira_assign_issue_security_scheme",
    product: "jira",
    write: true,
    invalidates: [],
    description:
      "Assign an issue security scheme (id or exact name) to a project through PUT /project/{key} and read it back. " +
      "Already assigned → already-satisfied. A project that already has an issue security scheme needs Jira's level " +
      "remapping to switch, so that is always a manual change in the UI (issue counts cannot see hidden issues).",
    inputShape: { project_key: z.string().trim().min(1), scheme: z.coerce.string().min(1).describe("Issue security scheme id or exact name"), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const key = args.project_key;
      const [project, target, current] = await Promise.all([c.get(`${API}/project/${seg(key)}`), securityScheme(c, args.scheme), projectSecurityScheme(c, key)]);
      const targetId = Number(target.id);
      const summary = `Assign issue security scheme ${targetId} '${target.name}' to project ${key}`;
      if (current?.id === targetId) return alreadySatisfied(summary, `project ${key} already uses issue security scheme '${target.name}'`);
      const identity = { op: "assign-issue-security-scheme", project: key, scheme: targetId };
      // A switch away from an existing scheme is always the UI remapping: a /search count of secured issues
      // only sees issues the caller may browse, so it cannot prove that no issue carries a level.
      if (current) {
        return manualStep(c, args, {
          summary,
          reason: `project ${key} already uses issue security scheme '${current.name ?? current.id}'; issues may carry its security levels (also ones this account cannot see), which Jira remaps only in the UI; this tool never changes issue security levels`,
          page: "/secure/project/SelectProjectIssueSecurityScheme!default.jspa",
          params: { projectId: project?.id },
          steps: [`Scheme: '${target.name}'`, "Click Next", "Map each old security level to a level of the new scheme (or None)", "Click Associate"],
          identity,
          state: { current: current.id },
          extra: { before: current, after: { id: targetId, name: target.name } },
        });
      }
      const req = { method: "PUT" as const, path: `${API}/project/${seg(key)}`, json: { issueSecurityScheme: targetId }, summary };
      if (args.dry_run !== false) return { ...(await guardedWrite(c, args, req)), before: null, after: { id: targetId, name: target.name }, identity, state: { current: null } };
      const result = await guardedWrite(c, args, req);
      const back = await projectSecurityScheme(c, key);
      if (back?.id !== targetId) throw new VerificationError(`${summary}: the project reads back with issue security scheme ${back?.id ?? "(none)"}`, back);
      return { ...result, result: { project: key, scheme: back } };
    },
  },
];
