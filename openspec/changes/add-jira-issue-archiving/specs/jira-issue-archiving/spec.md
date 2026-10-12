# Spec Delta

## ADDED Requirements

### Requirement: Archive and restore a single issue
The system SHALL provide `jira_archive_issue` and `jira_restore_issue` for one issue key. Both SHALL be dry runs unless `dry_run=false` and SHALL accept `notify_users`. Before a write the tool SHALL read `archiveddate`: an issue that is already in the target state SHALL be reported as already satisfied without a request. After an executed write the tool SHALL read the issue back and fail with a verification error when the target state is not visible. A 404 read-back after archiving SHALL be reported as unverified rather than failed.

#### Scenario: Issue already archived
- **WHEN** `jira_archive_issue` is called for an issue whose `archiveddate` is set
- **THEN** the result is already satisfied and no PUT is sent

#### Scenario: Restore verified
- **WHEN** `jira_restore_issue` runs with `dry_run=false` and Jira accepts the request
- **THEN** the tool reads the issue back and reports success only if `archiveddate` is empty

### Requirement: Archive issues in bulk by JQL
The system SHALL provide `jira_archive_issues` with a required `jql` and a `max_issues` cap (default 100, at most 10,000). The dry run SHALL show the number of matching issues and a bounded sample. Zero matches SHALL be already satisfied. More matches than `max_issues` SHALL be refused before any write, also when the count grew between the dry run and execution. The dry run SHALL read the ids of all matching issues (`fields=id`, bounded by `max_issues`) and carry a hash of the sorted ids in its plan `state`, so a plan apply detects a different set of issues even when the count is the same. Execution SHALL re-read the ids, SHALL refuse when they differ from an `approved_ids_hash` given by the caller, and SHALL send `POST /rest/api/2/issue/archive` whose JSON body is the JQL string `issue in (<ids>) AND (<jql>)` restricted to the ids it read (at most 500 ids per request), so issues that start to match later are never archived. It SHALL fail with a verification error naming the remaining count when any of those ids still matches afterwards.

#### Scenario: Cap exceeded
- **WHEN** the JQL matches 2,500 issues and `max_issues` is 1,000
- **THEN** the tool refuses with a message naming 2,500 matches and the cap, and sends nothing

#### Scenario: Dry run
- **WHEN** the JQL matches 42 issues
- **THEN** the dry run shows 42, up to `sample` keys with summary and status, the POST it would send restricted to the 42 ids, and a `state` with the ids hash

#### Scenario: Same count, different issues
- **WHEN** the matching issues change between the dry run and the apply but their number stays the same
- **THEN** the ids hash in `state` differs and the plan item is reported as drifted

#### Scenario: Issue starts to match after the ids were read
- **WHEN** an issue starts to match the JQL after execution read the ids
- **THEN** the POST does not include it and it is not archived

### Requirement: Unsupported instances
When Jira answers that issue archiving is unavailable (HTTP 501, a licensing or Data Center message about archiving, a missing archive resource, or an issue read without the `archiveddate` field), the archiving tools SHALL fail with an `Unsupported` error that says a Data Center license is required, instead of a raw HTTP error.

#### Scenario: Server license
- **WHEN** the archive request answers 403 with a message that archiving requires Jira Data Center
- **THEN** the tool fails with `Unsupported` and that explanation
