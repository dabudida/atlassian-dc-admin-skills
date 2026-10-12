import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runTool } from "../../src/runner.js";
import { jiraJsmRequestTools } from "../../src/tools/jira/jsmRequests.js";
import { testContext, type Call } from "./helpers.js";

const R = "/rest/servicedeskapi/request/SD-1";
const date = (iso: string) => ({ iso8601: iso, jira: iso, friendly: iso, epochMillis: Date.parse(iso) });

/** One JSM request with comments, participants, an approval, SLA and CSAT feedback. */
function fakeRequest(opts: { flipPublic?: boolean; flipStored?: boolean; endlessParticipants?: boolean; ignoreWrites?: boolean; approval?: { mine?: string; final?: string; canAnswer?: boolean } } = {}) {
  const comments: any[] = [
    { id: "100", body: "Hello customer", public: true, author: { name: "agent", displayName: "Agent" }, created: date("2026-01-02T10:00:00Z") },
    { id: "101", body: "x".repeat(3000), public: false, author: { name: "agent", displayName: "Agent" }, created: date("2026-01-02T11:00:00Z") },
  ];
  const participants = new Set<string>(["carol", "dave", "erin"]);
  const approval = {
    id: "7",
    name: "Manager approval",
    finalDecision: opts.approval?.final ?? "pending",
    canAnswerApproval: opts.approval?.canAnswer ?? true,
    approvers: [
      { approver: { name: "agent", displayName: "Agent" }, approverDecision: opts.approval?.mine ?? "pending" },
      { approver: { name: "bob", displayName: "Bob" }, approverDecision: "approved" },
    ],
    createdDate: date("2026-01-02T09:00:00Z"),
  };
  const paged = (all: unknown[], q: URLSearchParams) => {
    const start = Number(q.get("start") ?? 0);
    const limit = Number(q.get("limit") ?? 50);
    const values = all.slice(start, start + limit);
    return { size: values.length, start, limit, isLastPage: start + values.length >= all.length, values };
  };
  const user = (name: string) => ({ name, key: name, displayName: name.toUpperCase(), emailAddress: `${name}@example.com`, active: true });
  const responder = (c: Call) => {
    const url = new URL(c.url);
    const p = url.pathname;
    const q = url.searchParams;
    if (c.method !== "GET" && opts.ignoreWrites) return { status: 204 };
    if (p === R) {
      return {
        body: {
          issueId: "10001",
          issueKey: "SD-1",
          requestTypeId: "11",
          requestType: { id: "11", name: "Get IT help", description: "long text" },
          serviceDeskId: "3",
          createdDate: date("2026-01-02T08:00:00Z"),
          reporter: user("alice"),
          requestFieldValues: [
            { fieldId: "summary", label: "Summary", value: "Laptop broken" },
            { fieldId: "description", label: "Description", value: "y".repeat(1000) },
          ],
          currentStatus: { status: "Waiting for support", statusDate: date("2026-01-02T08:00:00Z") },
          participants: { size: 3, start: 0, limit: 50, isLastPage: true, values: [...participants].map(user) },
          sla: {
            size: 2, start: 0, limit: 50, isLastPage: true,
            values: [
              { id: "1", name: "Time to first response", completedCycles: [{ breached: true }], ongoingCycle: undefined },
              { id: "2", name: "Time to resolution", completedCycles: [], ongoingCycle: { breached: false, paused: false, withinCalendarHours: true, breachTime: date("2026-01-03T08:00:00Z"), remainingTime: { friendly: "7h", millis: 1 } } },
            ],
          },
          _links: { web: "https://jira.example.com/servicedesk/customer/portal/3/SD-1", self: "x" },
        },
      };
    }
    if (p === `${R}/comment`) {
      if (c.method === "POST") {
        const cm = { id: String(200 + comments.length), body: c.body.body, public: opts.flipPublic || opts.flipStored ? !c.body.public : c.body.public, author: { name: "agent" }, created: date("2026-01-03T00:00:00Z") };
        comments.push(cm);
        // flipStored: the POST response echoes the requested flag while the stored comment differs
        return { status: 201, body: opts.flipStored ? { ...cm, public: c.body.public } : cm };
      }
      const list = comments.filter((cm) => (cm.public ? q.get("public") !== "false" : q.get("internal") !== "false"));
      return { body: paged(list, q) };
    }
    const one = new RegExp(`^${R}/comment/(\\d+)$`).exec(p);
    if (one) {
      const cm = comments.find((x) => x.id === one[1]);
      return cm ? { body: cm } : { status: 404, body: { errorMessage: "No comment" } };
    }
    if (p === `${R}/participant` && opts.endlessParticipants && c.method === "GET") {
      const start = Number(q.get("start") ?? 0);
      const limit = Number(q.get("limit") ?? 50);
      const values = Array.from({ length: limit }, (_, i) => user(`user${start + i}`));
      return { body: { size: limit, start, limit, isLastPage: false, values } };
    }
    if (p === `${R}/participant`) {
      if (c.method === "POST") for (const u of c.body.usernames) participants.add(u);
      if (c.method === "DELETE") for (const u of c.body.usernames) participants.delete(u);
      return { body: paged([...participants].map(user), q) };
    }
    if (p === `${R}/approval`) return { body: paged([approval], q) };
    if (p === `${R}/approval/7`) {
      if (c.method === "POST") {
        approval.approvers[0].approverDecision = c.body.decision === "approve" ? "approved" : "declined";
        approval.finalDecision = approval.approvers[0].approverDecision;
      }
      return { body: approval };
    }
    if (p === `${R}/status`) return { body: paged([{ status: "Waiting for support", statusDate: date("2026-01-02T08:00:00Z") }, { status: "Open", statusDate: date("2026-01-02T07:00:00Z") }], q) };
    if (p === "/rest/api/2/myself") return { body: user("agent") };
    if (p === "/rest/api/2/field") {
      return {
        body: [
          { id: "summary", name: "Summary", schema: { type: "string" } },
          { id: "customfield_10303", name: "Satisfaction", custom: true, schema: { type: "any", custom: "com.atlassian.servicedesk:sd-request-feedback" } },
          { id: "customfield_10402", name: "Satisfaction date", custom: true, schema: { type: "datetime", custom: "com.atlassian.servicedesk:sd-request-feedback-date" } },
        ],
      };
    }
    if (p === "/rest/api/2/issue/SD-1") return { body: { key: "SD-1", fields: { customfield_10303: "com.atlassian.servicedesk.Feedback@1a2b", customfield_10402: "2026-01-04T10:00:00.000+0000" } } };
    if (p === "/rest/api/2/issue/SD-2") return { body: { key: "SD-2", fields: { customfield_10303: null, customfield_10402: null } } };
    if (p === "/rest/api/2/search") return { body: { total: /cf\[10303\] = 4\b/.test(q.get("jql")!) && /SD-1/.test(q.get("jql")!) ? 1 : 0, issues: [] } };
    if (p === "/rest/api/2/issue/SD-1/properties/service-request-feedback-comment") return { body: { key: "service-request-feedback-comment", value: { comment: "Great help" } } };
    return undefined;
  };
  return { responder, comments, participants, approval };
}

