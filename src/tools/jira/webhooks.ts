/**
 * Jira DC webhooks: list, read, create, change, enable/disable and delete.
 *
 * Jira DC 10+ serves webhooks from the jira-webhook plugin at `/rest/jira-webhook/1.0/webhooks`
 * (GET list with `event`/`start`/`limit`, POST create, GET/PUT/DELETE `/{webhookId}`; checked in the
 * plugin's application.wadl on 11.3). The legacy `/rest/webhooks/1.0/webhook` route answers a
 * personal access token with the login page, so it is not used.
 *
 * The payload is the one the Jira admin page sends (its Backbone model): `{name, url, events[],
 * active, scopeType: "global", configuration: {FILTERS?, DESCRIPTION?, SECRET?, EXCLUDE_BODY}}`
 * where EXCLUDE_BODY is the string "true"/"false" and empty FILTERS/DESCRIPTION/SECRET are omitted.
 * The admin page toggles enabled state by saving the full model with another `active`, so updates
 * and enable/disable always PUT the full merged model.
 *
 * Webhook URLs can carry credentials (user:password@host, token query parameters, tokens in the path
 * as Slack/Teams/Discord use) and the configuration can hold a signing secret: every value this module
 * returns masks them, and the write tools declare them as sensitive arguments, so `--plan` (which
 * stores arguments in plain text) refuses them and re-plan hints redact them.
 *
 * Unverified: whether GET returns SECRET in plain text. A plain value is reused for the full-model
 * PUT; a masked one (only mask characters, or only a flag) is never written back: update and
 * enable/disable then require the caller to pass `secret`.
 */

