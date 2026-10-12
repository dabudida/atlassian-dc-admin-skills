# Design

## Context

JSM 11.3 public REST (plugin 21.3.2) resources: `CustomerRequestResource` (`GET /request/{key}?expand=`), `CommentResource` (`GET/POST /request/{key}/comment`, query `public`, `internal`, `start`, `limit`; body `{body, public}`), `RequestParticipantResource` (`GET/POST/DELETE /request/{key}/participant`, body `{usernames}`), `ApprovalResource` (`GET /request/{key}/approval[/{id}]`, `POST /request/{key}/approval/{id}` with `{decision: approve|decline, comment?, commentPublic?}`), `RequestStatusResource` (`GET /request/{key}/status`). All need `X-ExperimentalApi: opt-in` (`sdGet`).

There is no feedback resource: `GET /request/{key}/feedback` answers 404 on 11.3.7. The CSAT rating lives in the custom field of type `com.atlassian.servicedesk:sd-request-feedback`, whose REST value is an opaque Java string, but JQL compares it numerically (`cf[N] = 5`). The comment is stored in the issue property `service-request-feedback-comment` (`{comment}`), and the date in the field of type `sd-request-feedback-date`.

## Goals / Non-Goals

**Goals:** a compact request view, honest comment visibility, idempotent participant and approval changes, bounded output.
**Non-Goals:** creating requests (existing `jira_create_customer_request`), transitions, attachments, SLA configuration, editing or deleting comments, submitting CSAT.

## Decisions

### Request view
`jira_get_request` reads `expand=requestType,participant,sla` and returns key, id, service desk id, request type `{id, name}`, current status and date, created date, reporter `{name, displayName}`, participant count (`size`, with `more: true` when the expanded page is not the last), an SLA summary per metric (name, ongoing breached/paused/remaining/breach time, completed cycles count and whether the last breached), the first 20 request field values with text cut at 300 characters, and links (portal `web`, agent `browse`).

### Comments
`jira_get_request_comments` pages with `public`/`internal` filters (`visibility=all|public|internal`) and returns `{id, public, author, created, body}` with bodies cut at `max_body_chars` (default 1,000, max 20,000). `jira_add_request_comment` requires `body`; `public` defaults to false. The summary states either "INTERNAL comment (agents only; the customer does not see it)" or "PUBLIC comment (visible to the customer on the portal and in notifications)". Each call adds a comment, so the tool is `unverifiable` for idempotency; after the POST the returned comment's `public` flag must match the request, otherwise VerificationError.

### Participants
Add/remove read all participants (paged, capped at 1,000), send only usernames that change, report already-satisfied when none, and read the list back.

### Approvals
`jira_answer_request_approval` reads the approval and `/rest/api/2/myself`. When the caller's approver decision already equals the requested decision → already-satisfied. When the caller answered differently, the approval is final, or `canAnswerApproval` is false → ValidationError explaining why. After the POST the approval is read back and the caller's decision must match. Approvers are shown with `capList`.

### Feedback
`jira_get_request_feedback` finds the two feedback fields by schema type, reads them on the issue, and when feedback exists probes ratings 5..1 with `issuekey = KEY AND cf[N] = r` count queries (at most five, `maxResults=0`), then reads the comment property (404 → null). Without the fields or feedback it returns `submitted: false` with a reason.

### Bounds and reuse
Paged reads use `pageShape(default, 50)`; `jira_get_request` and `jira_get_request_feedback` return one entity. All writes declare `invalidates: []`.

## Risks / Trade-offs

- JQL rating probe relies on numeric comparison of the CSAT field → verified on 11.3.7; when JQL fails the rating is `null` with the error in `rating_error`.
- The PAT user may not see requests it is not an agent on → errors surface as HTTP 403/404 from the API.

## Live verification

GET-only on JSM 11.3.7 against one request: request view with expansions, comments, participants, approvals, status history, SLA and the feedback probe all answered with the expected shapes; writes were run as dry runs only.

## Local Implementation Evidence (2026-10-11)

`test/unit/jsmRequests.test.ts`: 10 tests pass. Live GET-only run on JSM 11.3.7: all six reads answered (the feedback probe returned a numeric rating, a comment and a date on a rated request); comment and participant dry runs, participant removal already-satisfied, and the approval answer refused correctly for a user who cannot answer. No non-GET request was sent. `jira_get_request` and `jira_get_request_feedback` return one entity and need entries in the read-bounds exception list on registration.
