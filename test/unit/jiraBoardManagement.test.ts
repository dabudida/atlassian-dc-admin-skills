import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runTool } from "../../src/runner.js";
import { jiraBoardManagementTools, plannedMoves } from "../../src/tools/jira/boardManagement.js";
import { testContext, type Call } from "./helpers.js";

const GH = "/rest/greenhopper/1.0";
const AGILE = "/rest/agile/1.0";
const path = (c: Call) => new URL(c.url).pathname;
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

const STATUSES = [
  { id: "10100", name: "Backlog", category: "new" },
  { id: "3", name: "In Progress", category: "indeterminate" },
  { id: "10002", name: "Review", category: "indeterminate" },
  { id: "10001", name: "Done", category: "done" },
];
const status = (id: string) => {
  const s = STATUSES.find((x) => x.id === id)!;
  return { id: s.id, name: s.name, statusCategory: { id: "2", key: s.category, colorName: "default" }, issueCount: 0, isPresentInWorkflow: true };
};

/** A stateful fake Jira with board 56 (scrum, filter 10900) and the internal board configuration resources. */
type Location = { projectId: number; projectKey: string };
function fakeJira(opts: { version?: string; canEdit?: boolean; location?: Location | null; manyNamed?: number } = {}) {
  const s = {
    boards: [{ id: 56, name: "PROJ board", type: "scrum", filterId: 10900, ...(opts.location === null ? {} : { location: opts.location ?? { projectId: 10000, projectKey: "PROJ" } }) }] as Array<{ id: number; name: string; type: string; filterId: number; location?: Location }>,
    nextBoard: 90,
    filterId: 10900,
    constraint: "issueCount_",
    columns: [
      { id: 1, name: "To Do", min: "", max: "", statuses: ["10100"], isKanPlanColumn: false },
      { id: 2, name: "In Progress", min: "", max: "5", statuses: ["3"], isKanPlanColumn: false },
      { id: 3, name: "Done", min: "", max: "", statuses: ["10001"], isKanPlanColumn: false },
    ] as Array<{ id: number; name: string; min: string; max: string; statuses: string[]; isKanPlanColumn: boolean }>,
    nextColumn: 10,
    swimlaneStrategy: "custom",
    lanes: [
      { id: 1, name: "B", query: "priority = High", description: "", isDefault: false },
      { id: 2, name: "C", query: "priority = Low", description: "", isDefault: false },
      { id: 3, name: "Everything Else", query: "", description: "", isDefault: true },
    ],
    nextLane: 20,
    quickFilters: [
      { id: 11, name: "Only my issues", query: "assignee = currentUser()", description: "" },
      { id: 12, name: "Recently updated", query: "updatedDate >= -1d", description: "" },
    ],
    nextQf: 30,
    cardStrategy: "priority",
    cardRows: {
      priority: [
        { id: 101, strategy: "priority", value: "1", displayValue: "Highest", color: "#ff0000" },
        { id: 102, strategy: "priority", value: "2", displayValue: "High", color: "#ff8800" },
      ],
      issuetype: [{ id: 201, strategy: "issuetype", value: "10001", displayValue: "Story", color: "#00aa00" }],
      assignee: [],
      custom: [{ id: 301, strategy: "custom", value: "labels = urgent", displayValue: "labels = urgent", color: "#123456" }],
      none: [],
    } as Record<string, any[]>,
    nextRow: 400,
  };
  const canEdit = opts.canEdit ?? true;
  const editmodel = () => {
    const mapped = new Set(s.columns.flatMap((c) => c.statuses));
    return {
      id: 56,
      name: "PROJ board",
      canEdit,
      filterConfig: { id: s.filterId, name: `Filter ${s.filterId}`, query: "project = PROJ ORDER BY Rank ASC" },
      rapidListConfig: {
        rapidViewId: 56,
        canEdit,
        currentStatisticsField: { id: s.constraint },
        statisticsFields: [{ id: "none_" }, { id: "issueCount_" }, { id: "issueCountExclSubs_" }],
        mappedColumns: s.columns.map((c) => ({ id: c.id, name: c.name, min: c.min, max: c.max, isKanPlanColumn: c.isKanPlanColumn, mappedStatuses: c.statuses.map(status) })),
        unmappedStatuses: STATUSES.filter((x) => !mapped.has(x.id)).map((x) => status(x.id)),
      },
      swimlanesConfig: { rapidViewId: 56, canEdit, swimlaneStrategy: s.swimlaneStrategy, swimlanes: s.lanes },
      quickFilterConfig: { rapidViewId: 56, canEdit, quickFilters: s.quickFilters.map((q) => ({ ...q, canEdit: true })) },
      cardColorConfig: { rapidViewId: 56, canEdit, cardColorStrategy: s.cardStrategy },
      isSprintSupportEnabled: true,
    };
  };
  const responder = (c: Call) => {
    const p = path(c);
    const q = new URL(c.url).searchParams;
    if (p === "/rest/api/2/serverInfo") return { body: { version: opts.version ?? "11.3.7" } };
    if (p === "/rest/api/2/filter/favourite") return { body: [{ id: "10900", name: "PROJ filter", jql: "project = PROJ" }, { id: "10950", name: "PROJ kanban", jql: "project = PROJ AND type = Bug" }] };
    let m = /^\/rest\/api\/2\/filter\/(\d+)$/.exec(p);
    if (m) return ["10900", "10950", "10960"].includes(m[1]) ? { body: { id: m[1], name: `Filter ${m[1]}`, jql: "project = PROJ" } } : { status: 404, body: { errorMessages: ["no filter"] } };
    if (p === `${AGILE}/board` && c.method === "GET") {
      const name = q.get("name") ?? "";
      if (opts.manyNamed) {
        // an endless list of boards whose names contain the search text
        const startAt = Number(q.get("startAt") ?? 0);
        const values = Array.from({ length: 50 }, (_, i) => ({ id: 1000 + startAt + i, name: i === 0 && startAt === 0 ? name : `${name} ${startAt + i}`, type: "scrum" }));
        return { body: { startAt, maxResults: 50, total: opts.manyNamed, isLast: startAt + 50 >= opts.manyNamed, values } };
      }
      const values = s.boards.filter((b) => b.name.toLowerCase().includes(name.toLowerCase())).map((b) => ({ id: b.id, name: b.name, type: b.type }));
      return { body: { startAt: 0, maxResults: 50, total: values.length, isLast: true, values } };
    }
    if (p === `${AGILE}/board` && c.method === "POST") {
      const loc = c.body.location?.projectKeyOrId;
      const b = { id: s.nextBoard++, name: c.body.name, type: c.body.type, filterId: Number(c.body.filterId), ...(loc ? { location: { projectId: 10000, projectKey: String(loc) } } : {}) };
      s.boards.push(b);
      return { status: 201, body: { id: b.id, name: b.name, type: b.type } };
    }
    m = new RegExp(`^${AGILE}/board/(\\d+)(/configuration)?$`).exec(p);
    if (m) {
      const b = s.boards.find((x) => x.id === Number(m![1]));
      if (!b) return { status: 404, body: { errorMessages: ["Board does not exist"] } };
      if (c.method === "DELETE") { s.boards = s.boards.filter((x) => x !== b); return { status: 204 }; }
      if (m[2]) return { body: { id: b.id, name: b.name, type: b.type, filter: { id: String(b.filterId) } } };
      return { body: { id: b.id, name: b.name, type: b.type, ...(b.location ? { location: { ...b.location, displayName: `Project (${b.location.projectKey})` } } : {}) } };
    }
    if (p === `${GH}/rapidviewconfig/editmodel`) return { body: editmodel() };
    if (p === `${GH}/rapidviewconfig/filter` && c.method === "PUT") { s.filterId = Number(c.body.savedFilterId); return { body: { success: {} } }; }
    if (p === `${GH}/rapidviewconfig/columns` && c.method === "PUT") {
      s.constraint = c.body.currentStatisticsField.id;
      s.columns = c.body.mappedColumns.map((col: any) => ({ id: col.id ?? s.nextColumn++, name: col.name, min: col.min, max: col.max, isKanPlanColumn: !!col.isKanPlanColumn, statuses: col.mappedStatuses.map((x: any) => String(x.id)) }));
      return { body: { success: editmodel().rapidListConfig } };
    }
    if (p === `${GH}/rapidviewconfig/swimlaneStrategy` && c.method === "PUT") { s.swimlaneStrategy = c.body.swimlaneStrategyId; return { body: {} }; }
    if (p === `${GH}/swimlanes/56` && c.method === "POST") {
      const lane = { id: s.nextLane++, name: c.body.name, query: c.body.query, description: c.body.description ?? "", isDefault: false };
      s.lanes.splice(s.lanes.length - 1, 0, lane);
      return { body: lane };
    }
    m = new RegExp(`^${GH}/swimlanes/56/(\\d+)(/move)?$`).exec(p);
    if (m) {
      const lane = s.lanes.find((l) => l.id === Number(m![1]))!;
      if (c.method === "DELETE") { s.lanes = s.lanes.filter((l) => l !== lane); return { status: 204 }; }
      if (c.method === "PUT") { Object.assign(lane, { name: c.body.name, query: c.body.query, description: c.body.description }); return { body: lane }; }
      if (m[2]) {
        s.lanes = s.lanes.filter((l) => l !== lane);
        if (c.body.position === "First") s.lanes.unshift(lane);
        else s.lanes.splice(s.lanes.findIndex((l) => l.id === Number(String(c.body.after).split("/").pop())) + 1, 0, lane);
        return { body: lane };
      }
    }
    if (p === `${GH}/quickfilters/56` && c.method === "GET") return { body: { rapidViewId: 56, canEdit, quickFilters: s.quickFilters.map((x) => ({ ...x, canEdit: true })) } };
    if (p === `${GH}/quickfilters/56` && c.method === "POST") {
      const qf = { id: s.nextQf++, name: c.body.name, query: c.body.query, description: c.body.description ?? "" };
      s.quickFilters.push(qf);
      return { body: qf };
    }
    m = new RegExp(`^${GH}/quickfilters/56/(\\d+)$`).exec(p);
    if (m) {
      const qf = s.quickFilters.find((x) => x.id === Number(m![1]))!;
      if (c.method === "DELETE") { s.quickFilters = s.quickFilters.filter((x) => x !== qf); return { status: 204 }; }
      if (c.method === "PUT") { Object.assign(qf, { name: c.body.name, query: c.body.query, description: c.body.description }); return { body: qf }; }
    }
    if (p === `${GH}/cardcolors/56/strategy` && c.method === "PUT") { s.cardStrategy = c.body.cardColorStrategyId; return { body: {} }; }
    m = new RegExp(`^${GH}/cardcolors/56/strategy/(\\w+)$`).exec(p);
    if (m && c.method === "GET") return { body: { rapidViewId: 56, canEdit, cardColorStrategy: m[1], cardColors: q.get("preloadValues") === "true" ? s.cardRows[m[1]] : [] } };
    if (p === `${GH}/cardcolors/56/color` && c.method === "POST") {
      const row = { id: s.nextRow++, strategy: c.body.strategy, value: c.body.value, displayValue: c.body.value, color: c.body.color };
      s.cardRows[c.body.strategy].push(row);
      return { body: row };
    }
    m = new RegExp(`^${GH}/cardcolors/56/color/(\\d+)$`).exec(p);
    if (m) {
      for (const k of Object.keys(s.cardRows)) {
        const row = s.cardRows[k].find((r) => r.id === Number(m![1]));
        if (!row) continue;
        if (c.method === "DELETE") { s.cardRows[k] = s.cardRows[k].filter((r) => r !== row); return { status: 204 }; }
        if (c.method === "PUT") { row.color = c.body.color; return { body: row }; }
      }
    }
    return { status: 404, body: { errorMessages: [`unexpected ${c.method} ${p}`] } };
  };
  return { responder, state: s };
}

