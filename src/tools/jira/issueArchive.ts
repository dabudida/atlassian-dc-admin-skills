/**
 * Jira DC issue archiving: archive and restore one issue, archive issues in bulk by JQL.
 *
 * Resources (from the Jira 11.3 REST WADL): PUT /issue/{key}/archive and /restore (query notifyUsers,
 * default true) and POST /issue/archive (query notifyUsers, default false; JSON body = the JQL as a
 * JSON string; text/plain response). Archived state is read from the system field `archiveddate`
 * (null when not archived). JQL search never returns archived issues, so a bulk count is what would
 * be archived and a re-count after the write shows what is left. Bulk archiving pins the exact id
 * set of the dry run: requests carry `issue in (<ids>) AND (<jql>)` and the plan state hashes the ids. Issue archiving needs a Data Center
 * license; an instance that says otherwise yields an UnsupportedError.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { seg, type AtlassianClient } from "../../client.js";
import { errorDetail, isHttpStatusError, UnsupportedError, ValidationError, VerificationError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { alreadySatisfied, boolArg, dryRunShape, guardedWrite } from "../util.js";

const API = "/rest/api/2";
const MAX_ISSUES_DEFAULT = 100;
const MAX_ISSUES = 10_000;
const SAMPLE_DEFAULT = 10;
const SAMPLE_MAX = 50;
const RESPONSE_MAX = 2000;
/** Issues per id-page read and per archive request (keeps each restricted JQL a few KB long). */
const ID_PAGE = 500;
const CHUNK_IDS = 500;
const UNSUPPORTED = "Issue archiving is not available on this instance (it needs a Jira Data Center license)";

interface ArchiveState {
  key: string;
  archived: boolean;
  archivedDate: string | null;
  archivedBy: string | null;
}

/** The issue's archived state; null when Jira answers 404. Throws Unsupported when Jira has no archiveddate field. */
async function readState(client: AtlassianClient, key: string): Promise<ArchiveState | null> {
  let issue: any;
  try {
    issue = await client.get(`${API}/issue/${seg(key)}`, { fields: "archiveddate,archivedby" });
  } catch (e) {
    if (isHttpStatusError(e) && e.status === 404) return null;
    throw e;
  }
  const fields = issue?.fields ?? {};
  if (!("archiveddate" in fields)) throw new UnsupportedError(`${UNSUPPORTED}: issues have no 'archiveddate' field`, { issue: key });
  const date = fields.archiveddate ?? null;
  return {
    key: String(issue?.key ?? key),
    archived: date !== null,
    archivedDate: date,
    // the user's name only: no e-mail address or avatar
    archivedBy: fields.archivedby?.name ?? fields.archivedby?.key ?? null,
  };
}

/** An HTTP answer that says archiving is unavailable, as an UnsupportedError; anything else unchanged. */
function mapUnsupported(e: unknown, resourceMissingMeansUnsupported: boolean): unknown {
  if (!isHttpStatusError(e)) return e;
  const detail = errorDetail(e.body);
  const saysUnavailable = /archiv/i.test(detail) && /(data ?center|licen[cs]e|not (available|supported|enabled|allowed)|unavailable|disabled)/i.test(detail);
  if (e.status === 501 || ([400, 403, 404, 405].includes(e.status) && saysUnavailable) || (resourceMissingMeansUnsupported && [404, 405].includes(e.status))) {
    return new UnsupportedError(`${UNSUPPORTED}${detail ? `: ${detail}` : ` (HTTP ${e.status})`}`, { status: e.status });
  }
  return e;
}

async function send<T>(p: Promise<T>, resourceMissingMeansUnsupported: boolean): Promise<T> {
  try {
    return await p;
  } catch (e) {
    throw mapUnsupported(e, resourceMissingMeansUnsupported);
  }
}

const issueKeyShape = {
  issue_key: z.string().trim().min(1).describe("Issue key (PROJ-123) or id"),
  notify_users: boolArg.optional().describe("Send Jira's notifications (Jira's default for single issues: true)"),
};

