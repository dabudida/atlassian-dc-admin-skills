/**
 * Jira Service Management agent operations on one customer request: the service desk view, comments with
 * customer visibility, participants, approvals, status history and CSAT feedback.
 *
 * Public Service Desk API of JSM 11.3 (jira-servicedesk-public-rest-api-plugin 21.3.2: CustomerRequestResource,
 * CommentResource, RequestParticipantResource, ApprovalResource, RequestStatusResource), always with
 * `X-ExperimentalApi: opt-in`. JSM 11.3 has no feedback resource (`/request/{key}/feedback` is 404), so CSAT is
 * read from the `sd-request-feedback` custom field (rating via JQL, the REST value is opaque), the
 * `sd-request-feedback-date` field and the `service-request-feedback-comment` issue property.
 */

import { z } from "zod";
import { seg, type AtlassianClient } from "../../client.js";
import { isHttpStatusError, ValidationError, VerificationError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { alreadySatisfied, boolArg, capList, dryRunShape, fullListsShape, guardedWrite, listArg, pageShape, serverPage, type WriteRequest } from "../util.js";
import { lc, memberNames, splitMembers, uniqueUsers, type Members } from "./jsmCustomers.js";
import { OPT_IN, SD, sdGet } from "./servicedesk.js";

const PAGE_MAX = 50;
const MAX_PARTICIPANTS = 1000;
/** Request field values shown by jira_get_request, and the longest text kept per value. */
const MAX_FIELDS = 20;
const MAX_FIELD_CHARS = 300;
const FEEDBACK_TYPE = "com.atlassian.servicedesk:sd-request-feedback";
const FEEDBACK_DATE_TYPE = "com.atlassian.servicedesk:sd-request-feedback-date";
const FEEDBACK_COMMENT_PROPERTY = "service-request-feedback-comment";
const MAX_FEEDBACK_COMMENT = 2000;

const keyArg = z.string().trim().min(1).describe("Request issue key or id");
const usernamesArg = listArg.describe("Usernames, comma-separated");

const req = (key: string) => `/request/${seg(key)}`;
const iso = (d: any) => d?.iso8601 ?? null;
const userRef = (u: any) => (u ? { name: u.name, displayName: u.displayName } : null);

function cut(value: unknown, max: number): { text: unknown; truncated: boolean } {
  const text = typeof value === "string" ? value : value === null || value === undefined ? value : JSON.stringify(value);
  if (typeof text !== "string" || text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}…`, truncated: true };
}

function slaSummary(s: any) {
  const completed: any[] = s?.completedCycles ?? [];
  const o = s?.ongoingCycle;
  return {
    name: s?.name,
    ongoing: o
      ? { breached: o.breached, paused: o.paused, withinCalendarHours: o.withinCalendarHours, remaining: o.remainingTime?.friendly ?? null, breachTime: iso(o.breachTime) }
      : null,
    completedCycles: completed.length,
    lastCompletedBreached: completed.length ? !!completed[completed.length - 1]?.breached : null,
  };
}

const participantNames = (client: AtlassianClient, key: string): Promise<Members> => memberNames(client, `${req(key)}/participant`, MAX_PARTICIPANTS);

function compactApproval(a: any, full?: boolean) {
  const out: Record<string, unknown> = {
    id: String(a?.id),
    name: a?.name,
    finalDecision: a?.finalDecision,
    canAnswerApproval: a?.canAnswerApproval,
    created: iso(a?.createdDate),
    completed: iso(a?.completedDate),
  };
  capList(out, "approvers", (a?.approvers ?? []).map((x: any) => ({ name: x.approver?.name, displayName: x.approver?.displayName, decision: x.approverDecision })), full);
  return out;
}

/** The calling user's decision on an approval ("approved", "declined", "pending") or undefined when not an approver. */
function decisionOf(approval: any, username: string): string | undefined {
  return (approval?.approvers ?? []).find((x: any) => typeof x.approver?.name === "string" && lc(x.approver.name) === lc(username))?.approverDecision;
}

async function feedbackRating(client: AtlassianClient, key: string, fieldId: string): Promise<{ rating: number | null; error?: string }> {
  const n = fieldId.replace(/^customfield_/, "");
  try {
    for (const r of [5, 4, 3, 2, 1]) {
      const data: any = await client.get("/rest/api/2/search", { jql: `issuekey = "${key.replace(/"/g, "")}" AND cf[${n}] = ${r}`, maxResults: 0, fields: "id" });
      if (Number(data?.total) > 0) return { rating: r };
    }
    return { rating: null, error: "no rating 1-5 matched" };
  } catch (e) {
    return { rating: null, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}

export const jiraJsmRequestTools: ToolDef[] = [
  {
    name: "jira_get_request",
    product: "jira",
    description:
      "One JSM customer request in the service desk view: request type, current status, reporter, participant count, " +
      "SLA summary per metric, first request field values (cut) and portal/agent links.",
    inputShape: { issue_key: keyArg },
    async handler({ client }, args) {
      const c = client("jira");
      const r: any = await sdGet(c, req(args.issue_key), { expand: "requestType,participant,sla" });
      const fields: any[] = r?.requestFieldValues ?? [];
      const parts = r?.participants;
      return {
        key: r?.issueKey,
        id: r?.issueId,
        serviceDeskId: r?.serviceDeskId,
        requestType: { id: String(r?.requestTypeId ?? r?.requestType?.id), name: r?.requestType?.name },
        status: r?.currentStatus?.status,
        statusDate: iso(r?.currentStatus?.statusDate),
        created: iso(r?.createdDate),
        reporter: userRef(r?.reporter),
        participants: parts?.size ?? (parts?.values ?? []).length,
        participantsMore: parts && parts.isLastPage === false ? true : undefined,
        sla: (r?.sla?.values ?? []).map(slaSummary),
        fields: fields.slice(0, MAX_FIELDS).map((f) => ({ fieldId: f.fieldId, label: f.label, value: cut(f.value, MAX_FIELD_CHARS).text })),
        fieldsTotal: fields.length > MAX_FIELDS ? fields.length : undefined,
        links: { web: r?._links?.web, agent: r?.issueKey ? c.url(`/browse/${r.issueKey}`) : undefined },
      };
    },
  },
  {
    name: "jira_get_request_comments",
    product: "jira",
    description: "Comments of a JSM request with public (customer-visible) or internal flag, paged; long bodies are cut.",
    inputShape: {
      issue_key: keyArg,
      visibility: z.enum(["all", "public", "internal"]).optional().describe("Default all"),
      max_body_chars: z.coerce.number().int().min(50).max(20000).optional().describe("Longest body returned (default 1000)"),
      ...pageShape(20, PAGE_MAX),
    },
    narrowing: ["max_body_chars", "limit"],
    async handler({ client }, args) {
      const offset = args.offset ?? 0;
      const limit = Math.min(args.limit ?? 20, 50);
      const vis = args.visibility ?? "all";
      const data = await sdGet(client("jira"), `${req(args.issue_key)}/comment`, {
        public: vis !== "internal",
        internal: vis !== "public",
        start: offset,
        limit,
      });
      const max = args.max_body_chars ?? 1000;
      const items = (data?.values ?? []).map((cm: any) => {
        const body = cut(cm.body, max);
        return { id: String(cm.id), public: cm.public, author: cm.author?.name, created: iso(cm.created), body: body.text, bodyTruncated: body.truncated || undefined };
      });
      return serverPage(items, offset, limit, null, data?.isLastPage ?? true);
    },
  },
  {
    name: "jira_get_request_participants",
    product: "jira",
    description: "Participants of a JSM request (compact users), paged.",
    inputShape: { issue_key: keyArg, ...pageShape(50, PAGE_MAX) },
    async handler({ client }, args) {
      const offset = args.offset ?? 0;
      const limit = Math.min(args.limit ?? 50, 50);
      const data = await sdGet(client("jira"), `${req(args.issue_key)}/participant`, { start: offset, limit });
      const items = (data?.values ?? []).map((u: any) => ({ name: u.name, displayName: u.displayName, email: u.emailAddress, active: u.active }));
      return serverPage(items, offset, limit, null, data?.isLastPage ?? true);
    },
  },
  {
    name: "jira_get_request_approvals",
    product: "jira",
    description: "Approvals of a JSM request: final decision, whether you can answer, and each approver's decision (lists capped; full_lists=true shows all).",
    inputShape: { issue_key: keyArg, ...fullListsShape, ...pageShape(20, PAGE_MAX) },
    async handler({ client }, args) {
      const offset = args.offset ?? 0;
      const limit = Math.min(args.limit ?? 20, 50);
      const data = await sdGet(client("jira"), `${req(args.issue_key)}/approval`, { start: offset, limit });
      return serverPage((data?.values ?? []).map((a: any) => compactApproval(a, args.full_lists)), offset, limit, null, data?.isLastPage ?? true);
    },
  },
  {
    name: "jira_get_request_status_history",
    product: "jira",
    description: "Customer-facing status history of a JSM request (status, date) in server order, paged.",
    inputShape: { issue_key: keyArg, ...pageShape(50, PAGE_MAX) },
    async handler({ client }, args) {
      const offset = args.offset ?? 0;
      const limit = Math.min(args.limit ?? 50, 50);
      const data = await sdGet(client("jira"), `${req(args.issue_key)}/status`, { start: offset, limit });
      return serverPage((data?.values ?? []).map((s: any) => ({ status: s.status, date: iso(s.statusDate) })), offset, limit, null, data?.isLastPage ?? true);
    },
  },
  {
    name: "jira_get_request_feedback",
    product: "jira",
    description:
      "CSAT feedback of a JSM request: submitted, rating 1-5, comment, date. JSM 11.3 has no feedback REST resource, so the " +
      "rating is found with up to five JQL counts on the satisfaction field and the comment from its issue property.",
    inputShape: { issue_key: keyArg },
    async handler({ client }, args) {
      const c = client("jira");
      const all: any[] = ((await c.get("/rest/api/2/field")) as any[]) ?? [];
      const field = all.find((f) => f.schema?.custom === FEEDBACK_TYPE);
      const dateField = all.find((f) => f.schema?.custom === FEEDBACK_DATE_TYPE);
      if (!field) return { issue: args.issue_key, submitted: false, rating: null, reason: "no CSAT (sd-request-feedback) field on this instance" };
      const issue: any = await c.get(`/rest/api/2/issue/${seg(args.issue_key)}`, { fields: [field.id, dateField?.id].filter(Boolean).join(",") });
      const raw = issue?.fields?.[field.id];
      const date = dateField ? issue?.fields?.[dateField.id] ?? null : null;
      if ((raw === null || raw === undefined || raw === "") && !date) return { issue: issue?.key ?? args.issue_key, submitted: false, rating: null, comment: null, date: null };
      const key = String(issue?.key ?? args.issue_key);
      const { rating, error } = await feedbackRating(c, key, field.id);
      let comment: unknown = null;
      try {
        const prop: any = await c.get(`/rest/api/2/issue/${seg(key)}/properties/${FEEDBACK_COMMENT_PROPERTY}`);
        comment = cut(prop?.value?.comment ?? null, MAX_FEEDBACK_COMMENT).text;
      } catch (e) {
        if (!isHttpStatusError(e) || e.status !== 404) throw e;
      }
      return { issue: key, submitted: true, rating, rating_error: error, comment, date };
    },
  },
  {
    name: "jira_add_request_comment",
    unverifiable: "each call adds another comment",
    product: "jira",
    write: true,
    invalidates: [],
    description:
      "Comment on a JSM request. public=false (default) is an INTERNAL note only agents see; public=true is shown to the " +
      "customer on the portal and may be e-mailed. The stored comment is read back by id and its visibility checked.",
    inputShape: {
      issue_key: keyArg,
      body: z.string().min(1).describe("Comment text (Jira wiki markup)"),
      public: boolArg.optional().describe("Default false (internal). true: visible to the customer"),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const isPublic = args.public === true;
      const summary = isPublic
        ? `Add PUBLIC comment to ${args.issue_key} (visible to the customer on the portal and in notifications)`
        : `Add INTERNAL comment to ${args.issue_key} (agents only; the customer does not see it)`;
      const request: WriteRequest = { method: "POST", path: `${SD}${req(args.issue_key)}/comment`, json: { body: args.body, public: isPublic }, headers: OPT_IN, summary };
      const sent: any = await guardedWrite(c, args, request);
      if (sent.dry_run) return sent;
      const id = sent.result?.id;
      if (id === undefined || id === null || id === "") throw new VerificationError(`${summary}: the response has no comment id, so the stored comment cannot be read back`, sent.result);
      let stored: any;
      try {
        stored = await sdGet(c, `${req(args.issue_key)}/comment/${seg(String(id))}`);
      } catch (e) {
        if (isHttpStatusError(e) && e.status === 404) throw new VerificationError(`${summary}: comment ${id} does not read back`, { id: String(id) });
        throw e;
      }
      if (stored?.public !== isPublic) throw new VerificationError(`${summary}: the stored comment has public=${stored?.public}`, { id: String(id), public: stored?.public });
      return { ...sent, result: { id: String(id), public: stored.public, created: iso(stored.created) } };
    },
  },
  {
    name: "jira_add_request_participants",
    product: "jira",
    write: true,
    invalidates: [],
    description: "Add participants (usernames) to a JSM request. Only new ones are sent; all present → already-satisfied.",
    inputShape: { issue_key: keyArg, usernames: usernamesArg, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const wanted = uniqueUsers(args.usernames);
      if (!wanted.length) throw new ValidationError("Pass at least one username");
      const before = splitMembers(wanted, await participantNames(c, args.issue_key));
      // users not seen in a capped scan may already be participants; adding them again is harmless
      const missing = [...before.absent, ...before.unknown];
      const summary = `Add ${missing.length || wanted.length} participant(s) to ${args.issue_key}`;
      if (!missing.length) return alreadySatisfied(summary, "all users are already participants");
      const request: WriteRequest = { method: "POST", path: `${SD}${req(args.issue_key)}/participant`, json: { usernames: missing }, headers: OPT_IN, summary };
      const sent: any = await guardedWrite(c, args, request);
      if (sent.dry_run) return { ...sent, already_participants: before.present };
      const after = splitMembers(missing, await participantNames(c, args.issue_key));
      if (after.absent.length) throw new VerificationError(`${summary}: not participants afterwards: ${after.absent.join(", ")}`);
      const result = { issue: args.issue_key, added: missing };
      if (after.unknown.length) return { ...sent, verification: "partial", unverified: after.unknown, warning: `the request has more than ${MAX_PARTICIPANTS} participants; these users were not seen in the read-back`, result };
      return { ...sent, result };
    },
  },
  {
    name: "jira_remove_request_participants",
    product: "jira",
    write: true,
    invalidates: [],
    description: "Remove participants (usernames) from a JSM request. Only present ones are sent; none present → already-satisfied.",
    inputShape: { issue_key: keyArg, usernames: usernamesArg, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const wanted = uniqueUsers(args.usernames);
      if (!wanted.length) throw new ValidationError("Pass at least one username");
      const before = splitMembers(wanted, await participantNames(c, args.issue_key));
      if (before.unknown.length) {
        throw new ValidationError(`${args.issue_key} has more than ${MAX_PARTICIPANTS} participants: cannot tell whether ${before.unknown.join(", ")} ${before.unknown.length > 1 ? "are participants" : "is a participant"}`);
      }
      const present = before.canonical;
      const summary = `Remove ${present.length || wanted.length} participant(s) from ${args.issue_key}`;
      if (!present.length) return alreadySatisfied(summary, "none of the users is a participant");
      const request: WriteRequest = { method: "DELETE", path: `${SD}${req(args.issue_key)}/participant`, json: { usernames: present }, headers: OPT_IN, summary };
      const sent: any = await guardedWrite(c, args, request);
      if (sent.dry_run) return { ...sent, not_participants: before.absent };
      const after = splitMembers(present, await participantNames(c, args.issue_key));
      if (after.present.length) throw new VerificationError(`${summary}: still participants afterwards: ${after.present.join(", ")}`);
      const result = { issue: args.issue_key, removed: present };
      if (after.unknown.length) return { ...sent, verification: "partial", unverified: after.unknown, warning: `the request has more than ${MAX_PARTICIPANTS} participants; removal of these users could not be confirmed`, result };
      return { ...sent, result };
    },
  },
  {
    name: "jira_answer_request_approval",
    product: "jira",
    write: true,
    invalidates: [],
    description:
      "Approve or decline a JSM request approval as the calling user. Your same answer already given → already-satisfied; " +
      "a different answer, a final approval or no right to answer → refused. The approval is read back afterwards.",
    inputShape: {
      issue_key: keyArg,
      approval_id: z.coerce.string().trim().regex(/^\d+$/, "numeric approval id"),
      decision: z.enum(["approve", "decline"]),
      comment: z.string().min(1).optional().describe("Optional comment added with the answer"),
      comment_public: boolArg.optional().describe("Whether that comment is visible to the customer (server default when omitted)"),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const path = `${req(args.issue_key)}/approval/${args.approval_id}`;
      const [approval, me] = await Promise.all([sdGet(c, path), c.get("/rest/api/2/myself") as Promise<any>]);
      const username = String(me?.name ?? "");
      const wanted = args.decision === "approve" ? "approved" : "declined";
      const mine = decisionOf(approval, username);
      const summary = `${args.decision === "approve" ? "Approve" : "Decline"} approval ${args.approval_id} '${approval?.name}' on ${args.issue_key} as ${username}`;
      if (mine === wanted) return alreadySatisfied(summary, `${username} already ${wanted} it`, { finalDecision: approval?.finalDecision });
      if (mine === "approved" || mine === "declined") throw new ValidationError(`${username} already ${mine} approval ${args.approval_id}; an answer cannot be changed`);
      if (approval?.finalDecision && approval.finalDecision !== "pending") throw new ValidationError(`Approval ${args.approval_id} is final (${approval.finalDecision})`);
      if (approval?.canAnswerApproval === false) throw new ValidationError(`${username} cannot answer approval ${args.approval_id} (not an approver or not allowed)`);
      const body: Record<string, unknown> = { decision: args.decision };
      if (args.comment) body.comment = args.comment;
      if (args.comment !== undefined && args.comment_public !== undefined) body.commentPublic = args.comment_public;
      const request: WriteRequest = { method: "POST", path: `${SD}${path}`, json: body, headers: OPT_IN, summary };
      const sent: any = await guardedWrite(c, args, request);
      if (sent.dry_run) return { ...sent, approval: compactApproval(approval) };
      const back = await sdGet(c, path);
      const now = decisionOf(back, username);
      if (now !== wanted) throw new VerificationError(`${summary}: the approval reads back with decision ${now ?? "none"} for ${username}`, compactApproval(back));
      return { ...sent, result: { approval: String(back?.id ?? args.approval_id), myDecision: now, finalDecision: back?.finalDecision } };
    },
  },
];