import { z } from "zod";
import type { AtlassianClient } from "../../client.js";
import { isHttpStatusError, ValidationError, VerificationError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { alreadySatisfied, boolArg, contains, dryRunShape, guardedWrite, listArg, pageShape, paginate } from "../util.js";

const BASE = "/rest/jira-webhook/1.0/webhooks";
/** The list endpoint defaults to 10000 rows; one bounded read is enough for any real instance. */
const MAX_WEBHOOKS = 1000;

/** Event keys the Jira 11.3 admin page offers; other keys (from apps) are allowed with a warning. */
export const KNOWN_EVENTS = new Set([
  "jira:issue_created", "jira:issue_updated", "jira:issue_deleted", "jira:worklog_updated",
  "comment_created", "comment_updated", "comment_deleted",
  "issuelink_created", "issuelink_deleted",
  "worklog_created", "worklog_updated", "worklog_deleted",
  "jira:version_created", "jira:version_updated", "jira:version_deleted", "jira:version_released",
  "jira:version_unreleased", "jira:version_merged", "jira:version_moved",
  "project_created", "project_updated", "project_deleted", "project_archived", "project_restored",
  "user_created", "user_updated", "user_deleted",
  "board_created", "board_updated", "board_deleted", "board_configuration_changed",
  "sprint_created", "sprint_updated", "sprint_deleted", "sprint_started", "sprint_closed",
  "option_voting_changed", "option_watching_changed", "option_unassigned_issues_changed", "option_subtasks_changed",
  "option_attachments_changed", "option_issuelinks_changed", "option_timetracking_changed",
]);

const SENSITIVE_PARAM = /token|secret|key|pass|pwd|auth|sig|cred|session|code/i;
const OPAQUE_RUN = /[A-Za-z0-9_-]{16,}/g;

/**
 * Whether a URL part looks like a token: it holds a run of 16+ characters of [A-Za-z0-9_-] that has a digit
 * or mixed case, or is 32+ long (Slack, Teams and Discord put their tokens and ids in the path). Long runs of
 * lowercase words such as `jira-webhook-receiver` are not tokens.
 */
function tokenLike(part: string): boolean {
  return (part.match(OPAQUE_RUN) ?? []).some((r) => r.length >= 32 || /\d/.test(r) || (/[a-z]/.test(r) && /[A-Z]/.test(r)));
}

/** A webhook URL with user info, token-like path segments and sensitive-looking query values replaced by `***`; the fragment is dropped. */
export function maskUrl(raw: unknown): string {
  const s = String(raw ?? "");
  try {
    const u = new URL(s);
    const auth = u.username || u.password ? "***@" : "";
    const path = u.pathname.split("/").map((seg) => (tokenLike(seg) ? "***" : seg)).join("/");
    const params = [...u.searchParams.entries()].map(([k, v]) => `${encodeURIComponent(k)}=${SENSITIVE_PARAM.test(k) || tokenLike(v) ? "***" : encodeURIComponent(v)}`);
    return `${u.protocol}//${auth}${u.host}${path}${params.length ? `?${params.join("&")}` : ""}`;
  } catch {
    // not a parsable URL: still hide anything that looks like user info
    return s.replace(/\/\/[^/@\s]*@/, "//***@").replace(/#.*$/, "");
  }
}

/** Whether a webhook URL carries credentials: user info, a sensitive or token-like query value, a token-like path segment or a fragment. */
export function urlHasCredentials(raw: unknown): boolean {
  const s = String(raw ?? "");
  try {
    const u = new URL(s);
    if (u.username || u.password || u.hash) return true;
    if ([...u.searchParams.entries()].some(([k, v]) => SENSITIVE_PARAM.test(k) || tokenLike(v))) return true;
    return u.pathname.split("/").some(tokenLike);
  } catch {
    return /\/\/[^/@\s]*@/.test(s) || tokenLike(s);
  }
}

/** A signing secret as some servers return it: only mask characters. */
const MASKED_SECRET = /^[*\u2022]+$/;

/** Webhook arguments whose values never go into a plan file or a printed command. */
const SENSITIVE = {
  isSensitive: (arg: string, value: unknown) => (arg === "url" ? urlHasCredentials(value) : true),
};

interface Hook {
  id: number;
  name: string;
  url: string;
  enabled: boolean;
  events: string[];
  jql: string;
  excludeBody: boolean;
  description: string;
  secret: string;
  /** The server has a secret but did not return it in plain text (only mask characters, or only a flag). */
  secretMasked: boolean;
  scopeType: string;
  updated: unknown;
}

/** Normalise a server webhook (unmasked; never return it as is). */
function norm(h: any): Hook {
  const conf = h?.configuration ?? {};
  return {
    id: Number(h?.id),
    name: String(h?.name ?? ""),
    url: String(h?.url ?? ""),
    enabled: h?.active === true || h?.active === "true" || h?.enabled === true,
    events: Array.isArray(h?.events) ? h.events.map(String) : [],
    jql: String(conf.FILTERS ?? h?.filters?.["issue-related-events-section"] ?? ""),
    excludeBody: String(conf.EXCLUDE_BODY ?? h?.excludeBody ?? "false") === "true",
    description: String(conf.DESCRIPTION ?? h?.description ?? ""),
    secret: String(conf.SECRET ?? ""),
    secretMasked: MASKED_SECRET.test(String(conf.SECRET ?? "")) || (!conf.SECRET && (h?.hasSecret === true || h?.secretSet === true)),
    scopeType: String(h?.scopeType ?? "global"),
    updated: h?.updatedDate ?? null,
  };
}

/** What a caller may see: URL masked, the secret reduced to a flag. */
function view(h: Hook, full = false): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: h.id,
    name: h.name,
    url: maskUrl(h.url),
    enabled: h.enabled,
    events: full ? h.events : h.events.length > 5 ? `${h.events.slice(0, 5).join(",")},… (${h.events.length})` : h.events.join(","),
    jql: h.jql || null,
    excludeBody: h.excludeBody,
    hasSecret: h.secret.length > 0 || h.secretMasked,
  };
  if (full) Object.assign(out, { description: h.description || null, scopeType: h.scopeType, updated: typeof h.updated === "number" ? new Date(h.updated).toISOString() : h.updated });
  return out;
}

/** The request body the admin page sends. */
function body(h: Omit<Hook, "updated" | "id" | "secretMasked"> & { id?: number }): Record<string, unknown> {
  const configuration: Record<string, string> = { EXCLUDE_BODY: String(h.excludeBody) };
  if (h.jql) configuration.FILTERS = h.jql;
  if (h.description) configuration.DESCRIPTION = h.description;
  if (h.secret) configuration.SECRET = h.secret;
  const out: Record<string, unknown> = { name: h.name, url: h.url, events: h.events, active: h.enabled, scopeType: h.scopeType || "global", configuration };
  if (h.id !== undefined) out.id = h.id;
  return out;
}

/** The body as echoed in results: URL and secret masked. */
function echo(b: Record<string, any>): Record<string, unknown> {
  const conf = { ...(b.configuration ?? {}) };
  if (conf.SECRET) conf.SECRET = "***";
  return { ...b, url: maskUrl(b.url), configuration: conf };
}

