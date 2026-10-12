import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runTool } from "../../src/runner.js";
import { jiraPriorityTools } from "../../src/tools/jira/priorities.js";
import { testContext, type Call } from "./helpers.js";

const tool = (name: string) => {
  const t = jiraPriorityTools.find((x) => x.name === name);
  assert.ok(t, `tool ${name} exists`);
  return t;
};
const path = (c: Call) => new URL(c.url).pathname;
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

const PRIORITIES = [
  { id: "1", name: "Highest", description: "top", statusColor: "#d04437", iconUrl: "x" },
  { id: "2", name: "High", description: "", statusColor: "#f15C75", iconUrl: "x" },
  { id: "3", name: "Medium", description: "", statusColor: "#f79232", iconUrl: "x" },
  { id: "4", name: "Low", description: "", statusColor: "#707070", iconUrl: "x" },
];

/** A Jira with priority schemes, projects PROJ (default scheme) and SD (scheme 11001); `ignore` drops writes. */
function fakeJira(opts: { ignore?: boolean; foreign?: number } = {}) {
  const state = {
    schemes: [
      { id: 10101, name: "Default priority scheme", description: "", defaultOptionId: "3", optionIds: ["1", "2", "3", "4"], defaultScheme: true },
      { id: 11001, name: "Service Desk priorities", description: "SD", defaultOptionId: undefined as string | undefined, optionIds: ["2", "3"], defaultScheme: false },
    ] as any[],
    projects: { PROJ: 10101, SD: 11001 } as Record<string, number>,
    nextId: 12000,
  };
  const view = (s: any, expand: boolean) => ({ self: `https://jira.example.com/rest/api/2/priorityschemes/${s.id}`, ...s, ...(expand ? { projectKeys: Object.entries(state.projects).filter(([, id]) => id === s.id).map(([k]) => k) } : {}) });
  const responder = (c: Call) => {
    const p = path(c);
    const q = new URL(c.url).searchParams;
    if (p === "/rest/api/2/priority") return { body: PRIORITIES };
    if (p === "/rest/api/2/resolution") return { body: [{ id: "1", name: "Done", description: "finished" }, { id: "2", name: "Won't Do", description: "" }] };
    if (p === "/rest/api/2/priorityschemes" && c.method === "GET") {
      const start = Number(q.get("startAt") ?? 0);
      const max = Number(q.get("maxResults") ?? 50);
      const all = state.schemes.slice(start, start + max).map((s) => view(s, (q.get("expand") ?? "").includes("projectKeys")));
      return { body: { startAt: start, maxResults: max, total: state.schemes.length, schemes: all } };
    }
    if (p === "/rest/api/2/priorityschemes" && c.method === "POST") {
      const s = { id: state.nextId++, defaultScheme: false, description: "", ...c.body };
      if (!opts.ignore) state.schemes.push(s);
      return { status: 201, body: view(s, false) };
    }
    const one = /^\/rest\/api\/2\/priorityschemes\/(\d+)$/.exec(p);
    if (one) {
      const s = state.schemes.find((x) => x.id === Number(one[1]));
      if (!s) return { status: 404, body: { errorMessages: ["no scheme"] } };
      if (c.method === "GET") return { body: view(s, (q.get("expand") ?? "").includes("projectKeys")) };
      if (c.method === "PUT") {
        if (!opts.ignore) Object.assign(s, c.body);
        return { body: view(s, false) };
      }
      if (c.method === "DELETE") {
        if (!opts.ignore) {
          state.schemes = state.schemes.filter((x) => x !== s);
          for (const [k, id] of Object.entries(state.projects)) if (id === s.id) state.projects[k] = 10101;
        }
        return { status: 204, body: "" };
      }
    }
    const proj = /^\/rest\/api\/2\/project\/([A-Z]+)\/priorityscheme$/.exec(p);
    if (proj) {
      const key = proj[1]!;
      if (!(key in state.projects)) return { status: 404, body: { errorMessages: ["no project"] } };
      if (c.method === "PUT") {
        if (!opts.ignore) state.projects[key] = Number(c.body.id);
        return { body: view(state.schemes.find((s) => s.id === Number(c.body.id)), false) };
      }
      return { body: view(state.schemes.find((s) => s.id === state.projects[key]), false) };
    }
    if (/^\/rest\/api\/2\/project\/[A-Z]+$/.test(p)) return { body: { id: p.endsWith("SD") ? "10001" : "10000", key: p.split("/").pop() } };
    if (p === "/rest/api/2/search") return { body: { total: opts.foreign ?? 0, issues: [], jql: q.get("jql") } };
    return undefined;
  };
  return { responder, state };
}

async function run(name: string, args: Record<string, unknown>, j = fakeJira()) {
  const { ctx, calls } = testContext(j.responder);
  const r: any = await runTool(tool(name), args, ctx);
  return { r, calls, value: r.ok ? r.value : undefined, error: r.ok ? undefined : r.error };
}

