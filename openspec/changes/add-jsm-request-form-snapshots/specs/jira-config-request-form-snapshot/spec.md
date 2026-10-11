# Spec Delta

## Purpose

Retain ordered JSM request-type form configuration as a local, versioned Jira configuration snapshot with explicit source scope, mandatory-state provenance and completeness evidence.

## ADDED Requirements

### Requirement: Export a scoped request-form snapshot
The system SHALL provide `jira_export_config` for one service desk or project key, an output directory, and optional request-type selection. Its first supported component SHALL be `request-type-forms`. The file SHALL identify its schema version, source instance, Jira/JSM versions, service desk/project, capture start/end and selected component; it SHALL explicitly state that other Jira configuration areas are not captured. Jira access SHALL use GET only and SHALL not create portal requests, drafts or scripts.

Each included request type SHALL retain its id, exact name and issue type id when available. Each form SHALL retain visible fields in returned order, explicit 1-based positions, field ids, Jira names, labels, descriptions, visibility, `sdRequired`, `jiraRequired` and their effective `required`. Hidden fields SHALL be recorded separately. Unavailable mandatory flags SHALL remain unknown and SHALL not become false. Hidden preset values SHALL be omitted by default with an explicit omission marker; an opt-in SHALL retain them only in the local artifact.

#### Scenario: Ordered optional and Jira-required fields
- **WHEN** a selected form contains two fields whose portal flags are false but whose Jira flags differ
- **THEN** the snapshot preserves their field order, positions and separate/effective flags without representing the Jira-required field as optional

#### Scenario: Sensitive hidden presets
- **WHEN** an administrator exports without opting into preset values
- **THEN** the snapshot records the hidden field and omitted-preset marker while tool output contains no preset value

### Requirement: Report inventory and form coverage honestly
The exporter SHALL combine the paged public request-type inventory with the internal hidden request-type inventory for the selected service desk, merge by stable id and preserve explicit requested selection. It SHALL record inventory and per-form coverage as complete, partial or unavailable with reasons. Authorization failures and malformed top-level discovery SHALL fail the export rather than masquerade as missing data. A 404/unsupported form or hidden inventory SHALL be explicitly unavailable, not an empty form/inventory. Per-form unknown data SHALL not erase successfully captured forms. Capture across multiple GETs SHALL be labeled non-atomic; the exporter SHALL not claim a transactionally consistent Jira backup.

#### Scenario: Hidden inventory cannot be read
- **WHEN** hidden-request-type discovery is unsupported but the public inventory is available
- **THEN** the artifact includes the public forms and marks total inventory coverage partial with the hidden inventory unavailable

#### Scenario: One form is unavailable
- **WHEN** one inventoried request type cannot supply its form
- **THEN** that form is explicitly unavailable and successfully read forms retain their data

#### Scenario: Requested identity is ambiguous
- **WHEN** an explicit request-type name matches more than one inventoried type
- **THEN** the exporter rejects that selection before writing a snapshot and requests a stable id

### Requirement: Bounded local artifact with conflict protection
The exporter SHALL enforce maximum request-type and serialized-byte budgets, reject a non-progressing or over-limit inventory, and write no artifact for those failures. It SHALL validate local paths, reject a destination symlink or non-regular file, and atomically write one snapshot after collection. A different existing file SHALL produce a conflict unless overwrite was explicitly selected; overwrite SHALL back up the original first. The result SHALL contain bounded metadata, coverage counts, relative paths, byte count, SHA-256 and outcome only. It SHALL not print form content, descriptions, hidden defaults or raw server error bodies.

#### Scenario: Limit exceeded
- **WHEN** discovery or serialization exceeds an explicit configured budget
- **THEN** the exporter reports the exceeded budget and leaves local output files unchanged

#### Scenario: Existing snapshot conflict
- **WHEN** the destination contains a different snapshot and overwrite is false
- **THEN** the old file is preserved, the result reports conflict and the CLI exits with the conflict code 4

#### Scenario: Missing output directory
- **WHEN** output_dir does not exist or is not a directory
- **THEN** the exporter fails with a validation error (exit code 7) and writes nothing

#### Scenario: Complete data stays in the artifact
- **WHEN** a snapshot contains a long field description
- **THEN** the local JSON preserves it while CLI output remains bounded and contains only export metadata
