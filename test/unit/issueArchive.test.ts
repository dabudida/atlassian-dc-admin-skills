import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runTool } from "../../src/runner.js";
import { jiraIssueArchiveTools } from "../../src/tools/jira/issueArchive.js";
import { testContext, type Call } from "./helpers.js";

type Response = { status?: number; body?: unknown } | undefined;
const tool = (name: string) => {
  const t = jiraIssueArchiveTools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};
async function run(name: string, args: Record<string, unknown>, responder: (c: Call) => Response) {
  const { ctx, calls } = testContext((c) => {
    const r = responder(c);
    if (r) return r;
    throw new Error(`Unexpected request: ${c.method} ${c.url}`);
  });
  const result: any = await runTool(tool(name), args, ctx);
  return { result, value: result.ok ? result.value : undefined, calls };
}
const path = (c: Call) => new URL(c.url).pathname;
const query = (c: Call) => new URL(c.url).searchParams;

/** One issue whose archived state flips on archive/restore requests. */
function oneIssue(opts: { archived?: boolean; missing?: boolean; noField?: boolean; writeError?: Response; ignoreWrite?: boolean; notFoundWhenArchived?: boolean } = {}) {
  let archived = Boolean(opts.archived);
  return (c: Call): Response => {
    const p = path(c);
    if (c.method === "GET" && p === "/rest/api/2/issue/PROJ-1") {
      if (opts.missing || (opts.notFoundWhenArchived && archived)) return { status: 404, body: { errorMessages: ["Issue Does Not Exist"] } };
      const fields: Record<string, unknown> = { summary: "Old" };
      if (!opts.noField) {
        fields.archiveddate = archived ? "2026-10-01T10:00:00.000+0000" : null;
        fields.archivedby = archived ? { name: "alice", emailAddress: "alice@example.com" } : null;
      }
      return { body: { key: "PROJ-1", fields } };
    }
    if (c.method === "PUT" && (p === "/rest/api/2/issue/PROJ-1/archive" || p === "/rest/api/2/issue/PROJ-1/restore")) {
      if (opts.writeError) return opts.writeError;
      if (!opts.ignoreWrite) archived = p.endsWith("/archive");
      return { status: 204, body: "" };
    }
    return undefined;
  };
}