describe("priority and resolution reads", () => {
  it("lists priorities and resolutions compactly with local paging", async () => {
    const p = await run("jira_list_priorities", { limit: 2 });
    assert.ok(p.r.ok, JSON.stringify(p.error));
    assert.equal(p.value.total, 4);
    assert.deepEqual(p.value.items[0], { id: "1", name: "Highest", description: "top", statusColor: "#d04437" });
    assert.equal(p.value.nextOffset, 2);
    const r = await run("jira_list_resolutions", { name_contains: "do" });
    assert.deepEqual(r.value.items.map((x: any) => x.name), ["Done", "Won't Do"]);
  });

  it("lists priority schemes with default priority, project keys and default flag", async () => {
    const r = await run("jira_list_priority_schemes", {});
    assert.ok(r.r.ok, JSON.stringify(r.error));
    const [def, sd] = r.value.items;
    assert.equal(def.default, true);
    assert.deepEqual(def.defaultPriority, { id: "3", name: "Medium" });
    assert.deepEqual(def.projectKeys, ["PROJ"]);
    assert.equal(sd.defaultPriority, null);
    assert.equal(sd.priorityCount, 2);
    assert.ok(r.calls.every((c) => c.method === "GET"));
    assert.ok(r.calls.some((c) => new URL(c.url).searchParams.get("expand") === "schemes.projectKeys"));
  });

  it("gets a priority scheme by exact name with ordered priority names", async () => {
    const r = await run("jira_get_priority_scheme", { scheme: "service desk priorities" });
    assert.ok(r.r.ok, JSON.stringify(r.error));
    assert.equal(r.value.id, 11001);
    assert.deepEqual(r.value.priorities, [{ id: "2", name: "High" }, { id: "3", name: "Medium" }]);
    assert.deepEqual(r.value.projectKeys, ["SD"]);
  });
});