async function run(name: string, args: Record<string, unknown>, fake = fakeJira()) {
  const tool = jiraBoardManagementTools.find((t) => t.name === name);
  assert.ok(tool, `tool ${name} exists`);
  const { ctx, calls } = testContext(fake.responder);
  const res = await runTool(tool!, args, ctx);
  return { res, value: res.ok ? (res.value as any) : undefined, error: res.ok ? undefined : (res as any).error, calls, state: fake.state };
}

describe("board management tool definitions", () => {
  it("exports read and write tools with dry runs and invalidation lists", () => {
    const names = jiraBoardManagementTools.map((t) => t.name);
    for (const n of [
      "jira_create_board", "jira_delete_board", "jira_set_board_filter", "jira_get_board_columns", "jira_set_board_columns",
      "jira_get_board_swimlanes", "jira_set_board_swimlanes", "jira_get_board_quick_filters", "jira_create_board_quick_filter",
      "jira_update_board_quick_filter", "jira_delete_board_quick_filter", "jira_get_board_card_colors", "jira_set_board_card_colors",
    ]) assert.ok(names.includes(n), n);
    for (const t of jiraBoardManagementTools.filter((x) => x.write)) {
      assert.ok("dry_run" in t.inputShape, `${t.name} has dry_run`);
      assert.ok(Array.isArray(t.invalidates), `${t.name} declares invalidates`);
    }
  });
});

