import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runTool } from "../../src/runner.js";
import { jiraSchemeWriteTools } from "../../src/tools/jira/schemeWrites.js";
import { testContext, type Call } from "./helpers.js";

const tool = (name: string) => {
  const t = jiraSchemeWriteTools.find((x) => x.name === name);
  assert.ok(t, `tool ${name} exists`);
  return t;
};
const path = (c: Call) => new URL(c.url).pathname;
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

/** Notification scheme 10000 'Default Notification Scheme' and issue security scheme 10200 with one level. */
function fakeJira(opts: { ignore?: boolean; secured?: number; currentSecurity?: number | null } = {}) {
  const state = { security: opts.currentSecurity === undefined ? null : opts.currentSecurity } as { security: number | null };
  const notificationScheme = {
    id: 10000,
    name: "Default Notification Scheme",
    notificationSchemeEvents: [
      { event: { id: 1, name: "Issue Created" }, notifications: [{ id: 1, notificationType: "Reporter" }, { id: 2, notificationType: "Group", parameter: "jira-admins" }] },
      { event: { id: 2, name: "Issue Updated" }, notifications: [{ id: 3, notificationType: "ProjectRole", parameter: "10002", projectRole: { id: 10002, name: "Administrators" } }] },
      // Jira stores a Single User recipient by user KEY, not username
      { event: { id: 3, name: "Issue Assigned" }, notifications: [{ id: 4, notificationType: "User", parameter: "JIRAUSER10100" }] },
    ],
  };
  const securitySchemes = [
    { id: 10200, name: "Internal only", defaultSecurityLevelId: 10300, levels: [{ id: 10300, name: "Staff", description: "" }] },
    { id: 10201, name: "Partners", levels: [] },
  ];
  const responder = (c: Call) => {
    const p = path(c);
    const q = new URL(c.url).searchParams;
    if (p === "/rest/api/2/notificationscheme") return { body: { startAt: 0, maxResults: 50, total: 1, isLast: true, values: [{ id: 10000, name: notificationScheme.name }] } };
    if (p === "/rest/api/2/notificationscheme/10000") return { body: notificationScheme };
    if (p === "/rest/api/2/user") {
      const users: Record<string, string> = { "sample.user": "JIRAUSER10100", "other.user": "JIRAUSER10101" };
      const u = q.get("username") ?? "";
      return users[u] ? { body: { name: u, key: users[u] } } : { status: 404, body: { errorMessages: ["user not found"] } };
    }
    if (p === "/rest/api/2/role") return { body: [{ id: 10002, name: "Administrators" }, { id: 10001, name: "Developers" }] };
    if (p === "/rest/api/2/issuesecurityschemes") return { body: { issueSecuritySchemes: securitySchemes.map(({ levels, ...s }) => s) } };
    const sec = /^\/rest\/api\/2\/issuesecurityschemes\/(\d+)$/.exec(p);
    if (sec) return { body: securitySchemes.find((s) => s.id === Number(sec[1])) ?? undefined };
    if (p === "/rest/api/2/project/PROJ" && c.method === "GET") return { body: { id: "10000", key: "PROJ" } };
    if (p === "/rest/api/2/project/PROJ" && c.method === "PUT") {
      if (!opts.ignore && c.body?.issueSecurityScheme !== undefined) state.security = Number(c.body.issueSecurityScheme);
      return { body: { id: "10000", key: "PROJ" } };
    }
    if (p === "/rest/api/2/project/PROJ/issuesecuritylevelscheme") {
      if (state.security === null) return { status: 404, body: { errorMessages: ["Security level for project PROJ does not exist."] } };
      const s = securitySchemes.find((x) => x.id === state.security)!;
      return { body: { id: s.id, name: s.name } };
    }
    if (p === "/rest/api/2/search") return { body: { total: opts.secured ?? 0, issues: [], jql: q.get("jql") } };
    return undefined;
  };
  return { responder, state };
}

async function run(name: string, args: Record<string, unknown>, j = fakeJira()) {
  const { ctx, calls } = testContext(j.responder);
  const r: any = await runTool(tool(name), args, ctx);
  return { r, calls, value: r.ok ? r.value : undefined, error: r.ok ? undefined : r.error };
}

