# Spec Delta

## Purpose

Lets Jira Data Center administrators create and delete Jira Software boards and change a board's saved filter, columns and status mapping, swimlanes, quick filters and card colors with dry runs, idempotency and read-back verification.

## ADDED Requirements

### Requirement: Create and delete boards
The system SHALL provide `jira_create_board` ✎ with `name`, `type` (scrum or kanban), `filter` (filter id or exact name of a favourite filter) and an optional `project_key` location, using the public agile API. A board with the same name, type and filter SHALL be reported as already-satisfied; when `project_key` is given, its location SHALL match too, and a location that differs or cannot be read SHALL be refused instead of reported as satisfied. A board with the same name and other settings SHALL be refused. When the board name search returns more than 500 boards, the system SHALL refuse and ask for a more specific name instead of deciding that no duplicate exists. After a confirmed create the system SHALL read the board back and verify name, type and filter. The system SHALL provide `jira_delete_board` ✎ with `board_id`; its dry run SHALL name the board, its type, filter and the number of columns, quick filters and swimlanes, and SHALL state that issues, the saved filter and sprints are not deleted. A board that no longer exists SHALL be reported as already-satisfied.

#### Scenario: Create a Kanban board from a favourite filter
- **WHEN** an administrator creates a kanban board with a filter given by its exact favourite name
- **THEN** the dry run shows the resolved filter id and the request
- **AND** a confirmed create is verified by reading the new board back

#### Scenario: Delete summary
- **WHEN** an administrator plans to delete a board
- **THEN** the dry run names what is deleted and what is kept

### Requirement: Internal board settings are gated
Changes of the saved filter, columns, swimlanes, quick filters and card colors use Jira Software's internal API. The system SHALL allow them only on Jira 11.3.x and SHALL refuse other versions before sending anything. It SHALL refuse with an authorization error when the caller cannot edit the board. Every such write SHALL be a dry run by default, SHALL report already-satisfied when the board already matches, and SHALL read the board back after a confirmed change and fail verification on mismatch.

#### Scenario: Not a board administrator
- **WHEN** the caller cannot edit the board
- **THEN** the change is refused with an authorization error and nothing is sent

#### Scenario: Other Jira version
- **WHEN** Jira is not 11.3.x
- **THEN** the change is refused before any write request

### Requirement: Change the saved filter
The system SHALL provide `jira_set_board_filter` ✎ with `board_id` and `filter` (id or exact favourite name), and SHALL show the old and new filter in the dry run.

#### Scenario: Same filter
- **WHEN** the board already uses the filter
- **THEN** the system reports already-satisfied

### Requirement: Read and change columns
The system SHALL provide `jira_get_board_columns` returning ordered columns with ids, min/max and mapped statuses (id, name, category), the unmapped statuses and the column constraint. It SHALL provide `jira_set_board_columns` ✎ with the complete ordered `columns` list (name, statuses by id or exact name, optional min and max) and an optional `constraint`. Every status SHALL belong to the board's workflows and SHALL appear in at most one column; otherwise the system SHALL stop before changing anything and name the status. A status that is mapped now and would become unmapped SHALL be refused unless `allow_unmapped=true`. Existing columns SHALL keep their ids when their names match.

#### Scenario: Unknown status
- **WHEN** a column names a status that is not in the board's workflows
- **THEN** the system refuses and names the status

#### Scenario: Status left unmapped
- **WHEN** the target leaves a currently mapped status out of every column without `allow_unmapped=true`
- **THEN** the system refuses and names the status

### Requirement: Read and change swimlanes
The system SHALL provide `jira_get_board_swimlanes` and `jira_set_board_swimlanes` ✎ with an optional `strategy` (custom, parentChild, assignee, assigneeUnassignedFirst, epic, project, none) and optional `lanes`, the complete ordered list of query swimlanes (name, JQL query, optional description) for the custom strategy. The default swimlane SHALL be kept. Lanes SHALL be matched by name; missing ones deleted, changed ones updated, new ones created, and the order applied. `lanes` SHALL be refused unless the resulting strategy is custom. Ordering SHALL only move lanes present both on the board and in the requested list.

#### Scenario: Lanes without the custom strategy
- **WHEN** lanes are given for a board whose resulting strategy is assignee
- **THEN** the system refuses and nothing is sent

#### Scenario: Query lanes in order
- **WHEN** an administrator sets lanes A, B on a board with lanes B, C
- **THEN** C is deleted, A is created and the lanes read back as A, B followed by the default lane

### Requirement: Manage quick filters
The system SHALL provide `jira_get_board_quick_filters`, `jira_create_board_quick_filter` ✎, `jira_update_board_quick_filter` ✎ and `jira_delete_board_quick_filter` ✎. Quick filters SHALL be identified by id or exact name. Creating a quick filter that exists with the same query SHALL be already-satisfied; with another query it SHALL be refused. Deleting a missing quick filter SHALL be already-satisfied. The delete's plan state SHALL carry the quick filter's id and JQL, so a quick filter recreated under the same name is detected as drift.

#### Scenario: Update query
- **WHEN** an administrator changes a quick filter's JQL
- **THEN** the dry run shows old and new values and a confirmed change reads back the new JQL

### Requirement: Read and change card colors
The system SHALL provide `jira_get_board_card_colors` (strategy and color rows, bounded) and `jira_set_board_card_colors` ✎ with an optional `strategy` (issuetype, priority, assignee, custom, none) and optional `colors` (value and `#rrggbb` color). For issuetype, priority and assignee only the named rows SHALL change; an unknown value SHALL be refused. For custom, `colors` SHALL be the complete list of JQL rows.

#### Scenario: Recolor one priority
- **WHEN** an administrator sets the color of priority High
- **THEN** only that row changes and the colors read back with the new value