describe("jira_create_board / jira_delete_board", () => {
  it("plans a board from a favourite filter name without sending anything", async () => {
    const r = await run("jira_create_board", { name: "PROJ kanban", type: "kanban", filter: "proj kanban", project_key: "PROJ" });
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.equal(r.value.dry_run, true);
    assert.deepEqual(r.value.request.body, { name: "PROJ kanban", type: "kanban", filterId: 10950, location: { type: "project", projectKeyOrId: "PROJ" } });
    assert.equal(writes(r.calls).length, 0);
  });

  it("creates the board and reads it back", async () => {
    const r = await run("jira_create_board", { name: "PROJ kanban", type: "kanban", filter: "10950", dry_run: false });
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.deepEqual(writes(r.calls).map((c) => `${c.method} ${path(c)}`), [`POST ${AGILE}/board`]);
    assert.deepEqual(r.value.result, { id: 90, name: "PROJ kanban", type: "kanban", filterId: 10950 });
  });

  it("is already satisfied for the same board and refuses a same-name board with another filter", async () => {
    const same = await run("jira_create_board", { name: "PROJ board", type: "scrum", filter: "10900" });
    assert.equal(same.value.already_satisfied, true);
    const other = await run("jira_create_board", { name: "PROJ board", type: "scrum", filter: "10950" });
    assert.equal(other.res.ok, false);
    assert.match(other.error.message, /already exists/);
  });

  it("compares the requested location before calling a same-name board satisfied", async () => {
    const same = await run("jira_create_board", { name: "PROJ board", type: "scrum", filter: "10900", project_key: "PROJ" });
    assert.equal(same.value?.already_satisfied, true, JSON.stringify(same.error));
    const byId = await run("jira_create_board", { name: "PROJ board", type: "scrum", filter: "10900", project_key: "10000" });
    assert.equal(byId.value?.already_satisfied, true, JSON.stringify(byId.error));
    const other = await run("jira_create_board", { name: "PROJ board", type: "scrum", filter: "10900", project_key: "OPS" });
    assert.equal(other.res.ok, false);
    assert.match(other.error.message, /location/);
  });

  it("refuses to call a board without a readable location satisfied when a location is requested", async () => {
    const r = await run("jira_create_board", { name: "PROJ board", type: "scrum", filter: "10900", project_key: "PROJ" }, fakeJira({ location: null }));
    assert.equal(r.res.ok, false);
    assert.match(r.error.message, /location/);
  });

  it("refuses to decide there is no duplicate when the name search hits its cap", async () => {
    const r = await run("jira_create_board", { name: "Board", type: "scrum", filter: "10900" }, fakeJira({ manyNamed: 5000 }));
    assert.equal(r.res.ok, false);
    assert.equal(r.error.type, "ValidationError");
    assert.match(r.error.message, /more specific/);
  });

  it("refuses a filter name that is not a favourite", async () => {
    const r = await run("jira_create_board", { name: "X", type: "scrum", filter: "Nope" });
    assert.equal(r.res.ok, false);
    assert.match(r.error.message, /favourite/);
  });

  it("summarises what a delete removes and keeps, and verifies the board is gone", async () => {
    const dry = await run("jira_delete_board", { board_id: 56 });
    assert.ok(dry.res.ok, JSON.stringify(dry.error));
    assert.match(dry.value.summary, /PROJ board/);
    assert.match(dry.value.summary, /3 columns, 2 quick filters, 2 query swimlanes/);
    assert.match(dry.value.summary, /not deleted/);
    assert.equal(writes(dry.calls).length, 0);
    const done = await run("jira_delete_board", { board_id: 56, dry_run: false });
    assert.ok(done.res.ok, JSON.stringify(done.error));
    assert.equal(done.state.boards.length, 0);
    const gone = await run("jira_delete_board", { board_id: 77 });
    assert.equal(gone.value.already_satisfied, true);
  });
});

