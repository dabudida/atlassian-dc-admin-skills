# Proposal

## Why

Administrators of large Jira Data Center instances regularly need to find configuration that nobody uses (custom fields, schemes, workflows, screens), see how application licenses are consumed, and get a quick health overview before an upgrade or an audit. Today this takes many separate tool calls, and the agent has to join the results itself, which costs tokens and is easy to get wrong (for example, presenting a partial project scan as complete).

## What Changes

- Add four read-only report tools in `src/tools/jira/hygiene.ts` (exported as `jiraHygieneTools`):
  - `jira_report_unused_custom_fields`: custom fields without values, screens or contexts, from the paged `/rest/api/2/customFields` usage statistics; locked and managed fields are excluded.
  - `jira_report_unused_schemes`: permission, notification, issue security, issue type and priority schemes no project uses, inactive workflows and (opt-in) screens no project or workflow uses. Reuses the cached workflow-usage and screen-usage scans.
  - `jira_report_license_usage`: per application role seats, users and remaining seats, plus members of the role's groups who are inactive, never logged in or did not log in for N days. Bounded member scan with a hard cap and explicit truncation; no e-mail addresses.
  - `jira_instance_health`: failing health checks first (from `/rest/troubleshooting/1.0/check/`), counts, cluster node state and index consistency.
- Every report is bounded (scan caps, request budgets, list caps) and states when it is incomplete.

## Capabilities

### New Capabilities

- `jira-instance-hygiene-reports`: read-only, bounded reports on unused configuration, license consumption and instance health.

### Modified Capabilities

None. The reports reuse the existing workflow-usage and screen-usage scans (`jira-usage-scans`) without changing them.

## Impact

- New file `src/tools/jira/hygiene.ts` and `test/unit/hygiene.test.ts`; the integrator registers `jiraHygieneTools` in `src/tools/index.ts`.
- GET requests only. The support zip (`/rest/troubleshooting/1.0/support-zip/...`) answers 404 on Jira 11.3 and is out of scope.
