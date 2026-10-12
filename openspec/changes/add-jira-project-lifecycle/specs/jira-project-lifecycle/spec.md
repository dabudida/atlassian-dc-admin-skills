# Spec Delta

## Purpose

Create and change Jira projects, project categories and components, and create projects with shared configuration, through guarded, idempotent, read-back-verified writes.

## ADDED Requirements

### Requirement: Create a project
The system SHALL provide `jira_create_project` taking a project key, name, project type, lead and optional template, description, url, assignee type, category (id or exact name) and permission, notification and issue security scheme ids. With `from_project` it SHALL read that project's permission, notification and issue security scheme ids, category and type and use them unless explicitly given, and SHALL name the scheme types it cannot set at creation. The dry run SHALL validate the key with Jira's key validation, and the name, lead and type, before describing the request. After the write the project and requested scheme ids SHALL be read back. Project deletion SHALL NOT be offered.

#### Scenario: Copy schemes from an existing project
- **WHEN** an administrator creates a project with `from_project`
- **THEN** the request carries that project's permission, notification and issue security scheme ids, category and type, and the result lists workflow, issue type, screen and field configuration schemes as not copied

#### Scenario: Invalid or taken key
- **WHEN** the key violates the project key pattern or is used by another project
- **THEN** the dry run fails with a validation error and nothing is sent

#### Scenario: Re-run after creation
- **WHEN** the project already exists with the same name, type and lead (case-insensitive) and the requested category and scheme ids
- **THEN** the tool reports already-satisfied and sends nothing

#### Scenario: Existing project with other category or schemes
- **WHEN** the project exists with the same name, type and lead but another requested category or scheme id
- **THEN** the tool fails with a validation error pointing to `jira_update_project` or `jira_assign_project_scheme`

#### Scenario: Former key of a renamed project
- **WHEN** the requested key is a former key of another project (Jira's project read follows it)
- **THEN** the tool fails with a validation error naming that project instead of treating it as the same project

### Requirement: Update project details
The system SHALL provide `jira_update_project` for name, lead, description, url, assignee type and category, sending only fields that differ, showing before and after values in the dry run, reporting already-satisfied when nothing differs, and verifying changed fields by reading the project back.

#### Scenario: Change the category
- **WHEN** an administrator moves a project to another category by name
- **THEN** the request sends only the category id and the read-back shows the new category

### Requirement: Manage project categories
The system SHALL list project categories with their project counts and SHALL create, update and delete categories by id or exact name. Creating an existing category with the same description SHALL be already-satisfied; a different description SHALL be an error pointing to the update tool. Deleting SHALL name the projects that lose the category; a missing category SHALL be already-satisfied.

#### Scenario: Delete a used category
- **WHEN** a category used by one project is deleted in a dry run
- **THEN** the summary states that one project loses the category and lists its key

### Requirement: Manage components
The system SHALL create, update and delete project components by id or exact name. Delete SHALL state the related issue count and SHALL accept an optional target component in the same project for the issues, rejecting the component itself or an unknown target. Writes SHALL be idempotent and verified by reading back.

#### Scenario: Delete and move issues
- **WHEN** a component with issues is deleted with `move_issues_to`
- **THEN** the request carries `moveIssuesTo` with the target id and the summary states the issue count

### Requirement: Create a project with shared configuration
The system SHALL provide `jira_create_project_shared` that posts `{key, name, lead}` to `/rest/project-templates/1.0/createshared/{sourceProjectId}`, validates key, name and lead in the dry run, and verifies after the write that the new project uses the source's permission, notification, issue type and workflow schemes. A scheme that cannot be read on either side SHALL NOT count as a match; the result SHALL state a partial verification naming it. An existing target with the same name, type and shared schemes SHALL be already-satisfied. Lead usernames SHALL be compared case-insensitively in all project and component tools.

#### Scenario: New service desk sharing configuration
- **WHEN** an administrator creates a project sharing a JSM project's configuration
- **THEN** the dry run shows the createshared request with the source project id, and after execution the new project reads back with the source's schemes