describe("jira_set_board_filter", () => {
  it("is already satisfied for the current filter", async () => {
    const r = await run("jira_set_board_filter", { board_id: 56, filter: "10900" });
    assert.equal(r.value.already_satisfied, true);
  });

  it("switches the filter through the internal resource and reads it back", async () => {
    const dry = await run("jira_set_board_filter", { board_id: 56, filter: "PROJ kanban" });
    assert.deepEqual(dry.value.request.body, { id: 56, savedFilterId: 10950 });
    assert.deepEqual(dry.value.before, { id: 10900, name: "Filter 10900" });
    const r = await run("jira_set_board_filter", { board_id: 56, filter: "10950", dry_run: false });
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.equal(r.state.filterId, 10950);
  });

  it("refuses other Jira versions and non-administrators before writing", async () => {
    const old = await run("jira_set_board_filter", { board_id: 56, filter: "10950", dry_run: false }, fakeJira({ version: "10.3.1" }));
    assert.equal(old.error.type, "Unsupported");
    assert.equal(writes(old.calls).length, 0);
    const ro = await run("jira_set_board_filter", { board_id: 56, filter: "10950", dry_run: false }, fakeJira({ canEdit: false }));
    assert.equal(ro.error.type, "PermissionDenied");
    assert.equal(writes(ro.calls).length, 0);
  });
});

