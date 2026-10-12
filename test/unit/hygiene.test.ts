import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runTool } from "../../src/runner.js";
import { jiraHygieneTools } from "../../src/tools/jira/hygiene.js";
import { testContext, type Call } from "./helpers.js";

type Response = { status?: number; body?: unknown } | undefined;
const tool = (name: string) => {
  const t = jiraHygieneTools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};
async function run(name: string, args: Record<string, unknown>, responder: (c: Call) => Response) {
  const { ctx, calls } = testContext((c) => {
    const r = responder(c);
    if (r) return r;
    throw new Error(`Unexpected request: ${c.method} ${c.url}`);
  });
  const result = await runTool(tool(name), args, ctx);
  assert.ok(result.ok, JSON.stringify(result));
  assert.ok(calls.every((c) => c.method === "GET"), "reports only read");
  return { value: (result as any).value, calls };
}
const path = (c: Call) => new URL(c.url).pathname;
const query = (c: Call) => new URL(c.url).searchParams;

// -- custom fields --------------------------------------------------------------

const cf = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `customfield_${n}`, name: `Field ${n}`, type: "com.example:text", isLocked: false, isManaged: false,
  isAllProjects: true, projectsCount: 0, screensCount: 2, issuesWithValue: 10, ...extra,
});

describe("jira_report_unused_custom_fields", () => {
  it("lists candidates with reasons, excludes locked/managed and sorts by signals", async () => {
    const fields = [
      cf(1), // used
      cf(2, { issuesWithValue: 0 }),
      cf(3, { issuesWithValue: 0, screensCount: 0, isAllProjects: false, projectsCount: 0 }),
      cf(4, { issuesWithValue: 0, isLocked: true }),
      cf(5, { screensCount: 0, isManaged: true }),
      cf(6, { screensCount: 0, issuesWithValue: 3 }),
    ];
    const { value } = await run("jira_report_unused_custom_fields", {}, (c) =>
      path(c) === "/rest/api/2/customFields" ? { body: { total: fields.length, isLast: true, values: fields } } : undefined);
    assert.deepEqual(value.items.map((f: any) => f.id), ["customfield_3", "customfield_2", "customfield_6"]);
    assert.deepEqual(value.items[0].reasons, ["no values", "no screens", "no contexts"]);
    assert.equal(value.excluded.locked, 1);
    assert.equal(value.excluded.managed, 1);
    assert.equal(value.scanned, 6);
    assert.equal(value.truncatedScan, undefined);
  });

  it("filters by match and reports a cut scan", async () => {
    const page = (n: number) => Array.from({ length: 500 }, (_, i) => cf(n * 1000 + i, { issuesWithValue: i % 2 }));
    const { value, calls } = await run("jira_report_unused_custom_fields", { match: "no_values", max_scan: 600, limit: 5 }, (c) =>
      path(c) === "/rest/api/2/customFields"
        ? { body: { total: 3000, isLast: false, values: page(Number(query(c).get("startAt"))) } }
        : undefined);
    assert.deepEqual(calls.map((c) => query(c).get("startAt")), ["1", "2"]);
    assert.equal(value.scanned, 600);
    assert.equal(value.totalCustomFields, 3000);
    assert.equal(value.truncatedScan, true);
    assert.equal(value.returned, 5);
    assert.ok(value.items.every((f: any) => f.reasons.join() === "no values"));
  });
});

// -- schemes --------------------------------------------------------------------

