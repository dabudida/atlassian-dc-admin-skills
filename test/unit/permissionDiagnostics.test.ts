import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runTool } from "../../src/runner.js";
import { jiraPermissionDiagnosticTools, normalizePermission } from "../../src/tools/jira/permissionDiagnostics.js";
import { testContext, type Call } from "./helpers.js";

const tool = (name: string) => {
  const t = jiraPermissionDiagnosticTools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};

type Response = { status?: number; body?: unknown } | undefined;

const ALICE = {
  key: "JIRAUSER10001",
  name: "alice",
  displayName: "Alice",
  active: true,
  deleted: false,
  lastLoginTime: "2026-10-01T10:00:00.000+0000",
  groups: { size: 2, items: [{ name: "devs" }, { name: "everyone" }] },
  applicationRoles: { size: 1, items: [{ key: "jira-software", name: "Jira Software" }] },
};

const GRANTS = [
  { id: 1, permission: "BROWSE_PROJECTS", holder: { type: "group", parameter: "devs", group: { name: "devs" } } },
  { id: 2, permission: "BROWSE_PROJECTS", holder: { type: "projectRole", parameter: "10002", projectRole: { id: 10002, name: "Administrators" } } },
  { id: 3, permission: "BROWSE_PROJECTS", holder: { type: "applicationRole", parameter: "jira-servicedesk" } },
  { id: 4, permission: "BROWSE_PROJECTS", holder: { type: "reporter" } },
  { id: 5, permission: "BROWSE_PROJECTS", holder: { type: "userCustomField", parameter: "customfield_10500", field: { name: "Approvers" } } },
  { id: 6, permission: "CREATE_ISSUES", holder: { type: "projectRole", parameter: "10001", projectRole: { id: 10001, name: "Developers" } } },
  { id: 7, permission: "CREATE_ISSUES", holder: { type: "sd.customer.portal.only" } },
  { id: 8, permission: "TRANSITION_ISSUES", holder: { type: "assignee" } },
];

/** A small Jira: project PROJ (lead bob), permission scheme 10000, roles, user alice, issue PROJ-1. */
function fixture(opts: { searchUsers?: unknown[]; searchStatus?: number; user?: any; grants?: any[]; issue?: any; override?: (c: Call) => Response } = {}) {
  return (c: Call): Response => {
    const custom = opts.override?.(c);
    if (custom) return custom;
    const u = new URL(c.url);
    const p = u.pathname;
    const q = u.searchParams;
    if (p === "/rest/api/2/user") return { body: opts.user ?? ALICE };
    if (p === "/rest/api/2/project/PROJ") return { body: { id: "10000", key: "PROJ", name: "Project", lead: { name: "bob", key: "JIRAUSER10002" } } };
    if (p === "/rest/api/2/project/PROJ/permissionscheme") return { body: { id: 10000, name: "Default scheme", permissions: opts.grants ?? GRANTS } };
    if (p === "/rest/api/2/project/PROJ/role/10002") return { body: { id: 10002, name: "Administrators", actors: [
      { type: "atlassian-group-role-actor", name: "admins" },
      { type: "atlassian-user-role-actor", name: "alice" },
    ] } };
    if (p === "/rest/api/2/project/PROJ/role/10001") return { body: { id: 10001, name: "Developers", actors: [
      { type: "atlassian-group-role-actor", name: "devs" },
    ] } };
    if (p === "/rest/api/2/user/permission/search") {
      if (opts.searchStatus) return { status: opts.searchStatus, body: { errorMessages: [`Invalid permission name specified: '${q.get("permissions")}'`] } };
      return { body: opts.searchUsers ?? [{ name: "alice", key: "JIRAUSER10001" }] };
    }
    if (p === "/rest/api/2/issue/PROJ-1") return { body: opts.issue ?? { key: "PROJ-1", fields: {
      project: { key: "PROJ" },
      reporter: { name: "alice", key: "JIRAUSER10001" },
      assignee: null,
      security: { id: "10100", name: "Internal" },
      customfield_10500: [{ name: "carol", key: "JIRAUSER10003" }],
    } } };
    throw new Error(`Unexpected fixture request: ${c.method} ${p}`);
  };
}

