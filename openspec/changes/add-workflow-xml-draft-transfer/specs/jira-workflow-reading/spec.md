# Spec Delta

## MODIFIED Requirements

### Requirement: Read a workflow
The system SHALL provide `jira_get_workflow` with either a workflow name or a project key plus issue type (id or exact name), and an optional `draft` flag. It SHALL return:
- the workflow name, description, and whether it is a draft or has a draft with changes;
- the projects and issue types that share the workflow;
- the statuses with status id, name, status category and the initial status;
- the transitions with id, name, source status (or "any" for global transitions), target status, and the global and looped flags;
- the transition properties.

For conditions, validators and post-functions the designer reader SHALL state that their contents are not available through the designer REST API and SHALL NOT return guessed or empty lists in their place. A separately installed XML-transfer adapter SHALL allow a complete descriptor to be exported through `jira_export_workflow_xml` to a local artifact. The designer reader SHALL not imply that this adapter is installed or that it has inspected the exported rule contents.

#### Scenario: Workflow of a project and issue type
- **WHEN** an administrator requests the workflow for project BANK and issue type "Incident"
- **THEN** the result names the workflow, lists its statuses and transitions with directions, and lists the projects and issue types that share it

#### Scenario: Rules are not readable
- **WHEN** a workflow is read using the designer reader
- **THEN** the result marks conditions, validators and post-functions as not available through the designer REST API, with the reason

#### Scenario: Draft
- **WHEN** an administrator reads the draft of a workflow that has one
- **THEN** the result shows the draft's statuses and transitions and says it is a draft

#### Scenario: Complete XML route is separate
- **WHEN** an administrator has installed the XML adapter and explicitly exports a descriptor
- **THEN** complete rule contents are preserved in its local XML artifact while the designer reader keeps its stated limitations
