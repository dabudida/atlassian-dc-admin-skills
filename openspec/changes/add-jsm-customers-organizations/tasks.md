# Tasks

Work in `src/tools/jira/jsmCustomers.ts` and `test/unit/jsmCustomers.test.ts` only. For each group write the failing test first, verify the failure, implement, and rerun.

## 1. Organization reads

- [x] 1.1 Test and implement `jira_list_organizations` (server-side paging, compact `{id, name}` rows) and `jira_list_service_desk_organizations` (service desk id or project key).
- [x] 1.2 Test and implement `jira_get_organization` by id or exact name with a page of compact users; an ambiguous name raises a ValidationError.

## 2. Organization writes

- [x] 2.1 Test and implement `jira_create_organization` (existing name → already-satisfied; read back by name) and `jira_delete_organization` (irreversible summary, linked desk count; missing → already-satisfied; read back as gone).
- [x] 2.2 Test and implement `jira_add_organization_users` and `jira_remove_organization_users` (only missing/present usernames are sent; nothing to do → already-satisfied; members read back).
- [x] 2.3 Test and implement `jira_add_service_desk_organizations` (one POST per missing organization) and `jira_remove_service_desk_organization`, both read back from the desk links.

## 3. Customers

- [x] 3.1 Test and implement `jira_add_service_desk_customers` with the "Service Desk Customers" role as pre-check and read-back; a missing role yields `verification: "unverifiable"`.
- [x] 3.2 Test and implement `jira_remove_service_desk_customers` through the role actor; non-direct users are reported and skipped; no role → ValidationError.
- [x] 3.3 Test and implement `jira_create_customer` (`fullName` body, existing user → already-satisfied, read back by username).

## 4. Verification

- [x] 4.1 Run `node --import tsx --test test/unit/jsmCustomers.test.ts` and typecheck the new files.
- [x] 4.2 Verify read tools live with GET only and write tools as dry runs; record results in the report.
- [x] 4.3 Run `openspec validate add-jsm-customers-organizations --strict`.