describe("jira_archive_issue", () => {
  it("dry-runs by default and sends nothing", async () => {
    const { value, calls } = await run("jira_archive_issue", { issue_key: "PROJ-1" }, oneIssue());
    assert.equal(value.dry_run, true);
    assert.equal(value.request.method, "PUT");
    assert.match(value.request.url, /\/rest\/api\/2\/issue\/PROJ-1\/archive$/);
    assert.ok(calls.every((c) => c.method === "GET"));
  });

  it("is already satisfied for an archived issue", async () => {
    const { value } = await run("jira_archive_issue", { issue_key: "PROJ-1", dry_run: false }, oneIssue({ archived: true }));
    assert.equal(value.already_satisfied, true);
    assert.ok(!JSON.stringify(value).includes("@example.com"));
  });

  it("fails for a missing issue", async () => {
    const { result } = await run("jira_archive_issue", { issue_key: "PROJ-1" }, oneIssue({ missing: true }));
    assert.equal(result.ok, false);
    assert.equal(result.error.type, "ValidationError");
  });

  it("is unsupported when the issue has no archiveddate field", async () => {
    const { result } = await run("jira_archive_issue", { issue_key: "PROJ-1" }, oneIssue({ noField: true }));
    assert.equal(result.ok, false);
    assert.equal(result.error.type, "Unsupported");
  });

  it("archives with notifyUsers and verifies the read-back", async () => {
    const { value, calls } = await run("jira_archive_issue", { issue_key: "PROJ-1", dry_run: false, notify_users: false }, oneIssue());
    assert.equal(value.dry_run, false);
    const put = calls.find((c) => c.method === "PUT")!;
    assert.equal(query(put).get("notifyUsers"), "false");
    assert.equal(value.readBack.archived, true);
    assert.equal(value.readBack.archivedBy, "alice");
  });

  it("fails verification when the issue is not archived afterwards", async () => {
    const { result } = await run("jira_archive_issue", { issue_key: "PROJ-1", dry_run: false }, oneIssue({ ignoreWrite: true }));
    assert.equal(result.ok, false);
    assert.equal(result.error.type, "VerificationError");
  });

  it("reports a 404 read-back as unverified, not failed", async () => {
    const { value } = await run("jira_archive_issue", { issue_key: "PROJ-1", dry_run: false }, oneIssue({ notFoundWhenArchived: true }));
    assert.equal(value.verified, false);
    assert.match(value.note, /404/);
  });

  it("maps a Data Center licensing answer to Unsupported", async () => {
    const { result } = await run("jira_archive_issue", { issue_key: "PROJ-1", dry_run: false }, oneIssue({
      writeError: { status: 403, body: { errorMessages: ["Issue archiving is available only with a Jira Data Center license"] } },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.error.type, "Unsupported");
    assert.match(result.error.message, /Data Center/);
  });
});

describe("jira_restore_issue", () => {
  it("is already satisfied for an issue that is not archived", async () => {
    const { value } = await run("jira_restore_issue", { issue_key: "PROJ-1", dry_run: false }, oneIssue());
    assert.equal(value.already_satisfied, true);
  });

  it("restores and verifies", async () => {
    const { value, calls } = await run("jira_restore_issue", { issue_key: "PROJ-1", dry_run: false }, oneIssue({ archived: true }));
    assert.ok(calls.some((c) => c.method === "PUT" && path(c).endsWith("/restore")));
    assert.equal(value.readBack.archived, false);
  });

  it("dry-runs with a warning when the issue cannot be read", async () => {
    const { value } = await run("jira_restore_issue", { issue_key: "PROJ-1" }, oneIssue({ missing: true }));
    assert.equal(value.dry_run, true);
    assert.match(value.warning, /404/);
  });
});

// -- bulk -----------------------------------------------------------------------

function bulk(opts: { matches: number; afterWrite?: number; postError?: Response; firstId?: number; addAfterFirstRead?: number }) {
  // the matching issues, by id; restricted JQL (`issue in (...) AND (...)`) only sees the listed ids
  let ids = Array.from({ length: opts.matches }, (_, i) => (opts.firstId ?? 10001) + i);
  let searches = 0;
  const posted: string[] = [];
  const restrictTo = (jql: string): number[] => {
    const m = /^issue in \(([\d,\s]+)\) AND \(/.exec(jql);
    if (!m) return ids;
    const listed = new Set(m[1].split(",").map((x) => Number(x.trim())));
    return ids.filter((id) => listed.has(id));
  };
  const responder = (c: Call): Response => {
    const p = path(c);
    if (c.method === "GET" && p === "/rest/api/2/search") {
      const q = query(c);
      if (q.get("fields") === "id") searches++;
      const max = Number(q.get("maxResults"));
      const startAt = Number(q.get("startAt") ?? 0);
      const visible = restrictTo(q.get("jql")!);
      const page = visible.slice(startAt, startAt + max);
      const issues = page.map((id) => ({ id: String(id), key: `PROJ-${id - 10000}`, fields: { summary: `S${id - 10000}`, status: { name: "Done" } } }));
      const body = { total: visible.length, startAt, maxResults: max, issues };
      // issues that start to match right after the first id read
      if (q.get("fields") === "id" && searches === 1 && opts.addAfterFirstRead) {
        ids = [...ids, ...Array.from({ length: opts.addAfterFirstRead }, (_, i) => 90001 + i)];
      }
      return { body };
    }
    if (c.method === "POST" && p === "/rest/api/2/issue/archive") {
      if (opts.postError) return opts.postError;
      const jql = String(c.body);
      posted.push(jql);
      const archived = restrictTo(jql);
      const keep = archived.slice(0, opts.afterWrite ?? 0);
      ids = ids.filter((id) => !archived.includes(id) || keep.includes(id));
      return { body: `Archived ${archived.length} issues` };
    }
    return undefined;
  };
  return Object.assign(responder, { posted, ids: () => ids });
}
const JQL = "project = PROJ AND resolved < -365d";
const restricted = (ids: number[]) => `issue in (${ids.join(",")}) AND (${JQL})`;
const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);

describe("jira_archive_issues", () => {
  it("dry run shows count, sample, the POST restricted to the matched ids and an id-set drift state", async () => {
    const { value, calls } = await run("jira_archive_issues", { jql: JQL, sample: 2 }, bulk({ matches: 42 }));
    assert.equal(value.dry_run, true);
    assert.equal(value.matched, 42);
    assert.deepEqual(value.sample.map((s: any) => s.key), ["PROJ-1", "PROJ-2"]);
    assert.equal(value.state.matched, 42);
    assert.match(value.state.ids, /^[0-9a-f]{16}$/);
    assert.equal(value.request.method, "POST");
    assert.equal(value.request.body, restricted(range(10001, 42)));
    assert.ok(calls.every((c) => c.method === "GET"));
    // ids are read with fields=id only
    assert.ok(calls.some((c) => query(c).get("fields") === "id"));
  });

  it("a different set of issues with the same count changes the drift state", async () => {
    const a = await run("jira_archive_issues", { jql: JQL }, bulk({ matches: 5 }));
    const b = await run("jira_archive_issues", { jql: JQL }, bulk({ matches: 5, firstId: 20001 }));
    assert.equal(a.value.state.matched, b.value.state.matched);
    assert.notEqual(a.value.state.ids, b.value.state.ids);
  });

  it("is already satisfied when nothing matches", async () => {
    const { value } = await run("jira_archive_issues", { jql: JQL }, bulk({ matches: 0 }));
    assert.equal(value.already_satisfied, true);
  });

  it("refuses more matches than max_issues", async () => {
    const { result, calls } = await run("jira_archive_issues", { jql: JQL, max_issues: 1000, dry_run: false }, bulk({ matches: 2500 }));
    assert.equal(result.ok, false);
    assert.equal(result.error.type, "ValidationError");
    assert.match(result.error.message, /2500/);
    assert.ok(calls.every((c) => c.method === "GET"));
  });

  it("archives with one POST of the id-restricted JQL as a JSON string and verifies nothing remains", async () => {
    const { value, calls } = await run("jira_archive_issues", { jql: JQL, dry_run: false }, bulk({ matches: 3 }));
    const post = calls.filter((c) => c.method === "POST");
    assert.equal(post.length, 1);
    assert.equal(post[0].body, restricted([10001, 10002, 10003]));
    assert.equal(post[0].headers["Content-Type"], "application/json");
    assert.equal(query(post[0]).get("notifyUsers"), "false");
    assert.equal(value.dry_run, false);
    assert.equal(value.readBack.remaining, 0);
  });

  it("never archives an issue that starts to match after the ids were read", async () => {
    const h = bulk({ matches: 3, addAfterFirstRead: 1 });
    const { value } = await run("jira_archive_issues", { jql: JQL, dry_run: false }, h);
    assert.equal(value.matched, 3);
    assert.deepEqual(h.posted, [restricted([10001, 10002, 10003])]);
    assert.deepEqual(h.ids(), [90001]);
  });

  it("refuses execution when the matched ids differ from approved_ids_hash", async () => {
    const dry = await run("jira_archive_issues", { jql: JQL }, bulk({ matches: 5 }));
    const { result, calls } = await run("jira_archive_issues", { jql: JQL, dry_run: false, approved_ids_hash: dry.value.state.ids }, bulk({ matches: 5, firstId: 20001 }));
    assert.equal(result.ok, false);
    assert.equal(result.error.type, "ValidationError");
    assert.match(result.error.message, /changed/i);
    assert.ok(calls.every((c) => c.method === "GET"));
  });

  it("executes when the matched ids equal approved_ids_hash", async () => {
    const dry = await run("jira_archive_issues", { jql: JQL }, bulk({ matches: 5 }));
    const { value } = await run("jira_archive_issues", { jql: JQL, dry_run: false, approved_ids_hash: dry.value.state.ids }, bulk({ matches: 5 }));
    assert.equal(value.readBack.remaining, 0);
  });

  it("sends the approved ids in chunks when there are many", async () => {
    const h = bulk({ matches: 1200 });
    const { value } = await run("jira_archive_issues", { jql: JQL, dry_run: false, max_issues: 2000 }, h);
    assert.equal(h.posted.length, 3);
    assert.equal(h.posted[0], restricted(range(10001, 500)));
    assert.equal(h.posted[2], restricted(range(11001, 200)));
    assert.equal(value.readBack.remaining, 0);
    assert.equal(value.chunks, 3);
  });

  it("fails verification when approved issues still match", async () => {
    const { result } = await run("jira_archive_issues", { jql: JQL, dry_run: false }, bulk({ matches: 3, afterWrite: 1 }));
    assert.equal(result.ok, false);
    assert.equal(result.error.type, "VerificationError");
    assert.match(result.error.message, /1 issue/);
  });

  it("maps a missing bulk resource to Unsupported", async () => {
    const { result } = await run("jira_archive_issues", { jql: JQL, dry_run: false }, bulk({ matches: 3, postError: { status: 405, body: "" } }));
    assert.equal(result.ok, false);
    assert.equal(result.error.type, "Unsupported");
  });
});
