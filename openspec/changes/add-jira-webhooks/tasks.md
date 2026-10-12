# Tasks

Follow TDD: failing test in `test/unit/webhooks.test.ts`, then implementation in `src/tools/jira/webhooks.ts`. Live checks are GET/dry-run only.

## 1. Evidence

- [x] 1.1 Confirm the jira-webhook routes in its 11.3.7 WADL and that the legacy route answers a PAT with the login page.
- [x] 1.2 Derive the payload and enable/disable behavior from the admin page web resource; collect the offered event keys.

## 2. Reads

- [x] 2.1 `jira_list_webhooks`: bounded read, name/event filters, local paging, compact masked rows.
- [x] 2.2 `jira_get_webhook`: id or exact name, full masked view; ambiguous names fail.

## 3. Writes

- [x] 3.1 `jira_create_webhook`: masked dry run, idempotency by exact name/URL, conflict error, unknown-event warnings, read-back.
- [x] 3.2 `jira_update_webhook`: full-model merge keeping the stored secret, before/after, read-back.
- [x] 3.3 `jira_set_webhook_enabled`: full-model PUT with another `active`, already-satisfied, read-back.
- [x] 3.4 `jira_delete_webhook`: irreversible summary, already-satisfied when missing, 404 read-back.

## 4. Verification

- [x] 4.1 `node --import tsx --test test/unit/webhooks.test.ts` passes; no typecheck errors in the new file.
- [x] 4.2 Live GET-only list/get and a create dry run on 11.3.7; no write sent.
- [ ] 4.3 Integrator: register `jiraWebhookTools`, add `jira_get_webhook` to read-bound exceptions, regenerate docs and bundle.
