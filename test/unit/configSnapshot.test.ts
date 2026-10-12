import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runToolByName } from "../../src/runner.js";
import { writeLocal } from "../../src/tools/jira/scriptRoot.js";
import { testContext, type Call } from "./helpers.js";

const IJ = "/rest/servicedesk/1/servicedesk";
const SECRET = "PRIVATE-PRESET-SENTINEL";
const DESCRIPTION = "PRIVATE-DESCRIPTION-SENTINEL";
type Response = { status?: number; body?: unknown };
function fixture(override?: (c: Call) => Response | undefined) {
  return (c: Call): Response => {
    const custom = override?.(c);
    if (custom) return custom;
    const p = new URL(c.url).pathname;
    if (p.endsWith("/serverInfo")) return { body: { version: "11.3.6" } };
    if (p === "/rest/servicedeskapi/info") return { body: { version: "11.3.8" } };
    if (p === "/rest/servicedeskapi/servicedesk/3") return { body: { id: "3", projectId: "10100", projectKey: "BANK", projectName: "Bank" } };
    if (p === "/rest/servicedeskapi/servicedesk/3/requesttype") return { body: { isLastPage: true, values: [{ id: "83", name: "Incident", issueTypeId: "10004" }] } };
    if (p === `${IJ}/10100/request-type-groups/hidden/request-types`) return { body: [] };
    if (p.endsWith("/request-type-fields/visible")) return { body: [
      { id: 1, fieldId: "summary", jiraName: "Summary", label: "Title", description: DESCRIPTION, sdRequired: false, jiraRequired: true },
      { id: 2, fieldId: "description", jiraName: "Description", sdRequired: false, jiraRequired: false },
    ] };
    if (p.endsWith("/request-type-fields/hidden")) return { body: [{ id: 3, fieldId: "customfield_10000", jiraName: "Preset", sdRequired: false, jiraRequired: false, values: { value: [SECRET] } }] };
    throw new Error(`Unexpected fixture request: ${c.method} ${p}`);
  };
}
async function run(args: Record<string, unknown> = {}, override?: (c: Call) => Response | undefined) {
  const dir = mkdtempSync(join(tmpdir(), "config-snapshot-"));
  const { ctx, calls } = testContext(fixture(override));
  const result = await runToolByName("jira_export_config", { service_desk: "3", output_dir: dir, ...args }, ctx);
  const value = result.ok ? result.value as any : undefined;
  return { dir, calls, result, value, snapshot: () => JSON.parse(readFileSync(join(dir, "jira-config-3.json"), "utf8")) };
}
describe("request form configuration snapshot", () => {
  it("exports ordered fields, separate mandatory flags and no preset by default", async () => {
    const r = await run();
    assert.ok(r.result.ok, JSON.stringify(r.result));
    const s = r.snapshot();
    assert.equal(s.schemaVersion, 2);
    assert.equal(s.kind, "jira-config-snapshot");
    assert.equal(s.components.requestTypeForms.status, "COMPLETE");
    assert.deepEqual(s.coverage.components, { "request-type-forms": "COMPLETE" });
    assert.equal(s.capture.atomic, false);
    assert.equal(s.source.jsmVersion, "11.3.8");
    assert.deepEqual(s.scope.components, ["request-type-forms"]);
    const f = s.components.requestTypeForms.requestTypes[0].form;
    assert.deepEqual(f.visible.map((x: any) => [x.fieldId, x.position, x.sdRequired, x.jiraRequired, x.required]), [
      ["summary", 1, false, true, true], ["description", 2, false, false, false],
    ]);
    assert.equal(f.visible[0].description, DESCRIPTION);
    assert.equal(f.hidden[0].presetOmitted, true);
    assert.ok(!JSON.stringify(s).includes(SECRET));
    assert.ok(!JSON.stringify(r.result).includes(SECRET));
    assert.ok(!JSON.stringify(r.result).includes(DESCRIPTION));
    assert.ok(r.calls.every(c => c.method === "GET"));
  });
  it("preserves unknown raw flags and marks partial coverage", async () => {
    const r = await run({}, c => c.url.endsWith("/visible") ? { body: [{ id: 1, fieldId: "summary", sdRequired: "false" }] } : undefined);
    assert.ok(r.result.ok, JSON.stringify(r.result));
    const form = r.snapshot().components.requestTypeForms.requestTypes[0].form;
    assert.equal(form.visible[0].sdRequired, null);
    assert.equal(form.visible[0].jiraRequired, null);
    assert.equal(form.visible[0].required, null);
    assert.equal(form.status, "PARTIAL");
  });
  it("includes presets only in the opted-in artifact", async () => {
    const r = await run({ include_presets: true });
    assert.ok(r.result.ok, JSON.stringify(r.result));
    assert.ok(JSON.stringify(r.snapshot()).includes(SECRET));
    assert.ok(!JSON.stringify(r.result).includes(SECRET));
  });
  it("pages public inventory and merges hidden identities", async () => {
    const r = await run({}, c => {
      const u = new URL(c.url);
      if (u.pathname.endsWith("/3/requesttype")) return { body: u.searchParams.get("start") === "0"
        ? { isLastPage: false, values: [{ id: "83", name: "Incident", issueTypeId: "10004" }] }
        : { isLastPage: true, values: [{ id: "84", name: "Request", issueTypeId: "10001" }] } };
      if (u.pathname.endsWith("/hidden/request-types")) return { body: [{ id: 83, name: "Incident", issueType: { id: "10004" } }, { id: 85, name: "Hidden", issueType: { id: "10001" } }] };
      return undefined;
    });
    assert.ok(r.result.ok, JSON.stringify(r.result));
    const types = r.snapshot().components.requestTypeForms.requestTypes;
    assert.deepEqual(types.map((x: any) => x.id), ["83", "84", "85"]);
    assert.equal(types[2].issueTypeId, "10001");
    assert.equal(types[2].portalVisibility, "HIDDEN");
    assert.equal(r.calls.filter(c => new URL(c.url).pathname.endsWith("/3/requesttype")).length, 2);
  });
  it("records conflicting source identities without replacing public data", async () => {
    const r = await run({}, c => c.url.endsWith("/hidden/request-types") ? { body: [{ id: 83, name: "Other", issueType: { id: "999" } }] } : undefined);
    assert.ok(r.result.ok, JSON.stringify(r.result));
    assert.equal(r.snapshot().coverage.status, "PARTIAL");
    assert.equal(r.snapshot().components.requestTypeForms.requestTypes[0].name, "Incident");
    assert.ok(r.value.diagnostics.total > 0);
  });
  it("selects by exact name or id", async () => {
    for (const selection of [["Incident"], ["83"]]) {
      const r = await run({ request_types: selection });
      assert.ok(r.result.ok, JSON.stringify(r.result));
      assert.equal(r.snapshot().components.requestTypeForms.requestTypes.length, 1);
    }
  });
  it("selects an exact numeric name when no request type has that id", async () => {
    const r = await run({ request_types: ["2026"] }, c => new URL(c.url).pathname.endsWith("/3/requesttype") ? { body: { isLastPage: true, values: [{ id: "83", name: "2026" }] } } : undefined);
    assert.ok(r.result.ok, JSON.stringify(r.result));
    assert.equal(r.snapshot().components.requestTypeForms.requestTypes[0].id, "83");
  });
  it("refuses ambiguous and missing selections without artifacts", async () => {
    for (const selection of [["Same"], ["missing"]]) {
      const r = await run({ request_types: selection }, c => new URL(c.url).pathname.endsWith("/3/requesttype") ? { body: { isLastPage: true, values: [{ id: "83", name: "Same" }, { id: "84", name: "Same" }] } } : undefined);
      assert.equal(r.result.ok, false);
      assert.deepEqual(readdirSync(r.dir), []);
    }
  });
  it("retains public data when hidden discovery or one form source is unavailable", async () => {
    const r = await run({}, c => c.url.endsWith("/hidden/request-types") || c.url.endsWith("/request-type-fields/hidden") ? { status: 404, body: { errorMessages: [SECRET] } } : undefined);
    assert.ok(r.result.ok, JSON.stringify(r.result));
    const s = r.snapshot();
    assert.equal(s.coverage.status, "PARTIAL");
    assert.equal(s.components.requestTypeForms.requestTypes[0].form.visible.length, 2);
    assert.equal(s.components.requestTypeForms.requestTypes[0].form.sources.hidden.status, "UNAVAILABLE");
    assert.ok(!JSON.stringify(r.result).includes(SECRET));
  });
  it("marks a whole missing form unavailable while retaining another form", async () => {
    const r = await run({}, c => {
      const p = new URL(c.url).pathname;
      if (p.endsWith("/3/requesttype")) return { body: { isLastPage: true, values: [{ id: "83", name: "Good" }, { id: "84", name: "Missing" }] } };
      if (p.includes("/84/request-type-fields/")) return { status: 404 };
      return undefined;
    });
    assert.ok(r.result.ok, JSON.stringify(r.result));
    assert.deepEqual(r.snapshot().components.requestTypeForms.requestTypes.map((x: any) => x.form.status), ["COMPLETE", "UNAVAILABLE"]);
  });
  it("fails authorization and malformed discovery without leaking raw errors", async () => {
    for (const response of [{ status: 403, body: { errorMessages: [SECRET] } }, { body: { unexpected: SECRET } }]) {
      const r = await run({}, c => c.url.endsWith("/hidden/request-types") ? response : undefined);
      assert.equal(r.result.ok, false);
      assert.deepEqual(readdirSync(r.dir), []);
      assert.ok(!JSON.stringify(r.result).includes(SECRET));
    }
  });
  it("marks malformed form rows unavailable rather than successful empty", async () => {
    const r = await run({}, c => c.url.endsWith("/visible") ? { body: [{ label: SECRET }] } : undefined);
    assert.ok(r.result.ok, JSON.stringify(r.result));
    const form = r.snapshot().components.requestTypeForms.requestTypes[0].form;
    assert.equal(form.sources.visible.status, "UNAVAILABLE");
    assert.equal(form.status, "PARTIAL");
  });
  it("rejects repeated pages and inventory/byte limits before writing", async () => {
    const repeated = await run({}, c => new URL(c.url).pathname.endsWith("/3/requesttype") ? { body: { isLastPage: false, values: [{ id: "83", name: "Repeated" }] } } : undefined);
    const capped = await run({ max_request_types: 1 }, c => c.url.endsWith("/hidden/request-types") ? { body: [{ id: 85, name: "Hidden" }] } : undefined);
    const bytes = await run({ max_total_bytes: 10 });
    for (const r of [repeated, capped, bytes]) { assert.equal(r.result.ok, false); assert.deepEqual(readdirSync(r.dir), []); }
    assert.match((capped.result as any).error.message, /raise max_request_types \(up to 1000\)/);
    assert.match((bytes.result as any).error.message, /raise max_total_bytes/);
  });
  it("refuses unsafe schema limits before any HTTP call", async () => {
    const r = await run({ max_request_types: 1001 });
    assert.equal(r.result.ok, false);
    assert.equal(r.calls.length, 0);
  });
  it("bounds diagnostics and reports their full count", async () => {
    const r = await run({}, c => c.url.endsWith("/visible") ? { body: Array.from({ length: 60 }, (_, i) => ({ id: i + 1, fieldId: `customfield_${i}` })) } : undefined);
    assert.ok(r.result.ok, JSON.stringify(r.result));
    assert.equal(r.value.diagnostics.total, 60);
    assert.equal(r.value.diagnostics.items.length, 50);
    assert.equal(r.snapshot().components.requestTypeForms.requestTypes[0].form.visible.length, 60);
  });
  it("fails form authorization and public malformed discovery before publishing", async () => {
    for (const override of [
      (c: Call) => c.url.endsWith("/visible") ? { status: 401, body: { errorMessages: [SECRET] } } : undefined,
      (c: Call) => new URL(c.url).pathname.endsWith("/3/requesttype") ? { body: { values: [] } } : undefined,
    ]) {
      const r = await run({}, override);
      assert.equal(r.result.ok, false);
      assert.deepEqual(readdirSync(r.dir), []);
      assert.ok(!JSON.stringify(r.result).includes(SECRET));
    }
  });
  it("retains the existing identical artifact through the shared atomic writer", async () => {
    const r = await run();
    assert.ok(r.result.ok);
    const bytes = readFileSync(r.value.path);
    assert.equal((await writeLocal(r.value.path, bytes, false)).outcome, "ALREADY-SATISFIED");
    assert.deepEqual(readFileSync(r.value.path), bytes);
  });
  it("preserves conflicts, backs up overwrite and rejects symlinks/directories", async () => {
    for (const kind of ["file", "symlink", "directory"]) {
      const dir = mkdtempSync(join(tmpdir(), "config-existing-"));
      const target = join(dir, "jira-config-3.json");
      if (kind === "file") writeFileSync(target, "original");
      if (kind === "directory") mkdirSync(target);
      if (kind === "symlink") { writeFileSync(join(dir, "outside"), "original"); symlinkSync(join(dir, "outside"), target); }
      const r = await run({ output_dir: dir });
      if (kind === "file") {
        assert.ok(r.result.ok); assert.equal(r.value.outcome, "CONFLICT"); assert.equal(r.result.exitCode, 4); assert.equal(readFileSync(target, "utf8"), "original");
        const replaced = await run({ output_dir: dir, overwrite: true });
        assert.ok(replaced.result.ok); assert.equal(replaced.value.outcome, "REPLACED"); assert.equal(replaced.result.exitCode, 0); assert.equal(readFileSync(replaced.value.backup, "utf8"), "original");
      } else assert.equal(r.result.ok, false);
    }
  });
  it("rejects a missing or non-directory output_dir as a validation error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "config-outdir-"));
    writeFileSync(join(dir, "file"), "x");
    for (const output_dir of [join(dir, "missing"), join(dir, "file")]) {
      const r = await run({ output_dir });
      assert.equal(r.result.ok, false);
      if (!r.result.ok) {
        assert.equal(r.result.error.type, "ValidationError");
        assert.equal(r.result.exitCode, 7);
        assert.match(r.result.error.message, /output_dir/);
      }
    }
  });
});