describe("notification scheme changes (manual, verified on re-run)", () => {
  it("adds a notification as a manual change with the admin page and steps", async () => {
    const r = await run("jira_add_notification", { scheme: "Default Notification Scheme", event: "Issue Updated", recipient_type: "Group", recipient: "jira-users" });
    assert.ok(r.r.ok, JSON.stringify(r.error));
    assert.equal(r.value.request.method, "MANUAL");
    assert.match(r.value.request.url, /AddNotification!default\.jspa\?schemeId=10000$/);
    assert.ok(r.value.request.body.steps.some((s: string) => s.includes("Issue Updated")));
    assert.ok(r.value.request.body.steps.some((s: string) => s.includes("jira-users")));
    assert.ok(r.value.manual.reason);
    assert.equal(writes(r.calls).length, 0);
    const ex = await run("jira_add_notification", { scheme: 10000, event: 2, recipient_type: "Group", recipient: "jira-users", dry_run: false });
    assert.equal(ex.error?.type, "Unsupported");
  });

  it("reports an existing notification as already satisfied (role by name, event by id)", async () => {
    const r = await run("jira_add_notification", { scheme: 10000, event: "2", recipient_type: "ProjectRole", recipient: "Administrators", dry_run: false });
    assert.equal(r.value?.already_satisfied, true, JSON.stringify(r.error ?? r.value));
    const rep = await run("jira_add_notification", { scheme: 10000, event: "issue created", recipient_type: "Reporter" });
    assert.equal(rep.value?.already_satisfied, true);
  });

  it("validates recipient parameters and unknown events", async () => {
    const noParam = await run("jira_add_notification", { scheme: 10000, event: 1, recipient_type: "Group" });
    assert.equal(noParam.r.ok, false);
    assert.match(noParam.error.message, /recipient/);
    const extra = await run("jira_add_notification", { scheme: 10000, event: 1, recipient_type: "Reporter", recipient: "x" });
    assert.equal(extra.r.ok, false);
    const ev = await run("jira_add_notification", { scheme: 10000, event: "Nope", recipient_type: "Reporter" });
    assert.equal(ev.r.ok, false);
    assert.match(ev.error.message, /Nope/);
    const role = await run("jira_add_notification", { scheme: 10000, event: 1, recipient_type: "ProjectRole", recipient: "Nobody" });
    assert.match(role.error.message, /Nobody/);
  });

  it("removes a notification manually, or reports it already absent", async () => {
    const r = await run("jira_remove_notification", { scheme: 10000, event: "Issue Created", recipient_type: "Group", recipient: "jira-admins" });
    assert.ok(r.r.ok, JSON.stringify(r.error));
    assert.equal(r.value.request.method, "MANUAL");
    assert.match(r.value.request.url, /DeleteNotification!default\.jspa\?id=2&schemeId=10000$/);
    const gone = await run("jira_remove_notification", { scheme: 10000, event: "Issue Created", recipient_type: "Group", recipient: "nobody" });
    assert.equal(gone.value?.already_satisfied, true);
  });

  it("matches Single User recipients by user key (Jira stores the key, not the username)", async () => {
    const add = await run("jira_add_notification", { scheme: 10000, event: "Issue Assigned", recipient_type: "User", recipient: "sample.user" });
    assert.equal(add.value?.already_satisfied, true, JSON.stringify(add.error ?? add.value));
    const rm = await run("jira_remove_notification", { scheme: 10000, event: "Issue Assigned", recipient_type: "User", recipient: "sample.user" });
    assert.ok(rm.r.ok, JSON.stringify(rm.error));
    assert.equal(rm.value.already_satisfied, undefined);
    assert.match(rm.value.request.url, /DeleteNotification!default\.jspa\?id=4&schemeId=10000$/);
    const other = await run("jira_add_notification", { scheme: 10000, event: "Issue Assigned", recipient_type: "User", recipient: "other.user" });
    assert.equal(other.value.request.method, "MANUAL");
    const missing = await run("jira_add_notification", { scheme: 10000, event: "Issue Assigned", recipient_type: "User", recipient: "nobody" });
    assert.match(missing.error.message, /nobody/);
  });

  it("creates a notification scheme manually; an existing name is already satisfied", async () => {
    const r = await run("jira_create_notification_scheme", { name: "Quiet" });
    assert.equal(r.value.request.method, "MANUAL");
    assert.match(r.value.request.url, /AddNotificationScheme!default\.jspa$/);
    const have = await run("jira_create_notification_scheme", { name: "default notification scheme" });
    assert.equal(have.value?.already_satisfied, true);
  });
});

