# Proposal

## Why

The jira-config snapshot (`adapters/config-snapshot`) is served by a ScriptRunner custom endpoint, so a person had to open it in a browser and hand the zip to the agent. The CLI already holds an administrator token for the instance; a read-only download lets the agent refresh the snapshot on its own.

## What Changes

- Add `jira_download_scriptrunner_endpoint` to `src/tools/jira/scriptRoot.ts`: `GET /rest/scriptrunner/latest/custom/<name>` saved to a local file; the result carries path, size, SHA-256, content type and outcome, never the content.
- `Download` (`client.getBytes`) also returns `contentDisposition`, used for the file name.
- `jira-config/SKILL.md`: refresh the snapshot with the tool when the CLI is configured.

## Capabilities

### New Capabilities

- `scriptrunner-endpoint-download`: downloading the response of a ScriptRunner custom REST endpoint to local disk.

### Modified Capabilities

None.

## Impact

One tool in `jiraScriptRootTools`, one optional field in `Download`, `test/unit/srCustomEndpoint.test.ts`, regenerated `REFERENCE.md` and bundle. No configuration change.
