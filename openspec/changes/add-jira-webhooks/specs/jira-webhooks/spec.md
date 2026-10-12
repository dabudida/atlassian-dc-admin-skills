# Spec Delta

## Purpose

Read and manage Jira DC webhooks through the jira-webhook REST resource with credentials and secrets masked.

## ADDED Requirements

### Requirement: List and read webhooks with secrets masked
The system SHALL provide `jira_list_webhooks` (bounded, paged, filterable by name fragment and event key) and `jira_get_webhook` (numeric id or exact name) using `/rest/jira-webhook/1.0/webhooks`. Rows SHALL contain id, name, URL, enabled state, events, JQL filter, excludeBody and whether a secret is set. URL user info, sensitive-looking query values and token-like path segments (as Slack, Teams and Discord hooks use) SHALL be masked, the URL fragment SHALL be dropped, and the secret value SHALL never be returned.

#### Scenario: Credentials in a webhook URL
- **WHEN** a webhook URL contains `user:password@` or a `token` query parameter and the webhook has a secret
- **THEN** the output shows `***` for those parts and `hasSecret: true`, and contains none of the original values

### Requirement: Create webhooks idempotently
The system SHALL provide `jira_create_webhook` that sends `{name, url, events, active, scopeType, configuration: {FILTERS, DESCRIPTION, SECRET, EXCLUDE_BODY}}`. The dry run SHALL echo the body with the URL and secret masked. A webhook with the same exact name or URL and the same settings SHALL be already-satisfied; the same name or URL with other settings SHALL be an error pointing to the update tool. After execution the webhook SHALL be read back and compared.

#### Scenario: Re-run after creation
- **WHEN** the same create is run again
- **THEN** the tool reports already-satisfied and sends nothing

### Requirement: Update, enable/disable and delete webhooks
The system SHALL update a webhook by merging given fields into the full current model (keeping the stored secret unless replaced) and sending a PUT, SHALL enable or disable it with the same full-model PUT, and SHALL delete it by id. Unchanged state SHALL be already-satisfied, a missing webhook on delete SHALL be already-satisfied, dry runs SHALL show before/after values masked, and every executed write SHALL be verified by reading the webhook back.

#### Scenario: Disable a webhook
- **WHEN** an enabled webhook is disabled with dry_run=false
- **THEN** the PUT carries the full model with `active: false` and the read-back shows it disabled

#### Scenario: Secret returned masked
- **WHEN** Jira returns a webhook's stored secret only masked and an update or enable/disable is requested without `secret`
- **THEN** the tool fails with a validation error asking for the secret and sends no write

#### Scenario: Write not applied
- **WHEN** the server accepts a write but the webhook reads back unchanged
- **THEN** the tool fails with a verification error

### Requirement: Webhook secrets never reach plan files
The webhook write tools SHALL declare `secret` and `url` as sensitive arguments (a URL only when it carries user info, a sensitive or token-like query value, a token-like path segment or a fragment). Recording such a write in a change plan with `--plan` SHALL be refused with a validation error that tells the user to run the tool directly with dry_run=false, and a printed re-plan command SHALL show `<redacted>` instead of a sensitive value.

#### Scenario: Planning a webhook with a secret
- **WHEN** `jira_create_webhook` with a `secret` is run with `--plan`
- **THEN** nothing is written to the plan file and the error names dry_run=false as the way to apply it

