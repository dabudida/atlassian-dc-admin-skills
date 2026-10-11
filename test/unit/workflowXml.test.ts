import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, readdirSync, chmodSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { sha256 } from "../../src/tools/jira/scriptRoot.js";
import { runToolByName } from "../../src/runner.js";
import { adapterReason } from "../../src/tools/jira/workflowXml.js";
import { addResultToPlan, applyPlan, readPlan } from "../../src/plan.js";
import { testContext, TEST_ENV, type Call } from "./helpers.js";

const XML = '<workflow><meta name="script">PRIVATE-SCRIPT-SENTINEL</meta></workflow>';
const hash = (s: string) => sha256(Buffer.from(s));
function fake(override?: (c: Call) => any) {
  const state = { liveHash: hash(XML), draftHash: null as string | null, draftNormalizedHash: null as string | null, ignore: false };
  const responder = (c: Call) => {
    const custom = override?.(c); if (custom) return custom;
    const p = new URL(c.url).pathname;
    const data = { protocol: 1, jiraVersion: "11.3.6", scriptRunnerVersion: "10.11.1", workflow: "Workflow", active: true, system: false, ...state, usage: { total: 1, projectIds: ["10000"], truncated: false } };
    if (p.endsWith("/jiraWorkflowXml")) return { body: new URL(c.url).searchParams.get("include_xml") === "true" ? { ...data, xml: XML, mode: "live", counts: { steps: 1, initialActions: 1, globalActions: 0 } } : data };
    if (p.endsWith("/jiraWorkflowXmlValidate")) return { body: { ...data, desiredNormalizedHash: hash(c.body.xml) } };
    if (p.endsWith("/jiraWorkflowXmlDraft")) {
      assert.equal(c.body.expectedLiveHash, state.liveHash);
      assert.equal(c.body.expectedDraftHash, state.draftHash);
      if (!state.ignore) state.draftHash = state.draftNormalizedHash = hash(c.body.xml);
      return { body: { ...data, ...state } };
    }
    throw new Error(`Unexpected ${c.method} ${p}`);
  };
  return { state, ...testContext(responder) };
}
async function exported(f = fake()) {
  const dir = mkdtempSync(join(tmpdir(), "workflow-export-"));
  const r = await runToolByName("jira_export_workflow_xml", { workflow: "Workflow", output_dir: dir }, f.ctx);
  assert.ok(r.ok, JSON.stringify(r));
  return { ...f, dir, value: r.value as any };
}
describe("workflow XML transfer", () => {
  it("exports complete XML and manifest with no remote writes or content output", async () => {
    const r = await exported();
    assert.equal(readFileSync(r.value.xml_file, "utf8"), XML);
    assert.equal(JSON.parse(readFileSync(r.value.manifest_file, "utf8")).exportedXmlHash, hash(XML));
    assert.ok(!JSON.stringify(r.value).includes("PRIVATE-SCRIPT-SENTINEL"));
    assert.ok(r.calls.every(c => c.method === "GET"));
  });
  it("reports adapter absence or wrong protocol without creating local files", async () => {
    for (const response of [{ status: 404, body: { errorMessages: [XML] } }, { body: { protocol: 2 } }]) {
      const f = fake(() => response); const dir = mkdtempSync(join(tmpdir(), "workflow-missing-"));
      const r = await runToolByName("jira_export_workflow_xml", { workflow: "Workflow", output_dir: dir }, f.ctx);
      assert.equal(r.ok, false); assert.deepEqual(readdirSync(dir), []); assert.ok(!JSON.stringify(r).includes("PRIVATE-SCRIPT-SENTINEL"));
    }
  });
  it("refuses a missing draft and an unsupported product pair", async () => {
    for (const draft of [false, true]) {
      const f = fake(c => ({ body: { protocol: 1, jiraVersion: draft ? "11.3.6" : "12.0.0", scriptRunnerVersion: "10.11.1", workflow: "Workflow", active: true, system: false,
        liveHash: hash(XML), draftHash: null, draftNormalizedHash: null, usage: { total: 0, projectIds: [], truncated: false }, ...(draft ? {} : { xml: XML, mode: "live" }) } }));
      const dir = mkdtempSync(join(tmpdir(), "workflow-pair-"));
      const result = await runToolByName("jira_export_workflow_xml", { workflow: "Workflow", output_dir: dir, ...(draft ? { mode: "draft" } : {}) }, f.ctx);
      assert.equal(result.ok, false); assert.deepEqual(readdirSync(dir), []); assert.ok(f.calls.every(c => c.method === "GET"));
    }
  });
  it("previews edited XML without PUT and keeps plans content-free", async () => {
    const r = await exported();
    writeFileSync(r.value.xml_file, XML.replace("SENTINEL", "EDITED"));
    const args = { workflow: "Workflow", xml_file: r.value.xml_file, manifest_file: r.value.manifest_file };
    const dry = await runToolByName("jira_import_workflow_xml_draft", args, r.ctx);
    assert.ok(dry.ok, JSON.stringify(dry));
    assert.equal(r.calls.filter(c => c.method === "PUT").length, 0);
    const file = join(r.dir, "plan.json"); addResultToPlan(file, "jira_import_workflow_xml_draft", args, dry.value);
    assert.ok(!readFileSync(file, "utf8").includes("PRIVATE-SCRIPT"));
    writeFileSync(r.value.xml_file, XML + " ");
    const outcomes = await applyPlan(r.ctx, readPlan(file));
    assert.equal(outcomes[0].status, "drifted"); assert.equal(r.calls.filter(c => c.method === "PUT").length, 0);
  });
  it("applies only a draft and independently verifies it, then is satisfied", async () => {
    const r = await exported(); const args = { workflow: "Workflow", xml_file: r.value.xml_file, manifest_file: r.value.manifest_file };
    assert.ok((await runToolByName("jira_import_workflow_xml_draft", args, r.ctx)).ok);
    const applied = await runToolByName("jira_import_workflow_xml_draft", { ...args, dry_run: false }, r.ctx);
    assert.ok(applied.ok, JSON.stringify(applied));
    assert.equal(r.state.liveHash, hash(XML)); assert.equal(r.state.draftNormalizedHash, hash(XML));
    assert.equal(r.calls.filter(c => c.method === "PUT").length, 1);
    const satisfied = await runToolByName("jira_import_workflow_xml_draft", args, r.ctx);
    assert.ok(satisfied.ok); assert.equal((satisfied.value as any).already_satisfied, true);
  });
  it("refuses changed XML, manifest and server fingerprints after approval", async () => {
    for (const change of ["xml", "manifest", "live", "draft"]) {
      const r = await exported(); const args = { workflow: "Workflow", xml_file: r.value.xml_file, manifest_file: r.value.manifest_file };
      await runToolByName("jira_import_workflow_xml_draft", args, r.ctx);
      if (change === "xml") writeFileSync(r.value.xml_file, XML + " ");
      if (change === "manifest") writeFileSync(r.value.manifest_file, readFileSync(r.value.manifest_file, "utf8") + " ");
      if (change === "live") r.state.liveHash = hash("changed");
      if (change === "draft") r.state.draftHash = hash("changed");
      const applied = await runToolByName("jira_import_workflow_xml_draft", { ...args, dry_run: false }, r.ctx);
      assert.equal(applied.ok, false); assert.equal(r.calls.filter(c => c.method === "PUT").length, 0);
    }
  });
  it("rejects mismatched provenance and unsafe XML files", async () => {
    for (const change of ["workflow", "instance", "symlink", "malformed"]) {
      const r = await exported(); const manifest = JSON.parse(readFileSync(r.value.manifest_file, "utf8"));
      if (change === "workflow") manifest.workflow = "Other";
      if (change === "instance") manifest.source = "https://other.example";
      writeFileSync(r.value.manifest_file, change === "malformed" ? "PRIVATE-SCRIPT-BAD-JSON" : JSON.stringify(manifest));
      const xml = change === "symlink" ? join(r.dir, "link.xml") : r.value.xml_file;
      if (change === "symlink") symlinkSync(r.value.xml_file, xml);
      const applied = await runToolByName("jira_import_workflow_xml_draft", { workflow: "Workflow", xml_file: xml, manifest_file: r.value.manifest_file }, r.ctx);
      assert.equal(applied.ok, false); assert.equal(r.calls.filter(c => c.method === "PUT").length, 0);
      assert.ok(!JSON.stringify(applied).includes("PRIVATE-SCRIPT"));
    }
  });
  it("reports ignored saves rather than successful application", async () => {
    const r = await exported(); const args = { workflow: "Workflow", xml_file: r.value.xml_file, manifest_file: r.value.manifest_file };
    await runToolByName("jira_import_workflow_xml_draft", args, r.ctx); r.state.ignore = true;
    const result = await runToolByName("jira_import_workflow_xml_draft", { ...args, dry_run: false }, r.ctx);
    assert.equal(result.ok, false); assert.equal(r.calls.filter(c => c.method === "PUT").length, 1);
  });
  it("preserves conflicting generations and backs up replacement", async () => {
    const r = await exported();
    const args = { workflow: "Workflow", output_dir: r.dir };
    const same = await runToolByName("jira_export_workflow_xml", args, r.ctx);
    assert.ok(same.ok); assert.equal((same.value as any).outcome, "ALREADY-SATISFIED");
    writeFileSync(r.value.xml_file, "edited local copy");
    const conflict = await runToolByName("jira_export_workflow_xml", args, r.ctx);
    assert.ok(conflict.ok); assert.equal((conflict.value as any).outcome, "CONFLICT");
    assert.equal(readFileSync(r.value.xml_file, "utf8"), "edited local copy");
    const replaced = await runToolByName("jira_export_workflow_xml", { ...args, overwrite: true }, r.ctx);
    assert.ok(replaced.ok); assert.equal(readFileSync(join((replaced.value as any).backup, "workflow.xml"), "utf8"), "edited local copy");
    assert.equal(readFileSync(r.value.xml_file, "utf8"), XML);
  });
  it("does not follow an export generation symlink", async () => {
    const r = await exported(); const output = mkdtempSync(join(tmpdir(), "workflow-link-"));
    symlinkSync(r.value.target, join(output, r.value.target.split("/").pop()!));
    const result = await runToolByName("jira_export_workflow_xml", { workflow: "Workflow", output_dir: output, overwrite: true }, r.ctx);
    assert.equal(result.ok, false); assert.equal(readFileSync(r.value.xml_file, "utf8"), XML);
  });
  it("refuses oversized XML and a non-regular manifest", async () => {
    const r = await exported();
    const args = { workflow: "Workflow", xml_file: r.value.xml_file, manifest_file: r.value.manifest_file };
    assert.equal((await runToolByName("jira_import_workflow_xml_draft", { ...args, max_xml_bytes: 1 }, r.ctx)).ok, false);
    const dir = join(r.dir, "directory-manifest"); mkdirSync(dir);
    assert.equal((await runToolByName("jira_import_workflow_xml_draft", { ...args, manifest_file: dir }, r.ctx)).ok, false);
    assert.equal(r.calls.filter(c => c.method === "PUT").length, 0);
  });
  it("refuses non-UTF-8 input without replacing bytes silently", async () => {
    const r = await exported(); writeFileSync(r.value.xml_file, Buffer.from([60, 119, 62, 255]));
    const result = await runToolByName("jira_import_workflow_xml_draft", { workflow: "Workflow", xml_file: r.value.xml_file, manifest_file: r.value.manifest_file }, r.ctx);
    assert.equal(result.ok, false);
    assert.equal(r.calls.filter(c => c.method === "POST").length, 0);
  });
  it("sends one PUT for HTTP 429 and server errors", async () => {
    for (const response of [{ status: 429, body: { errorMessages: [XML] } }, { status: 503, body: XML }]) {
      const f = fake(c => c.method === "PUT" ? response : undefined); const r = await exported(f);
      const args = { workflow: "Workflow", xml_file: r.value.xml_file, manifest_file: r.value.manifest_file };
      await runToolByName("jira_import_workflow_xml_draft", args, r.ctx);
      const result = await runToolByName("jira_import_workflow_xml_draft", { ...args, dry_run: false }, r.ctx);
      assert.equal(result.ok, false); assert.equal(r.calls.filter(c => c.method === "PUT").length, 1);
      assert.ok(!JSON.stringify(result).includes("PRIVATE-SCRIPT"));
    }
  });
  it("preserves the previous generation when staging the manifest fails", async (t) => {
    const r = await exported(); writeFileSync(r.value.xml_file, "edited original");
    const manifest = readFileSync(r.value.manifest_file, "utf8");
    const original = fsPromises.writeFile;
    const mocked = t.mock.method(fsPromises, "writeFile", async (...args: any[]) => {
      if (String(args[0]).includes(".workflow-stage-") && String(args[0]).endsWith("manifest.json")) throw new Error("Injected staging failure");
      return (original as any)(...args);
    });
    syncBuiltinESMExports();
    try {
      const result = await runToolByName("jira_export_workflow_xml", { workflow: "Workflow", output_dir: r.dir, overwrite: true }, r.ctx);
      assert.equal(result.ok, false);
      assert.equal(readFileSync(r.value.xml_file, "utf8"), "edited original");
      assert.equal(readFileSync(r.value.manifest_file, "utf8"), manifest);
      assert.equal(readdirSync(r.dir).filter(x => x.startsWith(".workflow-stage-")).length, 0);
    } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  });
  it("honors a Cancel response at the CLI without sending a PUT", async () => {
    const r = await exported(); let puts = 0;
    const server = createServer(async (req, res) => {
      let body = ""; for await (const chunk of req) body += chunk;
      if (req.method === "PUT") puts++;
      const metadata = { protocol: 1, jiraVersion: "11.3.6", scriptRunnerVersion: "10.11.1", workflow: "Workflow", active: true, system: false,
        liveHash: hash(XML), draftHash: null, draftNormalizedHash: null, usage: { total: 1, projectIds: ["10000"], truncated: false } };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.method === "POST" ? { ...metadata, desiredNormalizedHash: hash(JSON.parse(body).xml) } : metadata));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as any).port}`;
      const manifest = JSON.parse(readFileSync(r.value.manifest_file, "utf8")); manifest.source = url; writeFileSync(r.value.manifest_file, JSON.stringify(manifest));
      const script = join(r.dir, process.platform === "darwin" ? "osascript" : "zenity");
      writeFileSync(script, process.platform === "darwin" ? '#!/bin/sh\necho CANCEL\n' : '#!/bin/sh\nexit 1\n'); chmodSync(script, 0o755);
      const cli = new URL("../../src/cli.ts", import.meta.url).pathname;
      const child = spawn(process.execPath, ["--import", "tsx", cli, "jira_import_workflow_xml_draft", JSON.stringify({ workflow: "Workflow", xml_file: r.value.xml_file, manifest_file: r.value.manifest_file, dry_run: false })],
        { cwd: process.cwd(), env: { ...process.env, ...TEST_ENV, JIRA_URL: url, ATLASSIAN_CONFIRM_MODE: "dialog", PATH: `${r.dir}:${process.env.PATH}` } });
      let output = ""; child.stdout.on("data", c => output += c); child.stderr.on("data", c => output += c);
      const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      assert.equal(code, 12, output); assert.equal(puts, 0); assert.ok(!output.includes("PRIVATE-SCRIPT"));
    } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
  });
  it("rechecks files changed during apply validation before PUT", async () => {
    for (const changedFile of ["xml", "manifest"]) {
      let validations = 0; let path = "";
      const f = fake(c => { if (c.method === "POST" && ++validations === 2) writeFileSync(path, readFileSync(path, "utf8") + " "); return undefined; });
      const r = await exported(f); path = changedFile === "xml" ? r.value.xml_file : r.value.manifest_file;
      const args = { workflow: "Workflow", xml_file: r.value.xml_file, manifest_file: r.value.manifest_file };
      await runToolByName("jira_import_workflow_xml_draft", args, r.ctx);
      const result = await runToolByName("jira_import_workflow_xml_draft", { ...args, dry_run: false }, r.ctx);
      assert.equal(result.ok, false); assert.equal(r.calls.filter(c => c.method === "PUT").length, 0);
    }
  });
  it("surfaces allowlisted adapter rejection reasons and withholds anything else", async () => {
    for (const [error, shown] of [["Invalid XML at line 3, column 7", true], ["Workflow XML does not match Jira's workflow grammar at line 12, column 5", true], ["Unknown workflow status reference", true], [`Invalid ${XML}`, false]] as const) {
      const f = fake(c => c.method === "POST" ? { status: 400, body: { error } } : undefined); const r = await exported(f);
      const result = await runToolByName("jira_import_workflow_xml_draft", { workflow: "Workflow", xml_file: r.value.xml_file, manifest_file: r.value.manifest_file }, r.ctx);
      assert.equal(result.ok, false);
      assert.equal((result as any).error.message.includes(error), shown, (result as any).error.message);
      assert.ok(!JSON.stringify(result).includes("PRIVATE-SCRIPT"));
    }
  });
  it("distinguishes an unsupported product pair from a missing adapter", async () => {
    const f = fake(() => ({ status: 501, body: { error: "Unsupported adapter pair" } })); const dir = mkdtempSync(join(tmpdir(), "workflow-pair-"));
    const result = await runToolByName("jira_export_workflow_xml", { workflow: "Workflow", output_dir: dir }, f.ctx);
    assert.equal(result.ok, false);
    assert.match((result as any).error.message, /Jira\/ScriptRunner version pair/);
  });
  it("reports an allowlisted conflict reason after a failed PUT", async () => {
    const f = fake(c => c.method === "PUT" ? { status: 409, body: { error: "Workflow fingerprints changed; preview again" } } : undefined); const r = await exported(f);
    const args = { workflow: "Workflow", xml_file: r.value.xml_file, manifest_file: r.value.manifest_file };
    await runToolByName("jira_import_workflow_xml_draft", args, r.ctx);
    const result = await runToolByName("jira_import_workflow_xml_draft", { ...args, dry_run: false }, r.ctx);
    assert.equal(result.ok, false);
    assert.equal((result as any).error.state.reason, "Workflow fingerprints changed; preview again");
  });
  it("allowlists every public rejection message the adapter can return", () => {
    const sources = ["WorkflowXmlSupport", "WorkflowXmlService", "WorkflowXmlEndpoints"].map(n => readFileSync(new URL(`../../adapters/workflow-xml/${n}.groovy`, import.meta.url), "utf8")).join("\n");
    const thrown = [...sources.matchAll(/new (?:AdapterRejection|XmlInputRejected|AdapterConflict)\((['"])(.+?)\1\)/g)].map(m => m[2].replace(/\$\{[^}]*created[^}]*\}/g, "true").replace(/\$\{[^}]+\}/g, "4"));
    const fixed = [...sources.matchAll(/'\{"error":"([^"]+)"\}'/g)].map(m => m[1]);
    const literals = [...thrown, ...fixed];
    assert.ok(thrown.length >= 15 && fixed.length >= 5, `found ${thrown.length} thrown and ${fixed.length} fixed`);
    for (const message of literals) assert.equal(adapterReason(JSON.stringify({ error: message })), message, message);
  });
  it("observes partial draft state after a failed mutation without repeating it", async () => {
    let draft: string | null = null;
    const f = fake(c => {
      if (c.method === "PUT") { draft = hash("created draft"); return { status: 409, body: { error: "draftCreated=true", detail: XML } }; }
      if (draft && c.method === "GET") return { body: { protocol: 1, jiraVersion: "11.3.6", scriptRunnerVersion: "10.11.1", workflow: "Workflow", active: true, system: false,
        liveHash: hash(XML), draftHash: draft, draftNormalizedHash: hash("partial"), usage: { total: 1, projectIds: ["10000"], truncated: false } } };
      return undefined;
    });
    const r = await exported(f); const args = { workflow: "Workflow", xml_file: r.value.xml_file, manifest_file: r.value.manifest_file };
    await runToolByName("jira_import_workflow_xml_draft", args, r.ctx);
    const result = await runToolByName("jira_import_workflow_xml_draft", { ...args, dry_run: false }, r.ctx);
    assert.equal(result.ok, false);
    assert.equal((result as any).error.state.observation.draftHash, draft);
    assert.equal((result as any).error.state.observation.draftCreatedObserved, true);
    assert.equal(r.calls.filter(c => c.method === "PUT").length, 1);
    assert.ok(!JSON.stringify(result).includes("PRIVATE-SCRIPT"));
  });
});
