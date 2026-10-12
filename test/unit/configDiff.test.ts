import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runTool } from "../../src/runner.js";
import { jiraConfigDiffTools } from "../../src/tools/jira/configDiff.js";
import { testContext } from "./helpers.js";

const tool = jiraConfigDiffTools.find(t => t.name === "jira_diff_config")!;
const SECRET = "PRIVATE-PRESET-SENTINEL";
const LONG = `PRIVATE-DESCRIPTION-${"x".repeat(200)}`;

function forms(overrides: { label?: string; rows?: boolean; preset?: string; extraType?: boolean; description?: string } = {}) {
  const visible = [
    { rowId: "1", fieldId: "summary", name: "Summary", label: overrides.label ?? "Title", description: overrides.description ?? "short", visibility: "VISIBLE", position: 1, sdRequired: false, jiraRequired: true, required: true },
    ...(overrides.rows === false ? [] : [{ rowId: "2", fieldId: "description", name: "Description", label: "", description: "", visibility: "VISIBLE", position: 2, sdRequired: false, jiraRequired: false, required: false }]),
  ];
  const hidden = [{ rowId: "3", fieldId: "customfield_10000", name: "Preset", label: "", description: "", visibility: "HIDDEN", position: 1, sdRequired: false, jiraRequired: false, required: false, presetOmitted: false, values: { value: [overrides.preset ?? "a"] } }];
  const rt = (id: string, name: string) => ({ id, name, issueTypeId: "10004", portalVisibility: "VISIBLE", form: { status: "COMPLETE", sources: { visible: { status: "COMPLETE" }, hidden: { status: "COMPLETE" } }, visible, hidden } });
  return { requestTypes: [rt("83", "Incident"), ...(overrides.extraType ? [rt("84", "Change")] : [])] };
}
function v2(components: Record<string, unknown>, opts: { start?: string; projectKey?: string } = {}) {
  const names: Record<string, string> = { requestTypeForms: "request-type-forms", projectSchemes: "project-schemes" };
  return {
    kind: "jira-config-snapshot", schemaVersion: 2,
    source: { baseUrl: "https://jira.example.com", jiraVersion: "11.3.6", jsmVersion: "11.3.6" },
    capture: { start: opts.start ?? "2026-01-01T00:00:00.000Z", end: opts.start ?? "2026-01-01T00:00:01.000Z", atomic: false },
    scope: { serviceDeskId: "3", projectId: "10100", projectKey: opts.projectKey ?? "SD", components: Object.keys(components).map(k => names[k] ?? k) },
    coverage: { status: "COMPLETE", components: {} }, components, diagnostics: { total: 0, items: [] },
  };
}
const schemes = (grants: string[]) => ({ status: "COMPLETE", permissionScheme: { status: "COMPLETE", id: "1", name: "Permissions", grants: grants.map(k => ({ key: k, permission: k.split("|")[0], holder: k.split("|")[1] })) } });
function files(before: unknown, after: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "config-diff-"));
  const a = join(dir, "a.json"), b = join(dir, "b.json");
  writeFileSync(a, typeof before === "string" ? before : JSON.stringify(before));
  writeFileSync(b, typeof after === "string" ? after : JSON.stringify(after));
  return { a, b };
}
async function diff(before: unknown, after: unknown, args: Record<string, unknown> = {}) {
  const { a, b } = files(before, after);
  const { ctx, calls } = testContext(() => { throw new Error("no network expected"); });
  const result = await runTool(tool, { before: a, after: b, ...args }, ctx);
  return { result, calls, value: result.ok ? (result.value as any) : undefined };
}