/** Comparable settings; the secret only when the caller sets one. */
function settings(h: Pick<Hook, "name" | "url" | "events" | "enabled" | "jql" | "excludeBody" | "description" | "secret">, withSecret: boolean) {
  return JSON.stringify([h.name, h.url, [...h.events].sort(), h.enabled, h.jql.trim(), h.excludeBody, h.description, withSecret ? h.secret : null]);
}

async function listHooks(c: AtlassianClient, event?: string): Promise<Hook[]> {
  const data = await c.get(BASE, { event, limit: MAX_WEBHOOKS });
  const list: any[] = Array.isArray(data) ? data : (data?.values ?? []);
  return list.map(norm);
}

/** A webhook by numeric id or exact name; undefined when absent, an error when a name is ambiguous. */
function pick(hooks: Hook[], given: string): Hook | undefined {
  const v = String(given).trim();
  const byId = /^\d+$/.test(v) ? hooks.find((h) => String(h.id) === v) : undefined;
  if (byId) return byId;
  const byName = hooks.filter((h) => h.name === v);
  if (byName.length > 1) throw new ValidationError(`Webhook name '${v}' is ambiguous (ids ${byName.map((h) => h.id).join(", ")}); pass the id`);
  return byName[0];
}

async function readOne(c: AtlassianClient, id: number): Promise<Hook | null> {
  try {
    return norm(await c.get(`${BASE}/${id}`));
  } catch (e) {
    if (isHttpStatusError(e) && e.status === 404) return null;
    throw e;
  }
}

/**
 * The full-model PUT must carry the stored secret, or Jira would drop it. A plain read-back is reused;
 * a masked one cannot be (saving it would store the mask), so the caller must pass the secret.
 */
function requireSecret(cur: Hook, given: string | undefined, action: string): void {
  if (given !== undefined || !cur.secretMasked) return;
  throw new ValidationError(
    `Webhook ${cur.id} '${cur.name}' has a signing secret that Jira returns masked; ${action} saves the full webhook, ` +
      "which would overwrite the secret with the mask or remove it. Pass secret=<the signing secret> (or a new one) and run it directly with dry_run=false",
  );
}

function unknownEvents(events: string[]): string[] {
  return events.filter((e) => !KNOWN_EVENTS.has(e));
}

/** Send a write whose body holds secrets: the dry run and the result echo a masked body. */
async function sendMasked(c: AtlassianClient, args: { dry_run?: boolean }, req: { method: "POST" | "PUT"; path: string; json: Record<string, unknown>; summary: string }) {
  const shown = { ...req, json: echo(req.json) };
  if (args.dry_run !== false) return guardedWrite(c, args, shown);
  const result = await c.request(req.method, req.path, { json: req.json });
  return { dry_run: false, product: c.product, summary: req.summary, request: (await guardedWrite(c, { dry_run: true }, shown)).request, raw: result };
}

const webhookArg = z.coerce.string().min(1).describe("Webhook id or exact name");
const eventsArg = listArg.describe("Event keys, comma-separated (e.g. jira:issue_created,comment_created)");