describe("board columns", () => {
  it("reads columns with status ids, unmapped statuses and the constraint", async () => {
    const r = await run("jira_get_board_columns", { board_id: 56 });
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.deepEqual(r.value.columns[1], { id: 2, name: "In Progress", min: null, max: 5, statuses: [{ id: "3", name: "In Progress", category: "indeterminate" }] });
    assert.deepEqual(r.value.unmappedStatuses, [{ id: "10002", name: "Review", category: "indeterminate" }]);
    assert.equal(r.value.constraint, "issueCount");
  });

  const target = [
    { name: "To Do", statuses: ["Backlog"] },
    { name: "Doing", statuses: ["In Progress", "10002"], max: 4 },
    { name: "Done", statuses: ["Done"] },
  ];

  it("plans columns, keeps ids of columns with the same name and sends the full mapping", async () => {
    const r = await run("jira_set_board_columns", { board_id: 56, columns: JSON.stringify(target) });
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.deepEqual(r.value.request.body.mappedColumns.map((c: any) => [c.id, c.name, c.mappedStatuses.map((s: any) => s.id), c.min, c.max]), [
      [1, "To Do", ["10100"], "", ""],
      [undefined, "Doing", ["3", "10002"], "", "4"],
      [3, "Done", ["10001"], "", ""],
    ]);
    assert.deepEqual(r.value.request.body.currentStatisticsField, { id: "issueCount_" });
    assert.deepEqual(r.value.unmappedAfter, []);
    assert.equal(writes(r.calls).length, 0);
  });

  it("applies the columns and verifies them by reading the edit model back", async () => {
    const r = await run("jira_set_board_columns", { board_id: 56, columns: target, constraint: "none", dry_run: false });
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.deepEqual(r.state.columns.map((c) => c.name), ["To Do", "Doing", "Done"]);
    assert.equal(r.state.constraint, "none_");
  });

  it("is already satisfied when the columns match", async () => {
    const r = await run("jira_set_board_columns", { board_id: 56, columns: [{ name: "To Do", statuses: ["10100"] }, { name: "In Progress", statuses: ["3"] }, { name: "Done", statuses: ["10001"] }] });
    assert.equal(r.value.already_satisfied, true);
  });

  it("refuses statuses outside the board's workflows and duplicates", async () => {
    const unknown = await run("jira_set_board_columns", { board_id: 56, columns: [{ name: "A", statuses: ["10100", "3", "10001", "Closed"] }] });
    assert.match(unknown.error.message, /Closed/);
    const dup = await run("jira_set_board_columns", { board_id: 56, columns: [{ name: "A", statuses: ["10100", "3"] }, { name: "B", statuses: ["3", "10001"] }] });
    assert.match(dup.error.message, /more than one column/);
  });

  it("handles boards with two same-named columns by id or by first unused match", async () => {
    const fake = fakeJira();
    fake.state.columns[1].name = "To Do";
    const byName = await run("jira_set_board_columns", { board_id: 56, columns: [{ name: "To Do", statuses: ["10100"] }, { name: "To Do", statuses: ["3"], max: 6 }, { name: "Done", statuses: ["10001"] }] }, fake);
    assert.ok(byName.res.ok, JSON.stringify(byName.error));
    assert.deepEqual(byName.value.request.body.mappedColumns.map((c: any) => c.id), [1, 2, 3]);
    const byId = await run("jira_set_board_columns", { board_id: 56, columns: [{ id: 2, name: "To Do", statuses: ["3"] }, { name: "To Do", statuses: ["10100"] }, { name: "Done", statuses: ["10001"] }] }, fake);
    assert.deepEqual(byId.value.request.body.mappedColumns.map((c: any) => c.id), [2, 1, 3]);
    const badId = await run("jira_set_board_columns", { board_id: 56, columns: [{ id: 99, name: "X", statuses: ["3", "10100", "10001"] }] }, fake);
    assert.match(badId.error.message, /99/);
  });

  it("refuses to unmap a mapped status unless allowed", async () => {
    const cols = [{ name: "To Do", statuses: ["10100"] }, { name: "Done", statuses: ["10001"] }];
    const refused = await run("jira_set_board_columns", { board_id: 56, columns: cols });
    assert.equal(refused.res.ok, false);
    assert.match(refused.error.message, /In Progress/);
    const allowed = await run("jira_set_board_columns", { board_id: 56, columns: cols, allow_unmapped: true });
    assert.ok(allowed.res.ok, JSON.stringify(allowed.error));
    assert.deepEqual(allowed.value.unmappedAfter, ["In Progress", "Review"]);
  });
});