async function explain(args: Record<string, unknown>, opts: Parameters<typeof fixture>[0] = {}) {
  const { ctx, calls } = testContext(fixture(opts));
  const result = await runTool(tool("jira_explain_permission"), args, ctx);
  assert.ok(result.ok, JSON.stringify(result));
  assert.ok(calls.every((c) => c.method === "GET"), "read-only");
  return { value: (result as any).value, calls };
}

describe("normalizePermission", () => {
  it("uppercases only known scheme keys and legacy names; plugin keys pass unchanged", () => {
    assert.deepEqual(normalizePermission(" browse "), { key: "BROWSE_PROJECTS", searchName: "BROWSE", known: true });
    assert.deepEqual(normalizePermission("create_issues"), { key: "CREATE_ISSUES", searchName: "CREATE_ISSUE", known: true });
    assert.deepEqual(normalizePermission(" com.example.plugin:viewReports "), { key: "com.example.plugin:viewReports", searchName: "com.example.plugin:viewReports", known: false });
  });
});

describe("jira_explain_permission", () => {
  it("explains each grant against the user and agrees with the ground truth", async () => {
    const { value, calls } = await explain({ username: "alice", project_key: "PROJ", permission: "BROWSE_PROJECTS" });
    assert.equal(value.verdict, "granted");
    assert.equal(value.permission, "BROWSE_PROJECTS");
    assert.equal(value.groundTruth.status, "granted");
    assert.equal(value.groundTruth.checkedAs, "BROWSE");
    assert.equal(value.computed, "granted");
    assert.equal(value.agreement, "agree");
    assert.deepEqual(value.permissionScheme, { id: 10000, name: "Default scheme" });
    const rows = Object.fromEntries(value.grants.map((g: any) => [g.holder, g]));
    assert.equal(rows["group:devs"].matches, "yes");
    assert.equal(rows["projectRole:Administrators"].matches, "yes");
    assert.match(rows["projectRole:Administrators"].why, /directly/);
    assert.equal(rows["applicationRole:jira-servicedesk"].matches, "no");
    assert.equal(rows["reporter"].matches, "conditional");
    assert.equal(rows["userCustomField:Approvers"].matches, "conditional");
    assert.equal(value.grants.length, 5, "only grants of the asked permission");
    assert.deepEqual(value.user.applications, ["jira-software"]);
    assert.equal(value.user.active, true);
    // the search endpoint takes the legacy permission name
    const search = calls.find((c) => c.url.includes("/user/permission/search"))!;
    const sq = new URL(search.url).searchParams;
    assert.equal(sq.get("permissions"), "BROWSE");
    assert.equal(sq.get("projectKey"), "PROJ");
    assert.equal(sq.get("username"), "alice");
  });

  it("accepts legacy aliases and matches project-role group actors", async () => {
    const { value } = await explain({ username: "alice", project_key: "PROJ", permission: "create_issue" });
    assert.equal(value.permission, "CREATE_ISSUES");
    const role = value.grants.find((g: any) => g.holder === "projectRole:Developers");
    assert.equal(role.matches, "yes");
    assert.match(role.why, /group devs/);
    const unknown = value.grants.find((g: any) => g.holder === "sd.customer.portal.only");
    assert.equal(unknown.matches, "unknown");
  });

  it("says so explicitly when the computed explanation disagrees with the ground truth", async () => {
    const { value } = await explain({ username: "alice", project_key: "PROJ", permission: "BROWSE_PROJECTS" }, { searchUsers: [] });
    assert.equal(value.verdict, "denied");
    assert.equal(value.computed, "granted");
    assert.equal(value.agreement, "disagree");
    assert.ok(value.notes.some((n: string) => /disagree/i.test(n)));
  });

  it("only counts an exact username match in the search result", async () => {
    const { value } = await explain({ username: "alice", project_key: "PROJ", permission: "BROWSE_PROJECTS" }, { searchUsers: [{ name: "alice2", key: "JIRAUSER2" }] });
    assert.equal(value.groundTruth.status, "denied");
  });

  it("falls back to the computed verdict when the ground truth is unavailable", async () => {
    const { value } = await explain({ username: "alice", project_key: "PROJ", permission: "TRANSITION_ISSUES" }, { searchStatus: 400 });
    assert.equal(value.groundTruth.status, "unavailable");
    assert.equal(value.computed, "conditional");
    assert.equal(value.verdict, "unknown");
    assert.equal(value.agreement, "unavailable");
  });

  it("evaluates issue holders and reports the issue security level", async () => {
    const { value, calls } = await explain({ username: "alice", permission: "BROWSE", issue_key: "PROJ-1" });
    assert.equal(value.project, "PROJ");
    assert.equal(value.issue.key, "PROJ-1");
    assert.deepEqual(value.issue.securityLevel, { id: "10100", name: "Internal" });
    assert.equal(value.issue.userInSecurityLevel, "granted-by-ground-truth");
    const rows = Object.fromEntries(value.grants.map((g: any) => [g.holder, g]));
    assert.equal(rows["reporter"].matches, "yes");
    assert.equal(rows["userCustomField:Approvers"].matches, "no");
    const search = calls.find((c) => c.url.includes("/user/permission/search"))!;
    assert.equal(new URL(search.url).searchParams.get("issueKey"), "PROJ-1");
    assert.equal(new URL(search.url).searchParams.get("projectKey"), null);
  });

  it("uses the issue's current project for a moved issue and rejects a mismatching project_key", async () => {
    const moved = { key: "PROJ-7", fields: { project: { key: "PROJ" }, reporter: null, assignee: null, security: null } };
    const override = (c: Call) => (/\/issue\/(OLD-5|PROJ-7)$/.test(new URL(c.url).pathname) ? { body: moved } : undefined);
    const { value } = await explain({ username: "alice", permission: "BROWSE", issue_key: "OLD-5" }, { override });
    assert.equal(value.project, "PROJ");
    assert.equal(value.issue.key, "PROJ-7");
    assert.equal(value.issue.userInSecurityLevel, "no-level");
    const { ctx } = testContext(fixture({ override }));
    const r = await runTool(tool("jira_explain_permission"), { username: "alice", permission: "BROWSE", issue_key: "OLD-5", project_key: "OTHER" }, ctx);
    assert.equal(r.ok, false);
  });

  it("explains a denial on a secured issue by the security level", async () => {
    const { value } = await explain({ username: "alice", permission: "BROWSE_PROJECTS", issue_key: "PROJ-1" }, { searchUsers: [] });
    assert.equal(value.verdict, "denied");
    assert.equal(value.issue.userInSecurityLevel, "likely-not");
    assert.ok(value.notes.some((n: string) => /security level/i.test(n)));
  });

  it("flags inactive users and users without application access", async () => {
    const { value } = await explain(
      { username: "alice", project_key: "PROJ", permission: "BROWSE_PROJECTS" },
      { user: { ...ALICE, active: false, applicationRoles: { size: 0, items: [] } }, searchUsers: [] },
    );
    assert.equal(value.verdict, "denied");
    assert.equal(value.computed, "denied");
    assert.ok(value.notes.some((n: string) => /inactive/i.test(n)));
    assert.ok(value.notes.some((n: string) => /application access/i.test(n)));
  });

  it("requires project_key or issue_key before any request", async () => {
    const { ctx, calls } = testContext(fixture());
    const r = await runTool(tool("jira_explain_permission"), { username: "alice", permission: "BROWSE" }, ctx);
    assert.equal(r.ok, false);
    assert.equal(calls.length, 0);
  });
});