export const jiraWebhookTools: ToolDef[] = [
  {
    name: "jira_list_webhooks",
    product: "jira",
    description:
      "Webhooks (jira-webhook REST, Jira DC 10+): id, name, URL (credentials and token parameters masked), enabled, " +
      "events, JQL filter, excludeBody, hasSecret. Filter by name fragment or one event key.",
    defaultFields: ["id", "name", "enabled", "url", "events"],
    inputShape: {
      name_contains: z.string().optional().describe("Matches the webhook name"),
      event: z.string().optional().describe("Only webhooks subscribed to this event key (server-side)"),
      ...pageShape(50),
    },
    async handler({ client }, args) {
      const hooks = await listHooks(client("jira"), args.event);
      const items = hooks.filter((h) => contains(h.name, args.name_contains)).map((h) => view(h));
      return { ...paginate(items, args, 50), ...(hooks.length >= MAX_WEBHOOKS ? { truncated: true, cap: MAX_WEBHOOKS } : {}) };
    },
  },
  {
    name: "jira_get_webhook",
    product: "jira",
    description: "One webhook by id or exact name: all events, JQL filter, description, excludeBody, enabled, updated (URL credentials and the secret masked).",
    inputShape: { webhook: webhookArg },
    async handler({ client }, args) {
      const c = client("jira");
      const h = /^\d+$/.test(String(args.webhook).trim()) ? await readOne(c, Number(args.webhook)) : pick(await listHooks(c), args.webhook);
      if (!h) throw new ValidationError(`No webhook '${args.webhook}'`);
      return view(h, true);
    },
  },
  {
    name: "jira_create_webhook",
    product: "jira",
    write: true,
    invalidates: [],
    description:
      "Create a webhook: name, url, events, optional jql (issue-event filter), exclude_body, description, secret, enabled (default true). " +
      "A webhook with the same name or URL and the same settings → already-satisfied; same name or URL otherwise → error (use jira_update_webhook). Read back after the write. " +
      "--plan is refused with a secret or a credentialed URL (plans store arguments in plain text): run it with dry_run=false instead.",
    sensitiveArgs: ["secret", "url"],
    ...SENSITIVE,
    inputShape: {
      name: z.string().trim().min(1),
      url: z.string().trim().url(),
      events: eventsArg,
      jql: z.string().trim().optional().describe("JQL that limits issue-related events"),
      exclude_body: boolArg.optional().describe("Send only the event, without the JSON body (default false)"),
      description: z.string().optional(),
      secret: z.string().optional().describe("Signing secret (never echoed)"),
      enabled: boolArg.optional().describe("Default true"),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const events: string[] = args.events;
      if (!events.length) throw new ValidationError("Pass at least one event");
      const c = client("jira");
      const want = {
        name: args.name, url: args.url, events, enabled: args.enabled ?? true, jql: args.jql ?? "", excludeBody: args.exclude_body ?? false,
        description: args.description ?? "", secret: args.secret ?? "", secretMasked: false, scopeType: "global",
      };
      const summary = `Create webhook '${args.name}' → ${maskUrl(args.url)} (${events.length} events)`;
      const hooks = await listHooks(c);
      const clash = hooks.filter((h) => h.name === args.name || h.url === args.url);
      const same = clash.find((h) => settings(h, !!args.secret) === settings(want, !!args.secret));
      if (same) return alreadySatisfied(summary, `webhook ${same.id} '${same.name}' already has these settings`, { webhook: view(same) });
      if (clash.length) {
        const h = clash[0];
        throw new ValidationError(`Webhook ${h.id} '${h.name}' (${maskUrl(h.url)}) already uses this ${h.name === args.name ? "name" : "URL"} with other settings; use jira_update_webhook`);
      }
      const warnings = unknownEvents(events).map((e) => `'${e}' is not an event key the Jira admin page offers`);
      const req = { method: "POST" as const, path: BASE, json: body(want), summary };
      const sent = await sendMasked(c, args, req);
      if (args.dry_run !== false) return { ...sent, ...(warnings.length ? { warnings } : {}), identity: { op: "create-webhook", name: args.name, url: maskUrl(args.url) }, state: { exists: false } };
      const back = (await listHooks(c)).find((h) => h.name === args.name && h.url === args.url);
      const withSecret = !!args.secret && !back?.secretMasked;
      if (!back || settings(back, withSecret) !== settings(want, withSecret) || (!!args.secret && !back.secret)) {
        throw new VerificationError(`${summary}: the webhook does not read back as created`, back ? view(back, true) : null);
      }
      const { raw: _raw, ...rest } = sent as any;
      return { ...rest, result: view(back, true), ...(warnings.length ? { warnings } : {}) };
    },
  },
  {
    name: "jira_update_webhook",
    product: "jira",
    write: true,
    invalidates: [],
    description:
      "Change a webhook's name, url, events, jql, exclude_body, description or secret (others kept, the stored secret too). " +
      "PUTs the full model; the dry run shows old and new values (masked). When Jira returns the stored secret masked, pass secret " +
      "(it cannot be kept otherwise). Read back after the write. --plan is refused with a secret or a credentialed URL.",
    sensitiveArgs: ["secret", "url"],
    ...SENSITIVE,
    inputShape: {
      webhook: webhookArg,
      name: z.string().trim().min(1).optional(),
      url: z.string().trim().url().optional(),
      events: eventsArg.optional(),
      jql: z.string().optional().describe("New JQL filter; empty string removes it"),
      exclude_body: boolArg.optional(),
      description: z.string().optional().describe("Empty string removes it"),
      secret: z.string().optional().describe("New signing secret (never echoed)"),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const keys = ["name", "url", "events", "jql", "exclude_body", "description", "secret"];
      if (!keys.some((k) => args[k] !== undefined)) throw new ValidationError(`Pass at least one of ${keys.join(", ")}`);
      if (args.events && !args.events.length) throw new ValidationError("events cannot be empty");
      const c = client("jira");
      const cur = pick(await listHooks(c), args.webhook);
      if (!cur) throw new ValidationError(`No webhook '${args.webhook}'`);
      const want: Hook = {
        ...cur,
        name: args.name ?? cur.name,
        url: args.url ?? cur.url,
        events: args.events ?? cur.events,
        jql: args.jql !== undefined ? args.jql.trim() : cur.jql,
        excludeBody: args.exclude_body ?? cur.excludeBody,
        description: args.description ?? cur.description,
        secret: args.secret ?? cur.secret,
      };
      const summary = `Update webhook ${cur.id} '${cur.name}'`;
      if (settings(cur, true) === settings(want, true)) return alreadySatisfied(summary, "it already has these settings");
      requireSecret(cur, args.secret, "the update");
      const req = { method: "PUT" as const, path: `${BASE}/${cur.id}`, json: body(want), summary };
      const sent = await sendMasked(c, args, req);
      const extra = { before: view(cur, true), after: view(want, true) };
      if (args.dry_run !== false) return { ...sent, ...extra, identity: { op: "update-webhook", webhook: cur.id }, state: { updated: cur.updated } };
      const back = await readOne(c, cur.id);
      if (!back || settings(back, !back.secretMasked) !== settings(want, !back.secretMasked)) throw new VerificationError(`${summary}: the webhook does not read back as updated`, back ? view(back, true) : null);
      const { raw: _raw, ...rest } = sent as any;
      return { ...rest, ...extra, result: view(back, true) };
    },
  },
  {
    name: "jira_set_webhook_enabled",
    product: "jira",
    write: true,
    invalidates: [],
    description:
      "Enable or disable a webhook (PUT of the full model with another active flag, as the admin page does). Same state → already-satisfied. " +
      "When Jira returns the stored secret masked, pass secret (the full-model PUT would lose it otherwise; --plan is then refused).",
    sensitiveArgs: ["secret"],
    ...SENSITIVE,
    inputShape: { webhook: webhookArg, enabled: boolArg, secret: z.string().optional().describe("The signing secret, needed when Jira returns it masked (never echoed)"), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const cur = pick(await listHooks(c), args.webhook);
      if (!cur) throw new ValidationError(`No webhook '${args.webhook}'`);
      const summary = `${args.enabled ? "Enable" : "Disable"} webhook ${cur.id} '${cur.name}'`;
      if (cur.enabled === args.enabled) return alreadySatisfied(summary, `it is already ${args.enabled ? "enabled" : "disabled"}`);
      requireSecret(cur, args.secret, "the toggle");
      const want = { ...cur, enabled: args.enabled, secret: args.secret ?? cur.secret };
      const req = { method: "PUT" as const, path: `${BASE}/${cur.id}`, json: body(want), summary };
      const sent = await sendMasked(c, args, req);
      if (args.dry_run !== false) return { ...sent, identity: { op: "set-webhook-enabled", webhook: cur.id, enabled: args.enabled }, state: { enabled: cur.enabled } };
      const back = await readOne(c, cur.id);
      if (!back || back.enabled !== args.enabled) throw new VerificationError(`${summary}: the webhook still reads back as ${back?.enabled ? "enabled" : "disabled"}`, back ? view(back, true) : null);
      const { raw: _raw, ...rest } = sent as any;
      return { ...rest, result: view(back, true) };
    },
  },
  {
    name: "jira_delete_webhook",
    product: "jira",
    write: true,
    invalidates: [],
    description: "Delete a webhook (irreversible: re-create it to restore). Already gone → already-satisfied. Verified by reading it back.",
    inputShape: { webhook: webhookArg, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const cur = pick(await listHooks(c), args.webhook);
      if (!cur) return alreadySatisfied(`Delete webhook '${args.webhook}'`, "no such webhook");
      const summary = `Delete webhook ${cur.id} '${cur.name}' → ${maskUrl(cur.url)} (${cur.enabled ? "enabled" : "disabled"}, ${cur.events.length} events); irreversible`;
      const req = { method: "DELETE" as const, path: `${BASE}/${cur.id}`, summary };
      if (args.dry_run !== false) return { ...(await guardedWrite(c, args, req)), webhook: view(cur, true), identity: { op: "delete-webhook", webhook: cur.id }, state: { exists: true } };
      const result = await guardedWrite(c, args, req);
      if (await readOne(c, cur.id)) throw new VerificationError(`${summary}: the webhook still exists`, { id: cur.id });
      return result;
    },
  },
];
