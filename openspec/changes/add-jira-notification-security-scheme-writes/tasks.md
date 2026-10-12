# Tasks

Read-only toward the live instance (WADL and GETs; dry runs only). New files only; registration in `src/tools/index.ts` is left to the integrator.

## 1. Research

- [x] 1.1 Fetch `/rest/api/2/application.wadl` and list every notification scheme, issue security scheme and project route; record that only reads exist.
- [x] 1.2 Probe candidate internal routes with GET (`/notificationscheme/{id}/notification`, `/issuesecurityschemes/{id}/level`) and the admin forms; record 404s and websudo prompts in design.md.

## 2. Implementation (TDD)

- [x] 2.1 Write `test/unit/jiraSchemeWrites.test.ts` against a fake Jira; verify it fails because the module does not exist.
- [x] 2.2 Add `src/tools/jira/manualSteps.ts` (`manualStep`, MANUAL item with steps; `Unsupported` on execution).
- [x] 2.3 Add `src/tools/jira/schemeWrites.ts` with the notification tools (already-satisfied check, MANUAL item, role/event resolution, parameter validation).
- [x] 2.4 Add the issue security scheme, level and level-member tools (member tool declared unverifiable).
- [x] 2.5 Add `jira_assign_issue_security_scheme` (PUT with read-back, manual when secured issues exist); run the tests and the typecheck for the new files.

## 3. Verification

- [x] 3.1 Live, GET only: dry runs of the notification and issue security tools with all non-GET requests blocked.
- [x] 3.2 `openspec validate add-jira-notification-security-scheme-writes --strict`.
- [ ] 3.3 Integrator: register `jiraSchemeWriteTools`, document the tools, run the full suite and build.
