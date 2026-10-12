# Spec Delta

## ADDED Requirements

### Requirement: Read a customer request as an agent
The system SHALL provide `jira_get_request` returning a compact service desk view of one request: key, service desk, request type, current status, reporter, participant count, an SLA summary per metric and portal/agent links. It SHALL also provide paged `jira_get_request_comments` (each comment flagged public or internal, filterable by visibility, bodies cut to a bounded length), `jira_get_request_participants`, `jira_get_request_approvals` (decision per approver, approver lists capped) and `jira_get_request_status_history`.

#### Scenario: Internal and public comments
- **WHEN** a request has one public and one internal comment
- **THEN** the comment listing returns both with `public: true` and `public: false`, and `visibility=public` returns only the first

#### Scenario: Request view
- **WHEN** an agent reads a request with two SLA metrics and three participants
- **THEN** the result shows the request type, current status, `participants: 3` and one summary row per SLA metric

### Requirement: Read customer satisfaction
The system SHALL provide `jira_get_request_feedback` returning whether CSAT feedback was submitted, its rating, comment and date. Because JSM 11.3 has no feedback REST resource, the rating SHALL be determined from the CSAT custom field through JQL and the comment from the request's feedback issue property; an unreadable rating SHALL be reported as null with a reason, never as a fabricated value.

#### Scenario: Rated request
- **WHEN** a request was rated 4 with a comment
- **THEN** the result is `submitted: true`, `rating: 4` and the comment text

#### Scenario: No feedback
- **WHEN** a request has no CSAT feedback
- **THEN** the result is `submitted: false` and no rating

### Requirement: Comment with explicit customer visibility
The system SHALL provide `jira_add_request_comment` ✎ with a `public` flag that defaults to false (internal). The dry-run summary SHALL state whether the customer will see the comment. After a confirmed change the system SHALL read the stored comment back by its id and check that it has the requested visibility.

#### Scenario: Default is internal
- **WHEN** an agent adds a comment without `public`
- **THEN** the request body has `public: false` and the summary says the customer does not see it

#### Scenario: Public comment
- **WHEN** an agent adds a comment with `public=true`
- **THEN** the summary says the comment is visible to the customer

### Requirement: Change participants and answer approvals idempotently
The system SHALL provide `jira_add_request_participants` ✎, `jira_remove_request_participants` ✎ and `jira_answer_request_approval` ✎ (`approve` or `decline`). Participant changes SHALL send only usernames that change, report already-satisfied when none do, and read the participants back. Usernames SHALL be compared case-insensitively, removals SHALL send the server's spelling, and when the participant list exceeds its scan cap the system SHALL refuse to call a user a non-participant and SHALL report an unconfirmed read-back as partial verification. Answering an approval SHALL report already-satisfied when the calling user already gave that answer, SHALL refuse when the user gave the other answer, the approval is final, or the user cannot answer, and SHALL read the approval back after a confirmed change.

#### Scenario: Already approved by me
- **WHEN** the calling user already approved the approval and asks to approve again
- **THEN** the system reports already-satisfied and sends nothing

#### Scenario: Participant already present
- **WHEN** every requested participant is already on the request
- **THEN** the system reports already-satisfied and sends nothing