// -- additional components ----------------------------------------------------------------

const API = "/rest/api/2";
const FC = "/rest/internal/2/fieldConfiguration";
const wimf = (fieldConfiguration: string, screen: { id: number; name: string } | undefined) => ({ statusLines: [
  { summary: [{ message: "Field configuration" }], details: [{ parameters: [{ type: "plain", value: "x" }, { type: "plain", value: fieldConfiguration }] }] },
  ...(screen ? [{ summary: [{ message: "Field Screen" }], details: [{ parameters: [
    { type: "plain", value: "x" }, { type: "plain", value: screen.name },
    { type: "link", href: `https://jira.example.com/secure/admin/ConfigureFieldScreen.jspa?id=${screen.id}` },
    { type: "link", href: "https://jira.example.com/secure/admin/ConfigureFieldScreenScheme.jspa?id=1" },
    { type: "link", href: "https://jira.example.com/secure/admin/ConfigureIssueTypeScreenScheme.jspa?id=2" },
  ] }] }] : []),
] });
/** A software project PROJ with every scheme the project components read; `reverse` flips server list order. */
function projectFixture(reverse = false) {
  const order = <T>(list: T[]) => (reverse ? [...list].reverse() : list);
  return (c: Call): Response | undefined => {
    const p = new URL(c.url).pathname;
    if (p === `${API}/project/PROJ`) return { body: { id: "10000", key: "PROJ", name: "Project", projectTypeKey: "software", lead: { name: "alice" },
      issueTypes: order([{ id: "10001", name: "Task" }, { id: "10002", name: "Bug" }]) } };
    if (p === `${API}/project/PROJ/workflowscheme`) return { body: { id: 10100, name: "WF scheme", defaultWorkflow: "jira", issueTypeMappings: reverse ? { "10002": "Bug WF", "10001": "Task WF" } : { "10001": "Task WF", "10002": "Bug WF" } } };
    if (p === `${API}/project/PROJ/notificationscheme`) return { body: { id: 10200, name: "Notifications" } };
    if (p === `${API}/project/PROJ/permissionscheme`) return { body: { id: 10300, name: "Permissions" } };
    if (p === `${API}/project/PROJ/issuesecuritylevelscheme`) return { status: 404 };
    if (p === `${API}/issuetypescheme`) return { body: { schemes: [{ id: "10400", name: "Issue types" }] } };
    if (p === `${API}/issuetypescheme/10400/associations`) return { body: [{ key: "PROJ" }] };
    if (p === `${API}/issuetypescheme/10400`) return { body: { id: "10400", name: "Issue types", defaultIssueType: { id: "10001" }, issueTypes: [{ id: "10001", name: "Task" }, { id: "10002", name: "Bug" }] } };
    if (p === `${API}/permissionscheme/10300`) return { body: { id: 10300, name: "Permissions", description: DESCRIPTION, permissions: order([
      { id: 2, permission: "BROWSE_PROJECTS", holder: { type: "group", parameter: "jira-users" } },
      { id: 1, permission: "ADMINISTER_PROJECTS", holder: { type: "projectRole", parameter: "10002", projectRole: { name: "Administrators" } } },
    ]) } };
    if (p === `${API}/notificationscheme/10200`) return { body: { id: 10200, name: "Notifications", notificationSchemeEvents: order([
      { event: { id: 2, name: "Issue Updated" }, notifications: [{ notificationType: "Reporter" }] },
      { event: { id: 1, name: "Issue Created" }, notifications: order([{ notificationType: "Group", parameter: "jira-users" }, { notificationType: "Assignee" }]) },
    ]) } };
    if (p === `${API}/project/PROJ/priorityscheme`) return { body: { id: 10101, name: "Default priority scheme", defaultOptionId: "3", optionIds: ["2", "3"], defaultScheme: true } };
    if (p === `${API}/priority`) return { body: order([{ id: "2", name: "High" }, { id: "3", name: "Medium" }]) };
    if (p === `${API}/customFields`) return { body: { values: [{ id: "customfield_10000" }] } };
    if (p.startsWith("/rest/whereismycf/1.0/fields/")) {
      const op = new URL(c.url).searchParams.get("issueOperation");
      return { body: wimf("Default Field Configuration", op === "0" ? { id: 1, name: "Create screen" } : { id: 2, name: "Edit screen" }) };
    }
    if (p === `${FC}/-1/projects`) return { body: { associatedProjects: order([{ key: "PROJ" }, { key: "OTHER" }]) } };
    if (p === `${FC}/-1` || p === `${FC}/10000`) return { body: { configName: "Default Field Configuration", total: 2, fields: order([
      { id: "summary", name: "Summary", description: "", hidden: false, required: true, actions: { edit: { url: "https://jira.example.com/secure/admin/EditFieldLayoutItem!default.jspa?id=10000&position=0" } } },
      { id: "customfield_10000", name: "Team", description: DESCRIPTION, hidden: true, required: false, actions: { edit: { url: "https://jira.example.com/secure/admin/EditFieldLayoutItem!default.jspa?id=10000&position=1" } } },
    ]) } };
    if (/^\/rest\/projectconfig\/1\/issuetype\/PROJ\/\d+\/fields$/.test(p)) return { body: { viewScreen: { screenId: 2, screenName: "Edit screen" } } };
    if (/^\/rest\/api\/2\/screens\/\d+\/tabs$/.test(p)) return { body: [{ id: 10, name: "Field Tab" }] };
    if (/^\/rest\/api\/2\/screens\/\d+\/tabs\/10\/fields$/.test(p)) return { body: [{ id: "summary", name: "Summary" }, { id: "customfield_10000", name: "Team" }] };
    return undefined;
  };
}
function jsmFixture(c: Call): Response | undefined {
  const p = new URL(c.url).pathname;
  if (p === "/rest/servicedeskapi/servicedesk/3/queue") return { body: { isLastPage: true, values: [
    { id: "2", name: "Open", jql: "resolution = EMPTY", fields: ["issuekey", "summary"] },
    { id: "1", name: "All", jql: "project = BANK", fields: ["issuekey"] },
  ] } };
  if (p === `${IJ}/agent/BANK/sla/metrics`) return { body: { timeMetrics: [{ id: 17, name: "Time to resolution", customerVisible: true,
    config: { definition: { start: [{ name: "Issue Created" }], pause: [], stop: [{ name: "Resolution: Set" }] }, goals: [{ jqlQuery: "", duration: 14400000, defaultGoal: true }] } }] } };
  if (p === `${IJ}/agent/BANK/sla/metrics/calendar-refs`) return { body: { calendars: [] } };
  if (p === `${IJ}/3/sla/calendars`) return { body: [{ name: "Default 24/7 calendar", dependentMetrics: [{ metricName: "Time to resolution" }] }] };
  return undefined;
}
async function runWith(args: Record<string, unknown>, override?: (c: Call) => Response | undefined) {
  const dir = mkdtempSync(join(tmpdir(), "config-snapshot-"));
  const { ctx, calls } = testContext(fixture(c => override?.(c) ?? projectFixture()(c) ?? jsmFixture(c)));
  const result = await runToolByName("jira_export_config", { output_dir: dir, ...args }, ctx);
  const value = result.ok ? result.value as any : undefined;
  return { dir, calls, result, value, snapshot: () => JSON.parse(readFileSync(value.path, "utf8")) };
}

