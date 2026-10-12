/**
 * Jira DC instance hygiene reports: unused custom fields, unused schemes / inactive workflows / unused
 * screens, license consumption and instance health. Read-only and bounded; every report says when it
 * could not cover everything.
 *
 * Workflow and screen usage reuse the cached scans of workflowSchemes.ts and screens.ts (scanCache.ts);
 * the per-project scheme scan below runs once per report call and is not cached.
 */

import { z } from "zod";
import { boundedAll, seg, type AtlassianClient } from "../../client.js";
import { isHttpStatusError, ValidationError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { boolArg, listArg, pageShape, paginate, settle } from "../util.js";
import { allScreens, screenUsageScan } from "./screens.js";
import { loadModel } from "./workflows.js";
import { workflowUsage } from "./workflowSchemes.js";

const API = "/rest/api/2";
const DAY_MS = 86_400_000;

// -- custom fields --------------------------------------------------------------

const CF_PAGE = 500;
const CF_SCAN_DEFAULT = 2000;
const CF_SCAN_MAX = 5000;

const CF_MATCH = ["any", "all", "no_values", "no_screens", "no_contexts"] as const;
const REASON_OF: Record<string, string> = { no_values: "no values", no_screens: "no screens", no_contexts: "no contexts" };

/** Why a custom field looks unused; numbers Jira does not report are not a reason. */
function fieldReasons(f: any): string[] {
  const out: string[] = [];
  if (f.issuesWithValue === 0) out.push("no values");
  if (f.screensCount === 0) out.push("no screens");
  if (!f.isAllProjects && f.projectsCount === 0) out.push("no contexts");
  return out;
}

// -- schemes --------------------------------------------------------------------

const SCHEME_TYPES = ["permission", "notification", "issue_security", "issue_type", "priority", "workflow", "screen"] as const;
type SchemeType = (typeof SCHEME_TYPES)[number];
const DEFAULT_TYPES: SchemeType[] = ["permission", "notification", "issue_security", "issue_type", "priority", "workflow"];

/** Categories whose usage is only readable per project, with the project resource that names the scheme. */
const PER_PROJECT: Partial<Record<SchemeType, string>> = {
  permission: "permissionscheme",
  notification: "notificationscheme",
  issue_security: "issuesecuritylevelscheme",
};

const MAX_PROJECT_SCAN = 2000;
const DEFAULT_PROJECT_SCAN = 500;
/** The screen-usage scan costs up to 40 requests per project, so it covers fewer projects by default. */
const DEFAULT_SCREEN_PROJECT_SCAN = 100;
const MAX_REQUESTS = 20_000;
const MAX_WORKFLOW_LOADS = 1000;
/** Default per-project request budget of the screen usage scan (REQUESTS_PER_PROJECT in screens.ts). */
const SCREEN_REQUESTS_PER_PROJECT = 40;
/** System defaults that Jira does not let you delete; never reported as candidates. */
const PROTECTED_PERMISSION_SCHEME = "0";
const PROTECTED_ISSUE_TYPE_SCHEME = "10000";

interface Incomplete {
  reason: string;
  coveredProjects?: number;
  totalProjects?: number;
  unreadableProjects?: number;
}

interface Category {
  type: SchemeType;
  total: number;
  used: number;
  protected?: number;
  unusedTotal: number;
  unused: Array<{ id?: string; name: string }>;
  complete: boolean;
  incomplete?: Incomplete;
}

function category(
  type: SchemeType,
  all: Array<{ id?: string; name: string; protected?: boolean }>,
  isUsed: (x: { id?: string; name: string }) => boolean,
  cap: number,
  incomplete?: Incomplete,
): Category {
  const protectedCount = all.filter((x) => x.protected).length;
  const candidates = all.filter((x) => !x.protected && !isUsed(x)).sort((a, b) => a.name.localeCompare(b.name));
  return {
    type,
    total: all.length,
    used: all.length - protectedCount - candidates.length,
    protected: protectedCount || undefined,
    unusedTotal: candidates.length,
    unused: candidates.slice(0, cap).map((x) => (x.id !== undefined ? { id: x.id, name: x.name } : { name: x.name })),
    complete: !incomplete,
    incomplete,
  };
}

/** A request budget shared by the per-project scan, the issue type scheme associations and the screen scan. */
function budget(max: number) {
  let used = 0;
  return {
    /** Reserve n requests at once, or none when they do not fit. */
    take(n: number): boolean {
      if (used + n > max) return false;
      used += n;
      return true;
    },
    get used() {
      return used;
    },
    get remaining() {
      return Math.max(0, max - used);
    },
  };
}

/**
 * For each per-project category: the scheme ids projects use, how many projects were covered, and per
 * category the projects whose scheme is unknown. Every project has a permission scheme, so a 404 there
 * means unreadable; for notification and issue security schemes a 404 means "none" on a live project
 * but is ambiguous on an archived one, so it counts as unreadable there.
 */
async function projectSchemeScan(client: AtlassianClient, projects: any[], types: SchemeType[], b: ReturnType<typeof budget>) {
  const used = new Map<SchemeType, Set<string>>(types.map((t) => [t, new Set()]));
  const unreadable = new Map<SchemeType, Set<string>>(types.map((t) => [t, new Set()]));
  const archivedNotFound = new Map<SchemeType, Set<string>>(types.map((t) => [t, new Set()]));
  let covered = 0;
  let exhausted = false;
  await boundedAll(projects.map((p) => async () => {
    if (!b.take(types.length)) {
      exhausted = true;
      return;
    }
    await Promise.all(types.map(async (t) => {
      try {
        const s = await client.get(`${API}/project/${seg(p.key)}/${PER_PROJECT[t]}`);
        if (s?.id !== undefined && s?.id !== null) used.get(t)!.add(String(s.id));
      } catch (e) {
        if (!isHttpStatusError(e)) throw e;
        if (e.status === 404 && t !== "permission") {
          // 404 on a live project: it has no such scheme
          if (p.archived === true) archivedNotFound.get(t)!.add(p.key);
          return;
        }
        unreadable.get(t)!.add(p.key);
      }
    }));
    covered++;
  }), 4);
  return { used, covered, unreadable, archivedNotFound, exhausted };
}

// -- license --------------------------------------------------------------------

const MAX_USERS_DEFAULT = 500;
const MAX_USERS = 5000;
const LIST_DEFAULT = 50;

/** Jira's "2026-10-11T10:00:00.000+0500" made parseable everywhere (offset with a colon). */
function parseJiraTime(v: unknown): number | null {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  return Number.isNaN(t) ? null : t;
}

// -- health ---------------------------------------------------------------------

const SEVERITY_RANK: Record<string, number> = { critical: 0, major: 1, warning: 2, minor: 3 };
const REASON_MAX = 200;
const cut = (s: unknown, n: number) => {
  const text = String(s ?? "").trim();
  return text.length > n ? `${text.slice(0, n)}…` : text;
};

const capShape = (what: string, def: number) =>
  z.coerce.number().int().min(1).max(500).optional().describe(`${what} shown per list (default ${def}, max 500); totals are always given`);

export const jiraHygieneTools: ToolDef[] = [
  {
    name: "jira_report_unused_custom_fields",
    product: "jira",
    description:
      "Custom fields that look unused: no issue values, on no screen, or without a context (not global, no projects), from " +
      "Jira's usage statistics. Locked and managed (system/app) fields are excluded and counted. Most signals first. " +
      `Scans at most max_scan fields (default ${CF_SCAN_DEFAULT}) and says when it was cut. Read-only; review before ` +
      "jira_delete_custom_fields.",
    inputShape: {
      match: z.enum(CF_MATCH).optional().describe("any (default): at least one signal; all: every signal; or one signal only"),
      max_scan: z.coerce.number().int().min(1).max(CF_SCAN_MAX).optional().describe(`Fields to scan (default ${CF_SCAN_DEFAULT}, max ${CF_SCAN_MAX})`),
      ...pageShape(50),
    },
    async handler({ client }, args) {
      const c = client("jira");
      const maxScan = args.max_scan ?? CF_SCAN_DEFAULT;
      const scanned: any[] = [];
      let total: number | undefined;
      // /customFields pages by page number: startAt is 1-based
      for (let page = 1; scanned.length < maxScan; page++) {
        const data = await c.get(`${API}/customFields`, { startAt: page, maxResults: CF_PAGE });
        const batch: any[] = data?.values ?? [];
        total = data?.total ?? total;
        scanned.push(...batch);
        if (batch.length < CF_PAGE || data?.isLast) break;
      }
      const fields = scanned.slice(0, maxScan);
      const excluded = { locked: 0, managed: 0 };
      const match = args.match ?? "any";
      const candidates = fields.flatMap((f) => {
        if (f.isLocked) { excluded.locked++; return []; }
        if (f.isManaged) { excluded.managed++; return []; }
        const reasons = fieldReasons(f);
        const keep = match === "any" ? reasons.length > 0
          : match === "all" ? reasons.length === 3
          : reasons.includes(REASON_OF[match]);
        return keep ? [{ f, reasons }] : [];
      });
      candidates.sort((a, b) =>
        b.reasons.length - a.reasons.length ||
        (a.f.issuesWithValue ?? 0) - (b.f.issuesWithValue ?? 0) ||
        String(a.f.name).localeCompare(String(b.f.name)));
      const items = candidates.map(({ f, reasons }) => ({
        id: f.id,
        name: f.name,
        issuesWithValue: f.issuesWithValue,
        screensCount: f.screensCount,
        projects: f.isAllProjects ? "all" : f.projectsCount,
        reasons,
      }));
      return {
        scanned: fields.length,
        totalCustomFields: total ?? null,
        truncatedScan: total !== undefined && total > fields.length ? true : undefined,
        excluded,
        ...paginate(items, args, 50),
      };
    },
  },
  {
    name: "jira_report_unused_schemes",
    product: "jira",
    description:
      "Configuration no project uses: permission, notification, issue security, issue type and priority schemes, inactive " +
      "workflows (not mapped by any workflow scheme in use) and, with types=screen, screens no project or workflow transition " +
      "uses. System defaults are never candidates. Scans projects (one request per project and scheme type, within " +
      "max_requests); a category whose scan was cut or hit unreadable projects says complete=false. Workflow schemes " +
      "cannot be listed on Jira DC and are not covered. Read-only.",
    inputShape: {
      types: listArg.optional().describe(`Categories (default ${DEFAULT_TYPES.join(",")}; also: screen, an expensive scan)`),
      scan_projects: z.coerce.number().int().min(1).max(MAX_PROJECT_SCAN).optional()
        .describe(`Projects to scan (default ${DEFAULT_PROJECT_SCAN}; screens default ${DEFAULT_SCREEN_PROJECT_SCAN}), max ${MAX_PROJECT_SCAN}`),
      max_requests: z.coerce.number().int().min(1).max(MAX_REQUESTS).optional()
        .describe("Request budget of the per-project scheme scan, issue type scheme associations, screen usage scan and workflow loads (default: what the scans need)"),
      max_per_type: capShape("Candidates", 50),
    },
    async handler({ client }, args) {
      const c = client("jira");
      const types = (args.types?.length ? args.types : DEFAULT_TYPES) as string[];
      const unknown = types.filter((t) => !(SCHEME_TYPES as readonly string[]).includes(t));
      if (unknown.length) throw new ValidationError(`Unknown types: ${unknown.join(", ")}; use ${SCHEME_TYPES.join(", ")}`);
      const want = (t: SchemeType) => types.includes(t);
      const cap = args.max_per_type ?? 50;
      const scanProjects = args.scan_projects ?? DEFAULT_PROJECT_SCAN;
      const perProjectTypes = (Object.keys(PER_PROJECT) as SchemeType[]).filter(want);
      const categories: Category[] = [];

      // lists first: they size the default budget
      const [perms, notifs, secs, itSchemes] = await Promise.all([
        want("permission") ? c.get(`${API}/permissionscheme`) : null,
        want("notification") ? c.getPagedResult(`${API}/notificationscheme`, "values", {}, 50, 5000) : null,
        want("issue_security") ? c.get(`${API}/issuesecurityschemes`) : null,
        want("issue_type") ? c.get(`${API}/issuetypescheme`) : null,
      ]);
      const itList: any[] = itSchemes ? (Array.isArray(itSchemes) ? itSchemes : (itSchemes.schemes ?? [])) : [];

      let projects: any[] = [];
      let totalProjects = 0;
      let allProjects: any[] | undefined;
      if (perProjectTypes.length) {
        const list = await c.get(`${API}/project`, { includeArchived: true });
        allProjects = Array.isArray(list) ? list : [];
        totalProjects = allProjects.length;
        projects = allProjects.slice(0, scanProjects);
      }
      const itToRead = itList.filter((s) => String(s.id) !== PROTECTED_ISSUE_TYPE_SCHEME);
      // without max_requests: what the scans need (the screen scan keeps its own default of 40 per project)
      const screenNeeds = want("screen") ? (args.scan_projects ?? DEFAULT_SCREEN_PROJECT_SCAN) * SCREEN_REQUESTS_PER_PROJECT + MAX_WORKFLOW_LOADS : 0;
      const b = budget(args.max_requests ?? Math.min(MAX_REQUESTS, perProjectTypes.length * projects.length + itToRead.length) + screenNeeds);

      if (perProjectTypes.length) {
        const scan = await projectSchemeScan(c, projects, perProjectTypes, b);
        const incompleteOf = (t: SchemeType): Incomplete | undefined => {
          const unreadable = scan.unreadable.get(t)!.size + scan.archivedNotFound.get(t)!.size || undefined;
          const base = { coveredProjects: scan.covered, totalProjects, unreadableProjects: unreadable };
          if (scan.exhausted) return { reason: `request budget (${b.used} requests)`, ...base };
          if (totalProjects > projects.length) return { reason: "project cap (scan_projects)", ...base };
          const reasons: string[] = [];
          if (scan.unreadable.get(t)!.size) reasons.push("some projects could not be read");
          if (scan.archivedNotFound.get(t)!.size) reasons.push(`${scan.archivedNotFound.get(t)!.size} archived project(s) answered 404, so their scheme is unknown`);
          return reasons.length ? { reason: reasons.join("; "), ...base } : undefined;
        };
        const usedBy = (t: SchemeType) => (x: { id?: string }) => scan.used.get(t)!.has(String(x.id));
        if (want("permission")) {
          const all = (perms?.permissionSchemes ?? []).map((s: any) => ({ id: String(s.id), name: s.name, protected: String(s.id) === PROTECTED_PERMISSION_SCHEME }));
          categories.push(category("permission", all, usedBy("permission"), cap, incompleteOf("permission")));
        }
        if (want("notification")) {
          const all = (notifs?.items ?? []).map((s: any) => ({ id: String(s.id), name: s.name }));
          const inc = incompleteOf("notification") ?? (notifs?.truncated ? { reason: "more than 5000 notification schemes" } : undefined);
          categories.push(category("notification", all, usedBy("notification"), cap, inc));
        }
        if (want("issue_security")) {
          const all = (secs?.issueSecuritySchemes ?? []).map((s: any) => ({ id: String(s.id), name: s.name }));
          categories.push(category("issue_security", all, usedBy("issue_security"), cap, incompleteOf("issue_security")));
        }
      }

      if (want("issue_type")) {
        let skipped = 0;
        let failed = 0;
        const usedIds = new Set<string>();
        const readIds = new Set<string>();
        await boundedAll(itToRead.map((s) => async () => {
          if (!b.take(1)) { skipped++; return; }
          try {
            const assoc = await c.get(`${API}/issuetypescheme/${seg(s.id)}/associations`);
            readIds.add(String(s.id));
            if (Array.isArray(assoc) && assoc.length) usedIds.add(String(s.id));
          } catch (e) {
            if (!isHttpStatusError(e)) throw e;
            failed++;
          }
        }), 4);
        const all = itList.map((s) => ({ id: String(s.id), name: s.name, protected: String(s.id) === PROTECTED_ISSUE_TYPE_SCHEME }));
        // schemes whose associations were not read stay out of the candidates: their use is unknown
        const inc = skipped ? { reason: `request budget: ${skipped} scheme association(s) not read (not listed as candidates)` }
          : failed ? { reason: `${failed} scheme association read(s) failed (not listed as candidates)` } : undefined;
        categories.push(category("issue_type", all, (x) => usedIds.has(String(x.id)) || !readIds.has(String(x.id)), cap, inc));
      }

      if (want("priority")) {
        const r = await c.getPagedResult(`${API}/priorityschemes`, "schemes", { expand: "schemes.projectKeys" }, 50, 5000);
        const all = r.items.map((s: any) => ({ id: String(s.id), name: s.name, protected: Boolean(s.defaultScheme), keys: s.projectKeys ?? [] }));
        const usedIds = new Set(all.filter((s) => s.keys.length).map((s) => s.id));
        categories.push(category("priority", all, (x) => usedIds.has(String(x.id)), cap, r.truncated ? { reason: "more than 5000 priority schemes" } : undefined));
      }

      let workflows: any[] | undefined;
      const readWorkflows = async () => (workflows ??= ((await c.get(`${API}/workflow`)) as any[]) ?? []);

      // archived projects are left out of the shared workflow scheme scan
      const countArchived = async () => {
        const all: any[] = allProjects ?? (await c.get(`${API}/project`, { includeArchived: true })) ?? [];
        return (Array.isArray(all) ? all : []).filter((p) => p.archived === true).length;
      };

      if (want("workflow")) {
        const list = await readWorkflows();
        const active = new Set<string>();
        let meta: any = {};
        for (const w of list) {
          if (w.default || w.isDefault) continue;
          // one cached project scan serves every workflow (scanCache "workflow-usage")
          const u = await workflowUsage(c, w.name, scanProjects);
          meta = u;
          if (u.usedBy.length) active.add(w.name);
        }
        const all = list.map((w) => ({ name: String(w.name), protected: Boolean(w.default || w.isDefault) }));
        const reasons: string[] = [];
        if (meta.truncatedScan) reasons.push("project cap (scan_projects)");
        if (meta.forbiddenProjects) reasons.push("some projects could not be read");
        if (meta.notFoundProjects) reasons.push(`${meta.notFoundProjects} project workflow scheme(s) not found (HTTP 404)`);
        const archived = await countArchived();
        if (archived) reasons.push(`${archived} archived project(s) not scanned: workflows only they use look inactive`);
        const unreadable = (meta.forbiddenProjects ?? 0) + (meta.notFoundProjects ?? 0) || undefined;
        const inc: Incomplete | undefined = reasons.length
          ? { reason: reasons.join("; "), coveredProjects: meta.scannedProjects, totalProjects: meta.totalProjects, unreadableProjects: unreadable }
          : undefined;
        categories.push(category("workflow", all, (x) => active.has(x.name), cap, inc));
      }

      if (want("screen")) {
        const screenProjects = args.scan_projects ?? DEFAULT_SCREEN_PROJECT_SCAN;
        const list = await readWorkflows();
        const toLoad = list.slice(0, MAX_WORKFLOW_LOADS);
        // workflow loads and the screen scan share the request budget: loads are reserved first, the
        // screen scan gets what is left
        let reserved = 0;
        while (reserved < toLoad.length && b.take(1)) reserved++;
        const screenBudget = b.remaining;
        b.take(screenBudget);
        const [screens, scan] = await Promise.all([allScreens(c), screenUsageScan(c, screenProjects, screenBudget)]);
        const usedIds = new Set<number>(scan.uses.map((u) => u.screenId).filter((id): id is number => id !== null));
        let loadFailures = 0;
        const loaded = await boundedAll(toLoad.slice(0, reserved).map((w) => async () => {
          try {
            return await loadModel(c, String(w.name));
          } catch (e) {
            // HTTP answers and "no such workflow" leave this workflow unknown; anything else is a bug or outage
            if (!isHttpStatusError(e) && !(e instanceof ValidationError)) throw e;
            loadFailures++;
            return null;
          }
        }), 4);
        for (const m of loaded) for (const t of m?.transitions ?? []) if (t.screenId !== null) usedIds.add(Number(t.screenId));
        const reasons: string[] = [];
        if (scan.incomplete) reasons.push(`screen usage scan: ${scan.incomplete.reason}`);
        if (scan.unreadableProjects) reasons.push(`${scan.unreadableProjects} project(s) unreadable`);
        if (scan.unresolved) reasons.push(`${scan.unresolved} create/edit screen lookup(s) unresolved`);
        if (list.length > toLoad.length) reasons.push(`only ${toLoad.length} of ${list.length} workflows checked for transition screens`);
        if (toLoad.length > reserved) reasons.push(`request budget: ${toLoad.length - reserved} workflow(s) not checked for transition screens`);
        if (loadFailures) reasons.push(`${loadFailures} workflow(s) could not be read`);
        if (screens.truncated) reasons.push("screen list cut");
        const inc: Incomplete | undefined = reasons.length
          ? { reason: reasons.join("; "), coveredProjects: scan.incomplete?.coveredProjects ?? scan.scannedProjects, totalProjects: scan.totalProjects }
          : undefined;
        const all = screens.map((s) => ({ id: String(s.id), name: s.name }));
        categories.push(category("screen", all, (x) => usedIds.has(Number(x.id)), cap, inc));
      }

      const notCovered = ["workflow schemes: Jira DC cannot list workflow schemes, so ones no project uses are not visible (GET /workflowscheme answers 405)"];
      const notes = [
        "Candidates still referenced elsewhere (a scheme in an unused scheme, a workflow in a draft or unused workflow scheme, a screen in an unused screen scheme) cannot be deleted until that reference is removed.",
      ];
      if (want("workflow")) notes.push("Workflow usage comes from the shared project scan, which lists non-archived projects only.");
      return { categories, notCovered, notes };
    },
  },
  {
    name: "jira_report_license_usage",
    product: "jira",
    description:
      "License consumption per application (Software, Service Management...): seats, users, remaining seats, and members of " +
      "the application's groups who are inactive, never logged in, or did not log in for stale_days (default 90). Reads " +
      `group members and each active member's last login, up to max_users unique users per application (default ${MAX_USERS_DEFAULT}, ` +
      `max ${MAX_USERS}); a cut scan says truncated. Usernames and display names only, no e-mail addresses. Read-only.`,
    inputShape: {
      application: z.string().optional().describe("Application role key (e.g. jira-software); default all"),
      stale_days: z.coerce.number().int().min(1).max(3650).optional().describe("Days without login that count as stale (default 90)"),
      max_users: z.coerce.number().int().min(1).max(MAX_USERS).optional().describe(`Unique group members checked per application (default ${MAX_USERS_DEFAULT}, max ${MAX_USERS})`),
      max_per_list: capShape("Users", LIST_DEFAULT),
    },
    async handler({ client }, args) {
      const c = client("jira");
      const roles: any[] = (await c.get(`${API}/applicationrole`)) ?? [];
      const selected = args.application ? roles.filter((r) => r.key === args.application) : roles;
      if (args.application && !selected.length) {
        throw new ValidationError(`No application '${args.application}'; known: ${roles.map((r) => r.key).join(", ")}`);
      }
      const staleDays = args.stale_days ?? 90;
      const maxUsers = args.max_users ?? MAX_USERS_DEFAULT;
      const listCap = args.max_per_list ?? LIST_DEFAULT;
      const now = Date.now();
      // one lookup per user across all applications
      const lookups = new Map<string, Promise<any | null>>();
      const lookup = (name: string) => {
        let p = lookups.get(name);
        if (!p) {
          p = c.get(`${API}/user`, { username: name }).catch((e) => {
            if (isHttpStatusError(e)) return null;
            throw e;
          });
          lookups.set(name, p);
        }
        return p;
      };
      const list = <T>(items: T[]) => ({ count: items.length, users: items.slice(0, listCap) });

      const out = [];
      for (const r of selected) {
        const members = new Map<string, any>();
        let truncated = false;
        for (const g of r.groups ?? []) {
          const page = await c.getPagedResult(`${API}/group/member`, "values", { groupname: g, includeInactiveUsers: true }, 50, maxUsers);
          if (page.truncated) truncated = true;
          for (const u of page.items as any[]) if (u?.name && !members.has(u.name)) members.set(u.name, u);
          if (members.size >= maxUsers) {
            if (members.size > maxUsers || (r.groups ?? []).indexOf(g) < (r.groups ?? []).length - 1) truncated = true;
            break;
          }
        }
        const checked = [...members.values()].slice(0, maxUsers);
        const inactive = checked.filter((u) => u.active === false);
        const active = checked.filter((u) => u.active !== false);
        const details = await boundedAll(active.map((u) => () => lookup(u.name)), 4);
        const never: Array<{ username: string; displayName?: string }> = [];
        const stale: Array<{ username: string; displayName?: string; lastLogin: string; daysSinceLogin: number }> = [];
        let lookupErrors = 0;
        active.forEach((u, i) => {
          const d = details[i];
          if (!d) { lookupErrors++; return; }
          const t = parseJiraTime(d.lastLoginTime);
          if (t === null) { never.push({ username: u.name, displayName: u.displayName }); return; }
          const days = Math.floor((now - t) / DAY_MS);
          if (days >= staleDays) stale.push({ username: u.name, displayName: u.displayName, lastLogin: new Date(t).toISOString().slice(0, 10), daysSinceLogin: days });
        });
        stale.sort((a, b) => b.daysSinceLogin - a.daysSinceLogin || a.username.localeCompare(b.username));
        out.push({
          key: r.key,
          name: r.name,
          numberOfSeats: r.numberOfSeats,
          userCount: r.userCount,
          remainingSeats: r.remainingSeats,
          hasUnlimitedSeats: r.hasUnlimitedSeats || undefined,
          groups: r.groups ?? [],
          members: members.size > maxUsers ? undefined : members.size,
          checkedMembers: checked.length,
          truncated: truncated || undefined,
          inactive: list(inactive.map((u) => ({ username: u.name, displayName: u.displayName }))),
          neverLoggedIn: list(never),
          stale: { days: staleDays, ...list(stale) },
          lookupErrors: lookupErrors || undefined,
        });
      }
      return {
        roles: out,
        note: "Inactive users do not consume seats; never/stale lists cover active members only. A cut scan (truncated) leaves members unchecked.",
      };
    },
  },
  {
    name: "jira_instance_health",
    product: "jira",
    description:
      "Instance health overview: failing health checks first (name, severity, application, short reason) with counts, " +
      "cluster node states and index consistency (database vs index issue counts). A part that cannot be read is shown " +
      "as an error. Read-only; the support zip is not available through REST on Jira 11.3.",
    inputShape: {
      include_healthy: boolArg.optional().describe("Also list the names of healthy checks (default: count only)"),
    },
    async handler({ client }, args) {
      const c = client("jira");
      const [checks, nodes, index] = await Promise.all([
        settle(c.get("/rest/troubleshooting/1.0/check/")),
        settle(c.get(`${API}/cluster/nodes`)),
        settle(c.get(`${API}/index/summary`)),
      ]);
      const out: Record<string, unknown> = {};
      if ((checks as any)?.error) {
        out.checks = { error: (checks as any).error };
      } else {
        const statuses: any[] = (checks as any)?.statuses ?? [];
        const enabled = (s: any) => s.isEnabled !== false && s.enabled !== false;
        const healthy = (s: any) => s.isHealthy === true || s.healthy === true;
        const failing = statuses.filter((s) => enabled(s) && !healthy(s));
        failing.sort((a, b) =>
          (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) || String(a.name).localeCompare(String(b.name)));
        out.counts = {
          total: statuses.length,
          healthy: statuses.filter((s) => enabled(s) && healthy(s)).length,
          failing: failing.length,
          disabled: statuses.filter((s) => !enabled(s)).length,
        };
        out.failing = failing.map((s) => ({
          name: s.name,
          severity: s.severity && s.severity !== "undefined" ? s.severity : undefined,
          application: s.application || undefined,
          failureReason: cut(s.failureReason, REASON_MAX) || undefined,
        }));
        if (args.include_healthy) out.healthy = statuses.filter((s) => enabled(s) && healthy(s)).map((s) => s.name);
      }
      if ((nodes as any)?.error) out.cluster = { error: (nodes as any).error };
      else {
        const list: any[] = Array.isArray(nodes) ? nodes : [];
        const notActive = list.filter((n) => n.state !== "ACTIVE" || n.alive === false).map((n) => ({ nodeId: n.nodeId, state: n.state, alive: n.alive }));
        out.cluster = { nodes: list.length, active: list.length - notActive.length, notActive };
      }
      if ((index as any)?.error) out.index = { error: (index as any).error };
      else {
        const i = (index as any)?.issueIndex ?? {};
        out.index = {
          indexReadable: i.indexReadable,
          countInDatabase: i.countInDatabase,
          countInIndex: i.countInIndex,
          countInArchive: i.countInArchive,
          consistent: i.indexReadable !== false && i.countInDatabase === i.countInIndex,
          lastUpdatedInDatabase: i.lastUpdatedInDatabase,
          lastUpdatedInIndex: i.lastUpdatedInIndex,
        };
      }
      return out;
    },
  },
];
