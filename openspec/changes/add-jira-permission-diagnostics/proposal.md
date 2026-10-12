# Proposal

## Why

"Why can't this user see / create / transition in this project?" is one of the most frequent Jira DC admin questions. Answering it today needs several tools (user, permission scheme, project roles, issue) and manual reasoning, and the reasoning can silently be wrong (custom-field holders, plugin permissions, issue security). Jira itself can answer the yes/no question, but not the why.

## What Changes

- Add read-only `jira_explain_permission`: for a user, a project permission (scheme key or legacy alias) and a project or issue, report Jira's own answer (ground truth via `/rest/api/2/user/permission/search`), the project's permission scheme, every grant of that permission with whether it matches the user and why, the user's active state and application access, and for an issue its security level. Disagreements between the computed explanation and the ground truth are reported explicitly, never guessed away.
- Add read-only `jira_user_access_summary`: one user's active state, last login, groups, application access and project roles (direct or via group) across a bounded, paged list of projects with a documented request budget.
- Both tools live in `src/tools/jira/permissionDiagnostics.ts` and export `jiraPermissionDiagnosticTools`.

## Capabilities

### New Capabilities

- `jira-permission-diagnostics`: explain a user's effective project permission and summarise a user's access.

### Modified Capabilities

None.

## Impact

New `src/tools/jira/permissionDiagnostics.ts` and `test/unit/permissionDiagnostics.test.ts`. The integrator registers the array in `src/tools/index.ts` and regenerates the reference. GET requests only; no new dependency.
