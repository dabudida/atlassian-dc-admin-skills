import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runTool } from "../../src/runner.js";
import { jiraProjectLifecycleTools } from "../../src/tools/jira/projectLifecycle.js";
import { testContext, type Call } from "./helpers.js";

const API = "/rest/api/2";
const tool = (name: string) => {
  const t = jiraProjectLifecycleTools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

/** A small Jira with projects, scheme assignments, categories, components and the shared-config route. */
function fakeJira(opts: { ignoreWrites?: boolean; sharedIssueTypeScheme?: number; noWorkflowScheme?: boolean } = {}) {
  const categories: any[] = [
    { id: "10000", name: "Internal", description: "Internal projects" },
    { id: "10001", name: "Customers", description: "" },
  ];
  const projects: any[] = [
    {
      id: "10100", key: "PROJ", name: "Project", projectTypeKey: "software", lead: { name: "alice" }, description: "", url: "",
      assigneeType: "PROJECT_LEAD", projectCategory: categories[0], formerKeys: ["OLD"],
      schemes: { permission: 0, notification: 10000, security: 10200, workflow: 10300, issueType: 10400 },
    },
    {
      id: "10200", key: "SD", name: "Service Desk", projectTypeKey: "service_desk", lead: { name: "alice" }, description: "", url: "",
      assigneeType: "UNASSIGNED", projectCategory: null,
      schemes: { permission: 10500, notification: 10000, security: null, workflow: 10600, issueType: 10700 },
    },
  ];
  const components: any[] = [
    { id: "20000", name: "Backend", description: "API", lead: { name: "alice" }, assigneeType: "PROJECT_DEFAULT", project: "PROJ", issues: 7 },
    { id: "20001", name: "Frontend", description: "", lead: null, assigneeType: "PROJECT_DEFAULT", project: "PROJ", issues: 0 },
  ];
  let nextId = 30000;
  const users = new Set(["alice", "bob"]);
  const projectOut = (p: any) => {
    const { schemes: _s, formerKeys: _f, ...rest } = p;
    return rest;
  };
  // GET /project/{key} also answers for a former key of a renamed project
  const byKey = (k: string) => projects.find((p) => p.key === k || p.id === k || p.formerKeys?.includes(k));
  const notFound = { status: 404, body: { errorMessages: ["not found"] } };
  const responder = (c: Call) => {
    const u = new URL(c.url);
    const p = u.pathname;
    const q = u.searchParams;
    if (p === `${API}/project` && c.method === "GET") return { body: projects.map(projectOut) };
    if (p === `${API}/project` && c.method === "POST") {
      const b = c.body;
      const np = {
        id: String(nextId++), key: b.key, name: b.name, projectTypeKey: b.projectTypeKey, lead: { name: b.lead }, description: b.description ?? "",
        url: b.url ?? "", assigneeType: b.assigneeType ?? "UNASSIGNED", projectCategory: categories.find((x) => Number(x.id) === b.categoryId) ?? null,
        schemes: { permission: b.permissionScheme ?? 0, notification: b.notificationScheme ?? 10000, security: b.issueSecurityScheme ?? null, workflow: null, issueType: null },
      };
      if (!opts.ignoreWrites) projects.push(np);
      return { status: 201, body: { id: Number(np.id), key: np.key, self: "x" } };
    }
    if (p === `${API}/projectvalidate/key`) {
      const k = q.get("key")!;
      if (!/^[A-Z][A-Z0-9]+$/.test(k)) return { body: { errorMessages: [], errors: { projectKey: "Project keys must start with an uppercase letter." } } };
      if (byKey(k)) return { body: { errorMessages: [], errors: { projectKey: `Project '${byKey(k).name}' uses this project key.` } } };
      return { body: { errorMessages: [], errors: {} } };
    }
    if (p === `${API}/project/type`) return { body: [{ key: "business" }, { key: "software" }, { key: "service_desk" }] };
    // Jira looks usernames up case-insensitively and answers with the stored name
    if (p === `${API}/user`) return users.has(q.get("username")!.toLowerCase()) ? { body: { name: q.get("username")!.toLowerCase(), active: true } } : notFound;
    let m = /^\/rest\/api\/2\/project\/([^/]+)(?:\/(\w+))?$/.exec(p);
    if (m) {
      const pr = byKey(decodeURIComponent(m[1]));
      if (!pr) return notFound;
      const sub = m[2];
      if (!sub && c.method === "GET") return { body: projectOut(pr) };
      if (!sub && c.method === "PUT") {
        if (opts.ignoreWrites) return { body: projectOut(pr) };
        const b = c.body;
        if (b.name !== undefined) pr.name = b.name;
        if (b.lead !== undefined) pr.lead = { name: b.lead };
        if (b.description !== undefined) pr.description = b.description;
        if (b.url !== undefined) pr.url = b.url;
        if (b.assigneeType !== undefined) pr.assigneeType = b.assigneeType;
        if (b.categoryId !== undefined) pr.projectCategory = categories.find((x) => Number(x.id) === b.categoryId) ?? null;
        return { body: projectOut(pr) };
      }
      if (sub === "permissionscheme") return { body: { id: pr.schemes.permission, name: `perm ${pr.schemes.permission}` } };
      if (sub === "notificationscheme") return { body: { id: pr.schemes.notification, name: `notif ${pr.schemes.notification}` } };
      if (sub === "issuesecuritylevelscheme") return pr.schemes.security == null ? notFound : { body: { id: pr.schemes.security, name: "sec" } };
      if (sub === "workflowscheme") return pr.schemes.workflow == null || opts.noWorkflowScheme ? notFound : { body: { id: pr.schemes.workflow, name: "wf" } };
      if (sub === "components") return { body: components.filter((x) => x.project === pr.key) };
    }
    if (p === `${API}/issuetypescheme`) {
      const ids = [...new Set(projects.map((x) => x.schemes.issueType).filter((x) => x != null))];
      return { body: { schemes: ids.map((id) => ({ id: String(id), name: `its ${id}` })) } };
    }
    const its = /^\/rest\/api\/2\/issuetypescheme\/(\d+)\/associations$/.exec(p);
    if (its) return { body: projects.filter((x) => String(x.schemes.issueType) === its[1]).map((x) => ({ key: x.key, id: x.id })) };
    if (p === `${API}/projectCategory`) {
      if (c.method === "GET") return { body: categories };
      const cat = { id: String(nextId++), name: c.body.name, description: c.body.description ?? "" };
      if (!opts.ignoreWrites) categories.push(cat);
      return { status: 201, body: cat };
    }
    m = /^\/rest\/api\/2\/projectCategory\/(\d+)$/.exec(p);
    if (m) {
      const i = categories.findIndex((x) => x.id === m![1]);
      if (i < 0) return notFound;
      if (c.method === "GET") return { body: categories[i] };
      if (c.method === "PUT") {
        if (!opts.ignoreWrites) categories[i] = { ...categories[i], ...c.body };
        return { body: categories[i] };
      }
      if (c.method === "DELETE") {
        if (!opts.ignoreWrites) categories.splice(i, 1);
        return { status: 204 };
      }
    }
    if (p === `${API}/component` && c.method === "POST") {
      const cp = { id: String(nextId++), name: c.body.name, description: c.body.description ?? "", lead: c.body.leadUserName ? { name: c.body.leadUserName } : null, assigneeType: c.body.assigneeType ?? "PROJECT_DEFAULT", project: c.body.project, issues: 0 };
      if (!opts.ignoreWrites) components.push(cp);
      return { status: 201, body: cp };
    }
    m = /^\/rest\/api\/2\/component\/(\d+)(\/relatedIssueCounts)?$/.exec(p);
    if (m) {
      const i = components.findIndex((x) => x.id === m![1]);
      if (i < 0) return notFound;
      if (m[2]) return { body: { issueCount: components[i].issues } };
      if (c.method === "GET") return { body: components[i] };
      if (c.method === "PUT") {
        if (!opts.ignoreWrites) {
          const b = c.body;
          const cp = components[i];
          if (b.name !== undefined) cp.name = b.name;
          if (b.description !== undefined) cp.description = b.description;
          if (b.leadUserName !== undefined) cp.lead = b.leadUserName ? { name: b.leadUserName } : null;
          if (b.assigneeType !== undefined) cp.assigneeType = b.assigneeType;
        }
        return { body: components[i] };
      }
      if (c.method === "DELETE") {
        if (!opts.ignoreWrites) {
          const to = q.get("moveIssuesTo");
          if (to) components.find((x) => x.id === to).issues += components[i].issues;
          components.splice(i, 1);
        }
        return { status: 204 };
      }
    }
    m = /^\/rest\/project-templates\/1\.0\/createshared\/(\d+)$/.exec(p);
    if (m && c.method === "POST") {
      const src = byKey(m[1]);
      const np = { ...structuredClone(src), id: String(nextId++), key: c.body.key, name: c.body.name, lead: { name: c.body.lead }, formerKeys: [] };
      if (opts.sharedIssueTypeScheme !== undefined) np.schemes.issueType = opts.sharedIssueTypeScheme;
      if (!opts.ignoreWrites) projects.push(np);
      return { body: { returnUrl: `/projects/${np.key}`, projectId: Number(np.id), projectKey: np.key, projectName: np.name } };
    }
    return undefined;
  };
  return { responder, projects, categories, components };
}

async function run(name: string, args: Record<string, unknown>, responder: (c: Call) => any) {
  const { ctx, calls } = testContext(responder);
  const res = await runTool(tool(name), args, ctx);
  return { res, value: res.ok ? (res.value as any) : undefined, error: res.ok ? undefined : (res as any).error, calls };
}
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

describe("jira_create_project", () => {
  const args = { project_key: "NEW", name: "New project", project_type: "software", lead: "bob" };

  it("dry run validates the key and sends the project body without writing", async () => {
    const r = await run("jira_create_project", { ...args, category: "Customers", permission_scheme: 10500 }, fakeJira().responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.equal(r.value.dry_run, true);
    assert.equal(writes(r.calls).length, 0);
    assert.ok(r.calls.some((c) => new URL(c.url).pathname === `${API}/projectvalidate/key`));
    assert.deepEqual(r.value.request.body, { key: "NEW", name: "New project", projectTypeKey: "software", lead: "bob", categoryId: 10001, permissionScheme: 10500 });
  });

  it("refuses an invalid or taken key, a taken name, an unknown lead or type", async () => {
    const bad = await run("jira_create_project", { ...args, project_key: "new-1" }, fakeJira().responder);
    assert.match(bad.error.message, /uppercase/);
    const name = await run("jira_create_project", { ...args, name: "service desk" }, fakeJira().responder);
    assert.match(name.error.message, /name/);
    const lead = await run("jira_create_project", { ...args, lead: "carol" }, fakeJira().responder);
    assert.match(lead.error.message, /carol/);
    const type = await run("jira_create_project", { ...args, project_type: "moon" }, fakeJira().responder);
    assert.match(type.error.message, /moon/);
    const taken = await run("jira_create_project", { ...args, project_key: "SD" }, fakeJira().responder);
    assert.match(taken.error.message, /SD/);
  });

  it("from_project copies permission, notification and security scheme ids, category and type; names what it cannot copy", async () => {
    const r = await run("jira_create_project", { project_key: "NEW", name: "New project", lead: "bob", from_project: "PROJ" }, fakeJira().responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.deepEqual(r.value.request.body, {
      key: "NEW", name: "New project", projectTypeKey: "software", lead: "bob",
      permissionScheme: 0, notificationScheme: 10000, issueSecurityScheme: 10200, categoryId: 10000,
    });
    assert.equal(r.value.copiedFrom.project, "PROJ");
    assert.match(JSON.stringify(r.value.notCopied), /workflow/);
  });

  it("explicit scheme ids override copied ones", async () => {
    const r = await run("jira_create_project", { project_key: "NEW", name: "New project", lead: "bob", from_project: "PROJ", permission_scheme: 10500 }, fakeJira().responder);
    assert.equal(r.value.request.body.permissionScheme, 10500);
  });

  it("executes, reads the project and its schemes back; a re-run is already_satisfied", async () => {
    const f = fakeJira();
    const r = await run("jira_create_project", { ...args, permission_scheme: 10500, dry_run: false }, f.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.equal(r.value.result.key, "NEW");
    assert.equal(r.value.result.schemes.permissionScheme, 10500);
    const again = await run("jira_create_project", args, f.responder);
    assert.equal(again.value.already_satisfied, true);
  });

  it("an existing key with other settings is an error; a project that does not appear fails verification", async () => {
    const other = await run("jira_create_project", { project_key: "PROJ", name: "Something else", project_type: "software", lead: "alice" }, fakeJira().responder);
    assert.match(other.error.message, /already exists/);
    const lost = await run("jira_create_project", { ...args, dry_run: false }, fakeJira({ ignoreWrites: true }).responder);
    assert.equal(lost.error.type, "VerificationError");
  });
});

describe("jira_create_project: existing projects", () => {
  const proj = { project_key: "PROJ", name: "Project", project_type: "software", lead: "alice" };

  it("compares the lead case-insensitively", async () => {
    const r = await run("jira_create_project", { ...proj, lead: "Alice" }, fakeJira().responder);
    assert.equal(r.value?.already_satisfied, true, JSON.stringify(r.error ?? r.value));
  });

  it("is already_satisfied only when the requested category and schemes match too", async () => {
    const same = await run("jira_create_project", { ...proj, category: "Internal", permission_scheme: 0, issue_security_scheme: 10200 }, fakeJira().responder);
    assert.equal(same.value?.already_satisfied, true, JSON.stringify(same.error ?? same.value));
    const cat = await run("jira_create_project", { ...proj, category: "Customers" }, fakeJira().responder);
    assert.equal(cat.res.ok, false);
    assert.match(cat.error.message, /category/);
    assert.match(cat.error.message, /jira_update_project/);
    const scheme = await run("jira_create_project", { ...proj, permission_scheme: 10500 }, fakeJira().responder);
    assert.equal(scheme.res.ok, false);
    assert.match(scheme.error.message, /permissionScheme/);
    assert.match(scheme.error.message, /jira_assign_project_scheme/);
    const copied = await run("jira_create_project", { ...proj, from_project: "SD", project_type: "software" }, fakeJira().responder);
    assert.equal(copied.res.ok, false);
    assert.match(copied.error.message, /jira_assign_project_scheme/);
  });

  it("does not treat a former key of a renamed project as the same project", async () => {
    const r = await run("jira_create_project", { ...proj, project_key: "OLD" }, fakeJira().responder);
    assert.equal(r.res.ok, false, JSON.stringify(r.value));
    assert.match(r.error.message, /former key of project PROJ/);
    const shared = await run("jira_create_project_shared", { from_project: "SD", project_key: "OLD", name: "Project", lead: "alice" }, fakeJira().responder);
    assert.equal(shared.res.ok, false);
    assert.match(shared.error.message, /former key of project PROJ/);
  });
});

describe("lead usernames are compared case-insensitively", () => {
  it("update project and components treat another case of the same lead as unchanged", async () => {
    const up = await run("jira_update_project", { project_key: "PROJ", lead: "ALICE" }, fakeJira().responder);
    assert.equal(up.value?.already_satisfied, true, JSON.stringify(up.error ?? up.value));
    const cc = await run("jira_create_component", { project_key: "PROJ", name: "Backend", lead: "Alice" }, fakeJira().responder);
    assert.equal(cc.value?.already_satisfied, true, JSON.stringify(cc.error ?? cc.value));
    const uc = await run("jira_update_component", { project_key: "PROJ", component: "Backend", lead: "ALICE" }, fakeJira().responder);
    assert.equal(uc.value?.already_satisfied, true, JSON.stringify(uc.error ?? uc.value));
  });

  it("a lead that reads back in another case still verifies", async () => {
    const f = fakeJira();
    const r = await run("jira_update_project", { project_key: "PROJ", lead: "Bob", name: "Renamed", dry_run: false }, (c) => {
      const out = f.responder(c);
      // Jira answers with the stored username, which may differ in case from the given one
      if (c.method === "GET" && out?.body && (out.body as any).lead?.name === "Bob") return { ...out, body: { ...(out.body as any), lead: { name: "bob" } } };
      return out;
    });
    assert.ok(r.res.ok, JSON.stringify(r.error));
  });
});

describe("jira_update_project", () => {
  it("shows before/after for the changed fields only, executes and verifies; same values are already_satisfied", async () => {
    const f = fakeJira();
    const dry = await run("jira_update_project", { project_key: "PROJ", name: "Project X", lead: "bob", category: "Customers" }, f.responder);
    assert.ok(dry.res.ok, JSON.stringify(dry.error));
    assert.deepEqual(dry.value.request.body, { name: "Project X", lead: "bob", categoryId: 10001 });
    assert.equal(dry.value.before.category, "Internal");
    assert.equal(dry.value.after.category, "Customers");
    const r = await run("jira_update_project", { project_key: "PROJ", name: "Project X", lead: "bob", category: "Customers", dry_run: false }, f.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.equal(f.projects[0].name, "Project X");
    const again = await run("jira_update_project", { project_key: "PROJ", name: "Project X", lead: "bob" }, f.responder);
    assert.equal(again.value.already_satisfied, true);
  });

  it("needs a change and verifies the read-back", async () => {
    const none = await run("jira_update_project", { project_key: "PROJ" }, fakeJira().responder);
    assert.equal(none.res.ok, false);
    const lost = await run("jira_update_project", { project_key: "PROJ", name: "Other", dry_run: false }, fakeJira({ ignoreWrites: true }).responder);
    assert.equal(lost.error.type, "VerificationError");
  });
});

describe("project categories", () => {
  it("lists categories with project counts", async () => {
    const r = await run("jira_list_project_categories", {}, fakeJira().responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.deepEqual(r.value.items.map((c: any) => [c.name, c.projects]), [["Internal", 1], ["Customers", 0]]);
  });

  it("creates with read-back; same name and description is already_satisfied, another description an error", async () => {
    const f = fakeJira();
    const r = await run("jira_create_project_category", { name: "Partners", description: "External", dry_run: false }, f.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.equal(r.value.result.name, "Partners");
    assert.equal((await run("jira_create_project_category", { name: "Partners", description: "External" }, f.responder)).value.already_satisfied, true);
    assert.match((await run("jira_create_project_category", { name: "partners", description: "Other" }, f.responder)).error.message, /jira_update_project_category/);
  });

  it("updates by name or id; same values are already_satisfied", async () => {
    const f = fakeJira();
    const r = await run("jira_update_project_category", { category: "Internal", description: "Inside", dry_run: false }, f.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.equal(f.categories[0].description, "Inside");
    assert.equal((await run("jira_update_project_category", { category: "10000", description: "Inside" }, f.responder)).value.already_satisfied, true);
  });

  it("deletes with the projects that lose it in the summary; a missing category is already_satisfied", async () => {
    const f = fakeJira();
    const dry = await run("jira_delete_project_category", { category: "Internal" }, f.responder);
    assert.match(dry.value.summary, /1 project/);
    assert.deepEqual(dry.value.projects, ["PROJ"]);
    const r = await run("jira_delete_project_category", { category: "Internal", dry_run: false }, f.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.equal(f.categories.length, 1);
    assert.equal((await run("jira_delete_project_category", { category: "Internal" }, f.responder)).value.already_satisfied, true);
  });
});

describe("components", () => {
  it("creates with read-back; same settings are already_satisfied, same name otherwise an error", async () => {
    const f = fakeJira();
    const dry = await run("jira_create_component", { project_key: "PROJ", name: "Mobile", lead: "bob", assignee_type: "COMPONENT_LEAD" }, f.responder);
    assert.deepEqual(dry.value.request.body, { project: "PROJ", name: "Mobile", leadUserName: "bob", assigneeType: "COMPONENT_LEAD" });
    const r = await run("jira_create_component", { project_key: "PROJ", name: "Mobile", lead: "bob", assignee_type: "COMPONENT_LEAD", dry_run: false }, f.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.equal(r.value.result.lead, "bob");
    assert.equal((await run("jira_create_component", { project_key: "PROJ", name: "Mobile", lead: "bob", assignee_type: "COMPONENT_LEAD" }, f.responder)).value.already_satisfied, true);
    assert.equal((await run("jira_create_component", { project_key: "PROJ", name: "Backend" }, f.responder)).value.already_satisfied, true);
    assert.match((await run("jira_create_component", { project_key: "PROJ", name: "Backend", description: "Other" }, f.responder)).error.message, /jira_update_component/);
  });

  it("updates by name and verifies; same values are already_satisfied", async () => {
    const f = fakeJira();
    const r = await run("jira_update_component", { project_key: "PROJ", component: "Frontend", description: "Web UI", dry_run: false }, f.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.equal(f.components[1].description, "Web UI");
    assert.equal((await run("jira_update_component", { project_key: "PROJ", component: "20001", description: "Web UI" }, f.responder)).value.already_satisfied, true);
  });

  it("deletes with the issue count and an optional target; a missing component is already_satisfied", async () => {
    const f = fakeJira();
    const dry = await run("jira_delete_component", { project_key: "PROJ", component: "Backend", move_issues_to: "Frontend" }, f.responder);
    assert.ok(dry.res.ok, JSON.stringify(dry.error));
    assert.match(dry.value.summary, /7 issues/);
    assert.match(dry.value.request.url, /moveIssuesTo=20001/);
    const r = await run("jira_delete_component", { project_key: "PROJ", component: "Backend", move_issues_to: "Frontend", dry_run: false }, f.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.equal(f.components.length, 1);
    assert.equal(f.components[0].issues, 7);
    assert.equal((await run("jira_delete_component", { project_key: "PROJ", component: "Backend" }, f.responder)).value.already_satisfied, true);
  });

  it("refuses moving issues to the deleted component itself or to an unknown one", async () => {
    assert.equal((await run("jira_delete_component", { project_key: "PROJ", component: "Backend", move_issues_to: "Backend" }, fakeJira().responder)).res.ok, false);
    assert.equal((await run("jira_delete_component", { project_key: "PROJ", component: "Backend", move_issues_to: "Nope" }, fakeJira().responder)).res.ok, false);
  });
});

describe("jira_create_project_shared", () => {
  const args = { from_project: "SD", project_key: "SD2", name: "Service Desk 2", lead: "bob" };

  it("dry run posts {key,name,lead} to createshared/{sourceProjectId} after validating the key", async () => {
    const r = await run("jira_create_project_shared", args, fakeJira().responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.match(r.value.request.url, /\/rest\/project-templates\/1\.0\/createshared\/10200$/);
    assert.deepEqual(r.value.request.body, { key: "SD2", name: "Service Desk 2", lead: "bob" });
    assert.equal(writes(r.calls).length, 0);
  });

  it("executes and verifies the new project shares the source's schemes; a re-run is already_satisfied", async () => {
    const f = fakeJira();
    const r = await run("jira_create_project_shared", { ...args, dry_run: false }, f.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.equal(r.value.result.key, "SD2");
    assert.equal(r.value.result.type, "service_desk");
    assert.equal((await run("jira_create_project_shared", args, f.responder)).value.already_satisfied, true);
  });

  it("verification compares the issue type scheme too", async () => {
    const r = await run("jira_create_project_shared", { ...args, dry_run: false }, fakeJira({ sharedIssueTypeScheme: 10400 }).responder);
    assert.equal(r.error?.type, "VerificationError", JSON.stringify(r.error ?? r.value));
    assert.match(r.error.message, /issueTypeScheme/);
  });

  it("states a partial verification when the workflow scheme cannot be read", async () => {
    const f = fakeJira({ noWorkflowScheme: true });
    const r = await run("jira_create_project_shared", { ...args, dry_run: false }, f.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.equal(r.value.verification.status, "partial");
    assert.deepEqual(r.value.verification.unverified, ["workflowScheme"]);
    const full = await run("jira_create_project_shared", { ...args, dry_run: false }, fakeJira().responder);
    assert.equal(full.value.verification.status, "full");
  });

  it("fails verification when the project does not appear", async () => {
    const r = await run("jira_create_project_shared", { ...args, dry_run: false }, fakeJira({ ignoreWrites: true }).responder);
    assert.equal(r.error.type, "VerificationError");
  });
});

describe("project lifecycle writes", () => {
  it("send nothing without arguments", async () => {
    for (const t of jiraProjectLifecycleTools.filter((x) => x.write)) {
      const { ctx, calls } = testContext();
      await runTool(t, {}, ctx);
      assert.equal(calls.length, 0, t.name);
    }
  });
});
