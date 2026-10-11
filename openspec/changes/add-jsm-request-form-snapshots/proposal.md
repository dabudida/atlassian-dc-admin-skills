# Proposal

## Why

The approved roadmap requires JSM request-type fields, order and mandatory state in a Jira configuration snapshot (item 11). The repository has form readers but no configuration snapshot exporter, so administrators cannot retain one explicit, completeness-aware baseline of those forms.

## What Changes

- Add a repository-owned `jira_export_config` tool whose initial component is `request-type-forms`, scoped to one service desk/project.
- Export visible and hidden request-type identity plus ordered form rows with stable field identifiers, labels, descriptions, visibility and separate portal/Jira/effective mandatory flags.
- Record versions, source scope, capture interval, inventory completeness and per-form availability; represent missing sections as unavailable, never empty success.
- Store the snapshot as a local JSON artifact and return bounded metadata, counts, hash and outcomes; default exports omit hidden preset values, with an explicit option for sensitive local evidence.
- Reuse existing path checks and conflict/backup behavior without making any Jira mutation or depending on a previous custom endpoint.

## Capabilities

### New Capabilities

- `jira-config-request-form-snapshot`: a bounded, versioned configuration export containing a JSM request-form component and explicit coverage evidence.

### Modified Capabilities

None. Existing form tools retain their user-visible contracts; reusable internal readers can be extracted without changing those contracts.

## Impact

Add `src/tools/jira/configSnapshot.ts`, unit fixtures/tests and `atlassian-dc-admin/CONFIG_SNAPSHOTS.md`; register the tool in `src/tools/index.ts`. Reuse and narrowly expose internal readers from `requestTypes.ts`. Regenerate the CLI/reference during apply. No new dependency, server installation, workflow XML implementation, Jira mutation, portal request or script execution is included.

This is the first snapshot component, not a complete export of every Jira administration area. The schema explicitly records that scope. The approved workflow XML transfer remains an independent next change.
