# Spec Delta

## Purpose

Read Jira DC priorities and resolutions, and manage priority schemes and their project assignment through the documented REST API, with verified UI steps where no API exists.

## ADDED Requirements

### Requirement: Bounded priority, resolution and priority scheme reads
The system SHALL provide `jira_list_priorities`, `jira_list_resolutions`, `jira_list_priority_schemes` and `jira_get_priority_scheme` using GET only. Lists SHALL be paged and filterable by name. Priority scheme rows SHALL include the default-scheme flag, the default priority (or null), the number of priorities, the project count and project keys capped unless full lists are requested. `jira_get_priority_scheme` SHALL accept an id or exact name and list the priorities in scheme order with names.

#### Scenario: Scheme without a default priority
- **WHEN** a priority scheme has no default option
- **THEN** its row reports the default priority as null

#### Scenario: Scheme by name
- **WHEN** a scheme is requested by its exact name in another letter case
- **THEN** the tool returns that scheme with its ordered priorities and project keys

### Requirement: Idempotent priority scheme writes with read-back
The system SHALL provide `jira_create_priority_scheme`, `jira_update_priority_scheme` and `jira_delete_priority_scheme`, dry run by default. Priorities and the default SHALL be accepted by id or exact name; unknown priorities and a default outside the list SHALL be validation errors. Create SHALL return `already_satisfied` for the same name and settings and fail for the same name with other settings. Update SHALL keep unspecified fields, show before and after, and return `already_satisfied` when nothing changes. Delete SHALL return `already_satisfied` for a missing scheme and name the projects that fall back to the default. The default priority scheme SHALL NOT be updated or deleted. Every executed write SHALL be read back and SHALL fail with a verification error when the scheme does not show the change.

#### Scenario: Create from priority names
- **WHEN** a scheme is created with priorities and a default given by name
- **THEN** the dry run shows a POST with the resolved ids in order, and the execution reads the scheme back

#### Scenario: Reorder
- **WHEN** an update gives the same priorities in a new order
- **THEN** a PUT with the new order is planned; repeating it after execution returns already_satisfied

#### Scenario: Write does not take effect
- **WHEN** Jira accepts the create but the scheme does not read back
- **THEN** the tool fails with a verification error

### Requirement: Assign a priority scheme to a project
The system SHALL provide `jira_assign_priority_scheme` for a project and a scheme (id or exact name). It SHALL return `already_satisfied` when the project already uses the scheme. When issues of the project have priorities the scheme lacks, it SHALL return a MANUAL item for the priority scheme association page and send no write. Otherwise it SHALL send `PUT /rest/api/2/project/{key}/priorityscheme` with the scheme id and verify through `GET /rest/api/2/project/{key}/priorityscheme`.

#### Scenario: Assignment needing migration
- **WHEN** the project has issues with priorities outside the target scheme
- **THEN** the tool returns a MANUAL item, and executing it fails as unsupported

### Requirement: Creating priorities and resolutions is a manual change
Because Jira DC has no REST endpoint to create priorities or resolutions, `jira_create_priority` and `jira_create_resolution` SHALL return `already_satisfied` when the name exists and otherwise a MANUAL item for the corresponding admin page with steps. Executing it SHALL fail as unsupported and send nothing.

#### Scenario: New priority
- **WHEN** no priority has the requested name
- **THEN** the tool returns a MANUAL item for the priorities admin page with the steps to add it