describe("jira_diff_config", () => {
  it("reports an empty diff for two captures of an unchanged instance without network access", async () => {
    const r = await diff(v2({ requestTypeForms: forms(), projectSchemes: schemes(["A|group:x"]) }), v2({ requestTypeForms: forms(), projectSchemes: schemes(["A|group:x"]) }, { start: "2026-02-01T00:00:00.000Z" }));
    assert.ok(r.result.ok, JSON.stringify(r.result));
    assert.equal(r.value.identical, true);
    assert.deepEqual(r.value.summary, { added: 0, removed: 0, changed: 0 });
    assert.equal(r.calls.length, 0);
  });
  it("lists added, removed and field-level changed items per component", async () => {
    const r = await diff(
      v2({ requestTypeForms: forms(), projectSchemes: schemes(["A|group:x"]) }),
      v2({ requestTypeForms: forms({ label: "Subject", rows: false }), projectSchemes: schemes(["A|group:x", "B|projectRole:Developers"]) }),
    );
    assert.ok(r.result.ok, JSON.stringify(r.result));
    assert.equal(r.value.identical, false);
    const f = r.value.components.requestTypeForms;
    assert.deepEqual(f.changed.items, [{ key: "requestTypes[83].form.visible[summary]", fields: [{ field: "label", before: "Title", after: "Subject" }] }]);
    assert.deepEqual(f.removed.items.map((x: any) => x.key), ["requestTypes[83].form.visible[description]"]);
    assert.equal(f.removed.items[0].name, "Description");
    assert.deepEqual(r.value.components.projectSchemes.added.items.map((x: any) => x.key), ["permissionScheme.grants[B|projectRole:Developers]"]);
    assert.deepEqual(r.value.summary, { added: 1, removed: 1, changed: 1 });
  });
  it("reports a removed parent once instead of each of its rows", async () => {
    const r = await diff(v2({ requestTypeForms: forms({ extraType: true }) }), v2({ requestTypeForms: forms() }));
    assert.ok(r.result.ok, JSON.stringify(r.result));
    assert.deepEqual(r.value.components.requestTypeForms.removed.items, [{ key: "requestTypes[84]", name: "Change" }]);
  });
  it("never prints hidden preset values and truncates long text", async () => {
    const r = await diff(v2({ requestTypeForms: forms() }), v2({ requestTypeForms: forms({ preset: SECRET, description: LONG }) }));
    assert.ok(r.result.ok, JSON.stringify(r.result));
    const text = JSON.stringify(r.value);
    assert.ok(!text.includes(SECRET));
    assert.ok(!text.includes(LONG));
    assert.ok(text.includes("PRIVATE-DESCRIPTION-"));
    const items = r.value.components.requestTypeForms.changed.items;
    assert.deepEqual(items.find((x: any) => x.key.includes("hidden")).fields, [{ field: "values", before: "[hidden]", after: "[hidden]" }]);
  });
  it("keeps object-shaped hidden preset values opaque: no secret, id or name leaks anywhere", async () => {
    const withPreset = (values: unknown) => {
      const f = forms();
      (f.requestTypes[0].form.hidden[0] as any).values = values;
      return f;
    };
    const before = withPreset([{ id: "OPT-ID-A", name: "OPT-NAME-A", value: "a" }]);
    const after = withPreset([{ id: "OPT-ID-A", name: "OPT-NAME-A", value: SECRET }, { id: `ID-${SECRET}`, name: `NAME-${SECRET}`, value: SECRET }]);
    const r = await diff(v2({ requestTypeForms: before }), v2({ requestTypeForms: after }));
    assert.ok(r.result.ok, JSON.stringify(r.result));
    const text = JSON.stringify(r.value);
    for (const leak of [SECRET, "OPT-ID-A", "OPT-NAME-A"]) assert.ok(!text.includes(leak), `leaked ${leak}: ${text}`);
    const f = r.value.components.requestTypeForms;
    assert.equal(f.added.total, 0);
    assert.equal(f.removed.total, 0);
    assert.deepEqual(f.changed.items, [{ key: "requestTypes[83].form.hidden[customfield_10000]", fields: [{ field: "values", before: "[hidden]", after: "[hidden]" }] }]);
    const same = await diff(v2({ requestTypeForms: after }), v2({ requestTypeForms: after }));
    assert.equal(same.value.identical, true);
  });
  it("is not identical when a component exists on one side only, and not decided when a requested one is in neither", async () => {
    const one = await diff(v2({ projectSchemes: schemes([]) }), v2({ projectSchemes: schemes([]), requestTypeForms: forms() }));
    assert.ok(one.result.ok, JSON.stringify(one.result));
    assert.equal(one.value.identical, false);
    const neither = await diff(v2({ projectSchemes: schemes([]) }), v2({ projectSchemes: schemes([]) }), { components: "project-schemes,jsm-queues" });
    assert.ok(neither.result.ok, JSON.stringify(neither.result));
    assert.equal(neither.value.identical, null);
    assert.match(neither.value.identicalReason, /jsm-queues/);
    assert.equal(neither.value.components.jsmQueues.captured, "neither");
  });
  it("caps item lists and field lists with totals", async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `P${i}|group:g`);
    const r = await diff(v2({ projectSchemes: schemes([]) }), v2({ projectSchemes: schemes(many(30)) }), { max_items: 5 });
    assert.ok(r.result.ok, JSON.stringify(r.result));
    const added = r.value.components.projectSchemes.added;
    assert.equal(added.total, 30);
    assert.equal(added.items.length, 5);
    assert.equal(added.truncated, true);
  });
  it("reads schema v1 request-form snapshots and warns about components captured on one side", async () => {
    const v1 = { schemaVersion: 1, source: {}, capture: { start: "x", end: "y", atomic: false },
      scope: { serviceDeskId: "3", projectId: "10100", projectKey: "SD", components: ["request-type-forms"] },
      coverage: { status: "COMPLETE" }, components: { requestTypeForms: forms() }, diagnostics: { total: 0, items: [] } };
    const r = await diff(v1, v2({ requestTypeForms: { status: "COMPLETE", ...forms() }, projectSchemes: schemes([]) }));
    assert.ok(r.result.ok, JSON.stringify(r.result));
    assert.equal(r.value.before.schemaVersion, 1);
    assert.equal(r.value.components.requestTypeForms.changed.total, 0);
    assert.equal(r.value.components.projectSchemes.captured, "after-only");
    assert.ok(r.value.warnings.some((w: string) => w.includes("project-schemes")));
  });
  it("warns once about partial coverage and about coverage that differs", async () => {
    const partial = { ...schemes([]), status: "PARTIAL" };
    const same = await diff(v2({ projectSchemes: partial }), v2({ projectSchemes: partial }));
    assert.ok(same.result.ok);
    assert.equal(same.value.warnings.filter((w: string) => w.includes("project-schemes")).length, 1);
    const differs = await diff(v2({ projectSchemes: partial }), v2({ projectSchemes: schemes([]) }));
    assert.ok(differs.value.warnings.some((w: string) => /coverage differs/.test(w)));
    assert.equal(differs.value.components.projectSchemes.changed.items[0].key, "(component)");
  });
  it("warns when the two snapshots have different scopes", async () => {
    const r = await diff(v2({ projectSchemes: schemes([]) }), v2({ projectSchemes: schemes([]) }, { projectKey: "OTHER" }));
    assert.ok(r.result.ok);
    assert.ok(r.value.warnings.some((w: string) => /scope/i.test(w)));
  });
  it("refuses non-JSON, non-snapshot and unsupported schema files without echoing content", async () => {
    for (const bad of [`not json ${SECRET}`, JSON.stringify({ hello: SECRET }), JSON.stringify({ ...v2({}), schemaVersion: 3 }), JSON.stringify([SECRET])]) {
      const r = await diff(bad, v2({}));
      assert.equal(r.result.ok, false);
      if (!r.result.ok) {
        assert.equal(r.result.error.type, "ValidationError");
        assert.ok(!JSON.stringify(r.result).includes(SECRET));
      }
    }
    const { ctx } = testContext();
    const missing = await runTool(tool, { before: join(tmpdir(), "no-such-snapshot.json"), after: join(tmpdir(), "no-such-snapshot.json") }, ctx);
    assert.equal(missing.ok, false);
  });
  it("narrows the diff to selected components", async () => {
    const r = await diff(v2({ projectSchemes: schemes([]), requestTypeForms: forms() }), v2({ projectSchemes: schemes(["A|x"]), requestTypeForms: forms({ label: "Other" }) }), { components: "project-schemes" });
    assert.ok(r.result.ok, JSON.stringify(r.result));
    assert.deepEqual(Object.keys(r.value.components), ["projectSchemes"]);
  });
});
