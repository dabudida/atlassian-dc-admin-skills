import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { addResultToPlan, addToPlan, applyPlan, readPlan, renderOutcomes, renderPlan, replanCommand } from "../../src/plan.js";
import { existsSync, readFileSync } from "node:fs";
import { runToolByName } from "../../src/runner.js";
import { fakeJiraUsers, testContext } from "./helpers.js";

async function plan(file: string, tool: string, args: Record<string, unknown>) {
  const { ctx } = testContext();
  const res = await runToolByName(tool, args, ctx);
  assert.ok(res.ok);
  return addToPlan(file, tool, args, res.value);
}

describe("change plans", () => {
  it("records dry runs, lists them and applies all with one command", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "plan-")), "p.json");
    await plan(file, "jira_add_user_to_group", { group: "g1", username: "ivan" });
    await plan(file, "jira_set_user_active", { user: "olga", active: false });
    const p = readPlan(file);
    assert.equal(p.items.length, 2);
    assert.match(renderPlan(p, file), /2 change\(s\)[\s\S]*1\. Add ivan to g1[\s\S]*2\. Deactivate user olga/);

    const { ctx, calls } = testContext(fakeJiraUsers().responder);
    const outcomes = await applyPlan(ctx, p);
    assert.deepEqual(outcomes.map((o) => o.status), ["done", "done"], JSON.stringify(outcomes));
    assert.deepEqual(calls.filter((c) => c.method !== "GET").map((c) => c.method), ["POST", "PUT"]);
    assert.match(renderOutcomes(outcomes), /^applied 2\/2/);
  });

  it("applies only the selected items", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "plan-")), "p.json");
    await plan(file, "jira_add_user_to_group", { group: "g1", username: "ivan" });
    await plan(file, "jira_add_user_to_group", { group: "g2", username: "ivan" });
    const { ctx, calls } = testContext(fakeJiraUsers().responder);
    const outcomes = await applyPlan(ctx, readPlan(file), [2]);
    assert.equal(outcomes.length, 1);
    assert.match(calls.filter((c) => c.method !== "GET")[0]!.url, /groupname=g2/);
  });

  it("skips an item whose request changed since it was approved", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "plan-")), "p.json");
    const page = (version: number) => (c: any) =>
      c.method === "GET" ? { body: { id: "42", type: "page", title: "T", version: { number: version }, space: { key: "DOC" } } } : undefined;
    {
      const { ctx } = testContext(page(3));
      const res = await runToolByName("confluence_update_page", { page: "42", title: "T", content: "<p>x</p>", content_format: "storage" }, ctx);
      assert.ok(res.ok, JSON.stringify(!res.ok && res.error));
      addToPlan(file, "confluence_update_page", { page: "42", title: "T", content: "<p>x</p>", content_format: "storage" }, res.value);
    }
    const { ctx, calls } = testContext(page(4)); // someone edited the page meanwhile
    const outcomes = await applyPlan(ctx, readPlan(file));
    assert.equal(outcomes[0].status, "drifted");
    assert.ok(calls.every((c) => c.method === "GET"));
  });

  describe("sensitive arguments", () => {
    const dry = { dry_run: true, summary: "Create webhook", request: { method: "POST", url: "https://jira.example.com/rest/jira-webhook/1.0/webhooks", body: {} } };

    it("refuses to plan a write with a secret, so it never lands in the plan file", () => {
      const file = join(mkdtempSync(join(tmpdir(), "plan-")), "p.json");
      const args = { name: "Hook", url: "https://hooks.example.com/in", events: ["jira:issue_created"], secret: "topsecret" };
      assert.throws(() => addResultToPlan(file, "jira_create_webhook", args, dry), (e: any) => e.name === "ValidationError" && /secret/.test(e.message) && /dry_run=false/.test(e.message));
      assert.throws(() => addToPlan(file, "jira_update_webhook", { webhook: "1", secret: "topsecret" }, dry), /dry_run=false/);
      assert.equal(existsSync(file), false);
    });

    it("refuses a credentialed webhook URL but plans a plain one", () => {
      const file = join(mkdtempSync(join(tmpdir(), "plan-")), "p.json");
      for (const url of ["https://bot:hunter2@chat.example.com/relay", "https://ci.example.com/hook?token=abc123", "https://hooks.example.com/services/T0AAAAAAA/B0BBBBBBB/abcdEFGHijklMNOPqrstUVWX"]) {
        assert.throws(() => addToPlan(file, "jira_create_webhook", { name: "Hook", url, events: ["x"] }, dry), /url/, url);
      }
      assert.equal(existsSync(file), false);
      addToPlan(file, "jira_create_webhook", { name: "Hook", url: "https://hooks.example.com/jira/in", events: ["x"] }, dry);
      assert.match(readFileSync(file, "utf8"), /hooks\.example\.com\/jira\/in/);
    });

    it("refuses to plan user creation with a password, but plans it without one", () => {
      const file = join(mkdtempSync(join(tmpdir(), "plan-")), "p.json");
      const userDry = { dry_run: true, summary: "Create user alice", request: { method: "POST", url: "https://jira.example.com/rest/api/2/user", body: {} } };
      assert.throws(() => addToPlan(file, "jira_create_user", { username: "alice", email: "alice@example.com", display_name: "Alice", password: "pw-secret" }, userDry), /password/);
      assert.throws(() => addToPlan(file, "confluence_create_user", { username: "alice", full_name: "Alice", email: "alice@example.com", password: "pw-secret" }, userDry), /password/);
      assert.equal(existsSync(file), false);
      addToPlan(file, "jira_create_user", { username: "alice", email: "alice@example.com", display_name: "Alice" }, userDry);
      assert.ok(!readFileSync(file, "utf8").includes("pw-secret"));
    });

    it("the re-plan command never prints sensitive values", () => {
      const cmd = replanCommand("jira_update_webhook", { webhook: "1", secret: "topsecret", url: "https://bot:hunter2@chat.example.com/relay", name: "Hook" });
      assert.ok(!cmd.includes("topsecret") && !cmd.includes("hunter2"), cmd);
      assert.match(cmd, /secret='?<redacted>'?/);
      assert.match(cmd, /url='?<redacted>'?/);
      assert.match(cmd, /name=Hook/);
      assert.match(replanCommand("jira_update_webhook", { webhook: "1", url: "https://hooks.example.com/jira/in" }), /url=https:\/\/hooks\.example\.com\/jira\/in/);
    });
  });
});