/** Archive or restore one issue: idempotent, dry run by default, read back after the write. */
async function setArchived(client: AtlassianClient, args: Record<string, any>, archive: boolean) {
  const key = args.issue_key as string;
  const verb = archive ? "archive" : "restore";
  const summary = `${archive ? "Archive" : "Restore"} issue ${key}`;
  const before = await readState(client, key);
  let warning: string | undefined;
  if (!before) {
    if (archive) throw new ValidationError(`No issue '${key}' (HTTP 404: it does not exist or is not visible to this account)`);
    // archived issues should stay readable by key; if this Jira hides them, let the restore request decide
    warning = `GET issue answered 404, so its archived state is unknown; the restore is sent as is and Jira answers 404 if the issue does not exist`;
  } else if (before.archived === archive) {
    return alreadySatisfied(summary, archive ? `the issue was archived on ${before.archivedDate}` : "the issue is not archived", { issue: before.key });
  }
  const req = {
    method: "PUT" as const,
    path: `${API}/issue/${seg(key)}/${verb}`,
    params: args.notify_users === undefined ? undefined : { notifyUsers: args.notify_users },
    summary,
  };
  if (args.dry_run !== false) {
    const dry = await guardedWrite(client, args, req);
    return { ...dry, ...(warning ? { warning } : {}) };
  }
  const result = await send(guardedWrite(client, args, req), false);
  const after = await readState(client, key);
  if (!after) {
    if (archive) {
      return { ...result, verified: false, note: "GET issue answers 404 after archiving: this Jira does not show archived issues by key, so the state could not be read back" };
    }
    throw new VerificationError(`${summary}: the issue cannot be read afterwards (HTTP 404)`, { issue: key });
  }
  if (after.archived !== archive) {
    throw new VerificationError(`${summary}: Jira reports the issue as ${after.archived ? "archived" : "not archived"} afterwards`, after);
  }
  return { ...result, readBack: after };
}

/** Number of issues the JQL matches (never archived ones) and the first `sample` of them. */
async function countMatches(client: AtlassianClient, jql: string, sample: number) {
  let data: any;
  try {
    data = await client.get(`${API}/search`, { jql, startAt: 0, maxResults: sample, fields: "summary,status" });
  } catch (e) {
    if (isHttpStatusError(e) && e.status === 400) throw new ValidationError(`Invalid JQL: ${errorDetail(e.body) || e.message}`);
    throw e;
  }
  const issues: any[] = data?.issues ?? [];
  return {
    total: Number(data?.total ?? issues.length),
    sample: issues.slice(0, sample).map((i) => ({ key: i.key, summary: i.fields?.summary, status: i.fields?.status?.name })),
  };
}

/** Ids of every issue the JQL matches, paged with fields=id; refuses when more than `cap` match. */
async function matchingIds(client: AtlassianClient, jql: string, cap: number): Promise<string[]> {
  const ids: string[] = [];
  for (let startAt = 0; ; ) {
    const data: any = await client.get(`${API}/search`, { jql, startAt, maxResults: ID_PAGE, fields: "id" });
    const issues: any[] = data?.issues ?? [];
    for (const i of issues) ids.push(String(i.id));
    if (ids.length > cap) {
      throw new ValidationError(`The JQL matches more than max_issues=${cap} issues now; narrow the JQL or raise max_issues (at most ${MAX_ISSUES})`);
    }
    startAt += issues.length;
    if (issues.length === 0 || startAt >= Number(data?.total ?? 0)) break;
  }
  return [...new Set(ids)].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
}

/** Short fingerprint of a sorted id set, used as plan drift state. */
const idsHash = (ids: string[]) => createHash("sha256").update(ids.join(",")).digest("hex").slice(0, 16);

/** The original JQL restricted to the approved ids, one JQL per chunk of ids. */
function restrictedJql(ids: string[], jql: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < ids.length; i += CHUNK_IDS) out.push(`issue in (${ids.slice(i, i + CHUNK_IDS).join(",")}) AND (${jql})`);
  return out;
}

const cut = (v: unknown) => {
  const text = typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);
  return text.length > RESPONSE_MAX ? `${text.slice(0, RESPONSE_MAX)}… (${text.length} characters)` : text;
};

