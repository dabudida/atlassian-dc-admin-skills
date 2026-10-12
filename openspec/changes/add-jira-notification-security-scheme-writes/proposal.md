# Proposal

## Why

Administrators can read notification schemes and issue security schemes (`jira_get_notification_scheme`, `jira_get_issue_security_scheme`) but cannot plan changes to them. Jira DC 11.3 publishes no REST write for notification scheme contents, issue security schemes, levels or level members, so the tools must say honestly which changes go through REST and which must be made in the UI, without inventing endpoints.

## What Changes

- Add `src/tools/jira/schemeWrites.ts` exporting `jiraSchemeWriteTools`.
- Manual (UI-only) write tools that check the current state, return `already_satisfied` when it already holds, and otherwise return a plan item with `request.method: "MANUAL"`, the websudo-protected admin page and exact steps: `jira_create_notification_scheme`, `jira_add_notification`, `jira_remove_notification`, `jira_create_issue_security_scheme`, `jira_add_issue_security_level`, `jira_add_issue_security_level_member` (declared `unverifiable`: no REST read of members exists).
- One REST write: `jira_assign_issue_security_scheme` through `PUT /rest/api/2/project/{key}` with `issueSecurityScheme`, read back through `GET /rest/api/2/project/{key}/issuesecuritylevelscheme`; a switch while issues carry security levels becomes a manual change.
- A shared helper `src/tools/jira/manualSteps.ts` for manual plan items with steps (also used by `add-jira-priorities-resolutions`).

## Capabilities

### New Capabilities

- `jira-notification-security-scheme-writes`: planning notification scheme and issue security scheme changes, with an honest REST/manual split.

### Modified Capabilities

None. Assigning a notification scheme to a project stays in `jira_assign_project_scheme` (`jira-project-scheme-assignment`).

## Impact

New files only: the tool module, the manual-step helper and `test/unit/jiraSchemeWrites.test.ts`. The integrator registers `jiraSchemeWriteTools` in `src/tools/index.ts` and documents the tools in the skill reference. No dependency or configuration change.