describe("board swimlanes", () => {
  it("reads strategy and lanes", async () => {
    const r = await run("jira_get_board_swimlanes", { board_id: 56 });
    assert.equal(r.value.strategy, "custom");
    assert.deepEqual(r.value.lanes.map((l: any) => [l.name, l.isDefault]), [["B", false], ["C", false], ["Everything Else", true]]);
  });

  it("sets query lanes in order and keeps the default lane", async () => {
    const lanes = [{ name: "A", query: "priority = Highest" }, { name: "B", query: "priority = High" }];
    const dry = await run("jira_set_board_swimlanes", { board_id: 56, lanes: JSON.stringify(lanes) });
    assert.ok(dry.res.ok, JSON.stringify(dry.error));
    assert.deepEqual(dry.value.after.lanes, ["A", "B", "Everything Else"]);
    assert.equal(writes(dry.calls).length, 0);
    const r = await run("jira_set_board_swimlanes", { board_id: 56, lanes, dry_run: false });
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.deepEqual(r.state.lanes.map((l) => l.name), ["A", "B", "Everything Else"]);
  });

  it("treats JQL that Jira stored with trailing blanks as unchanged", async () => {
    const fake = fakeJira();
    fake.state.lanes[0].query = "priority = High  ";
    const r = await run("jira_set_board_swimlanes", { board_id: 56, lanes: [{ name: "B", query: "priority = High" }, { name: "C", query: "priority = Low" }] }, fake);
    assert.equal(r.value.already_satisfied, true);
  });

  it("refuses lane changes unless the resulting strategy is custom", async () => {
    const fake = fakeJira();
    fake.state.swimlaneStrategy = "assignee";
    const lanes = [{ name: "B", query: "priority = High" }];
    const r = await run("jira_set_board_swimlanes", { board_id: 56, lanes }, fake);
    assert.equal(r.res.ok, false);
    assert.match(r.error.message, /custom/);
    const toOther = await run("jira_set_board_swimlanes", { board_id: 56, strategy: "epic", lanes });
    assert.equal(toOther.res.ok, false);
    const toCustom = await run("jira_set_board_swimlanes", { board_id: 56, strategy: "custom", lanes }, fake);
    assert.ok(toCustom.res.ok, JSON.stringify(toCustom.error));
  });

  it("plans moves only over members present in both lists", () => {
    assert.deepEqual(plannedMoves(["a", "b", "x"], ["c", "b", "a"]), [{ id: "b", after: null }]);
    assert.deepEqual(plannedMoves(["a", "b"], ["a", "b"]), []);
    assert.deepEqual(plannedMoves(["a", "b", "c"], ["c", "a", "b"]), [{ id: "c", after: null }]);
  });

  it("changes only the strategy and is idempotent", async () => {
    const r = await run("jira_set_board_swimlanes", { board_id: 56, strategy: "assignee", dry_run: false });
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.deepEqual(writes(r.calls).map((c) => [path(c), c.body]), [[`${GH}/rapidviewconfig/swimlaneStrategy`, { id: 56, swimlaneStrategyId: "assignee" }]]);
    const same = await run("jira_set_board_swimlanes", { board_id: 56, strategy: "custom" });
    assert.equal(same.value.already_satisfied, true);
  });
});