function schemeInstance(opts: {
  budgetFail?: boolean;
  withScreens?: boolean;
  permNotFound?: boolean;
  archivedProject?: boolean;
  workflowSchemeNotFound?: boolean;
  workflowLoadThrows?: boolean;
} = {}) {
  return (c: Call): Response => {
    const p = path(c);
    if (p === "/rest/api/2/project") {
      const live = [{ key: "PROJ", id: "1" }, { key: "OPS", id: "2" }];
      // archived projects are listed only with includeArchived=true
      const archived = opts.archivedProject && query(c).get("includeArchived") === "true" ? [{ key: "OLD", id: "3", archived: true }] : [];
      return { body: [...live, ...archived] };
    }
    if (p === "/rest/api/2/permissionscheme") return { body: { permissionSchemes: [{ id: 0, name: "Default Permission Scheme" }, { id: 10, name: "Used perm" }, { id: 11, name: "Dead perm" }] } };
    if (p === "/rest/api/2/notificationscheme") return { body: { total: 2, isLast: true, values: [{ id: 20, name: "Used notif" }, { id: 21, name: "Dead notif" }] } };
    if (p === "/rest/api/2/issuesecurityschemes") return { body: { issueSecuritySchemes: [{ id: 30, name: "Dead sec" }] } };
    if (p === "/rest/api/2/issuetypescheme") return { body: { schemes: [{ id: "10000", name: "Default Issue Type Scheme" }, { id: "40", name: "Used its" }, { id: "41", name: "Dead its" }] } };
    if (p === "/rest/api/2/issuetypescheme/40/associations") return { body: [{ key: "PROJ" }] };
    if (p === "/rest/api/2/issuetypescheme/41/associations") return { body: [] };
    if (p === "/rest/api/2/issuetypescheme/10000/associations") return { body: [] };
    if (p === "/rest/api/2/priorityschemes") return { body: { total: 3, schemes: [
      { id: 1, name: "Default priority scheme", defaultScheme: true, projectKeys: [] },
      { id: 50, name: "Used prio", projectKeys: ["OPS"] },
      { id: 51, name: "Dead prio", projectKeys: [] },
    ] } };
    if (p === "/rest/api/2/workflow") return { body: [
      { name: "jira", default: true }, { name: "Used WF" }, { name: "Mapped WF" }, { name: "Dead WF" },
    ] };
    const m = p.match(/^\/rest\/api\/2\/project\/(\w+)\/(\w+)$/);
    if (m) {
      const [, key, what] = m;
      if (opts.budgetFail && key === "OPS") return { status: 403, body: {} };
      if (key === "OLD") return { status: 404, body: {} };
      if (what === "permissionscheme") return opts.permNotFound && key === "OPS" ? { status: 404, body: {} } : { body: { id: 10, name: "Used perm" } };
      if (what === "workflowscheme" && opts.workflowSchemeNotFound && key === "OPS") return { status: 404, body: {} };
      if (what === "notificationscheme") return key === "PROJ" ? { body: { id: 20, name: "Used notif" } } : { status: 404, body: {} };
      if (what === "issuesecuritylevelscheme") return { status: 404, body: {} };
      if (what === "workflowscheme") return { body: { id: 60, name: "WFS", defaultWorkflow: "Used WF", issueTypeMappings: { "10001": "Mapped WF" } } };
    }
    if (opts.withScreens) {
      if (p === "/rest/api/2/screens") return { body: { total: 3, screens: [{ id: 1, name: "Create" }, { id: 2, name: "Resolve" }, { id: 3, name: "Orphan" }] } };
      if (p === "/rest/api/2/project/PROJ" || p === "/rest/api/2/project/OPS") return { body: { issueTypes: [{ id: "10001", name: "Task" }] } };
      if (p.startsWith("/rest/projectconfig/1/issuetype/")) return { body: { viewScreen: { screenId: 1, screenName: "Create" } } };
      if (p.startsWith("/rest/api/2/customFields")) return { body: { values: [] } };
      if (p === "/rest/workflowDesigner/1.0/workflows") {
        const name = query(c).get("name");
        if (opts.workflowLoadThrows) throw new Error("socket hang up");
        return { body: { layout: { statuses: [], transitions: name === "Used WF" ? [{ id: "A1", actionId: 11, name: "Resolve", screenId: 2, screenName: "Resolve", sourceId: "S1", targetId: "S2" }] : [] } } };
      }
    }
    return undefined;
  };
}

describe("jira_report_unused_schemes", () => {
  it("finds unused schemes and inactive workflows, never protected defaults", async () => {
    const { value } = await run("jira_report_unused_schemes", {}, schemeInstance());
    const by = Object.fromEntries(value.categories.map((c: any) => [c.type, c]));
    assert.deepEqual(by.permission.unused.map((s: any) => s.name), ["Dead perm"]);
    assert.deepEqual(by.notification.unused.map((s: any) => s.name), ["Dead notif"]);
    assert.deepEqual(by.issue_security.unused.map((s: any) => s.name), ["Dead sec"]);
    assert.deepEqual(by.issue_type.unused.map((s: any) => s.name), ["Dead its"]);
    assert.deepEqual(by.priority.unused.map((s: any) => s.name), ["Dead prio"]);
    assert.deepEqual(by.workflow.unused.map((s: any) => s.name), ["Dead WF"]);
    assert.ok(value.categories.every((c: any) => c.complete === true), JSON.stringify(value.categories));
    assert.equal(by.permission.used, 1);
    assert.ok(value.notCovered.some((n: string) => /workflow schemes/i.test(n)));
    assert.equal(by.screen, undefined, "screens are opt-in");
  });

  it("marks per-project categories incomplete when the budget runs out", async () => {
    const { value } = await run("jira_report_unused_schemes", { types: "permission,notification", max_requests: 3 }, schemeInstance());
    const by = Object.fromEntries(value.categories.map((c: any) => [c.type, c]));
    assert.equal(by.permission.complete, false);
    assert.match(by.permission.incomplete.reason, /request budget/);
    assert.equal(by.permission.incomplete.coveredProjects, 1);
    assert.equal(by.issue_type, undefined);
  });

  it("marks categories incomplete when projects cannot be read", async () => {
    const { value } = await run("jira_report_unused_schemes", { types: "permission" }, schemeInstance({ budgetFail: true }));
    assert.equal(value.categories[0].complete, false);
    assert.equal(value.categories[0].incomplete.unreadableProjects, 1);
  });

  it("finds unused screens on request, excluding transition screens", async () => {
    const { value } = await run("jira_report_unused_schemes", { types: "screen", scan_projects: 2 }, schemeInstance({ withScreens: true }));
    const screens = value.categories.find((c: any) => c.type === "screen");
    assert.deepEqual(screens.unused.map((s: any) => s.name), ["Orphan"]);
  });
});

