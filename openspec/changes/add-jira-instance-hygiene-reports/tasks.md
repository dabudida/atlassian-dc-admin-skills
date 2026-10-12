# Tasks

## 1. Unused custom fields

- [x] 1.1 Write failing tests in `test/unit/hygiene.test.ts` for candidates, locked/managed exclusion, sorting, page-number paging and scan truncation.
- [x] 1.2 Implement `jira_report_unused_custom_fields` in `src/tools/jira/hygiene.ts` and verify the tests pass.

## 2. Unused schemes, workflows and screens

- [x] 2.1 Write failing tests for unused permission/notification/issue security/issue type/priority schemes, inactive workflows (reused workflow scan), protected defaults, the request budget marking a category incomplete and opt-in screens.
- [x] 2.2 Implement `jira_report_unused_schemes` reusing `workflowUsage`, `screenUsageScan`, `allScreens` and `loadModel`; verify the tests pass.
- [x] 2.3 Write failing tests, then fix completeness: 404 permission scheme as unreadable, archived-project 404s, workflow 404s and archived projects, screen scan and workflow loads within `max_requests`, non-HTTP workflow load errors re-thrown.

## 3. License usage

- [x] 3.1 Write failing tests for seats, inactive/never/stale members, de-duplication across groups, the member cap with truncation and absence of e-mail addresses.
- [x] 3.2 Implement `jira_report_license_usage`; verify the tests pass.

## 4. Instance health

- [x] 4.1 Write failing tests for failing checks first, counts, cut failure reasons, and cluster/index summaries that degrade to errors without failing the report.
- [x] 4.2 Implement `jira_instance_health`; verify the tests pass.

## 5. Verification

- [x] 5.1 Typecheck the new files and run the report tools live (GET only) through a scratch script; record observations in the report.
- [x] 5.2 `openspec validate add-jira-instance-hygiene-reports --strict` passes.
