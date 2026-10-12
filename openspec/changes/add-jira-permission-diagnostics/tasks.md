# Tasks

## 1. Explain a permission

- [x] 1.1 Write failing tests in `test/unit/permissionDiagnostics.test.ts` (grant matching per holder type, legacy aliases, exact-match ground truth, disagreement note, unavailable ground truth, issue holders and security level, inactive/unlicensed users, project_key or issue_key required, moved issue). Verify they fail because the module is missing.
- [x] 1.2 Implement `jira_explain_permission` in `src/tools/jira/permissionDiagnostics.ts` with the legacy-name map, grant evaluation, ground truth paging and verdict/agreement logic; verify the tests pass.

## 2. User access summary

- [x] 2.1 Write failing tests for explicit projects, paging over all projects, role filtering and the request budget.
- [x] 2.2 Implement `jira_user_access_summary` with one global role read, projects × roles reads under the 200-request budget and per-project errors; verify the tests pass.

## 3. Verification

- [x] 3.1 Typecheck the new files and run `openspec validate add-jira-permission-diagnostics --strict`.
- [x] 3.2 Verify both tools live with GET only (own user, one project and one issue); the ground truth and the computed verdict agree.
- [ ] 3.3 Integrator: register `jiraPermissionDiagnosticTools` in `src/tools/index.ts`, regenerate the reference and mention the tools in the skill docs.
