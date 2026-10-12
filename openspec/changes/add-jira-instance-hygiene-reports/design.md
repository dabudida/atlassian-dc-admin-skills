# Design

## Context

Verified on Jira DC 11.3.7 with GET requests:
- `/rest/api/2/customFields` pages by page number (`startAt` is 1-based) and returns `issuesWithValue`, `projectsCount`, `screensCount`, `isAllProjects`, `isLocked`, `isManaged`; there is no `lastValueUpdate` on 11.3.
- `/rest/api/2/permissionscheme`, `/notificationscheme` (paged), `/issuesecurityschemes`, `/issuetypescheme` (plus `/{id}/associations`), `/priorityschemes?expand=schemes.projectKeys` (paged, `defaultScheme`), `/workflow` (all workflows, `default` flag) and `/screens` list the objects.
- Project usage of permission, notification and issue security schemes is only readable per project (`/project/{key}/permissionscheme`, `/notificationscheme`, `/issuesecuritylevelscheme`). A 404 means none for notification and issue security schemes on live projects; every project has a permission scheme, so a 404 there means unreadable, and a 404 on an archived project is ambiguous and also counts as unreadable.
- `GET /rest/api/2/workflowscheme` answers 405: DC cannot list all workflow schemes, so unused workflow schemes cannot be found (the existing scan only sees schemes projects use).
- `/rest/api/2/applicationrole` returns `numberOfSeats`, `remainingSeats`, `userCount`, `hasUnlimitedSeats`, `groups`; `/group/member` does not return `lastLoginTime`, `GET /user?username=` does.
- `/rest/troubleshooting/1.0/check/` returns `statuses[]` with `name`, `isHealthy`, `failureReason`, `severity`, `application`, `isEnabled`; `/cluster/nodes` and `/index/summary` exist on DC.

## Goals / Non-Goals

**Goals:** compact, bounded, honest reports that an agent can act on. **Non-Goals:** deleting anything, support zips, new caching layers, workflow scheme discovery beyond what projects use.

## Decisions

### Reuse existing scans, no new cache

Workflows are inactive when `workflowUsage()` (the cached `workflow-usage` scan from `workflowSchemes.ts`) finds no scheme in use that maps them. Screens use `screenUsageScan()` and `allScreens()` from `screens.ts`, plus transition screens of every workflow (`loadModel()` from `workflows.ts`). The per-project scheme scan for permission, notification and issue security schemes is new but runs once per report call; `ScanKind` is not extended because no write tool would invalidate it within a run and the file is shared.

### Bounds

- Custom fields: `max_scan` default 2,000, max 5,000; result list paged (`limit` default 50, max 500).
- Schemes: `scan_projects` default 500, max 2,000; `max_requests` request budget (default 3 per scanned project plus one per issue type scheme, max 20,000); each category shows at most `max_per_type` (default 50, max 500) candidates plus a total. Screens are opt-in (`types=screen`) because the screen-usage scan costs up to 40 requests per project. With screens, the budget also covers the screen scan and up to 1,000 workflow loads (default adds 40 per screen-scanned project plus 1,000): workflow loads are reserved first and the screen scan gets the rest; skipped loads make the category incomplete.
- License: `max_users` default 500, hard cap 5,000 unique group members; lists capped by `max_per_list` (default 50, max 500). Only usernames, display names and last-login dates are returned.
- Health: failure reasons cut to 200 characters; healthy checks only as a count unless `include_healthy=true`.

### Honest completeness

Every category carries `complete`. A project cap, an exhausted request budget, unreadable projects (403, a 404 permission scheme, a 404 on an archived project) or an incomplete reused scan make it `complete: false` with a reason; for workflows, project workflow schemes answering 404 and archived projects (not part of the shared scan) do too. Non-HTTP errors fail the report; candidates are still listed but marked as unverified. System defaults (permission scheme id 0, issue type scheme id 10000, the default priority scheme, the default workflow) are never candidates.

### License semantics

For each role, the union of the role's group members (inactive included) is read; inactive members are counted (they do not consume seats). Active members are looked up one by one for `lastLoginTime`; a missing value means "never logged in". `stale_days` (default 90) separates stale from recent. When the cap is hit the role says `truncated: true` and how many members were checked.
