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
    assert.equal(s.schemaVersion, 1);
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
