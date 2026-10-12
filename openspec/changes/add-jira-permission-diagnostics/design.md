# Design

## Context

Existing readers (`readUser` in users.ts, `schemeGrants`/`holderLabel` in schemes.ts, `roleActors` in projects.ts) are module-private. To keep file ownership strict, small local equivalents are used; exporting the originals later is a safe refactor.

Probed on Jira DC 11.3 (GET): `/rest/api/2/user/permission/search` accepts only legacy permission names (`BROWSE`, `CREATE_ISSUE`, `TRANSITION_ISSUE`, `PROJECT_ADMIN`, `COMMENT_ISSUE`...) and answers 400 for scheme keys (`BROWSE_PROJECTS`...) and for plugin permissions without a legacy id (`BROWSE_ARCHIVE`, `MANAGE_SPRINTS_PERMISSION`, `VIEW_DEV_TOOLS`...). Its `username` parameter is a search text, so the result must be matched exactly. `issueKey` instead of `projectKey` applies issue-level checks (issue security, issue roles). There is no public REST endpoint for issue security level members.

## Decisions

### Ground truth first, explanation second

The verdict is the ground truth when it is definite (granted/denied). The computed verdict (from grants) is `granted`, `denied`, `conditional` (only issue-dependent holders match, no issue given) or `unknown`. `agreement` is `agree`, `disagree`, `computed-inconclusive` or `unavailable`. When the ground truth is unavailable (400 for the permission name, or the user not found among the first 500 search matches), the verdict falls back to a definite computed verdict, otherwise `unknown`.

### Permission names

A static map translates scheme keys to legacy names and back; input in either spelling (any case) is normalised to the scheme key for grant matching and to the legacy name for the search. Unknown keys pass through unchanged.

### Grant evaluation

Per holder type: `anyone` → yes; `applicationRole` (empty = any logged-in user with application access, else that application); `group` (user's groups; partial group lists give unknown instead of no); `user` (name or key); `projectLead`; `projectRole` (actors of that role in the project: user actors directly, group actors via the user's groups; roles are read only for the grants of the asked permission); `reporter`/`assignee` and `userCustomField`/`groupCustomField` → conditional without an issue, evaluated against issue field values with one. Any other holder type (e.g. JSM `sd.customer.portal.only`) is `unknown` and is named when a disagreement occurs.

### Issue security

The issue's `security` field is reported. Membership cannot be read via REST, so it is inferred: `granted-by-ground-truth` when Jira grants the permission on the issue, `likely-not` when the scheme grants it but Jira denies it on the issue, otherwise `unknown`; `no-level` when the issue has none.

### Access summary budget

Roles are listed once (`/rest/api/2/role`); every project has every global role, so one request per project and role is made (no per-project role-link reads) with bounded concurrency. Default page 20 projects, max 50; the page shrinks so that projects × roles ≤ 200 requests, and `roles=` narrows it. Failed role reads become a per-project `error`, not a failed call. Groups use the shared preview cap (`full_lists=true` for all).

## Risks / Trade-offs

- The legacy-name map may miss plugin permissions → the ground truth is then marked unavailable and the computed verdict is labelled as such.
- Internal `/rest/projectconfig/latest/roles/{key}` would give one request per project but is undocumented; the public API is used.
- Users with more groups than Jira lists are handled as partial (unknown instead of no).

## Migration Plan

Additive read-only tools; rollback removes the file and its registration.
