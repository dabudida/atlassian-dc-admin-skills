# Proposal

## Why

Webhooks are configured only in the Jira admin UI. Administrators cannot list them with masked credentials, audit their filters, or create, change, enable/disable and delete them reproducibly and safely from the toolkit.

## What Changes

- Add read tools `jira_list_webhooks` (compact, paged, name/event filter) and `jira_get_webhook` (id or exact name). URL user info and sensitive-looking query values are masked; the signing secret is reduced to `hasSecret`.
- Add write tools `jira_create_webhook`, `jira_update_webhook`, `jira_set_webhook_enabled` and `jira_delete_webhook` on the Jira DC 10+ jira-webhook REST resource (`/rest/jira-webhook/1.0/webhooks`), dry-run by default, idempotent by exact name/URL, and verified by reading back.
- Do not use the legacy `/rest/webhooks/1.0/webhook` route: on 11.3.7 it answers a personal access token with the login page.

## Capabilities

### New Capabilities

- `jira-webhooks`: read and manage Jira DC webhooks with secrets masked.

### Modified Capabilities

None.

## Impact

New `src/tools/jira/webhooks.ts` exporting `jiraWebhookTools` and `test/unit/webhooks.test.ts`. The integrator registers the array, adds `jira_get_webhook` to the single-entity read-bound exceptions, and regenerates docs/bundle. No new dependency.