export const jiraIssueArchiveTools: ToolDef[] = [
  {
    name: "jira_archive_issue",
    product: "jira",
    write: true,
    invalidates: [],
    description:
      "Archive one issue (Data Center): it leaves search, boards and the index but stays readable by key. Already archived " +
      "issues are reported as satisfied; the result is read back (archiveddate). jira_restore_issue undoes it.",
    inputShape: { ...issueKeyShape, ...dryRunShape },
    async handler({ client }, args) {
      return setArchived(client("jira"), args, true);
    },
  },
  {
    name: "jira_restore_issue",
    product: "jira",
    write: true,
    invalidates: [],
    description: "Restore an archived issue (Data Center). Issues that are not archived are reported as satisfied; the result is read back.",
    inputShape: { ...issueKeyShape, ...dryRunShape },
    async handler({ client }, args) {
      return setArchived(client("jira"), args, false);
    },
  },
  {
    name: "jira_archive_issues",
    product: "jira",
    write: true,
    invalidates: [],
    description:
      "Archive every issue a JQL matches (Data Center). The dry run shows the match count, a sample and a hash of the " +
      `matching issue ids (state.ids); more matches than max_issues (default ${MAX_ISSUES_DEFAULT}, max ${MAX_ISSUES}) are refused. ` +
      "Execution re-reads the ids, refuses when they differ from approved_ids_hash, sends the JQL restricted to those ids " +
      `(issue in (...) AND (<jql>), ${CHUNK_IDS} ids per request) and fails when any of them still matches afterwards. ` +
      "Notifications are off unless notify_users=true. " +
      "Restore single issues with jira_restore_issue.",
    inputShape: {
      jql: z.string().trim().min(1).describe("Issues to archive, e.g. project = PROJ AND resolved < -365d"),
      max_issues: z.coerce.number().int().min(1).max(MAX_ISSUES).optional()
        .describe(`Refuse when the JQL matches more issues (default ${MAX_ISSUES_DEFAULT}, max ${MAX_ISSUES})`),
      sample: z.coerce.number().int().min(0).max(SAMPLE_MAX).optional().describe(`Matching issues shown in the dry run (default ${SAMPLE_DEFAULT})`),
      notify_users: boolArg.optional().describe("Send Jira's notifications (default false)"),
      approved_ids_hash: z.string().trim().min(1).optional()
        .describe("state.ids of the approved dry run: execution refuses when the matching issues differ"),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const cap = args.max_issues ?? MAX_ISSUES_DEFAULT;
      const sampleSize = args.sample ?? SAMPLE_DEFAULT;
      const counted = await countMatches(c, args.jql, args.dry_run === false ? 0 : sampleSize);
      const summary = `Archive ${counted.total} issue(s) matching: ${args.jql}`;
      if (counted.total === 0) return alreadySatisfied(summary, "no issue matches the JQL (archived issues are never matched)", { matched: 0 });
      if (counted.total > cap) {
        throw new ValidationError(`The JQL matches ${counted.total} issues, more than max_issues=${cap}; narrow the JQL or raise max_issues (at most ${MAX_ISSUES})`);
      }
      // the exact set to archive: every request is restricted to these ids, so issues that start to
      // match later are never archived, and the plan state changes when the set changes
      const ids = await matchingIds(c, args.jql, cap);
      if (ids.length === 0) return alreadySatisfied(summary, "no issue matches the JQL (archived issues are never matched)", { matched: 0 });
      const hash = idsHash(ids);
      if (args.approved_ids_hash !== undefined && args.approved_ids_hash !== hash) {
        throw new ValidationError(`The issues matching the JQL changed since approval (ids hash ${hash}, approved ${args.approved_ids_hash}); run the dry run again and review it`);
      }
      const jqls = restrictedJql(ids, args.jql);
      const reqFor = (jql: string, i: number) => ({
        method: "POST" as const,
        path: `${API}/issue/archive`,
        params: { notifyUsers: args.notify_users ?? false },
        // the body is the JQL as a JSON string
        json: jql,
        summary: jqls.length > 1 ? `${summary} (part ${i + 1}/${jqls.length})` : `Archive ${ids.length} issue(s) matching: ${args.jql}`,
      });
      const state = { matched: ids.length, ids: hash };
      if (args.dry_run !== false) {
        const dry = await guardedWrite(c, args, reqFor(jqls[0], 0));
        return {
          ...dry,
          summary: `Archive ${ids.length} issue(s) matching: ${args.jql}`,
          matched: ids.length,
          sample: counted.sample,
          ...(jqls.length > 1 ? { chunks: jqls.length, note: `${dry.note} The ids are sent in ${jqls.length} requests of up to ${CHUNK_IDS}; the request shown is the first.` } : {}),
          state,
        };
      }
      const results: unknown[] = [];
      let last: any;
      for (const [i, jql] of jqls.entries()) {
        last = await send(guardedWrite(c, args, reqFor(jql, i)), true);
        results.push(last.result);
      }
      // verify the approved ids only: issues that started to match later were not part of the request
      let remaining = 0;
      for (const jql of jqls) remaining += (await countMatches(c, jql, 0)).total;
      const response = cut(results.length === 1 ? results[0] : results);
      if (remaining > 0) {
        throw new VerificationError(`${summary}: ${remaining} issue(s) still match afterwards (no permission, or archiving failed for them)`, {
          remaining,
          response,
        });
      }
      return {
        ...last,
        summary: `Archive ${ids.length} issue(s) matching: ${args.jql}`,
        result: response,
        matched: ids.length,
        ...(jqls.length > 1 ? { chunks: jqls.length } : {}),
        readBack: { remaining: 0 },
      };
    },
  },
];
