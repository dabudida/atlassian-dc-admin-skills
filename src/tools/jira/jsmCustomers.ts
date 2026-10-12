/**
 * Jira Service Management customers and organizations.
 *
 * Public Service Desk API of JSM 11.3 (jira-servicedesk-public-rest-api-plugin 21.3.2: OrganizationResource,
 * OrganizationServiceDeskResource, ServiceDeskCustomerResource, CustomerResource); every call sends
 * `X-ExperimentalApi: opt-in`. `GET /servicedesk/{id}/customer` answers 405 and there is no customer removal
 * route, so directly added customers are read from (and removed through) the project role
 * "Service Desk Customers", where JSM keeps them as user actors.
 */

import { z } from "zod";
import { seg, type AtlassianClient } from "../../client.js";
import { isHttpStatusError, ValidationError, VerificationError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { alreadySatisfied, dryRunShape, guardedWrite, listArg, pageShape, serverPage, type WriteRequest } from "../util.js";
import { resolveServiceDesk, type ServiceDesk } from "./requestTypes.js";
import { OPT_IN, SD, sdGet } from "./servicedesk.js";

const PAGE_MAX = 50;
/** Organizations read when an organization is given by name. */
const MAX_ORGS = 5000;
/** Members read for an idempotency check or a read-back. */
const MAX_MEMBERS = 10000;
/** Service desks scanned for links when an organization is deleted. */
const MAX_DESK_SCAN = 100;
const CUSTOMER_ROLE = "Service Desk Customers";

interface Org {
  id: string;
  name: string;
}

const sdArg = z.coerce.string().trim().min(1).describe("Service desk id or project key");
const orgArg = z.coerce.string().trim().min(1).describe("Organization id or exact name");
const usernamesArg = listArg.describe("Usernames, comma-separated");

function compactUser(u: any) {
  return { name: u?.name, key: u?.key, displayName: u?.displayName, email: u?.emailAddress, active: u?.active };
}

/** Every value of a servicedeskapi `{values, isLastPage}` listing, up to `max` items. */
export async function allPages(client: AtlassianClient, path: string, max: number): Promise<{ values: any[]; complete: boolean }> {
  const values: any[] = [];
  for (let start = 0; values.length < max; ) {
    const data = await sdGet(client, path, { start, limit: PAGE_MAX });
    const page: any[] = data?.values ?? [];
    values.push(...page);
    if (!page.length || data?.isLastPage !== false) return { values, complete: true };
    start += page.length;
  }
  return { values: values.slice(0, max), complete: false };
}

/** Usernames as a lowercase → server spelling map (Jira usernames are case-insensitive), and whether the scan was complete. */
export interface Members {
  names: Map<string, string>;
  complete: boolean;
}
export const lc = (u: string) => u.toLowerCase();

/** Usernames of a servicedeskapi user listing, up to `max`. */
export async function memberNames(client: AtlassianClient, path: string, max: number): Promise<Members> {
  const { values, complete } = await allPages(client, path, max);
  return { names: new Map(values.map((u) => [lc(String(u.name)), String(u.name)])), complete };
}

/**
 * Split the wanted usernames by a member scan: members (server spelling), non-members, and those whose
 * membership is unknown because the scan was capped (they are neither claimed members nor non-members).
 */
export function splitMembers(wanted: string[], m: Members) {
  const present = wanted.filter((u) => m.names.has(lc(u)));
  const rest = wanted.filter((u) => !m.names.has(lc(u)));
  return {
    present,
    canonical: present.map((u) => m.names.get(lc(u))!),
    absent: m.complete ? rest : [],
    unknown: m.complete ? [] : rest,
  };
}

/** An organization by numeric id; undefined when there is none. */
async function orgById(client: AtlassianClient, id: string): Promise<Org | undefined> {
  try {
    const o = await sdGet(client, `/organization/${id}`);
    if (o?.id !== undefined) return { id: String(o.id), name: String(o.name) };
  } catch (e) {
    if (!isHttpStatusError(e) || e.status !== 404) throw e;
  }
  return undefined;
}

/**
 * An organization by numeric id, or by exact (case-insensitive) name; undefined when there is none. A number
 * that is one organization's id and another's exact name is ambiguous. When the organization list exceeds
 * MAX_ORGS, a name that is not found is refused rather than reported as missing.
 */
async function findOrganization(client: AtlassianClient, given: string): Promise<Org | undefined> {
  const value = String(given).trim();
  const byId = /^\d+$/.test(value) ? await orgById(client, value) : undefined;
  const { values, complete } = await allPages(client, "/organization", MAX_ORGS);
  const hits = values.filter((o) => String(o.name).toLowerCase() === value.toLowerCase());
  if (byId) {
    const others = hits.filter((o) => String(o.id) !== byId.id);
    if (others.length) {
      throw new ValidationError(
        `Organization '${value}' is ambiguous: it is the id of ${orgLabel(byId)} and the name of ${others.map((o) => `${o.id} (${o.name})`).join(", ")}; pass the id of the other organization or rename it`,
      );
    }
    return byId;
  }
  if (hits.length > 1) throw new ValidationError(`Organization name '${value}' is ambiguous: ${hits.map((o) => `${o.id} (${o.name})`).join(", ")}; pass the id`);
  if (hits.length) return { id: String(hits[0].id), name: String(hits[0].name) };
  if (!complete) throw new ValidationError(`More than ${MAX_ORGS} organizations: '${value}' cannot be looked up by name; pass the id`);
  return undefined;
}

async function requireOrganization(client: AtlassianClient, given: string): Promise<Org> {
  const org = await findOrganization(client, given);
  if (!org) throw new ValidationError(`No organization '${given}'`);
  return org;
}

const orgMembers = (client: AtlassianClient, org: Org) => memberNames(client, `/organization/${org.id}/user`, MAX_MEMBERS);

async function deskOrgIds(client: AtlassianClient, sd: ServiceDesk): Promise<{ ids: Set<string>; complete: boolean }> {
  const { values, complete } = await allPages(client, `/servicedesk/${sd.id}/organization`, MAX_ORGS);
  return { ids: new Set(values.map((o) => String(o.id))), complete };
}

const orgLabel = (o: Org) => `'${o.name}' (${o.id})`;
const unique = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
/** Usernames without blanks and case-insensitive duplicates (one spelling is kept). */
export const uniqueUsers = (xs: string[]) => [...new Map(unique(xs).map((x) => [lc(x), x] as const)).values()];

/** Run several described requests: a dry run lists them (first as `request`, the rest as `followUps`). */
async function sendAll(client: AtlassianClient, args: { dry_run?: boolean }, reqs: WriteRequest[], summary: string, extra: Record<string, unknown> = {}) {
  const described = await Promise.all(reqs.map(async (r) => (await guardedWrite(client, { dry_run: true }, r)).request as Record<string, unknown>));
  if (args.dry_run !== false) {
    return {
      dry_run: true,
      product: client.product,
      summary,
      request: described[0],
      followUps: described.slice(1),
      ...extra,
      note: "Nothing was changed. Confirm with the user, then re-run with dry_run=false.",
    };
  }
  for (const r of reqs) await client.request(r.method, r.path, { params: r.params, json: r.json, headers: r.headers });
  return { dry_run: false, product: client.product, summary, request: described[0], followUps: described.slice(1) };
}

// -- customers role ---------------------------------------------------------------------

interface CustomerRole {
  path: string;
  /** Direct user actors, lowercase username → server spelling. */
  users: Map<string, string>;
}

/** The "Service Desk Customers" role of the desk's project with its direct user actors; undefined without that role. */
async function customerRole(client: AtlassianClient, sd: ServiceDesk): Promise<CustomerRole | undefined> {
  const roles: Record<string, string> = ((await client.get(`/rest/api/2/project/${seg(sd.projectKey)}/role`)) as any) ?? {};
  const entry = Object.entries(roles).find(([name]) => name.toLowerCase() === CUSTOMER_ROLE.toLowerCase());
  if (!entry) return undefined;
  const path = new URL(entry[1], client.url("/")).pathname.replace(/^.*(\/rest\/api\/2\/project\/)/, "$1");
  const role: any = await client.get(path);
  const users = new Map<string, string>((role?.actors ?? []).filter((a: any) => a.type === "atlassian-user-role-actor").map((a: any) => [lc(String(a.name)), String(a.name)]));
  return { path, users };
}

async function existingUser(client: AtlassianClient, email: string): Promise<any | undefined> {
  try {
    const u = await client.get("/rest/api/2/user", { username: email });
    if (u) return u;
  } catch (e) {
    if (!isHttpStatusError(e) || e.status !== 404) throw e;
  }
  const found: any[] = ((await client.get("/rest/api/2/user/search", { username: email, maxResults: 50 })) as any[]) ?? [];
  return found.find((u) => String(u.emailAddress ?? "").toLowerCase() === email.toLowerCase());
}

export const jiraJsmCustomerTools: ToolDef[] = [
  {
    name: "jira_list_organizations",
    product: "jira",
    description: "JSM customer organizations of the instance (id, name), paged. Agents see all; other users only their own.",
    inputShape: { ...pageShape(50, PAGE_MAX) },
    async handler({ client }, args) {
      const offset = args.offset ?? 0;
      const limit = Math.min(args.limit ?? 50, 50);
      const data = await sdGet(client("jira"), "/organization", { start: offset, limit });
      return serverPage((data?.values ?? []).map((o: any) => ({ id: String(o.id), name: o.name })), offset, limit, null, data?.isLastPage ?? true);
    },
  },
  {
    name: "jira_get_organization",
    product: "jira",
    description: "One JSM organization by id or exact name, with a page of its users (compact rows).",
    inputShape: { organization: orgArg, ...pageShape(50, PAGE_MAX) },
    async handler({ client }, args) {
      const c = client("jira");
      const org = await requireOrganization(c, args.organization);
      const offset = args.offset ?? 0;
      const limit = Math.min(args.limit ?? 50, 50);
      const data = await sdGet(c, `/organization/${org.id}/user`, { start: offset, limit });
      return { organization: org, users: serverPage((data?.values ?? []).map(compactUser), offset, limit, null, data?.isLastPage ?? true) };
    },
  },
  {
    name: "jira_list_service_desk_organizations",
    aliases: { service_desk_id: "service_desk" },
    product: "jira",
    description: "Organizations linked to a service desk (id, name), paged.",
    inputShape: { service_desk: sdArg, ...pageShape(50, PAGE_MAX) },
    async handler({ client }, args) {
      const c = client("jira");
      const sd = await resolveServiceDesk(c, args.service_desk);
      const offset = args.offset ?? 0;
      const limit = Math.min(args.limit ?? 50, 50);
      const data = await sdGet(c, `/servicedesk/${sd.id}/organization`, { start: offset, limit });
      return { service_desk: sd.projectKey, ...serverPage((data?.values ?? []).map((o: any) => ({ id: String(o.id), name: o.name })), offset, limit, null, data?.isLastPage ?? true) };
    },
  },
  {
    name: "jira_create_organization",
    product: "jira",
    write: true,
    invalidates: [],
    description: "Create a JSM organization. An organization with that name (case-insensitive) → already-satisfied.",
    inputShape: { name: z.string().trim().min(1), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const summary = `Create organization '${args.name}'`;
      const { values, complete } = await allPages(c, "/organization", MAX_ORGS);
      const existing = values.find((o) => String(o.name).toLowerCase() === args.name.toLowerCase());
      if (existing) return alreadySatisfied(summary, `organization ${existing.id} '${existing.name}' already exists`);
      if (!complete) throw new ValidationError(`More than ${MAX_ORGS} organizations: cannot check that '${args.name}' does not exist yet`);
      const req: WriteRequest = { method: "POST", path: `${SD}/organization`, json: { name: args.name }, headers: OPT_IN, summary };
      if (args.dry_run !== false) return guardedWrite(c, args, req);
      const sent = await guardedWrite(c, args, req);
      const createdId = (sent as any).result?.id;
      const back = createdId !== undefined && createdId !== null
        ? await orgById(c, String(createdId))
        : (await allPages(c, "/organization", MAX_ORGS)).values.find((o) => o.name === args.name);
      if (!back || back.name !== args.name) throw new VerificationError(`${summary}: the organization does not read back`, (sent as any).result);
      return { ...sent, result: { id: String(back.id), name: back.name } };
    },
  },
  {
    name: "jira_delete_organization",
    product: "jira",
    write: true,
    invalidates: [],
    description:
      "Delete a JSM organization (id or exact name). IRREVERSIBLE: it disappears from every service desk and its user " +
      "memberships are dropped. The dry run lists linked service desks. Already gone → already-satisfied.",
    inputShape: { organization: orgArg, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const org = await findOrganization(c, args.organization);
      if (!org) return alreadySatisfied(`Delete organization '${args.organization}'`, "no such organization");
      const desks = await allPages(c, "/servicedesk", MAX_DESK_SCAN);
      const linked: string[] = [];
      let scanComplete = desks.complete;
      for (const d of desks.values) {
        const links = await deskOrgIds(c, { id: String(d.id), projectId: String(d.projectId), projectKey: String(d.projectKey), name: String(d.projectName) });
        if (links.ids.has(org.id)) linked.push(String(d.projectKey));
        scanComplete &&= links.complete;
      }
      const users = await sdGet(c, `/organization/${org.id}/user`, { start: 0, limit: 1 });
      const hasUsers = (users?.values ?? []).length > 0;
      const summary =
        `Delete organization ${orgLabel(org)} — IRREVERSIBLE: removes it from ${linked.length} service desk(s)` +
        `${linked.length ? ` (${linked.join(", ")})` : ""}${hasUsers ? " and drops all its user memberships" : ""}`;
      const req: WriteRequest = { method: "DELETE", path: `${SD}/organization/${org.id}`, headers: OPT_IN, summary };
      const evidence = { linked_service_desks: linked, desk_scan_complete: scanComplete, has_users: hasUsers };
      if (args.dry_run !== false) return { ...(await guardedWrite(c, args, req)), ...evidence };
      const sent = await guardedWrite(c, args, req);
      if (await orgById(c, org.id)) throw new VerificationError(`${summary}: the organization still exists`);
      return { ...sent, result: { id: org.id, deleted: true } };
    },
  },
  {
    name: "jira_add_organization_users",
    product: "jira",
    write: true,
    invalidates: [],
    description: "Add users (usernames) to a JSM organization. Only non-members are sent; all members → already-satisfied.",
    inputShape: { organization: orgArg, usernames: usernamesArg, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const org = await requireOrganization(c, args.organization);
      const wanted = uniqueUsers(args.usernames);
      if (!wanted.length) throw new ValidationError("Pass at least one username");
      const before = splitMembers(wanted, await orgMembers(c, org));
      // users not seen in a capped scan may already be members; adding a member again is harmless
      const missing = [...before.absent, ...before.unknown];
      const summary = `Add ${missing.length || wanted.length} user(s) to organization ${orgLabel(org)}`;
      if (!missing.length) return alreadySatisfied(summary, "all users are already members");
      const req: WriteRequest = { method: "POST", path: `${SD}/organization/${org.id}/user`, json: { usernames: missing }, headers: OPT_IN, summary };
      if (args.dry_run !== false) return { ...(await guardedWrite(c, args, req)), already_members: before.present };
      const sent = await guardedWrite(c, args, req);
      const after = splitMembers(missing, await orgMembers(c, org));
      if (after.absent.length) throw new VerificationError(`${summary}: not members afterwards: ${after.absent.join(", ")}`);
      const result = { organization: org.id, added: missing };
      if (after.unknown.length) return { ...sent, verification: "partial", unverified: after.unknown, warning: `the organization has more than ${MAX_MEMBERS} members; these users were not seen in the read-back`, result };
      return { ...sent, result };
    },
  },
  {
    name: "jira_remove_organization_users",
    product: "jira",
    write: true,
    invalidates: [],
    description: "Remove users (usernames) from a JSM organization. Only members are sent; none are members → already-satisfied.",
    inputShape: { organization: orgArg, usernames: usernamesArg, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const org = await requireOrganization(c, args.organization);
      const wanted = uniqueUsers(args.usernames);
      if (!wanted.length) throw new ValidationError("Pass at least one username");
      const before = splitMembers(wanted, await orgMembers(c, org));
      if (before.unknown.length) {
        throw new ValidationError(`Organization ${orgLabel(org)} has more than ${MAX_MEMBERS} members: cannot tell whether ${before.unknown.join(", ")} ${before.unknown.length > 1 ? "are members" : "is a member"}`);
      }
      const present = before.canonical;
      const summary = `Remove ${present.length || wanted.length} user(s) from organization ${orgLabel(org)}`;
      if (!present.length) return alreadySatisfied(summary, "none of the users is a member");
      const req: WriteRequest = { method: "DELETE", path: `${SD}/organization/${org.id}/user`, json: { usernames: present }, headers: OPT_IN, summary };
      if (args.dry_run !== false) return { ...(await guardedWrite(c, args, req)), not_members: before.absent };
      const sent = await guardedWrite(c, args, req);
      const after = splitMembers(present, await orgMembers(c, org));
      if (after.present.length) throw new VerificationError(`${summary}: still members afterwards: ${after.present.join(", ")}`);
      const result = { organization: org.id, removed: present };
      if (after.unknown.length) return { ...sent, verification: "partial", unverified: after.unknown, warning: `the organization has more than ${MAX_MEMBERS} members; removal of these users could not be confirmed`, result };
      return { ...sent, result };
    },
  },
  {
    name: "jira_add_service_desk_organizations",
    aliases: { service_desk_id: "service_desk", organization: "organizations" },
    product: "jira",
    write: true,
    invalidates: [],
    description: "Link organizations (ids or exact names) to a service desk; one request per organization not yet linked.",
    inputShape: { service_desk: sdArg, organizations: listArg.describe("Organization ids or exact names, comma-separated"), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const sd = await resolveServiceDesk(c, args.service_desk);
      const given = unique(args.organizations);
      if (!given.length) throw new ValidationError("Pass at least one organization");
      const orgs: Org[] = [];
      for (const g of given) {
        const o = await requireOrganization(c, g);
        if (!orgs.some((x) => x.id === o.id)) orgs.push(o);
      }
      const { ids: linked } = await deskOrgIds(c, sd);
      // organizations not seen in a capped scan may already be linked; linking again is harmless
      const missing = orgs.filter((o) => !linked.has(o.id));
      const summary = `Link ${missing.length ? missing.map(orgLabel).join(", ") : `${orgs.length} organization(s)`} to service desk ${sd.projectKey}`;
      if (!missing.length) return alreadySatisfied(summary, "all organizations are already linked");
      const reqs: WriteRequest[] = missing.map((o) => ({ method: "POST", path: `${SD}/servicedesk/${sd.id}/organization`, json: { organizationId: Number(o.id) }, headers: OPT_IN, summary: `Link ${orgLabel(o)} to ${sd.projectKey}` }));
      const out = await sendAll(c, args, reqs, summary, { already_linked: orgs.filter((o) => linked.has(o.id)).map((o) => o.name) });
      if (args.dry_run !== false) return out;
      const after = await deskOrgIds(c, sd);
      const absent = missing.filter((o) => !after.ids.has(o.id));
      const result = { service_desk: sd.projectKey, linked: missing.map((o) => o.id) };
      if (absent.length && after.complete) throw new VerificationError(`${summary}: not linked afterwards: ${absent.map(orgLabel).join(", ")}`);
      if (absent.length) return { ...out, verification: "partial", unverified: absent.map((o) => o.id), warning: `the service desk has more than ${MAX_ORGS} organizations; these links were not seen in the read-back`, result };
      return { ...out, result };
    },
  },
  {
    name: "jira_remove_service_desk_organization",
    aliases: { service_desk_id: "service_desk" },
    product: "jira",
    write: true,
    invalidates: [],
    description: "Unlink an organization (id or exact name) from a service desk. Not linked → already-satisfied.",
    inputShape: { service_desk: sdArg, organization: orgArg, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const sd = await resolveServiceDesk(c, args.service_desk);
      const org = await requireOrganization(c, args.organization);
      const summary = `Unlink organization ${orgLabel(org)} from service desk ${sd.projectKey}`;
      const before = await deskOrgIds(c, sd);
      if (!before.ids.has(org.id)) {
        if (!before.complete) throw new ValidationError(`Service desk ${sd.projectKey} has more than ${MAX_ORGS} organizations: cannot tell whether ${orgLabel(org)} is linked`);
        return alreadySatisfied(summary, "the organization is not linked");
      }
      const req: WriteRequest = { method: "DELETE", path: `${SD}/servicedesk/${sd.id}/organization`, json: { organizationId: Number(org.id) }, headers: OPT_IN, summary };
      if (args.dry_run !== false) return guardedWrite(c, args, req);
      const sent = await guardedWrite(c, args, req);
      const after = await deskOrgIds(c, sd);
      if (after.ids.has(org.id)) throw new VerificationError(`${summary}: still linked afterwards`);
      const result = { service_desk: sd.projectKey, unlinked: org.id };
      if (!after.complete) return { ...sent, verification: "partial", warning: `the service desk has more than ${MAX_ORGS} organizations; the unlink could not be confirmed`, result };
      return { ...sent, result };
    },
  },
  {
    name: "jira_add_service_desk_customers",
    aliases: { service_desk_id: "service_desk" },
    product: "jira",
    write: true,
    invalidates: [],
    description:
      "Add existing users (usernames) as customers of a service desk. Membership is checked and read back through the " +
      `project role '${CUSTOMER_ROLE}' (direct user actors only; group or organization access is not seen). ` +
      "Without that role the result says verification: unverifiable.",
    inputShape: { service_desk: sdArg, usernames: usernamesArg, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const sd = await resolveServiceDesk(c, args.service_desk);
      const wanted = uniqueUsers(args.usernames);
      if (!wanted.length) throw new ValidationError("Pass at least one username");
      const role = await customerRole(c, sd);
      const already = role ? wanted.filter((u) => role.users.has(lc(u))) : [];
      const missing = wanted.filter((u) => !already.includes(u));
      const summary = `Add ${missing.length || wanted.length} customer(s) to service desk ${sd.projectKey}`;
      if (!missing.length) return alreadySatisfied(summary, `all users are already direct members of '${CUSTOMER_ROLE}'`);
      const req: WriteRequest = { method: "POST", path: `${SD}/servicedesk/${sd.id}/customer`, json: { usernames: missing }, headers: OPT_IN, summary };
      const verification = role ? "verified" : "unverifiable";
      const warning = role ? undefined : `project ${sd.projectKey} has no '${CUSTOMER_ROLE}' role, so existing customers cannot be read and the result cannot be read back; a repeated apply sends the request again`;
      if (args.dry_run !== false) return { ...(await guardedWrite(c, args, req)), already_customers: already, verification: role ? "checked" : verification, warning };
      const sent = await guardedWrite(c, args, req);
      if (role) {
        const after = await customerRole(c, sd);
        const absent = missing.filter((u) => !after?.users.has(lc(u)));
        if (absent.length) throw new VerificationError(`${summary}: not in '${CUSTOMER_ROLE}' afterwards: ${absent.join(", ")}`);
      }
      return { ...sent, verification, warning, result: { service_desk: sd.projectKey, added: missing } };
    },
  },
  {
    name: "jira_remove_service_desk_customers",
    aliases: { service_desk_id: "service_desk" },
    product: "jira",
    write: true,
    invalidates: [],
    description:
      `Remove customers (usernames) from a service desk by deleting their user actor from the project role '${CUSTOMER_ROLE}' ` +
      "(the public API has no removal route). Users who are not direct actors (group, organization access) are reported, not changed.",
    inputShape: { service_desk: sdArg, usernames: usernamesArg, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const sd = await resolveServiceDesk(c, args.service_desk);
      const wanted = uniqueUsers(args.usernames);
      if (!wanted.length) throw new ValidationError("Pass at least one username");
      const role = await customerRole(c, sd);
      if (!role) throw new ValidationError(`Project ${sd.projectKey} has no '${CUSTOMER_ROLE}' role; customers cannot be removed through the API`);
      // DELETE ?user= takes the actor's server spelling
      const present = wanted.filter((u) => role.users.has(lc(u))).map((u) => role.users.get(lc(u))!);
      const notDirect = wanted.filter((u) => !role.users.has(lc(u)));
      const summary = `Remove ${present.length || wanted.length} customer(s) from service desk ${sd.projectKey}`;
      if (!present.length) return alreadySatisfied(summary, `none of the users is a direct member of '${CUSTOMER_ROLE}'`, { not_direct_customers: notDirect });
      const reqs: WriteRequest[] = present.map((u) => ({ method: "DELETE", path: role.path, params: { user: u }, summary: `Remove ${u} from '${CUSTOMER_ROLE}' of ${sd.projectKey}` }));
      const out = await sendAll(c, args, reqs, summary, { not_direct_customers: notDirect });
      if (args.dry_run !== false) return out;
      const after = await customerRole(c, sd);
      const still = present.filter((u) => after?.users.has(lc(u)));
      if (still.length) throw new VerificationError(`${summary}: still in '${CUSTOMER_ROLE}' afterwards: ${still.join(", ")}`);
      return { ...out, not_direct_customers: notDirect, result: { service_desk: sd.projectKey, removed: present } };
    },
  },
  {
    name: "jira_create_customer",
    product: "jira",
    write: true,
    invalidates: [],
    description:
      "Create a JSM customer account (username = e-mail; no invitation is sent; Jira administrator needed). " +
      "A user with that username or e-mail → already-satisfied. Add it to a desk with jira_add_service_desk_customers.",
    inputShape: { email: z.string().trim().email(), display_name: z.string().trim().min(1).describe("Full name shown in Jira"), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const summary = `Create customer ${args.email}`;
      const existing = await existingUser(c, args.email);
      if (existing) return alreadySatisfied(summary, `user '${existing.name}' already has this username or e-mail`, { user: compactUser(existing) });
      const req: WriteRequest = { method: "POST", path: `${SD}/customer`, json: { email: args.email, fullName: args.display_name }, headers: OPT_IN, summary };
      if (args.dry_run !== false) return guardedWrite(c, args, req);
      const sent = await guardedWrite(c, args, req);
      const back = await existingUser(c, args.email);
      if (!back) throw new VerificationError(`${summary}: the customer does not read back`, (sent as any).result);
      return { ...sent, result: compactUser(back) };
    },
  },
];
