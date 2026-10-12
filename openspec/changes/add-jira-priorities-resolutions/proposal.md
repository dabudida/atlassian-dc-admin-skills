# Proposal

## Why

Administrators cannot see or manage priorities, resolutions and priority schemes with the tools today. Jira DC publishes a REST API for priority schemes and their project assignment, but none for creating priorities or resolutions, so the tools must use the API where it exists and give verified UI steps where it does not.

## What Changes

- Add `src/tools/jira/priorities.ts` exporting `jiraPriorityTools`.
- Reads: `jira_list_priorities`, `jira_list_resolutions`, `jira_list_priority_schemes` (default flag, default priority, priority count, project keys capped), `jira_get_priority_scheme` (ordered priorities, default, project keys).
- REST writes, dry run by default, idempotent and read back: `jira_create_priority_scheme`, `jira_update_priority_scheme` (name, description, ordered priorities and default by id or exact name), `jira_delete_priority_scheme`, `jira_assign_priority_scheme` (manual when Jira would migrate issue priorities).
- Manual writes (no REST endpoint): `jira_create_priority`, `jira_create_resolution`, using `manualStep()` from `src/tools/jira/manualSteps.ts` (added by `add-jira-notification-security-scheme-writes`).

## Capabilities

### New Capabilities

- `jira-priorities-resolutions`: reading priorities and resolutions, and managing priority schemes and their project assignment.

### Modified Capabilities

None.

## Impact

New files only: the tool module and `test/unit/jiraPriorities.test.ts`. The integrator registers `jiraPriorityTools` in `src/tools/index.ts` and documents the tools. No dependency or configuration change.
