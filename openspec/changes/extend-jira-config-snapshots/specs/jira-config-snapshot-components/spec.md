# Spec Delta

## ADDED Requirements

### Requirement: Explicit snapshot components
`jira_export_config` SHALL accept a `components` list drawn from `request-type-forms`, `jsm-queues`, `jsm-sla`, `project-schemes`, `project-fields` and `project-screens`. The default SHALL remain `request-type-forms` only. Service-desk components SHALL require `service_desk`. Project components SHALL require `project_key` or default to the service desk's project. Missing scope, unknown components, or `request_types` without `request-type-forms` SHALL be refused before any HTTP request. A snapshot that contains only service-desk components or only project components SHALL work. Jira access SHALL use GET only.

#### Scenario: Project-only snapshot
- **WHEN** an administrator exports `project-schemes` for a project key without a service desk
- **THEN** the snapshot is written without any JSM request, and its scope records the project key and a null service desk

#### Scenario: Explicit project beside a service desk
- **WHEN** an administrator exports with a service desk and a project_key naming a different project
- **THEN** the scope records the explicit project's key and its own project id, and the service desk's project id separately as serviceDeskProjectId

#### Scenario: Missing scope
- **WHEN** a project component is requested without project_key or service_desk
- **THEN** the export fails with a validation error before any HTTP request and writes nothing

### Requirement: Per-component and per-area coverage
Each component SHALL carry a COMPLETE, PARTIAL or UNAVAILABLE status, and every area it contains SHALL carry its own status and reason. Areas that Jira 11.3 does not expose (field configuration schemes, screen schemes, issue type screen schemes) SHALL be recorded as UNAVAILABLE with a reason, never as empty. Missing or unsupported routes and malformed responses SHALL make the area UNAVAILABLE. Reaching a read cap SHALL make it PARTIAL. Authorization failures on core routes SHALL fail the export without upstream bodies. The snapshot coverage SHALL list each component's status.

#### Scenario: SLA source unavailable
- **WHEN** the SLA metrics and calendar routes return 404
- **THEN** the jsm-sla component is UNAVAILABLE and overall coverage is PARTIAL

#### Scenario: Scheme resources not exposed
- **WHEN** project-fields or project-screens is captured
- **THEN** the field configuration scheme, or the screen scheme definitions, are UNAVAILABLE with a reason, while readable configurations and screens are retained

### Requirement: Normalized, bounded, uniquely named artifacts
Component content SHALL contain no timestamps. Collections without a defined order SHALL be sorted deterministically, and configured order SHALL be kept with explicit positions, so two captures of an unchanged instance have identical components. Each component SHALL respect `max_component_bytes`, and the snapshot SHALL respect `max_total_bytes`. Exceeding either SHALL fail before writing and name the argument to raise. The snapshot SHALL declare `kind: jira-config-snapshot` and schema version 2. Artifact names SHALL include the scope and the sorted component list. The request-form-only export SHALL keep `jira-config-<serviceDeskId>.json`.

#### Scenario: Reordered server responses
- **WHEN** the server returns the same configuration in a different order
- **THEN** the two snapshots have identical components

#### Scenario: Component budget exceeded
- **WHEN** a component serializes larger than max_component_bytes
- **THEN** the export fails, naming the component and max_component_bytes, and the output directory is unchanged
