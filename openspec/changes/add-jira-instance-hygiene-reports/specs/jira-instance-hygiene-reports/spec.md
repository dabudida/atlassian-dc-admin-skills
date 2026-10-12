# Spec Delta

## ADDED Requirements

### Requirement: Unused custom field report
The system SHALL provide `jira_report_unused_custom_fields`, which scans `/rest/api/2/customFields` page by page up to `max_scan` fields and lists candidates that have no issue values, are on no screen, or have no context (not global and no projects). Each candidate SHALL name its reasons. Locked and managed fields SHALL be excluded and counted. Candidates SHALL be sorted by number of reasons, then by fewest values, then by name, and returned in pages. When the scan stops before the last field, the result SHALL say so.

#### Scenario: Locked field without values
- **WHEN** a locked field and an ordinary field both have zero values
- **THEN** only the ordinary field is a candidate and the locked field is counted as excluded

#### Scenario: Scan cap reached
- **WHEN** the instance has 3,000 custom fields and `max_scan` is 2,000
- **THEN** the result says 2,000 of 3,000 fields were scanned

### Requirement: Unused scheme report
The system SHALL provide `jira_report_unused_schemes` for permission, notification, issue security, issue type and priority schemes, inactive workflows, and on request screens. A scheme is unused when no scanned project uses it; a workflow is inactive when no workflow scheme in use maps it; a screen is unused when no scanned project uses it for create, edit or view and no workflow transition shows it. System defaults SHALL never be candidates. Each category SHALL report its candidate total, a capped list and `complete`. A project cap, a spent request budget, unreadable projects or an incomplete reused scan SHALL make the category incomplete with a reason. Every project has a permission scheme, so a 404 for a project's permission scheme SHALL count as an unreadable project; a 404 for an archived project's notification or issue security scheme SHALL also make that category incomplete. The workflow category SHALL be incomplete when project workflow schemes answer 404 or when archived projects exist (the shared workflow scan leaves them out). With `types=screen`, the screen usage scan and the workflow loads for transition screens SHALL share the `max_requests` budget, and a spent budget SHALL make the screen category incomplete. Errors other than HTTP answers SHALL fail the report instead of being counted as unreadable. Workflow schemes SHALL be reported as not covered because Jira DC cannot list them.

#### Scenario: Request budget spent
- **WHEN** the budget runs out after 80 of 300 projects
- **THEN** the permission, notification and issue security categories are marked incomplete and name the budget

#### Scenario: Permission scheme not readable
- **WHEN** a project answers 404 for its permission scheme
- **THEN** the permission category is incomplete and counts that project as unreadable

#### Scenario: Screen budget spent on workflow loads
- **WHEN** `types=screen` runs with a `max_requests` smaller than the workflows to load
- **THEN** no more requests than the budget are sent for workflow loads and the screen scan, and the screen category is incomplete naming the request budget

#### Scenario: Workflow in a used scheme
- **WHEN** a workflow is the default of a workflow scheme a project uses
- **THEN** it is not listed as inactive

### Requirement: License usage report
The system SHALL provide `jira_report_license_usage`, which lists for each application role its seats, user count, remaining seats and unlimited flag, and scans the members of the role's groups up to a hard cap of unique users. It SHALL report inactive members, active members who never logged in and active members whose last login is older than `stale_days`, each as a count and a capped list of usernames. E-mail addresses SHALL NOT be returned. When the cap is reached, the role SHALL be marked truncated with the number of members checked.

#### Scenario: Member cap
- **WHEN** a role's groups have 8,000 unique members and the cap is 500
- **THEN** the role reports `truncated: true` and 500 checked members

### Requirement: Instance health report
The system SHALL provide `jira_instance_health`, which lists failing enabled health checks first (name, severity, application, failure reason cut to 200 characters), and counts of all, healthy, failing and disabled checks. It SHALL add cluster node states and index consistency (database versus index count) when those reads succeed; a failed part SHALL be reported as an error without failing the report.

#### Scenario: Index behind
- **WHEN** the database holds 1,000 issues and the index 990
- **THEN** the report shows the index as inconsistent with both counts
