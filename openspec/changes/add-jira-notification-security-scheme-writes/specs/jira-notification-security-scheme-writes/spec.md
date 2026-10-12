# Spec Delta

## Purpose

Plan notification scheme and issue security scheme changes on Jira DC honestly: REST where Jira offers a write, verified manual UI steps where it does not.

## ADDED Requirements

### Requirement: Notification scheme changes are verified manual changes
The system SHALL provide `jira_create_notification_scheme`, `jira_add_notification` and `jira_remove_notification`. Each SHALL read the current state over REST (GET only) and return `already_satisfied` without a plan item when the target state holds. Otherwise it SHALL return a dry-run item with `request.method` `MANUAL`, the absolute admin page URL, ordered UI steps and the reason (no REST write; the admin form needs websudo). Executing such an item SHALL fail with an `Unsupported` error that names the URL and steps, and SHALL send nothing. Schemes SHALL be accepted by id or exact name, events by id or exact name, project-role recipients by id or exact name, and Single User recipients by username, resolved to the user key Jira stores (`GET /rest/api/2/user?username=`).

#### Scenario: Adding a missing recipient
- **WHEN** a group is not notified on an event of the scheme
- **THEN** the tool returns a MANUAL item pointing at the scheme's add-notification page with steps naming the event and group, and sends no request

#### Scenario: Recipient already notified
- **WHEN** the scheme already notifies the project role on the event
- **THEN** the tool returns already_satisfied

#### Scenario: Removing a notification
- **WHEN** the recipient is notified on the event
- **THEN** the MANUAL item links to the delete page with that notification's id; when it is not notified the tool returns already_satisfied

#### Scenario: Single User recipient
- **WHEN** a Single User recipient is given by username and the scheme stores that user by key
- **THEN** adding it is already_satisfied and removing it links to the delete page of that notification

#### Scenario: Missing recipient parameter
- **WHEN** a recipient type that needs a parameter is given without one
- **THEN** the tool fails with a validation error before any plan item is produced

### Requirement: Issue security scheme contents are manual changes
The system SHALL provide `jira_create_issue_security_scheme` and `jira_add_issue_security_level`, which return `already_satisfied` when the scheme or level (and requested default) exists and a MANUAL item with the admin page and steps otherwise. It SHALL provide `jira_add_issue_security_level_member` as a MANUAL item that is declared unverifiable, because Jira DC has no REST read of level members, and whose note says to check the result in the UI. An unknown level SHALL be a validation error.

#### Scenario: New level
- **WHEN** the scheme lacks a level of that name
- **THEN** the tool returns a MANUAL item for the scheme's levels page

#### Scenario: Member addition
- **WHEN** a member is requested for an existing level
- **THEN** the tool returns a MANUAL item for the add-member page and states that the result cannot be verified over REST

### Requirement: Assign an issue security scheme with read-back
The system SHALL provide `jira_assign_issue_security_scheme` for a project and a scheme (id or exact name). It SHALL return `already_satisfied` when the project already uses the scheme. When the project already has another issue security scheme, it SHALL return a MANUAL item for the project's security scheme page instead of writing, because issues may carry its levels (a search count cannot see issues hidden from the caller). Only when the project has no issue security scheme it SHALL send `PUT /rest/api/2/project/{key}` with `issueSecurityScheme` (dry run by default) and SHALL fail with a verification error unless `GET /rest/api/2/project/{key}/issuesecuritylevelscheme` then returns the new scheme.

#### Scenario: Project without a scheme
- **WHEN** the project has no issue security scheme and the change is executed
- **THEN** one PUT is sent and the project reads back with the new scheme

#### Scenario: Assignment does not take effect
- **WHEN** Jira accepts the PUT but the project still reads back with another scheme
- **THEN** the tool fails with a verification error

#### Scenario: Switching from an existing scheme
- **WHEN** the project already uses another issue security scheme
- **THEN** the tool returns a MANUAL item and sends no write