async function run(name: string, args: Record<string, unknown>, responder: (c: Call) => any) {
  const tool = jiraJsmRequestTools.find((t) => t.name === name);
  assert.ok(tool, `no tool ${name}`);
  const { ctx, calls } = testContext(responder);
  const res = await runTool(tool, args, ctx);
  return { res, value: res.ok ? (res.value as any) : undefined, error: res.ok ? undefined : (res as any).error, calls };
}

const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

describe("request reads", () => {
  it("returns a compact request view with SLA summary, participant count and links", async () => {
    const r = await run("jira_get_request", { issue_key: "SD-1" }, fakeRequest().responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    const v = r.value;
    assert.equal(v.key, "SD-1");
    assert.deepEqual(v.requestType, { id: "11", name: "Get IT help" });
    assert.equal(v.status, "Waiting for support");
    assert.equal(v.participants, 3);
    assert.deepEqual(v.reporter, { name: "alice", displayName: "ALICE" });
    assert.equal(v.sla.length, 2);
    assert.deepEqual(v.sla[0], { name: "Time to first response", ongoing: null, completedCycles: 1, lastCompletedBreached: true });
    assert.equal(v.sla[1].ongoing.remaining, "7h");
    assert.equal(v.links.agent, "https://jira.example.com/browse/SD-1");
    assert.ok(v.fields[1].value.length < 400);
    assert.equal(r.calls[0].headers["X-ExperimentalApi"], "opt-in");
    assert.match(r.calls[0].url, /expand=requestType%2Cparticipant%2Csla/);
  });

  it("lists comments with a public flag, filters by visibility and cuts long bodies", async () => {
    const all = await run("jira_get_request_comments", { issue_key: "SD-1" }, fakeRequest().responder);
    assert.ok(all.res.ok, JSON.stringify(all.error));
    assert.deepEqual(all.value.items.map((cm: any) => cm.public), [true, false]);
    assert.ok(all.value.items[1].body.length < 1100);
    assert.equal(all.value.items[1].bodyTruncated, true);
    const pub = await run("jira_get_request_comments", { issue_key: "SD-1", visibility: "public" }, fakeRequest().responder);
    assert.deepEqual(pub.value.items.map((cm: any) => cm.id), ["100"]);
    assert.equal(new URL(pub.calls[0].url).searchParams.get("internal"), "false");
    const internal = await run("jira_get_request_comments", { issue_key: "SD-1", visibility: "internal" }, fakeRequest().responder);
    assert.deepEqual(internal.value.items.map((cm: any) => cm.id), ["101"]);
  });

  it("lists participants, approvals and status history page by page", async () => {
    const parts = await run("jira_get_request_participants", { issue_key: "SD-1", limit: 2 }, fakeRequest().responder);
    assert.deepEqual(parts.value.items.map((u: any) => u.name), ["carol", "dave"]);
    assert.equal(parts.value.nextOffset, 2);
    const ap = await run("jira_get_request_approvals", { issue_key: "SD-1" }, fakeRequest().responder);
    assert.ok(ap.res.ok, JSON.stringify(ap.error));
    assert.deepEqual(ap.value.items[0].approvers, [{ name: "agent", displayName: "Agent", decision: "pending" }, { name: "bob", displayName: "Bob", decision: "approved" }]);
    assert.equal(ap.value.items[0].finalDecision, "pending");
    const st = await run("jira_get_request_status_history", { issue_key: "SD-1" }, fakeRequest().responder);
    assert.deepEqual(st.value.items.map((s: any) => s.status), ["Waiting for support", "Open"]);
  });

  it("reads CSAT feedback through the field, JQL and the comment property", async () => {
    const r = await run("jira_get_request_feedback", { issue_key: "SD-1" }, fakeRequest().responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.deepEqual({ submitted: r.value.submitted, rating: r.value.rating, comment: r.value.comment }, { submitted: true, rating: 4, comment: "Great help" });
    assert.equal(r.value.date, "2026-01-04T10:00:00.000+0000");
    assert.ok(r.calls.every((c) => c.method === "GET"));
    const none = await run("jira_get_request_feedback", { issue_key: "SD-2" }, fakeRequest().responder);
    assert.equal(none.value.submitted, false);
    assert.equal(none.value.rating, null);
  });
});

describe("request writes", () => {
  it("adds an internal comment by default and says the customer does not see it", async () => {
    const dry = await run("jira_add_request_comment", { issue_key: "SD-1", body: "Checking logs" }, fakeRequest().responder);
    assert.ok(dry.res.ok, JSON.stringify(dry.error));
    assert.deepEqual(dry.value.request.body, { body: "Checking logs", public: false });
    assert.match(dry.value.summary, /INTERNAL/);
    assert.match(dry.value.summary, /customer does not see/);
    assert.equal(writes(dry.calls).length, 0);
  });

  it("adds a public comment, says the customer sees it, and verifies the stored flag", async () => {
    const f = fakeRequest();
    const dry = await run("jira_add_request_comment", { issue_key: "SD-1", body: "Fixed", public: true }, f.responder);
    assert.match(dry.value.summary, /PUBLIC.*visible to the customer/);
    const done = await run("jira_add_request_comment", { issue_key: "SD-1", body: "Fixed", public: "true", dry_run: false }, f.responder);
    assert.ok(done.res.ok, JSON.stringify(done.error));
    assert.equal(done.value.result.public, true);
    const bad = await run("jira_add_request_comment", { issue_key: "SD-1", body: "Fixed", public: true, dry_run: false }, fakeRequest({ flipPublic: true }).responder);
    assert.equal(bad.error.type, "VerificationError");
  });

  it("adds and removes only changing participants; no change is already_satisfied", async () => {
    const f = fakeRequest();
    const dry = await run("jira_add_request_participants", { issue_key: "SD-1", usernames: "carol,frank" }, f.responder);
    assert.deepEqual(dry.value.request.body, { usernames: ["frank"] });
    assert.ok((await run("jira_add_request_participants", { issue_key: "SD-1", usernames: "carol,frank", dry_run: false }, f.responder)).res.ok);
    assert.ok(f.participants.has("frank"));
    assert.equal((await run("jira_add_request_participants", { issue_key: "SD-1", usernames: "frank" }, f.responder)).value.already_satisfied, true);
    const rm = await run("jira_remove_request_participants", { issue_key: "SD-1", usernames: "frank,zed", dry_run: false }, f.responder);
    assert.ok(rm.res.ok, JSON.stringify(rm.error));
    assert.deepEqual(writes(rm.calls)[0].body, { usernames: ["frank"] });
    assert.equal((await run("jira_remove_request_participants", { issue_key: "SD-1", usernames: "frank" }, f.responder)).value.already_satisfied, true);
    const unverified = await run("jira_add_request_participants", { issue_key: "SD-1", usernames: "gina", dry_run: false }, fakeRequest({ ignoreWrites: true }).responder);
    assert.equal(unverified.error.type, "VerificationError");
  });

  it("answers an approval, reads it back, and the same answer again is already_satisfied", async () => {
    const f = fakeRequest();
    const dry = await run("jira_answer_request_approval", { issue_key: "SD-1", approval_id: 7, decision: "approve" }, f.responder);
    assert.ok(dry.res.ok, JSON.stringify(dry.error));
    assert.deepEqual(dry.value.request.body, { decision: "approve" });
    const done = await run("jira_answer_request_approval", { issue_key: "SD-1", approval_id: 7, decision: "approve", dry_run: false }, f.responder);
    assert.ok(done.res.ok, JSON.stringify(done.error));
    assert.equal(done.value.result.myDecision, "approved");
    const again = await run("jira_answer_request_approval", { issue_key: "SD-1", approval_id: 7, decision: "approve" }, fakeRequest({ approval: { mine: "approved", final: "approved" } }).responder);
    assert.equal(again.value.already_satisfied, true);
  });

  it("refuses a different answer, a final approval, or a user who cannot answer", async () => {
    const other = await run("jira_answer_request_approval", { issue_key: "SD-1", approval_id: 7, decision: "decline" }, fakeRequest({ approval: { mine: "approved" } }).responder);
    assert.equal(other.error.type, "ValidationError");
    assert.match(other.error.message, /already approved/);
    const final = await run("jira_answer_request_approval", { issue_key: "SD-1", approval_id: 7, decision: "approve" }, fakeRequest({ approval: { final: "declined" } }).responder);
    assert.match(final.error.message, /final/);
    const cannot = await run("jira_answer_request_approval", { issue_key: "SD-1", approval_id: 7, decision: "approve" }, fakeRequest({ approval: { canAnswer: false } }).responder);
    assert.match(cannot.error.message, /cannot answer/);
  });

  it("re-reads the stored comment by id and fails when its public flag differs from the POST response", async () => {
    const ok = await run("jira_add_request_comment", { issue_key: "SD-1", body: "Fixed", public: true, dry_run: false }, fakeRequest().responder);
    assert.ok(ok.res.ok, JSON.stringify(ok.error));
    assert.ok(ok.calls.some((c) => c.method === "GET" && new URL(c.url).pathname === `${R}/comment/${ok.value.result.id}`));
    const bad = await run("jira_add_request_comment", { issue_key: "SD-1", body: "Fixed", public: true, dry_run: false }, fakeRequest({ flipStored: true }).responder);
    assert.equal(bad.error?.type, "VerificationError", JSON.stringify(bad.value));
  });

  it("matches participants case-insensitively and removes them by the server's username", async () => {
    const f = fakeRequest();
    assert.equal((await run("jira_add_request_participants", { issue_key: "SD-1", usernames: "CAROL" }, f.responder)).value.already_satisfied, true);
    const rm = await run("jira_remove_request_participants", { issue_key: "SD-1", usernames: "Carol", dry_run: false }, f.responder);
    assert.ok(rm.res.ok, JSON.stringify(rm.error));
    assert.deepEqual(writes(rm.calls)[0].body, { usernames: ["carol"] });
    assert.equal(f.participants.has("carol"), false);
  });

  it("never claims a non-participant or a verified add when the participant list is capped", async () => {
    const rm = await run("jira_remove_request_participants", { issue_key: "SD-1", usernames: "zed" }, fakeRequest({ endlessParticipants: true }).responder);
    assert.equal(rm.error?.type, "ValidationError", JSON.stringify(rm.value));
    const add = await run("jira_add_request_participants", { issue_key: "SD-1", usernames: "zed", dry_run: false }, fakeRequest({ endlessParticipants: true, ignoreWrites: true }).responder);
    assert.ok(add.res.ok, JSON.stringify(add.error));
    assert.equal(add.value.verification, "partial");
    assert.deepEqual(add.value.unverified, ["zed"]);
  });

  it("write tools take dry_run and invalidate nothing", () => {
    for (const t of jiraJsmRequestTools.filter((x) => x.write)) {
      assert.deepEqual(t.invalidates, [], t.name);
      assert.ok("dry_run" in t.inputShape, t.name);
    }
  });
});
