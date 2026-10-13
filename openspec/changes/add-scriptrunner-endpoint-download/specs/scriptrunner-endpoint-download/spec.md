# Spec Delta

## Purpose

Download the response of a ScriptRunner custom REST endpoint to local disk without showing its content.

## ADDED Requirements

### Requirement: Read-only custom endpoint download
The system SHALL provide `jira_download_scriptrunner_endpoint` that sends `GET /rest/scriptrunner/latest/custom/<name>` with the optional query string and writes the body to a local file. `name` SHALL match `[A-Za-z0-9_-]+`; any other name SHALL be a validation error sent before any request. The result SHALL contain the endpoint path, query, local path, size, SHA-256, content type and outcome, and SHALL NOT contain the body.

#### Scenario: Snapshot download
- **WHEN** the endpoint answers a zip with `Content-Disposition: attachment; filename="jira-config-20261012-160943.zip"`
- **THEN** the file is written under that name in output_dir (default ~/Downloads) and the outcome is WRITTEN

#### Scenario: Name leaving custom/
- **WHEN** name is `../api/2/myself`
- **THEN** the tool fails validation and sends no request

### Requirement: Bounded and non-destructive
A response larger than `max_bytes` (default 200 MB) SHALL write nothing. An existing different local file SHALL be kept and reported as CONFLICT. A failing endpoint SHALL write nothing. The client request timeout SHALL be raised to `timeout_s` (default 600 s) for the call only and restored afterwards.

#### Scenario: Endpoint error
- **WHEN** the endpoint answers HTTP 500
- **THEN** the tool fails, no file is written and the client timeout is back to its configured value