describe("board quick filters", () => {
  it("lists quick filters", async () => {
    const r = await run("jira_get_board_quick_filters", { board_id: 56 });
    assert.deepEqual(r.value.items.map((q: any) => q.name), ["Only my issues", "Recently updated"]);
  });

  it("creates one, is already satisfied for an identical one and refuses a conflicting one", async () => {
    const r = await run("jira_create_board_quick_filter", { board_id: 56, name: "Bugs", query: "type = Bug", dry_run: false });
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.equal(r.value.result.id, 30);
    const same = await run("jira_create_board_quick_filter", { board_id: 56, name: "only my issues", query: "assignee = currentUser()" });
    assert.equal(same.value.already_satisfied, true);
    const other = await run("jira_create_board_quick_filter", { board_id: 56, name: "Only my issues", query: "reporter = currentUser()" });
    assert.match(other.error.message, /already exists/);
  });

  it("updates by name with before/after and reads back", async () => {
    const dry = await run("jira_update_board_quick_filter", { board_id: 56, quick_filter: "Recently updated", query: "updatedDate >= -2d" });
    assert.equal(dry.value.before.query, "updatedDate >= -1d");
    assert.equal(dry.value.after.query, "updatedDate >= -2d");
    const r = await run("jira_update_board_quick_filter", { board_id: 56, quick_filter: "12", query: "updatedDate >= -2d", dry_run: false });
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.equal(r.state.quickFilters[1].query, "updatedDate >= -2d");
  });

  it("deletes one and is already satisfied when missing", async () => {
    const r = await run("jira_delete_board_quick_filter", { board_id: 56, quick_filter: "Only my issues", dry_run: false });
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.deepEqual(r.state.quickFilters.map((q) => q.id), [12]);
    const gone = await run("jira_delete_board_quick_filter", { board_id: 56, quick_filter: "Nope" });
    assert.equal(gone.value.already_satisfied, true);
  });

  it("puts the quick filter's id and JQL in the plan state, so a recreated same-name filter drifts", async () => {
    const dry = await run("jira_delete_board_quick_filter", { board_id: 56, quick_filter: "Only my issues" });
    assert.deepEqual(dry.value.state, { exists: true, id: 11, query: "assignee = currentUser()" });
    const fake = fakeJira();
    fake.state.quickFilters[0] = { id: 99, name: "Only my issues", query: "reporter = currentUser()", description: "" };
    const again = await run("jira_delete_board_quick_filter", { board_id: 56, quick_filter: "Only my issues" }, fake);
    assert.notDeepEqual(again.value.state, dry.value.state);
  });
});