describe("jira_report_unused_schemes completeness", () => {
  async function runRaw(args: Record<string, unknown>, responder: (c: Call) => Response) {
    const { ctx, calls } = testContext((c) => {
      const r = responder(c);
      if (r) return r;
      throw new Error(`Unexpected request: ${c.method} ${c.url}`);
    });
    return { result: (await runTool(tool("jira_report_unused_schemes"), args, ctx)) as any, calls };
  }
  const byType = (value: any) => Object.fromEntries(value.categories.map((c: any) => [c.type, c]));

  it("counts a 404 permission scheme as an unreadable project, not as no scheme", async () => {
    const { value } = await run("jira_report_unused_schemes", { types: "permission" }, schemeInstance({ permNotFound: true }));
    const perm = byType(value).permission;
    assert.equal(perm.complete, false);
    assert.equal(perm.incomplete.unreadableProjects, 1);
  });

  it("marks notification and issue security incomplete when an archived project answers 404", async () => {
    const { value } = await run("jira_report_unused_schemes", { types: "notification,issue_security" }, schemeInstance({ archivedProject: true }));
    const by = byType(value);
    assert.equal(by.notification.complete, false);
    assert.match(by.notification.incomplete.reason, /archived/);
    assert.equal(by.issue_security.complete, false);
  });

  it("keeps notification complete when a live project answers 404 (no scheme)", async () => {
    const { value } = await run("jira_report_unused_schemes", { types: "notification" }, schemeInstance());
    assert.equal(byType(value).notification.complete, true);
  });

  it("marks workflows incomplete when project workflow schemes answer 404", async () => {
    const { value } = await run("jira_report_unused_schemes", { types: "workflow" }, schemeInstance({ workflowSchemeNotFound: true }));
    const wf = byType(value).workflow;
    assert.equal(wf.complete, false);
    assert.match(wf.incomplete.reason, /not found|404/);
  });

  it("marks workflows incomplete when archived projects were left out of the scan", async () => {
    const { value } = await run("jira_report_unused_schemes", { types: "workflow" }, schemeInstance({ archivedProject: true }));
    const wf = byType(value).workflow;
    assert.equal(wf.complete, false);
    assert.match(wf.incomplete.reason, /archived/);
  });

  it("counts screen scan and workflow loads against max_requests and reports the cut", async () => {
    const { value, calls } = await run("jira_report_unused_schemes", { types: "screen", scan_projects: 2, max_requests: 3 }, schemeInstance({ withScreens: true }));
    const screens = byType(value).screen;
    const budgeted = calls.filter((c) => /^\/rest\/(workflowDesigner|projectconfig)\//.test(path(c)) ||
      /^\/rest\/api\/2\/project\/\w+$/.test(path(c)) || path(c).startsWith("/rest/api/2/customFields/"));
    assert.ok(budgeted.length <= 3, `${budgeted.length} budgeted requests`);
    assert.equal(screens.complete, false);
    assert.match(screens.incomplete.reason, /request budget/);
  });

  it("re-throws a non-HTTP error from a workflow load", async () => {
    const { result } = await runRaw({ types: "screen", scan_projects: 2 }, schemeInstance({ withScreens: true, workflowLoadThrows: true }));
    assert.equal(result.ok, false);
  });
});

// -- license --------------------------------------------------------------------

const DAY = 86_400_000;
function licenseInstance(now: number, members: Record<string, any[]>, logins: Record<string, number | undefined>) {
  return (c: Call): Response => {
    const p = path(c);
    if (p === "/rest/api/2/applicationrole") return { body: [
      { key: "jira-software", name: "Jira Software", groups: ["dev", "devs-extra"], numberOfSeats: 100, remainingSeats: 97, userCount: 3, hasUnlimitedSeats: false },
    ] };
    if (p === "/rest/api/2/group/member") {
      const all = members[query(c).get("groupname")!] ?? [];
      const start = Number(query(c).get("startAt") ?? 0);
      const size = Number(query(c).get("maxResults") ?? 50);
      const values = all.slice(start, start + size);
      return { body: { total: all.length, isLast: start + size >= all.length, values } };
    }
    if (p === "/rest/api/2/user") {
      const name = query(c).get("username")!;
      const t = logins[name];
      return { body: { name, displayName: name.toUpperCase(), emailAddress: `${name}@example.com`, active: true, ...(t ? { lastLoginTime: new Date(now - t * DAY).toISOString() } : {}) } };
    }
    return undefined;
  };
}
const member = (name: string, active = true) => ({ name, displayName: name.toUpperCase(), emailAddress: `${name}@example.com`, active });

