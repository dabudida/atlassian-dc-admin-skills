# Proposal

## Why

Agents and administrators working a JSM request need the request's service desk view: request type, status history, participants, approvals, public versus internal comments, SLA state and customer satisfaction. The skill only exposes generic Jira issue tools (`jira_get_issue`, `jira_add_comment`), which cannot tell whether a comment reaches the customer, and has no approval or participant tools.

## What Changes

- Add read tools: `jira_get_request` (compact servicedeskapi view with SLA summary and links), `jira_get_request_comments` (paged, with a public/internal flag), `jira_get_request_participants`, `jira_get_request_approvals`, `jira_get_request_status_history` and `jira_get_request_feedback` (CSAT rating, comment and date).
- Add guarded writes: `jira_add_request_comment` with an explicit `public` flag that defaults to internal, `jira_add_request_participants`, `jira_remove_request_participants` and `jira_answer_request_approval`.
- Writes are dry runs by default, idempotent where the state can be read, and read back after a confirmed change.

## Capabilities

### New Capabilities

- `jsm-request-agent-operations`: agent-side reads and changes of one JSM customer request.

### Modified Capabilities

None. `jira_create_customer_request`, `jira_get_issue`, `jira_add_comment` and `jira_get_issue_sla` keep their contracts.

## Impact

Add `src/tools/jira/jsmRequests.ts` (export `jiraJsmRequestTools`) and `test/unit/jsmRequests.test.ts`. The integrator registers the array, documents the tools and adds `jira_get_request` and `jira_get_request_feedback` to the single-entity read exceptions. No new dependency.