describe("board card colors", () => {
  it("reads the strategy and its colors", async () => {
    const r = await run("jira_get_board_card_colors", { board_id: 56 });
    assert.equal(r.value.strategy, "priority");
    assert.deepEqual(r.value.items[1], { id: 102, value: "2", name: "High", color: "#ff8800" });
  });

  it("recolors only the named row and verifies it", async () => {
    const r = await run("jira_set_board_card_colors", { board_id: 56, colors: JSON.stringify([{ value: "high", color: "#00FF00" }]), dry_run: false });
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.deepEqual(writes(r.calls).map((c) => `${c.method} ${path(c)}`), [`PUT ${GH}/cardcolors/56/color/102`]);
    assert.equal(r.state.cardRows.priority[1].color, "#00FF00");
    assert.equal(r.state.cardRows.priority[0].color, "#ff0000");
  });

  it("refuses unknown values and bad colors, and is idempotent", async () => {
    const unknown = await run("jira_set_board_card_colors", { board_id: 56, colors: [{ value: "Blocker", color: "#000000" }] });
    assert.match(unknown.error.message, /Blocker/);
    const bad = await run("jira_set_board_card_colors", { board_id: 56, colors: [{ value: "High", color: "red" }] });
    assert.equal(bad.res.ok, false);
    const same = await run("jira_set_board_card_colors", { board_id: 56, colors: [{ value: "High", color: "#FF8800" }] });
    assert.equal(same.value.already_satisfied, true);
  });

  it("switches to query colors with a complete list", async () => {
    const r = await run("jira_set_board_card_colors", { board_id: 56, strategy: "custom", colors: [{ value: "type = Bug", color: "#aa0000" }], dry_run: false });
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.equal(r.state.cardStrategy, "custom");
    assert.deepEqual(r.state.cardRows.custom.map((x) => [x.value, x.color]), [["type = Bug", "#aa0000"]]);
  });
});
