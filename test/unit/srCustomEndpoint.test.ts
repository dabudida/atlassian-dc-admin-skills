import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runToolByName } from "../../src/runner.js";
import { testContext, type Call } from "./helpers.js";

const TOOL = "jira_download_scriptrunner_endpoint";
const BODY = "PK\u0003\u0004 MARKER_SNAPSHOT_CONTENT";
const path = (c: Call) => new URL(c.url).pathname;
const tmp = () => mkdtempSync(join(tmpdir(), "sr-custom-"));

/** Fake custom endpoint: answers the snapshot zip, or `status` with an error text. */
function fakeEndpoint(opts: { status?: number; disposition?: string | null } = {}) {
  return (c: Call) => {
    if (path(c) !== "/rest/scriptrunner/latest/custom/jiraConfigSnapshot") return undefined;
    if (opts.status) return { status: opts.status, body: "java.lang.IllegalStateException: boom" };
    const headers: Record<string, string> = { "content-type": "application/zip" };
    const disposition = opts.disposition === undefined ? 'attachment; filename="jira-config-20261012-160943.zip"' : opts.disposition;
    if (disposition) headers["content-disposition"] = disposition;
    return { body: BODY, headers };
  };
}

async function run(args: Record<string, unknown>, responder: (c: Call) => any) {
  const { ctx, calls } = testContext(responder);
  const res = await runToolByName(TOOL, args, ctx);
  return { ctx, res, value: res.ok ? (res.value as any) : undefined, error: res.ok ? undefined : (res as any).error, calls };
}

describe("ScriptRunner custom endpoint download", () => {
  it("saves the response under its Content-Disposition name with a GET only, and never shows the content", async () => {
    const dir = tmp();
    const r = await run({ name: "jiraConfigSnapshot", query: "skip=jsm,assets", output_dir: dir }, fakeEndpoint());
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.deepEqual([...new Set(r.calls.map((c) => c.method))], ["GET"]);
    const call = r.calls.find((c) => path(c).endsWith("/custom/jiraConfigSnapshot"))!;
    assert.equal(new URL(call.url).searchParams.get("skip"), "jsm,assets");
    const out = join(dir, "jira-config-20261012-160943.zip");
    assert.equal(r.value.out, out);
    assert.equal(readFileSync(out, "utf8"), BODY);
    assert.equal(r.value.size, Buffer.byteLength(BODY));
    assert.equal(r.value.sha256, createHash("sha256").update(BODY).digest("hex"));
    assert.equal(r.value.outcome, "WRITTEN");
    assert.ok(!JSON.stringify(r.value).includes("MARKER_SNAPSHOT_CONTENT"));
  });

  it("names the file after the endpoint when there is no Content-Disposition", async () => {
    const dir = tmp();
    const r = await run({ name: "jiraConfigSnapshot", output_dir: dir }, fakeEndpoint({ disposition: null }));
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.match(readdirSync(dir)[0]!, /^jiraConfigSnapshot-\d{8}-\d{6}\.zip$/);
  });

  it("refuses names that would leave custom/ before any request", async () => {
    for (const name of ["../api/2/myself", "a/b", "a?b=1", ""]) {
      const r = await run({ name, out: join(tmp(), "x") }, fakeEndpoint());
      assert.equal(r.res.ok, false, name);
      assert.equal(r.calls.length, 0, name);
    }
  });

  it("keeps a different local file and reports CONFLICT", async () => {
    const out = join(tmp(), "snapshot.zip");
    writeFileSync(out, "older snapshot");
    const r = await run({ name: "jiraConfigSnapshot", out }, fakeEndpoint());
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.equal(r.value.outcome, "CONFLICT");
    assert.equal(readFileSync(out, "utf8"), "older snapshot");
  });

  it("writes nothing when the response is larger than max_bytes", async () => {
    const dir = tmp();
    const r = await run({ name: "jiraConfigSnapshot", output_dir: dir, max_bytes: 8 }, fakeEndpoint());
    assert.equal(r.res.ok, false);
    assert.match(r.error.message, /max_bytes/);
    assert.equal(readdirSync(dir).length, 0);
  });

  it("writes nothing when the endpoint fails, and restores the client timeout", async () => {
    const dir = tmp();
    const r = await run({ name: "jiraConfigSnapshot", output_dir: dir, timeout_s: 900 }, fakeEndpoint({ status: 500 }));
    assert.equal(r.res.ok, false);
    assert.equal(readdirSync(dir).length, 0);
    assert.equal(r.ctx.client("jira").config.timeoutMs, 60_000);
    assert.ok(!existsSync(join(dir, "jira-config-20261012-160943.zip")));
  });
});