describe("jira_user_access_summary", () => {
  function accessFixture(c: Call): Response {
    const u = new URL(c.url);
    const p = u.pathname;
    if (p === "/rest/api/2/user") return { body: ALICE };
    if (p === "/rest/api/2/role") return { body: [{ id: 10001, name: "Developers" }, { id: 10002, name: "Administrators" }] };
    if (p === "/rest/api/2/project") return { body: [{ key: "PROJ" }, { key: "OTHER" }, { key: "THIRD" }] };
    const m = p.match(/^\/rest\/api\/2\/project\/([A-Z]+)\/role\/(\d+)$/);
    if (m) {
      const [, key, id] = m;
      const actors: any[] = [];
      if (key === "PROJ" && id === "10001") actors.push({ type: "atlassian-group-role-actor", name: "devs" });
      if (key === "PROJ" && id === "10002") actors.push({ type: "atlassian-user-role-actor", name: "alice" });
      if (key === "OTHER" && id === "10002") actors.push({ type: "atlassian-group-role-actor", name: "admins" });
      return { body: { id: Number(id), actors } };
    }
    throw new Error(`Unexpected fixture request: ${c.method} ${p}`);
  }

  it("summarises user access and project roles across explicit projects", async () => {
    const { ctx, calls } = testContext(accessFixture);
    const r = await runTool(tool("jira_user_access_summary"), { username: "alice", projects: "PROJ,OTHER" }, ctx);
    assert.ok(r.ok, JSON.stringify(r));
    const v = (r as any).value;
    assert.equal(v.user.name, "alice");
    assert.equal(v.user.lastLoginTime, ALICE.lastLoginTime);
    assert.deepEqual(v.user.groups, ["devs", "everyone"]);
    assert.deepEqual(v.user.applications, ["jira-software"]);
    assert.deepEqual(v.projectRoles.items, [
      { project: "PROJ", roles: [{ role: "Administrators", via: ["direct"] }, { role: "Developers", via: ["group:devs"] }] },
      { project: "OTHER", roles: [] },
    ]);
    assert.equal(v.projectRoles.nextOffset, null);
    assert.ok(calls.every((c) => c.method === "GET"));
    // one global role list, then projects x roles; no per-project role link reads
    assert.equal(calls.filter((c) => /\/project\/[A-Z]+\/role\/\d+$/.test(new URL(c.url).pathname)).length, 4);
  });

  it("pages over all projects when none are given", async () => {
    const { ctx } = testContext(accessFixture);
    const r = await runTool(tool("jira_user_access_summary"), { username: "alice", limit: 2 }, ctx);
    assert.ok(r.ok, JSON.stringify(r));
    const v = (r as any).value;
    assert.equal(v.projectRoles.total, 3);
    assert.equal(v.projectRoles.returned, 2);
    assert.equal(v.projectRoles.nextOffset, 2);
  });

  it("filters roles by name to reduce requests", async () => {
    const { ctx, calls } = testContext(accessFixture);
    const r = await runTool(tool("jira_user_access_summary"), { username: "alice", projects: "PROJ,OTHER", roles: "Developers" }, ctx);
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(calls.filter((c) => /\/role\/\d+$/.test(new URL(c.url).pathname)).length, 2);
  });

  it("accepts duplicate role inputs naming the same role and still rejects unknown ones", async () => {
    const { ctx } = testContext(accessFixture);
    const r = await runTool(tool("jira_user_access_summary"), { username: "alice", projects: "PROJ", roles: "Developers,10001,developers" }, ctx);
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual((r as any).value.projectRoles.items, [{ project: "PROJ", roles: [{ role: "Developers", via: ["group:devs"] }] }]);
    const bad = await runTool(tool("jira_user_access_summary"), { username: "alice", projects: "PROJ", roles: "Developers,Nope" }, testContext(accessFixture).ctx);
    assert.equal(bad.ok, false);
    assert.match((bad as any).error.message, /Unknown project role\(s\): Nope$/);
  });

  it("shrinks the page so projects x roles stays within the request budget", async () => {
    const roles = Array.from({ length: 10 }, (_, i) => ({ id: 20000 + i, name: `Role ${i}` }));
    const { ctx, calls } = testContext((c) => {
      const p = new URL(c.url).pathname;
      if (p === "/rest/api/2/role") return { body: roles };
      return accessFixture(c) ?? undefined;
    });
    const keys = Array.from({ length: 40 }, (_, i) => `P${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`);
    const r = await runTool(tool("jira_user_access_summary"), { username: "alice", projects: keys.join(","), limit: 50 }, ctx);
    assert.ok(r.ok, JSON.stringify(r));
    const v = (r as any).value;
    assert.equal(v.projectRoles.returned, 20);
    assert.equal(v.projectRoles.nextOffset, 20);
    assert.ok(v.limits.note);
    assert.ok(calls.filter((c) => /\/role\/\d+$/.test(new URL(c.url).pathname)).length <= 200);
  });
});
