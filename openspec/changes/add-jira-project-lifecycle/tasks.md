# Tasks

Follow TDD per group: write the failing test in `test/unit/projectLifecycle.test.ts`, see it fail, implement in `src/tools/jira/projectLifecycle.ts`, see it pass. Live checks are GET/dry-run only.

## 1. Evidence

- [x] 1.1 Grep projects.ts, projectSchemes.ts, adminLifecycle.ts and projectMeta.ts for existing archive/restore, scheme assignment, versions and component reads; scope out duplicates.
- [x] 1.2 Confirm routes in the 11.3.7 `rest/api/2` and project-templates WADLs; confirm the `createshared` body and answer in the dialog web resource; probe `projectvalidate/key` answers.

## 2. Projects

- [x] 2.1 Tests and implementation for `jira_create_project`: body, key/name/lead/type validation, existing-key satisfied/error, `from_project` copy and override, read-back of project and scheme ids.
- [x] 2.2 Tests and implementation for `jira_update_project`: changed-fields body, before/after, already-satisfied, read-back verification.

## 3. Categories

- [x] 3.1 `jira_list_project_categories` with project counts and paging.
- [x] 3.2 Create/update/delete category writes with idempotency, project impact in the delete summary and read-back.

## 4. Components

- [x] 4.1 Create/update/delete component writes; delete with issue count and validated `move_issues_to`; read-back.

## 5. Shared configuration

- [x] 5.1 `jira_create_project_shared` with validation, already-satisfied on an existing shared project and verification of shared schemes.

## 6. Verification

- [x] 6.1 `node --import tsx --test test/unit/projectLifecycle.test.ts` passes; `npx tsc --noEmit` reports no errors in the new file.
- [x] 6.2 Live GET-only checks and dry runs on the 11.3.7 instance; no write sent.
- [ ] 6.3 Integrator: register `jiraProjectLifecycleTools`, add `jira_list_project_categories` to read-bound/docs coverage as needed, regenerate the reference and bundle.
