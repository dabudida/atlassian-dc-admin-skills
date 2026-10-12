# Proposal

## Why

`jira_export_config` (change `add-jsm-request-form-snapshots`, implemented but not archived) captures only JSM request-type forms. Administrators also need a baseline of a project's schemes, field configurations and screens, and of a service desk's queues and SLAs, and a way to see what changed between two captures without reading two large JSON files by hand.

## What Changes

- Add an explicit `components` argument to `jira_export_config`. The default stays `["request-type-forms"]`, so existing calls behave as before. New components: `project-schemes`, `project-fields`, `project-screens` (one project key) and `jsm-queues`, `jsm-sla` (one service desk). A snapshot can contain only service-desk components or only project components.
- Each component and area records COMPLETE/PARTIAL/UNAVAILABLE coverage. Areas Jira 11.3 does not expose over REST (field configuration schemes, screen schemes, issue type screen schemes) are recorded as UNAVAILABLE with a reason, not left out or shown as empty.
- Normalize component content: stable ordering, and no timestamps inside components. Two captures of an unchanged instance then have identical components.
- Each component has a size budget (`max_component_bytes`), alongside the existing total budget.
- Bump the snapshot to schema v2 (adds a `kind` marker and per-component status). Artifact names include the scope and component list. The request-form-only export keeps its old `jira-config-<serviceDeskId>.json` name.
- Add the read tool `jira_diff_config`. It compares two local snapshot files (v1 or v2) and reports a bounded diff per component. It refuses files that are not snapshots or that use an unsupported schema. Hidden preset values are never printed, and long text appears only as a short preview.

## Capabilities

### New Capabilities

- `jira-config-snapshot-components`: explicit multi-component Jira configuration snapshots with per-area coverage and normalized content.
- `jira-config-snapshot-diff`: a bounded, local comparison of two snapshots.

### Modified Capabilities

None in `openspec/specs/`. This change builds on the unarchived `jira-config-request-form-snapshot` capability and keeps its behavior. Only the schema version number changes, to 2.

## Impact

Edits `src/tools/jira/configSnapshot.ts` and `test/unit/configSnapshot.test.ts`. Adds `src/tools/jira/configDiff.ts` (exports `jiraConfigDiffTools`) and `test/unit/configDiff.test.ts`. The integrator registers `jiraConfigDiffTools` in `src/tools/index.ts`, updates `atlassian-dc-admin/CONFIG_SNAPSHOTS.md` and the generated reference, and rebuilds the bundle. Reuses the existing readers `resolveProjectConfig`, `listQueues`, `readScreen`, `whereIsMyField`, `jira_get_field_configuration` and the `jira_get_sla_configuration`/`jira_list_sla_calendars` handlers. No new dependency, no Jira write.
