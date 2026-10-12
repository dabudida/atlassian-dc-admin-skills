import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runTool } from "../../src/runner.js";
import { jiraJsmCustomerTools } from "../../src/tools/jira/jsmCustomers.js";
import { testContext, type Call } from "./helpers.js";

const SDAPI = "/rest/servicedeskapi";
const OPT_IN = "X-ExperimentalApi";

/** A small JSM: organizations with users, desk links, the customers role and a user directory. */
function fakeJsm(opts: { noCustomerRole?: boolean; ignoreWrites?: boolean } = {}) {
  const orgs = new Map<string, { name: string; users: Set<string> }>([
    ["1", { name: "Acme", users: new Set(["alice"]) }],
    ["2", { name: "Globex", users: new Set() }],
    ["3", { name: "Twin", users: new Set() }],
    ["4", { name: "twin", users: new Set() }],
  ]);
  const deskOrgs = new Map<string, Set<string>>([["3", new Set(["1"])], ["5", new Set(["1"])]]);
  const roleActors = new Set<string>(["alice"]);
  const users = new Map<string, { email: string; displayName: string }>([["alice", { email: "alice@example.com", displayName: "Alice" }]]);
  let nextOrg = 10;
  const desks = [
    { id: "3", projectId: "10100", projectKey: "SD", projectName: "Service Desk" },
    { id: "5", projectId: "10200", projectKey: "HR", projectName: "HR Desk" },
  ];
  const paged = (all: unknown[], q: URLSearchParams) => {
    const start = Number(q.get("start") ?? 0);
    const limit = Number(q.get("limit") ?? 50);
    const values = all.slice(start, start + limit);
    return { size: values.length, start, limit, isLastPage: start + values.length >= all.length, values };
  };
  const userRow = (name: string) => ({ name, key: name, displayName: users.get(name)?.displayName ?? name, emailAddress: users.get(name)?.email ?? `${name}@example.com`, active: true });
  const responder = (c: Call) => {
    const url = new URL(c.url);
    const p = url.pathname;
    const q = url.searchParams;
    const write = c.method !== "GET";
    if (write && opts.ignoreWrites) return { status: 204 };
    if (p === `${SDAPI}/servicedesk`) return { body: paged(desks, q) };
    const desk = /^\/rest\/servicedeskapi\/servicedesk\/(\d+)$/.exec(p);
    if (desk) return { body: desks.find((d) => d.id === desk[1]) };
    if (p === `${SDAPI}/organization`) {
      if (c.method === "POST") {
        const id = String(nextOrg++);
        orgs.set(id, { name: c.body.name, users: new Set() });
        return { status: 201, body: { id, name: c.body.name } };
      }
      return { body: paged([...orgs].map(([id, o]) => ({ id, name: o.name })), q) };
    }
    let m = /^\/rest\/servicedeskapi\/organization\/(\d+)$/.exec(p);
    if (m) {
      const o = orgs.get(m[1]);
      if (!o) return { status: 404, body: { errorMessage: "Organization does not exist" } };
      if (c.method === "DELETE") {
        orgs.delete(m[1]);
        for (const s of deskOrgs.values()) s.delete(m[1]);
        return { status: 204 };
      }
      return { body: { id: m[1], name: o.name } };
    }
    m = /^\/rest\/servicedeskapi\/organization\/(\d+)\/user$/.exec(p);
    if (m) {
      const o = orgs.get(m[1])!;
      if (c.method === "POST") for (const u of c.body.usernames) o.users.add(u);
      if (c.method === "DELETE") for (const u of c.body.usernames) o.users.delete(u);
      if (write) return { status: 204 };
      return { body: paged([...o.users].map(userRow), q) };
    }
    m = /^\/rest\/servicedeskapi\/servicedesk\/(\d+)\/organization$/.exec(p);
    if (m) {
      const set = deskOrgs.get(m[1]) ?? new Set<string>();
      deskOrgs.set(m[1], set);
      if (c.method === "POST") set.add(String(c.body.organizationId));
      if (c.method === "DELETE") set.delete(String(c.body.organizationId));
      if (write) return { status: 204 };
      return { body: paged([...set].map((id) => ({ id, name: orgs.get(id)?.name })), q) };
    }
    if (p === `${SDAPI}/servicedesk/3/customer`) {
      if (c.method !== "POST") return { status: 500, body: "HTTP 405 Method Not Allowed" };
      for (const u of c.body.usernames) roleActors.add(u);
      return { status: 204 };
    }
    if (p === `${SDAPI}/customer` && c.method === "POST") {
      users.set(c.body.email, { email: c.body.email, displayName: c.body.fullName });
      return { status: 201, body: userRow(c.body.email) };
    }
    if (p === "/rest/api/2/project/SD/role") {
      const roles: Record<string, string> = { Administrators: "https://jira.example.com/rest/api/2/project/10100/role/10002" };
      if (!opts.noCustomerRole) roles["Service Desk Customers"] = "https://jira.example.com/rest/api/2/project/10100/role/10101";
      return { body: roles };
    }
    if (p === "/rest/api/2/project/SD/role/10101" || p === "/rest/api/2/project/10100/role/10101") {
      if (c.method === "DELETE") {
        roleActors.delete(q.get("user")!);
        return { status: 204 };
      }
      const actors = [
        ...[...roleActors].map((name, i) => ({ id: i + 1, type: "atlassian-user-role-actor", name, displayName: name })),
        { id: 99, type: "atlassian-group-role-actor", name: "customers-group", displayName: "customers-group" },
      ];
      return { body: { id: 10101, name: "Service Desk Customers", actors } };
    }
    if (p === "/rest/api/2/user") {
      const u = users.get(q.get("username")!);
      return u ? { body: userRow(q.get("username")!) } : { status: 404, body: { errorMessages: ["The user does not exist"] } };
    }
    if (p === "/rest/api/2/user/search") {
      const needle = q.get("username")!.toLowerCase();
      return { body: [...users].filter(([n, u]) => n.includes(needle) || u.email.includes(needle)).map(([n]) => userRow(n)) };
    }
    return undefined;
  };
  return { responder, orgs, deskOrgs, roleActors, users };
}