describe("jira_report_license_usage", () => {
  it("reports seats, inactive, never and stale members without e-mails", async () => {
    const now = Date.now();
    const { value, calls } = await run("jira_report_license_usage", { stale_days: 30 }, licenseInstance(now,
      { dev: [member("alice"), member("bob"), member("carol", false)], "devs-extra": [member("alice"), member("dave")] },
      { alice: 2, bob: 100, dave: undefined }));
    const role = value.roles[0];
    assert.equal(role.key, "jira-software");
    assert.equal(role.remainingSeats, 97);
    assert.equal(role.members, 4);
    assert.equal(role.inactive.count, 1);
    assert.deepEqual(role.inactive.users.map((u: any) => u.username), ["carol"]);
    assert.deepEqual(role.neverLoggedIn.users.map((u: any) => u.username), ["dave"]);
    assert.deepEqual(role.stale.users.map((u: any) => u.username), ["bob"]);
    assert.equal(role.stale.users[0].daysSinceLogin, 100);
    assert.equal(role.truncated, undefined);
    assert.ok(!JSON.stringify(value).includes("@example.com"));
    // one lookup per unique active member
    assert.equal(calls.filter((c) => path(c) === "/rest/api/2/user").length, 3);
  });

  it("stops at the member cap and says so", async () => {
    const many = Array.from({ length: 30 }, (_, i) => member(`u${i}`));
    const { value } = await run("jira_report_license_usage", { max_users: 10 }, licenseInstance(Date.now(), { dev: many }, {}));
    const role = value.roles[0];
    assert.equal(role.truncated, true);
    assert.equal(role.checkedMembers, 10);
  });
});

// -- health ---------------------------------------------------------------------

describe("jira_instance_health", () => {
  it("lists failing checks first with cut reasons and summarises cluster and index", async () => {
    const long = "x".repeat(500);
    const { value } = await run("jira_instance_health", {}, (c) => {
      const p = path(c);
      if (p === "/rest/troubleshooting/1.0/check/") return { body: { statuses: [
        { name: "Healthy one", isHealthy: true, isEnabled: true, severity: "undefined", application: "JIRA" },
        { name: "Disk", isHealthy: false, isEnabled: true, severity: "warning", failureReason: long, application: "JIRA" },
        { name: "DB", isHealthy: false, isEnabled: true, severity: "critical", failureReason: "slow", application: "JIRA" },
        { name: "Off", isHealthy: false, isEnabled: false, severity: "major" },
      ] } };
      if (p === "/rest/api/2/cluster/nodes") return { body: [{ nodeId: "n1", state: "ACTIVE", alive: true }, { nodeId: "n2", state: "OFFLINE", alive: false }] };
      if (p === "/rest/api/2/index/summary") return { body: { issueIndex: { indexReadable: true, countInDatabase: 1000, countInIndex: 990, countInArchive: 5 } } };
      return undefined;
    });
    assert.deepEqual(value.counts, { total: 4, healthy: 1, failing: 2, disabled: 1 });
    assert.deepEqual(value.failing.map((f: any) => f.name), ["DB", "Disk"]);
    assert.ok(value.failing[1].failureReason.length <= 201);
    assert.equal(value.cluster.nodes, 2);
    assert.deepEqual(value.cluster.notActive, [{ nodeId: "n2", state: "OFFLINE", alive: false }]);
    assert.equal(value.index.consistent, false);
    assert.equal(value.index.countInIndex, 990);
    assert.equal(value.healthy, undefined);
  });

  it("degrades a failed part to an error", async () => {
    const { value } = await run("jira_instance_health", {}, (c) => {
      const p = path(c);
      if (p === "/rest/troubleshooting/1.0/check/") return { body: { statuses: [] } };
      if (p === "/rest/api/2/cluster/nodes") return { status: 404, body: {} };
      if (p === "/rest/api/2/index/summary") return { body: { issueIndex: { indexReadable: true, countInDatabase: 1, countInIndex: 1 } } };
      return undefined;
    });
    assert.match(value.cluster.error, /404/);
    assert.equal(value.index.consistent, true);
  });
});