describe("additional configuration components", () => {
  it("exports a project-only scheme snapshot with stable ordering and no JSM calls", async () => {
    const r = await runWith({ project_key: "PROJ", components: ["project-schemes"] });
    assert.ok(r.result.ok, JSON.stringify(r.result));
    assert.equal(r.value.relativePath, "jira-config-PROJ-project-schemes.json");
    assert.ok(r.calls.every(c => c.method === "GET"));
    assert.ok(!r.calls.some(c => c.url.includes("/servicedeskapi")), "no JSM call for a project-only snapshot");
    const s = r.snapshot();
    assert.deepEqual(s.scope.components, ["project-schemes"]);
    assert.equal(s.scope.projectKey, "PROJ");
    assert.equal(s.scope.serviceDeskId, null);
    assert.equal(s.source.jsmVersion, null);
    const ps = s.components.projectSchemes;
    assert.equal(ps.status, "COMPLETE");
    assert.deepEqual(ps.permissionScheme.grants.map((g: any) => g.key), ["ADMINISTER_PROJECTS|projectRole:Administrators", "BROWSE_PROJECTS|group:jira-users"]);
    assert.deepEqual(ps.notificationScheme.events.map((e: any) => [e.id, e.notifications]), [["1", ["Assignee", "Group:jira-users"]], ["2", ["Reporter"]]]);
    assert.equal(ps.issueSecurityScheme.status, "COMPLETE");
    assert.equal(ps.issueSecurityScheme.id, null);
    assert.deepEqual(ps.workflowScheme.mappings.map((m: any) => [m.issueTypeId, m.workflow]), [["10001", "Task WF"], ["10002", "Bug WF"]]);
    assert.equal(ps.issueTypeScheme.defaultIssueTypeId, "10001");
    assert.deepEqual(ps.priorityScheme.priorities.map((x: any) => x.name), ["High", "Medium"]);
    assert.equal(ps.priorityScheme.defaultPriorityId, "3");
    assert.deepEqual(s.coverage.components, { "project-schemes": "COMPLETE" });
    assert.ok(!JSON.stringify(r.result).includes(DESCRIPTION));
  });
  it("captures field configurations and screens with explicit unavailable scheme areas", async () => {
    const r = await runWith({ project_key: "PROJ", components: ["project-screens", "project-fields"] });
    assert.ok(r.result.ok, JSON.stringify(r.result));
    assert.equal(r.value.relativePath, "jira-config-PROJ-project-fields+project-screens.json");
    const s = r.snapshot();
    const fields = s.components.projectFields;
    assert.equal(fields.sources.fieldConfigurationScheme.status, "UNAVAILABLE");
    assert.equal(fields.configurations.length, 1);
    assert.deepEqual(fields.configurations[0].issueTypes, ["Bug", "Task"]);
    assert.deepEqual(fields.configurations[0].fields.map((f: any) => f.id), ["customfield_10000", "summary"]);
    assert.equal(fields.status, "PARTIAL");
    const screens = s.components.projectScreens;
    assert.equal(screens.sources.screenSchemes.status, "UNAVAILABLE");
    assert.deepEqual(screens.usage.map((u: any) => u.key), ["10001:create", "10001:edit", "10001:view", "10002:create", "10002:edit", "10002:view"]);
    assert.deepEqual(screens.screens.map((x: any) => [x.id, x.tabs[0].fields.length]), [["1", 2], ["2", 2]]);
    assert.equal(screens.usage[0].screenSchemeId, "1");
  });
  it("exports service-desk-only queues and SLA metrics; an unavailable SLA source is explicit", async () => {
    const r = await runWith({ service_desk: "3", components: ["jsm-sla", "jsm-queues"] });
    assert.ok(r.result.ok, JSON.stringify(r.result));
    assert.equal(r.value.relativePath, "jira-config-sd3-jsm-queues+jsm-sla.json");
    const s = r.snapshot();
    assert.deepEqual(s.components.jsmQueues.queues.map((q: any) => [q.id, q.position]), [["2", 1], ["1", 2]]);
    assert.equal(s.components.jsmSla.metrics[0].name, "Time to resolution");
    assert.equal(s.components.jsmSla.metrics[0].goals[0].target, "4h");
    assert.equal(s.components.requestTypeForms, undefined);
    const missing = await runWith({ service_desk: "3", components: ["jsm-sla"] }, c => c.url.includes("/sla/") ? { status: 404 } : undefined);
    assert.ok(missing.result.ok, JSON.stringify(missing.result));
    assert.equal(missing.snapshot().components.jsmSla.status, "UNAVAILABLE");
    assert.equal(missing.snapshot().coverage.status, "PARTIAL");
  });
  it("normalizes server order so unchanged captures have identical components", async () => {
    const all = ["project-schemes", "project-fields", "project-screens"];
    const a = await runWith({ project_key: "PROJ", components: all });
    const b = await runWith({ project_key: "PROJ", components: all }, c => projectFixture(true)(c));
    assert.ok(a.result.ok && b.result.ok);
    assert.deepEqual(a.snapshot().components, b.snapshot().components);
    assert.ok(!JSON.stringify(a.snapshot().components).match(/\d{4}-\d\d-\d\dT/), "no timestamps inside components");
  });
  it("requires an explicit scope for each selected component before any HTTP call", async () => {
    for (const args of [{ components: ["project-schemes"] }, { project_key: "PROJ", components: ["jsm-queues"] }, { components: ["request-type-forms"] }, { service_desk: "3", components: ["unknown"] }]) {
      const r = await runWith(args);
      assert.equal(r.result.ok, false, JSON.stringify(args));
      assert.equal(r.calls.length, 0);
      assert.deepEqual(readdirSync(r.dir), []);
    }
  });
  it("derives the project of a service desk for project components", async () => {
    const r = await runWith({ service_desk: "3", components: ["project-schemes"] }, c => {
      const u = new URL(c.url);
      return u.pathname.startsWith(`${API}/project/BANK`) ? projectFixture()({ ...c, url: c.url.replace("/project/BANK", "/project/PROJ") }) : undefined;
    });
    assert.ok(r.result.ok, JSON.stringify(r.result));
    assert.equal(r.value.relativePath, "jira-config-sd3-project-schemes.json");
    assert.equal(r.snapshot().scope.projectKey, "BANK");
  });
  it("records the explicit project's own id when it differs from the service desk's project", async () => {
    const r = await runWith({ service_desk: "3", project_key: "PROJ", components: ["jsm-queues", "project-schemes"] });
    assert.ok(r.result.ok, JSON.stringify(r.result));
    const scope = r.snapshot().scope;
    assert.equal(scope.projectKey, "PROJ");
    assert.equal(scope.projectId, "10000");
    assert.equal(scope.serviceDeskId, "3");
    assert.equal(scope.serviceDeskProjectId, "10100");
  });
  it("records the service desk's project id when the project is derived from it", async () => {
    const r = await runWith({ service_desk: "3", components: ["jsm-queues"] });
    assert.ok(r.result.ok, JSON.stringify(r.result));
    const scope = r.snapshot().scope;
    assert.equal(scope.projectId, "10100");
    assert.equal(scope.serviceDeskProjectId, "10100");
  });
  it("enforces a per-component byte budget before writing", async () => {
    const r = await runWith({ project_key: "PROJ", components: ["project-schemes"], max_component_bytes: 100 });
    assert.equal(r.result.ok, false);
    assert.match((r.result as any).error.message, /project-schemes.*max_component_bytes/);
    assert.deepEqual(readdirSync(r.dir), []);
  });
});