async function run(name: string, args: Record<string, unknown>, responder: (c: Call) => any) {
  const tool = jiraJsmCustomerTools.find((t) => t.name === name);
  assert.ok(tool, `no tool ${name}`);
  const { ctx, calls } = testContext(responder);
  const res = await runTool(tool, args, ctx);
  return { res, value: res.ok ? (res.value as any) : undefined, error: res.ok ? undefined : (res as any).error, calls };
}

const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

describe("organization reads", () => {
  it("lists organizations page by page with compact rows and the opt-in header", async () => {
    const r = await run("jira_list_organizations", { limit: 2 }, fakeJsm().responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.deepEqual(r.value.items, [{ id: "1", name: "Acme" }, { id: "2", name: "Globex" }]);
    assert.equal(r.value.nextOffset, 2);
    assert.equal(r.calls[0].headers[OPT_IN], "opt-in");
  });

  it("gets an organization by exact name with a page of compact users", async () => {
    const r = await run("jira_get_organization", { organization: "acme" }, fakeJsm().responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.equal(r.value.organization.id, "1");
    assert.deepEqual(r.value.users.items, [{ name: "alice", key: "alice", displayName: "Alice", email: "alice@example.com", active: true }]);
  });

  it("rejects an ambiguous organization name", async () => {
    const r = await run("jira_get_organization", { organization: "Twin" }, fakeJsm().responder);
    assert.equal(r.error.type, "ValidationError");
    assert.match(r.error.message, /ambiguous.*3.*4/);
  });

  it("lists the organizations of a service desk by project key", async () => {
    const r = await run("jira_list_service_desk_organizations", { service_desk: "SD" }, fakeJsm().responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.deepEqual(r.value.items, [{ id: "1", name: "Acme" }]);
  });
});

describe("organization writes", () => {
  it("creates an organization, reads it back, and a re-run is already_satisfied", async () => {
    const j = fakeJsm();
    const dry = await run("jira_create_organization", { name: "Initech" }, j.responder);
    assert.ok(dry.res.ok, JSON.stringify(dry.error));
    assert.equal(dry.value.dry_run, true);
    assert.deepEqual(dry.value.request.body, { name: "Initech" });
    assert.equal(writes(dry.calls).length, 0);
    const done = await run("jira_create_organization", { name: "Initech", dry_run: false }, j.responder);
    assert.ok(done.res.ok, JSON.stringify(done.error));
    assert.equal(done.value.result.id, "10");
    assert.equal((await run("jira_create_organization", { name: "initech" }, j.responder)).value.already_satisfied, true);
  });

  it("previews deletion as irreversible with linked desks, deletes, and is satisfied when gone", async () => {
    const j = fakeJsm();
    const dry = await run("jira_delete_organization", { organization: "Acme" }, j.responder);
    assert.ok(dry.res.ok, JSON.stringify(dry.error));
    assert.match(dry.value.summary, /irreversible/i);
    assert.deepEqual(dry.value.linked_service_desks, ["SD", "HR"]);
    assert.equal(dry.value.has_users, true);
    const done = await run("jira_delete_organization", { organization: 1, dry_run: false }, j.responder);
    assert.ok(done.res.ok, JSON.stringify(done.error));
    assert.equal(j.orgs.has("1"), false);
    assert.equal((await run("jira_delete_organization", { organization: "Acme" }, j.responder)).value.already_satisfied, true);
  });

  it("adds only missing users and verifies them; all present is already_satisfied", async () => {
    const j = fakeJsm();
    const dry = await run("jira_add_organization_users", { organization: "Acme", usernames: "alice,bob" }, j.responder);
    assert.deepEqual(dry.value.request.body, { usernames: ["bob"] });
    const done = await run("jira_add_organization_users", { organization: "Acme", usernames: "alice,bob", dry_run: false }, j.responder);
    assert.ok(done.res.ok, JSON.stringify(done.error));
    assert.deepEqual([...j.orgs.get("1")!.users], ["alice", "bob"]);
    assert.equal((await run("jira_add_organization_users", { organization: "Acme", usernames: ["bob"] }, j.responder)).value.already_satisfied, true);
  });

  it("fails verification when added users do not read back", async () => {
    const r = await run("jira_add_organization_users", { organization: "Acme", usernames: "bob", dry_run: false }, fakeJsm({ ignoreWrites: true }).responder);
    assert.equal(r.error.type, "VerificationError");
  });

  it("removes only present users with a DELETE body; none present is already_satisfied", async () => {
    const j = fakeJsm();
    const done = await run("jira_remove_organization_users", { organization: "Acme", usernames: "alice,carol", dry_run: false }, j.responder);
    assert.ok(done.res.ok, JSON.stringify(done.error));
    const del = writes(done.calls)[0];
    assert.equal(del.method, "DELETE");
    assert.deepEqual(del.body, { usernames: ["alice"] });
    assert.equal(j.orgs.get("1")!.users.size, 0);
    assert.equal((await run("jira_remove_organization_users", { organization: "Acme", usernames: "alice" }, j.responder)).value.already_satisfied, true);
  });

  it("links only missing organizations to a desk, one POST each", async () => {
    const j = fakeJsm();
    const dry = await run("jira_add_service_desk_organizations", { service_desk: "SD", organizations: "Acme,Globex" }, j.responder);
    assert.ok(dry.res.ok, JSON.stringify(dry.error));
    assert.deepEqual([dry.value.request, ...dry.value.followUps].map((r: any) => r.body), [{ organizationId: 2 }]);
    const done = await run("jira_add_service_desk_organizations", { service_desk: "SD", organizations: "Acme,Globex", dry_run: false }, j.responder);
    assert.ok(done.res.ok, JSON.stringify(done.error));
    assert.deepEqual([...j.deskOrgs.get("3")!], ["1", "2"]);
    assert.equal((await run("jira_add_service_desk_organizations", { service_desk: "3", organizations: "Globex" }, j.responder)).value.already_satisfied, true);
  });

  it("unlinks an organization from a desk; not linked is already_satisfied", async () => {
    const j = fakeJsm();
    const done = await run("jira_remove_service_desk_organization", { service_desk: "SD", organization: "Acme", dry_run: false }, j.responder);
    assert.ok(done.res.ok, JSON.stringify(done.error));
    assert.deepEqual(writes(done.calls)[0].body, { organizationId: 1 });
    assert.equal(j.deskOrgs.get("3")!.size, 0);
    assert.equal((await run("jira_remove_service_desk_organization", { service_desk: "SD", organization: "Acme" }, j.responder)).value.already_satisfied, true);
  });
});

describe("service desk customers", () => {
  it("adds missing customers and verifies them through the customers role", async () => {
    const j = fakeJsm();
    const dry = await run("jira_add_service_desk_customers", { service_desk: "SD", usernames: "alice,bob" }, j.responder);
    assert.ok(dry.res.ok, JSON.stringify(dry.error));
    assert.deepEqual(dry.value.request.body, { usernames: ["bob"] });
    assert.deepEqual(dry.value.already_customers, ["alice"]);
    const done = await run("jira_add_service_desk_customers", { service_desk: "SD", usernames: "alice,bob", dry_run: false }, j.responder);
    assert.ok(done.res.ok, JSON.stringify(done.error));
    assert.equal(done.value.verification, "verified");
    assert.equal((await run("jira_add_service_desk_customers", { service_desk: "SD", usernames: "bob" }, j.responder)).value.already_satisfied, true);
  });

  it("marks membership unverifiable when the project has no customers role", async () => {
    const j = fakeJsm({ noCustomerRole: true });
    const dry = await run("jira_add_service_desk_customers", { service_desk: "SD", usernames: "alice" }, j.responder);
    assert.ok(dry.res.ok, JSON.stringify(dry.error));
    assert.equal(dry.value.verification, "unverifiable");
    const done = await run("jira_add_service_desk_customers", { service_desk: "SD", usernames: "alice", dry_run: false }, j.responder);
    assert.ok(done.res.ok, JSON.stringify(done.error));
    assert.equal(done.value.verification, "unverifiable");
    const rm = await run("jira_remove_service_desk_customers", { service_desk: "SD", usernames: "alice" }, j.responder);
    assert.equal(rm.error.type, "ValidationError");
  });

  it("fails verification when an added customer is not in the role afterwards", async () => {
    const r = await run("jira_add_service_desk_customers", { service_desk: "SD", usernames: "bob", dry_run: false }, fakeJsm({ ignoreWrites: true }).responder);
    assert.equal(r.error.type, "VerificationError");
  });

  it("removes direct customers through the role and reports the others", async () => {
    const j = fakeJsm();
    const dry = await run("jira_remove_service_desk_customers", { service_desk: "SD", usernames: "alice,dave" }, j.responder);
    assert.ok(dry.res.ok, JSON.stringify(dry.error));
    assert.deepEqual(dry.value.not_direct_customers, ["dave"]);
    assert.equal(dry.value.followUps.length, 0);
    assert.equal(dry.value.request.method, "DELETE");
    const done = await run("jira_remove_service_desk_customers", { service_desk: "SD", usernames: "alice,dave", dry_run: false }, j.responder);
    assert.ok(done.res.ok, JSON.stringify(done.error));
    assert.equal(j.roleActors.has("alice"), false);
    assert.equal(new URL(writes(done.calls)[0].url).searchParams.get("user"), "alice");
    assert.equal((await run("jira_remove_service_desk_customers", { service_desk: "SD", usernames: "alice" }, j.responder)).value.already_satisfied, true);
  });

  it("creates a customer with fullName, reads it back, and an existing address is already_satisfied", async () => {
    const j = fakeJsm();
    const dry = await run("jira_create_customer", { email: "fred@example.com", display_name: "Fred" }, j.responder);
    assert.ok(dry.res.ok, JSON.stringify(dry.error));
    assert.deepEqual(dry.value.request.body, { email: "fred@example.com", fullName: "Fred" });
    const done = await run("jira_create_customer", { email: "fred@example.com", display_name: "Fred", dry_run: false }, j.responder);
    assert.ok(done.res.ok, JSON.stringify(done.error));
    assert.equal(done.value.result.name, "fred@example.com");
    assert.equal((await run("jira_create_customer", { email: "fred@example.com", display_name: "Fred" }, j.responder)).value.already_satisfied, true);
    assert.equal((await run("jira_create_customer", { email: "alice@example.com", display_name: "A" }, j.responder)).value.already_satisfied, true);
  });

  it("write tools send nothing without dry_run=false", async () => {
    for (const t of jiraJsmCustomerTools.filter((x) => x.write)) {
      assert.deepEqual(t.invalidates, [], t.name);
      assert.ok("dry_run" in t.inputShape, t.name);
    }
  });
});

/** Wraps the fake so that a listing path never ends: pages of synthetic rows with isLastPage false. */
function endless(base: (c: Call) => any, pathname: string, row: (i: number) => unknown, writes: "ignore" | "pass" = "pass") {
  return (c: Call) => {
    const url = new URL(c.url);
    if (url.pathname !== pathname) return base(c);
    if (c.method !== "GET") return writes === "ignore" ? { status: 204 } : base(c);
    const start = Number(url.searchParams.get("start") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const values = Array.from({ length: limit }, (_, i) => row(start + i));
    return { body: { size: limit, start, limit, isLastPage: false, values } };
  };
}
const userRowN = (i: number) => ({ name: `user${i}`, key: `user${i}`, displayName: `User ${i}`, active: true });

describe("case-insensitive usernames", () => {
  it("treats usernames case-insensitively for organization membership and sends the server's names", async () => {
    const j = fakeJsm();
    assert.equal((await run("jira_add_organization_users", { organization: "Acme", usernames: "ALICE" }, j.responder)).value.already_satisfied, true);
    const rm = await run("jira_remove_organization_users", { organization: "Acme", usernames: "Alice", dry_run: false }, j.responder);
    assert.ok(rm.res.ok, JSON.stringify(rm.error));
    assert.deepEqual(writes(rm.calls)[0].body, { usernames: ["alice"] });
    assert.equal(j.orgs.get("1")!.users.size, 0);
  });

  it("treats usernames case-insensitively for the customers role and deletes the canonical actor", async () => {
    const j = fakeJsm();
    assert.equal((await run("jira_add_service_desk_customers", { service_desk: "SD", usernames: "ALICE" }, j.responder)).value.already_satisfied, true);
    const rm = await run("jira_remove_service_desk_customers", { service_desk: "SD", usernames: "ALICE", dry_run: false }, j.responder);
    assert.ok(rm.res.ok, JSON.stringify(rm.error));
    assert.equal(new URL(writes(rm.calls)[0].url).searchParams.get("user"), "alice");
    assert.equal(j.roleActors.has("alice"), false);
  });
});

describe("organization lookup and capped scans", () => {
  it("rejects a numeric input that is one organization's id and another's exact name", async () => {
    const j = fakeJsm();
    j.orgs.set("6", { name: "1", users: new Set() });
    const r = await run("jira_get_organization", { organization: "1" }, j.responder);
    assert.equal(r.error?.type, "ValidationError");
    assert.match(r.error.message, /ambiguous/);
  });

  it("never claims a user is not a member when the member list is capped", async () => {
    const j = fakeJsm();
    const responder = endless(j.responder, "/rest/servicedeskapi/organization/1/user", userRowN);
    const rm = await run("jira_remove_organization_users", { organization: "Acme", usernames: "zed" }, responder);
    assert.equal(rm.error?.type, "ValidationError", JSON.stringify(rm.value));
    assert.match(rm.error.message, /cannot|more than/i);
  });

  it("reports partial verification instead of failure or success when the read-back is capped", async () => {
    const j = fakeJsm();
    const responder = endless(j.responder, "/rest/servicedeskapi/organization/1/user", userRowN, "ignore");
    const r = await run("jira_add_organization_users", { organization: "Acme", usernames: "zed", dry_run: false }, responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.equal(r.value.verification, "partial");
    assert.deepEqual(r.value.unverified, ["zed"]);
  });

  it("refuses the duplicate check and not-found decisions when the organization list is capped", async () => {
    const j = fakeJsm();
    const responder = endless(j.responder, "/rest/servicedeskapi/organization", (i) => ({ id: String(1000 + i), name: `Org ${i}` }));
    const create = await run("jira_create_organization", { name: "Initech" }, responder);
    assert.equal(create.error?.type, "ValidationError", JSON.stringify(create.value));
    const del = await run("jira_delete_organization", { organization: "Initech" }, responder);
    assert.equal(del.error?.type, "ValidationError", JSON.stringify(del.value));
  });

  it("refuses to call an organization unlinked when the desk's organization list is capped", async () => {
    const j = fakeJsm();
    const responder = endless(j.responder, "/rest/servicedeskapi/servicedesk/3/organization", (i) => ({ id: String(1000 + i), name: `Org ${i}` }));
    const r = await run("jira_remove_service_desk_organization", { service_desk: "SD", organization: "Globex" }, responder);
    assert.equal(r.error?.type, "ValidationError", JSON.stringify(r.value));
  });
});
