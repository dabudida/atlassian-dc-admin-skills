import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runTool } from "../../src/runner.js";
import { jiraWebhookTools, maskUrl, urlHasCredentials } from "../../src/tools/jira/webhooks.js";
import { testContext, type Call } from "./helpers.js";

const BASE = "/rest/jira-webhook/1.0/webhooks";
const tool = (name: string) => {
  const t = jiraWebhookTools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

/** An in-memory jira-webhook REST resource (Jira DC 10+ shape: active, scopeType, configuration.{FILTERS,EXCLUDE_BODY,DESCRIPTION,SECRET}). */
function fakeWebhooks(opts: { ignoreWrites?: boolean; maskSecrets?: boolean } = {}) {
  const hooks: any[] = [
    {
      id: 1,
      name: "Build trigger",
      url: "https://ci.example.com/hook?token=abc123&project=PROJ",
      active: true,
      scopeType: "global",
      events: ["jira:issue_created", "jira:issue_updated"],
      configuration: { FILTERS: "project = PROJ", EXCLUDE_BODY: "false", SECRET: "s3cr3t" },
      updatedDate: 1700000000000,
    },
    {
      id: 2,
      name: "Chat relay",
      url: "https://bot:hunter2@chat.example.com/relay",
      active: false,
      scopeType: "global",
      events: ["comment_created"],
      configuration: { EXCLUDE_BODY: "true", DESCRIPTION: "Posts comments" },
      updatedDate: 1700000000001,
    },
  ];
  let next = 10;
  // a server that answers GET with the secret masked
  const out = (h: any) => (opts.maskSecrets && h.configuration?.SECRET ? { ...h, configuration: { ...h.configuration, SECRET: "********" } } : h);
  const responder = (c: Call) => {
    const p = new URL(c.url).pathname;
    if (p === BASE) {
      if (c.method === "GET") return { body: hooks.map(out) };
      if (c.method === "POST") {
        const h = { ...c.body, id: next++, updatedDate: 1 };
        if (!opts.ignoreWrites) hooks.push(h);
        return { status: 201, body: h };
      }
    }
    const m = /\/webhooks\/(\d+)$/.exec(p);
    if (m) {
      const i = hooks.findIndex((h) => String(h.id) === m[1]);
      if (i < 0) return { status: 404, body: { errorMessages: ["not found"] } };
      if (c.method === "GET") return { body: out(hooks[i]) };
      if (c.method === "PUT") {
        if (!opts.ignoreWrites) hooks[i] = { ...c.body, id: hooks[i].id, updatedDate: 2 };
        return { body: hooks[i] };
      }
      if (c.method === "DELETE") {
        if (!opts.ignoreWrites) hooks.splice(i, 1);
        return { status: 204 };
      }
    }
    return undefined;
  };
  return { responder, hooks };
}

async function run(name: string, args: Record<string, unknown>, responder: (c: Call) => any) {
  const { ctx, calls } = testContext(responder);
  const res = await runTool(tool(name), args, ctx);
  return { res, value: res.ok ? (res.value as any) : undefined, error: res.ok ? undefined : (res as any).error, calls };
}
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

describe("jira webhooks: reads", () => {
  it("lists compact rows with secrets and URL credentials masked", async () => {
    const r = await run("jira_list_webhooks", {}, fakeWebhooks().responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.equal(r.value.total, 2);
    const [a, b] = r.value.items;
    assert.equal(a.name, "Build trigger");
    assert.equal(a.enabled, true);
    assert.equal(a.jql, "project = PROJ");
    assert.equal(a.hasSecret, true);
    assert.match(a.url, /token=\*\*\*/);
    assert.match(a.url, /project=PROJ/);
    assert.equal(b.url, "https://***@chat.example.com/relay");
    assert.equal(b.excludeBody, true);
    const text = JSON.stringify(r.value);
    for (const leaked of ["abc123", "hunter2", "s3cr3t"]) assert.ok(!text.includes(leaked), leaked);
  });

  it("filters by name and event, and pages", async () => {
    const r = await run("jira_list_webhooks", { name_contains: "chat" }, fakeWebhooks().responder);
    assert.deepEqual(r.value.items.map((x: any) => x.id), [2]);
    const e = await run("jira_list_webhooks", { event: "comment_created" }, fakeWebhooks().responder);
    assert.equal(new URL(e.calls[0].url).searchParams.get("event"), "comment_created");
    const p = await run("jira_list_webhooks", { limit: 1 }, fakeWebhooks().responder);
    assert.equal(p.value.nextOffset, 1);
  });

  it("gets one webhook by id or exact name; unknown names fail", async () => {
    const byName = await run("jira_get_webhook", { webhook: "Chat relay" }, fakeWebhooks().responder);
    assert.ok(byName.res.ok, JSON.stringify(byName.error));
    assert.equal(byName.value.id, 2);
    assert.equal(byName.value.description, "Posts comments");
    const byId = await run("jira_get_webhook", { webhook: "1" }, fakeWebhooks().responder);
    assert.ok(!JSON.stringify(byId.value).includes("s3cr3t"));
    const missing = await run("jira_get_webhook", { webhook: "Nope" }, fakeWebhooks().responder);
    assert.equal(missing.res.ok, false);
  });
});

describe("jira webhooks: URL masking", () => {
  it("masks token path segments (Slack/Teams/Discord) and drops the fragment", () => {
    const slack = maskUrl("https://hooks.slack.com/services/T0AAAAAAA/B0BBBBBBB/abcdEFGHijklMNOPqrstUVWX#frag");
    assert.ok(!slack.includes("abcdEFGHijklMNOPqrstUVWX"), slack);
    assert.ok(!slack.includes("frag"), slack);
    assert.match(slack, /^https:\/\/hooks\.slack\.com\/services\//);
    const teams = maskUrl("https://example.webhook.office.com/webhookb2/0f8fad5b-d9cb-469f-a165-70867728950e@7c9e6679-7425-40de-944b-e07fc1f90ae7/IncomingWebhook/a1b2c3d4e5f60718293a4b5c6d7e8f90/0f8fad5b-d9cb-469f-a165-70867728950e");
    for (const leaked of ["0f8fad5b-d9cb", "7c9e6679", "a1b2c3d4e5f6"]) assert.ok(!teams.includes(leaked), teams);
    assert.match(teams, /IncomingWebhook/);
    const discord = maskUrl("https://discord.com/api/webhooks/123456789012345678/AbC-dEf_GhIjKlMnOpQrStUvWxYz0123456789");
    assert.ok(!discord.includes("AbC-dEf_GhIjKlMnOpQrStUvWxYz0123456789"), discord);
    assert.equal(maskUrl("https://hooks.example.com/jira/in?project=PROJ"), "https://hooks.example.com/jira/in?project=PROJ");
  });

  it("tells credentialed URLs from plain ones", () => {
    assert.equal(urlHasCredentials("https://bot:hunter2@chat.example.com/relay"), true);
    assert.equal(urlHasCredentials("https://ci.example.com/hook?token=abc123"), true);
    assert.equal(urlHasCredentials("https://hooks.slack.com/services/T0AAAAAAA/B0BBBBBBB/abcdEFGHijklMNOPqrstUVWX"), true);
    assert.equal(urlHasCredentials("https://hooks.example.com/in#sig=1"), true);
    assert.equal(urlHasCredentials("https://hooks.example.com/jira-webhook-receiver/in?project=PROJ"), false);
  });

  it("webhook writes declare secret and url as sensitive arguments", () => {
    for (const name of ["jira_create_webhook", "jira_update_webhook", "jira_set_webhook_enabled"]) {
      assert.ok(tool(name).sensitiveArgs?.includes("secret"), name);
    }
    assert.ok(tool("jira_create_webhook").sensitiveArgs?.includes("url"));
  });
});

describe("jira webhooks: masked secrets in the read-back", () => {
  it("update and set enabled require the secret when Jira returns it masked, instead of saving the mask", async () => {
    const f = fakeWebhooks({ maskSecrets: true });
    const up = await run("jira_update_webhook", { webhook: "Build trigger", jql: "project = OTHER" }, f.responder);
    assert.equal(up.res.ok, false);
    assert.equal(up.error.type, "ValidationError");
    assert.match(up.error.message, /secret/);
    const en = await run("jira_set_webhook_enabled", { webhook: "Build trigger", enabled: false }, f.responder);
    assert.equal(en.error?.type, "ValidationError");
    assert.match(en.error.message, /secret/);
    assert.equal(writes([...up.calls, ...en.calls]).length, 0);
  });

  it("with the secret passed, the PUT carries it and the masked read-back still verifies", async () => {
    const f = fakeWebhooks({ maskSecrets: true });
    const up = await run("jira_update_webhook", { webhook: "Build trigger", jql: "project = OTHER", secret: "n3w", dry_run: false }, f.responder);
    assert.ok(up.res.ok, JSON.stringify(up.error));
    assert.equal(writes(up.calls)[0].body.configuration.SECRET, "n3w");
    assert.ok(!writes(up.calls).some((c) => JSON.stringify(c.body).includes("****")));
    const en = await run("jira_set_webhook_enabled", { webhook: "Build trigger", enabled: false, secret: "n3w", dry_run: false }, f.responder);
    assert.ok(en.res.ok, JSON.stringify(en.error));
    assert.equal(writes(en.calls)[0].body.configuration.SECRET, "n3w");
    assert.ok(!JSON.stringify(en.value).includes("n3w"));
  });

  it("a webhook without a secret still toggles without one", async () => {
    const r = await run("jira_set_webhook_enabled", { webhook: "Chat relay", enabled: true, dry_run: false }, fakeWebhooks({ maskSecrets: true }).responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
  });
});

describe("jira webhooks: writes", () => {
  const create = { name: "Audit sink", url: "https://audit.example.com/in?key=K1", events: "jira:issue_deleted,project_deleted", jql: "project = PROJ", secret: "topsecret" };

  it("create: dry run shows the DC payload with the secret masked and sends nothing", async () => {
    const r = await run("jira_create_webhook", create, fakeWebhooks().responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.equal(r.value.dry_run, true);
    assert.equal(writes(r.calls).length, 0);
    const body = r.value.request.body;
    assert.deepEqual(body.events, ["jira:issue_deleted", "project_deleted"]);
    assert.equal(body.active, true);
    assert.equal(body.scopeType, "global");
    assert.equal(body.configuration.FILTERS, "project = PROJ");
    assert.equal(body.configuration.EXCLUDE_BODY, "false");
    assert.equal(body.configuration.SECRET, "***");
    assert.ok(!JSON.stringify(r.value).includes("topsecret"));
    assert.ok(!JSON.stringify(r.value).includes("K1"));
  });

  it("create: executes, sends the real secret, reads back, then a re-run is already_satisfied", async () => {
    const f = fakeWebhooks();
    const r = await run("jira_create_webhook", { ...create, dry_run: false }, f.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    const post = writes(r.calls)[0];
    assert.equal(post.method, "POST");
    assert.equal(post.body.configuration.SECRET, "topsecret");
    assert.equal(post.body.url, create.url);
    assert.equal(r.value.result.id, 10);
    assert.ok(!JSON.stringify(r.value).includes("topsecret"));
    const again = await run("jira_create_webhook", create, f.responder);
    assert.equal(again.value.already_satisfied, true);
  });

  it("create: same name or same URL with other settings is refused", async () => {
    const byName = await run("jira_create_webhook", { name: "Build trigger", url: "https://x.example.com", events: "jira:issue_created" }, fakeWebhooks().responder);
    assert.match(byName.error.message, /jira_update_webhook/);
    const byUrl = await run("jira_create_webhook", { name: "Other", url: "https://bot:hunter2@chat.example.com/relay", events: "comment_created" }, fakeWebhooks().responder);
    assert.match(byUrl.error.message, /jira_update_webhook/);
    assert.ok(!byUrl.error.message.includes("hunter2"));
  });

  it("create: a webhook that does not read back fails verification", async () => {
    const r = await run("jira_create_webhook", { ...create, dry_run: false }, fakeWebhooks({ ignoreWrites: true }).responder);
    assert.equal(r.res.ok, false);
    assert.equal(r.error.type, "VerificationError");
  });

  it("update: merges into the full model, keeps the stored secret, shows before/after", async () => {
    const f = fakeWebhooks();
    const dry = await run("jira_update_webhook", { webhook: "Build trigger", jql: "project = PROJ AND type = Bug" }, f.responder);
    assert.ok(dry.res.ok, JSON.stringify(dry.error));
    assert.equal(dry.value.before.jql, "project = PROJ");
    assert.equal(dry.value.after.jql, "project = PROJ AND type = Bug");
    assert.equal(dry.value.request.method, "PUT");
    const r = await run("jira_update_webhook", { webhook: "Build trigger", jql: "project = PROJ AND type = Bug", dry_run: false }, f.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    const put = writes(r.calls)[0];
    assert.equal(put.body.configuration.SECRET, "s3cr3t");
    assert.deepEqual(put.body.events, ["jira:issue_created", "jira:issue_updated"]);
    assert.equal(f.hooks[0].configuration.FILTERS, "project = PROJ AND type = Bug");
    const again = await run("jira_update_webhook", { webhook: "Build trigger", jql: "project = PROJ AND type = Bug" }, f.responder);
    assert.equal(again.value.already_satisfied, true);
  });

  it("update: requires at least one change", async () => {
    const r = await run("jira_update_webhook", { webhook: "1" }, fakeWebhooks().responder);
    assert.equal(r.res.ok, false);
  });

  it("set enabled: flips active with a full PUT and reads it back; same state is already_satisfied", async () => {
    const f = fakeWebhooks();
    const same = await run("jira_set_webhook_enabled", { webhook: "Chat relay", enabled: false }, f.responder);
    assert.equal(same.value.already_satisfied, true);
    const r = await run("jira_set_webhook_enabled", { webhook: "Chat relay", enabled: true, dry_run: false }, f.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    const put = writes(r.calls)[0];
    assert.equal(put.body.active, true);
    assert.equal(put.body.name, "Chat relay");
    assert.equal(put.body.configuration.DESCRIPTION, "Posts comments");
    assert.equal(f.hooks[1].active, true);
  });

  it("set enabled: a state that does not change fails verification", async () => {
    const r = await run("jira_set_webhook_enabled", { webhook: "Chat relay", enabled: true, dry_run: false }, fakeWebhooks({ ignoreWrites: true }).responder);
    assert.equal(r.error.type, "VerificationError");
  });

  it("delete: describes, deletes and verifies; a missing webhook is already_satisfied", async () => {
    const f = fakeWebhooks();
    const dry = await run("jira_delete_webhook", { webhook: "Chat relay" }, f.responder);
    assert.equal(dry.value.request.method, "DELETE");
    assert.match(dry.value.summary, /Chat relay/);
    const r = await run("jira_delete_webhook", { webhook: "Chat relay", dry_run: false }, f.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.equal(f.hooks.length, 1);
    const again = await run("jira_delete_webhook", { webhook: "Chat relay" }, f.responder);
    assert.equal(again.value.already_satisfied, true);
  });

  it("every write sends nothing without arguments", async () => {
    for (const t of jiraWebhookTools.filter((x) => x.write)) {
      const { ctx, calls } = testContext();
      await runTool(t, {}, ctx);
      assert.equal(calls.length, 0, t.name);
    }
  });
});