describe("issue security schemes", () => {
  it("creates a scheme and a level manually, verified by name on re-run", async () => {
    const s = await run("jira_create_issue_security_scheme", { name: "New scheme" });
    assert.equal(s.value.request.method, "MANUAL");
    assert.match(s.value.request.url, /AddIssueSecurityScheme!default\.jspa$/);
    assert.equal((await run("jira_create_issue_security_scheme", { name: "Partners" })).value?.already_satisfied, true);
    const l = await run("jira_add_issue_security_level", { scheme: "Internal only", name: "Managers" });
    assert.equal(l.value.request.method, "MANUAL");
    assert.match(l.value.request.url, /EditIssueSecurities!default\.jspa\?schemeId=10200$/);
    assert.equal((await run("jira_add_issue_security_level", { scheme: 10200, name: "staff" })).value?.already_satisfied, true);
  });

  it("adds a level member as an unverifiable manual change", async () => {
    const r = await run("jira_add_issue_security_level_member", { scheme: 10200, level: "Staff", member_type: "group", member: "staff" });
    assert.ok(r.r.ok, JSON.stringify(r.error));
    assert.equal(r.value.request.method, "MANUAL");
    assert.match(r.value.request.url, /AddIssueSecurity!default\.jspa\?schemeId=10200$/);
    assert.match(r.value.note, /no REST read/);
    assert.ok(tool("jira_add_issue_security_level_member").unverifiable);
    const bad = await run("jira_add_issue_security_level_member", { scheme: 10200, level: "Nope", member_type: "reporter" });
    assert.match(bad.error.message, /Nope/);
  });

  it("assigns a scheme to a project without one through REST and reads it back", async () => {
    const j = fakeJira();
    const dry = await run("jira_assign_issue_security_scheme", { project_key: "PROJ", scheme: "Internal only" }, j);
    assert.ok(dry.r.ok, JSON.stringify(dry.error));
    assert.equal(dry.value.request.method, "PUT");
    assert.match(dry.value.request.url, /\/rest\/api\/2\/project\/PROJ$/);
    assert.deepEqual(dry.value.request.body, { issueSecurityScheme: 10200 });
    assert.equal(dry.value.before, null);
    assert.equal(writes(dry.calls).length, 0);
    const ex = await run("jira_assign_issue_security_scheme", { project_key: "PROJ", scheme: 10200, dry_run: false }, j);
    assert.ok(ex.r.ok, JSON.stringify(ex.error));
    assert.equal(j.state.security, 10200);
    const again = await run("jira_assign_issue_security_scheme", { project_key: "PROJ", scheme: 10200, dry_run: false }, j);
    assert.equal(again.value?.already_satisfied, true);
  });

  it("fails verification when the assignment does not read back", async () => {
    const r = await run("jira_assign_issue_security_scheme", { project_key: "PROJ", scheme: 10200, dry_run: false }, fakeJira({ ignore: true }));
    assert.equal(r.error?.type, "VerificationError", JSON.stringify(r.error ?? r.value));
  });

  it("turns a switch with secured issues into a manual change (Jira would remap levels)", async () => {
    const j = fakeJira({ currentSecurity: 10200, secured: 4 });
    const r = await run("jira_assign_issue_security_scheme", { project_key: "PROJ", scheme: "Partners" }, j);
    assert.ok(r.r.ok, JSON.stringify(r.error));
    assert.equal(r.value.request.method, "MANUAL");
    assert.match(r.value.request.url, /SelectProjectIssueSecurityScheme!default\.jspa\?projectId=10000$/);
    assert.equal(writes(r.calls).length, 0);
    // the /search count only sees issues visible to the caller: a switch is always the UI remapping
    const hidden = await run("jira_assign_issue_security_scheme", { project_key: "PROJ", scheme: "Partners" }, fakeJira({ currentSecurity: 10200, secured: 0 }));
    assert.equal(hidden.value.request.method, "MANUAL");
    assert.ok(!hidden.calls.some((c) => path(c) === "/rest/api/2/search"));
  });
});