describe("priority scheme writes", () => {
  it("creates a scheme from priority names, dry run first, then reads it back", async () => {
    const j = fakeJira();
    const args = { name: "Team scheme", priorities: "High,Low", default_priority: "Low" };
    const dry = await run("jira_create_priority_scheme", args, j);
    assert.ok(dry.r.ok, JSON.stringify(dry.error));
    assert.equal(dry.value.dry_run, true);
    assert.equal(dry.value.request.method, "POST");
    assert.deepEqual(dry.value.request.body, { name: "Team scheme", description: "", defaultOptionId: "4", optionIds: ["2", "4"] });
    assert.equal(writes(dry.calls).length, 0);
    const ex = await run("jira_create_priority_scheme", { ...args, dry_run: false }, j);
    assert.ok(ex.r.ok, JSON.stringify(ex.error));
    assert.equal(ex.value.result.id, 12000);
    assert.equal(writes(ex.calls).length, 1);
    const again = await run("jira_create_priority_scheme", { ...args, dry_run: false }, j);
    assert.equal(again.value?.already_satisfied, true, JSON.stringify(again.error ?? again.value));
  });

  it("refuses a create whose name exists with other settings, and a default outside the list", async () => {
    const clash = await run("jira_create_priority_scheme", { name: "Service Desk priorities", priorities: "1" });
    assert.equal(clash.r.ok, false);
    assert.match(clash.error.message, /already exists/);
    const bad = await run("jira_create_priority_scheme", { name: "X", priorities: "1,2", default_priority: "Low" });
    assert.equal(bad.r.ok, false);
    assert.match(bad.error.message, /default/i);
    const unknown = await run("jira_create_priority_scheme", { name: "X", priorities: "Nope" });
    assert.match(unknown.error.message, /Nope/);
  });

  it("fails verification when the created scheme does not read back", async () => {
    const r = await run("jira_create_priority_scheme", { name: "Team scheme", priorities: "2", dry_run: false }, fakeJira({ ignore: true }));
    assert.equal(r.r.ok, false);
    assert.equal(r.error.type, "VerificationError", JSON.stringify(r.error));
  });

  it("updates order and default, keeping unspecified fields; same values are already satisfied", async () => {
    const j = fakeJira();
    const dry = await run("jira_update_priority_scheme", { scheme: 11001, priorities: "Medium,High", default_priority: "3" }, j);
    assert.ok(dry.r.ok, JSON.stringify(dry.error));
    assert.equal(dry.value.request.method, "PUT");
    assert.deepEqual(dry.value.request.body, { name: "Service Desk priorities", description: "SD", defaultOptionId: "3", optionIds: ["3", "2"] });
    assert.deepEqual(dry.value.before.priorities, ["High", "Medium"]);
    assert.deepEqual(dry.value.after.priorities, ["Medium", "High"]);
    const ex = await run("jira_update_priority_scheme", { scheme: 11001, priorities: "Medium,High", default_priority: "3", dry_run: false }, j);
    assert.ok(ex.r.ok, JSON.stringify(ex.error));
    assert.deepEqual(j.state.schemes[1].optionIds, ["3", "2"]);
    const same = await run("jira_update_priority_scheme", { scheme: "Service Desk priorities", priorities: "Medium,High", dry_run: false }, j);
    assert.equal(same.value?.already_satisfied, true);
    assert.equal(writes(same.calls).length, 0);
  });

  it("refuses to change or delete the default scheme", async () => {
    const u = await run("jira_update_priority_scheme", { scheme: 10101, name: "Renamed" });
    assert.equal(u.r.ok, false);
    assert.match(u.error.message, /default priority scheme/i);
    const d = await run("jira_delete_priority_scheme", { scheme: 10101 });
    assert.equal(d.r.ok, false);
  });

  it("deletes a scheme naming the projects that fall back, and reports a missing one as already satisfied", async () => {
    const j = fakeJira();
    const dry = await run("jira_delete_priority_scheme", { scheme: 11001 }, j);
    assert.ok(dry.r.ok, JSON.stringify(dry.error));
    assert.equal(dry.value.request.method, "DELETE");
    assert.match(dry.value.summary, /SD/);
    const ex = await run("jira_delete_priority_scheme", { scheme: 11001, dry_run: false }, j);
    assert.ok(ex.r.ok, JSON.stringify(ex.error));
    assert.equal(j.state.schemes.length, 1);
    const gone = await run("jira_delete_priority_scheme", { scheme: 11001, dry_run: false }, j);
    assert.equal(gone.value?.already_satisfied, true);
  });

  it("assigns a scheme to a project and reads it back; already assigned is satisfied", async () => {
    const j = fakeJira();
    const dry = await run("jira_assign_priority_scheme", { project_key: "PROJ", scheme: "Service Desk priorities" }, j);
    assert.ok(dry.r.ok, JSON.stringify(dry.error));
    assert.equal(dry.value.request.method, "PUT");
    assert.match(dry.value.request.url, /\/rest\/api\/2\/project\/PROJ\/priorityscheme$/);
    assert.deepEqual(dry.value.request.body, { id: 11001 });
    const ex = await run("jira_assign_priority_scheme", { project_key: "PROJ", scheme: 11001, dry_run: false }, j);
    assert.ok(ex.r.ok, JSON.stringify(ex.error));
    assert.equal(j.state.projects.PROJ, 11001);
    const again = await run("jira_assign_priority_scheme", { project_key: "PROJ", scheme: 11001, dry_run: false }, j);
    assert.equal(again.value?.already_satisfied, true);
    const ignored = await run("jira_assign_priority_scheme", { project_key: "SD", scheme: 10101, dry_run: false }, fakeJira({ ignore: true }));
    assert.equal(ignored.error?.type, "VerificationError");
  });

  it("turns an assignment that would migrate issue priorities into a manual change", async () => {
    const r = await run("jira_assign_priority_scheme", { project_key: "PROJ", scheme: 11001 }, fakeJira({ foreign: 3 }));
    assert.ok(r.r.ok, JSON.stringify(r.error));
    assert.equal(r.value.request.method, "MANUAL");
    assert.ok(r.value.manual);
    assert.equal(writes(r.calls).length, 0);
    const ex = await run("jira_assign_priority_scheme", { project_key: "PROJ", scheme: 11001, dry_run: false }, fakeJira({ foreign: 3 }));
    assert.equal(ex.r.ok, false);
    assert.equal(ex.error.type, "Unsupported");
  });
});

describe("creating priorities and resolutions (UI only)", () => {
  it("returns a manual change for a new priority, already satisfied when it exists", async () => {
    const r = await run("jira_create_priority", { name: "Blocker", status_color: "#ff0000" });
    assert.ok(r.r.ok, JSON.stringify(r.error));
    assert.equal(r.value.request.method, "MANUAL");
    assert.match(r.value.request.url, /ViewPriorities\.jspa/);
    assert.ok(r.value.request.body.steps.length > 0);
    const have = await run("jira_create_priority", { name: "high" });
    assert.equal(have.value?.already_satisfied, true);
    const ex = await run("jira_create_priority", { name: "Blocker", dry_run: false });
    assert.equal(ex.error?.type, "Unsupported");
  });

  it("returns a manual change for a new resolution", async () => {
    const r = await run("jira_create_resolution", { name: "Duplicate" });
    assert.equal(r.value.request.method, "MANUAL");
    assert.match(r.value.request.url, /ViewResolutions\.jspa/);
    const have = await run("jira_create_resolution", { name: "Done" });
    assert.equal(have.value?.already_satisfied, true);
  });
});
