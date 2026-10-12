# Spec Delta

## Purpose

Build a read-only snapshot of a Jira DC configuration on the server, unpack it locally into a grep-friendly cache, and answer configuration questions from it.

## ADDED Requirements

### Requirement: Read-only snapshot endpoint
The adapter SHALL expose `GET /rest/scriptrunner/latest/custom/jiraConfigSnapshot` to the configured administrator groups and return `jira-config-<timestamp>.zip`. It SHALL NOT change the instance. The zip SHALL contain `meta.json` (generatedAt, baseUrl, Jira version, counts, skipped sections), `errors.json`, one JSON per project, scheme, screen, field, workflow, service desk, request type and Assets schema, workflow XML for all workflows and drafts, and TSV indexes. `exclude` SHALL leave out projects of the given categories; `skip` SHALL leave out the named sections (jsm, assets, scriptrunner, automation, drafts, options).

#### Scenario: Failing object
- **WHEN** reading one object or one REST part throws
- **THEN** the failure is listed in errors.json with scope, key and message, and the rest of the zip is produced

#### Scenario: Unhandled failure
- **WHEN** building the zip fails as a whole
- **THEN** the endpoint answers 500 with the stack trace as text

### Requirement: REST sections under the caller's session
JSM forms, queues and SLAs, the Assets structure, the ScriptRunner report and the Automation export SHALL be read over REST from inside the server with the caller's Cookie and Authorization headers, first through the local connector and then through baseUrl. The ScriptRunner report SHALL be embedded as `scriptrunner-report.zip` and the Automation export as `automation-rules.json`. Hidden request type fields SHALL keep their preset values.

#### Scenario: App not installed
- **WHEN** JSM or Assets answers 404
- **THEN** that section is empty and errors.json names it

### Requirement: Local unpack bound to the instance
`unpack.py` SHALL resolve the instance folder from `meta.baseUrl` through `instances.json` and refuse an unknown host unless `--instance` is given. It SHALL replace only `<root>/<instance>/jira-config/`, extract the embedded ScriptRunner report into `jira-config/scriptrunner/`, rewrite JSON with readable non-ASCII text, record the sources in `sources.json`, print the counts and up to ten errors, and rebuild the indexes.

#### Scenario: Host mapped to another folder
- **WHEN** `--instance` differs from the folder instances.json gives for the host
- **THEN** unpack stops before touching any folder

### Requirement: ScriptRunner and Automation indexes
`build_indexes.py` SHALL write `sr-features.tsv` (kind, id, name, disabled, projects, script paths, folder), `sr-workflow-functions.tsv` (workflow, draft flag, transition, from, to, function type and name, script path) and `automation-rules.tsv` (id, state, name, trigger, project keys). It SHALL prefer the report and export embedded in the snapshot and fall back to `<instance>/scriptrunner/` and the newest `<instance>/automation/automation-rules-*.json`.

#### Scenario: Automation before the first snapshot
- **WHEN** no snapshot projects exist yet
- **THEN** the Automation index lists project ids and says so
