# Design

## Context

Jira DC 10 moved webhooks to the jira-webhook plugin. On the 11.3.7 instance `GET /rest/webhooks/1.0/webhook` returns the login page for a personal access token, while `GET /rest/jira-webhook/1.0/webhooks` returns a JSON array.

## Evidence (GET only)

- `rest/jira-webhook/1.0/application.wadl` (11.3.7): `webhooks` GET (`event`, `statistics`, `start`, `limit` default 10000) and POST (JSON); `webhooks/{webhookId}` GET (`statistics`), PUT (JSON) and DELETE; plus read-only `statistics`, `latest` and `transitions` sub-resources.
- The admin page web resource (`atl.plugins.webhooks.admin`) defines the model the UI saves: `{name, url, events[], active, scopeType: "global", configuration: {FILTERS, DESCRIPTION, EXCLUDE_BODY, SECRET}}`. On submit it sets `FILTERS` (the issue-event JQL), `DESCRIPTION` and `SECRET` only when non-empty and `EXCLUDE_BODY` always as the string `"true"`/`"false"`. Enable/disable only toggles `active` and is saved with the same full-model PUT.
- The event keys the 11.3.7 admin page offers (issue, comment, issue link, worklog, version, project, user, board, sprint and option events).

No webhook existed on the instance, so a live read of a populated webhook was not possible; the reader therefore also accepts the legacy field names (`enabled`, `filters["issue-related-events-section"]`, `excludeBody`).

## Decisions

### Reads

`jira_list_webhooks` reads one bounded list (`limit=1000`, `event` passed to the server), filters by name fragment and pages locally; it returns id, name, masked URL, enabled, events (first five plus count), JQL, excludeBody and hasSecret, and reports truncation at the cap. `jira_get_webhook` resolves a numeric id through `GET /{id}` or an exact name through the list and returns all events, description, scope and updated time. URL masking replaces user info with `***@`, masks query values whose names look sensitive (token, secret, key, password, auth, signature, credential, session, code) or whose values look like tokens, replaces token-like path segments with `***` (a run of 16+ `[A-Za-z0-9_-]` characters with a digit or mixed case, or 32+ long; this covers Slack, Teams and Discord hook tokens while keeping word paths such as `jira-webhook-receiver`), and drops the fragment. The secret is never returned.

### Writes

- Create: `POST` the admin-page body. An existing webhook with the same exact name or URL and the same settings (secret compared only when given) is already-satisfied; the same name or URL with other settings is an error pointing to `jira_update_webhook`. Unknown event keys are warnings, not errors (apps can add events). After the write the webhook is found by name and URL and compared.
- Update: merge the given fields into the current webhook (stored secret kept unless replaced, empty `jql`/`description` remove them) and `PUT` the full model including `id`. The dry run shows before/after (masked). Read back through `GET /{id}`.
- Set enabled: same full-model `PUT` with another `active`; the same state is already-satisfied.
- Delete: `DELETE /{id}`; a missing webhook is already-satisfied; the summary states the target, state and event count and that the deletion is irreversible; verified by a 404 on read-back.

Dry runs and results echo the request with the URL and `SECRET` masked; the real values are sent only on execution. Writes invalidate no cached scan.

**Secret read-back assumption (unverified).** No live instance with a secret was available, so it is unknown whether `GET` returns `configuration.SECRET` in plain text. The full-model PUT needs the stored secret, so: a plain value read back is reused; a value made only of mask characters (`*`, `•`), or a bare `hasSecret`/`secretSet` flag without a value, is never written back. Update and enable/disable then fail with a validation error asking for `secret` (enable/disable accepts an optional `secret` for this). Read-back verification compares the secret only when it comes back in plain text. If Jira omitted SECRET entirely without any flag while one is set, the tool cannot know, and a PUT might drop it; check `hasSecret` before and after on the first live write.

**Plans.** Change plans store arguments in plain text, so the webhook writes declare `sensitiveArgs` (`secret`; `url` when it carries credentials). `--plan` is refused for such a call (run it with dry_run=false, through the CLI confirmation) and re-plan hints print `<redacted>`.

## Risks / Trade-offs

- The body shape comes from the admin UI rather than published REST docs → read-back verification turns any server-side difference into a verification error.
- Some instances may still serve the legacy plugin → out of scope; it does not accept a PAT on DC 11.
- Masking is heuristic for query parameter names → user info and common credential names are covered; full URLs are never needed in output.

## Migration Plan

Register `jiraWebhookTools` (suggested group "Jira webhooks"), add `jira_get_webhook` to the read-bound single-entity exceptions, regenerate docs/bundle. Rollback removes the file and registration.

## Local Implementation Evidence (2026-10-11)

13 unit tests (in-memory jira-webhook resource) cover masking, filters/paging, dry-run masking, real-secret sending, idempotency, conflicts, update merge, enable/disable, delete and verification failures. Live 11.3.7 with a GET-only fetch guard: list (0 webhooks), get of a missing id, and a create dry run; no write was sent.
