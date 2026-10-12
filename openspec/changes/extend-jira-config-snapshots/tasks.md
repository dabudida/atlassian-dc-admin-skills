# Tasks

Builds on the unarchived `add-jsm-request-form-snapshots` change; keep its behavior (including CONFLICT exit code 4 and the output_dir validation error). TDD for each group. GET-only live checks.

## 1. Snapshot components

- [x] 1.1 Add failing tests for a project-only `project-schemes` export (sorted grants/events/mappings, priority scheme, missing security scheme, no JSM calls, scoped artifact name).
- [x] 1.2 Add `components`, `project_key` and `max_component_bytes` to `jira_export_config`; validate scope before HTTP; gate the JSM version only for service-desk components; keep the default and the legacy artifact name.
- [x] 1.3 Implement `project-schemes` through `resolveProjectConfig` and the scheme GET routes, with per-area status.
- [x] 1.4 Implement `project-fields` (field configuration handler, paged fields, scheme UNAVAILABLE) and `project-screens` ("Where is my field", project-config view screen, `readScreen`, screen schemes UNAVAILABLE), with caps.
- [x] 1.5 Implement `jsm-queues` (`listQueues`) and `jsm-sla` (SLA configuration and calendar handlers); unavailable SLA routes are explicit.
- [x] 1.6 Add normalization (a reversed-order fixture must give identical components, with no timestamps inside), the per-component byte budget, schema v2 with `kind`, and `coverage.components`.

## 2. Diff tool

- [x] 2.1 Add failing tests in `test/unit/configDiff.test.ts` for an empty diff without network, added/removed/changed with field-level values, parent-only removal, preset masking and truncation, caps, v1 compatibility, one-sided components, scope warnings, refusals and component filtering.
- [x] 2.2 Implement `jira_diff_config` in `src/tools/jira/configDiff.ts` (export `jiraConfigDiffTools`).

## 3. Verification

- [x] 3.1 Run `node --import tsx --test test/unit/configSnapshot.test.ts test/unit/configDiff.test.ts test/unit/tools.test.ts` and typecheck the owned files.
- [x] 3.2 Live (GET only): export project and service-desk snapshots twice into the scratchpad and confirm `jira_diff_config` reports identical.
- [ ] 3.3 Integrator: register `jiraConfigDiffTools`, update `atlassian-dc-admin/CONFIG_SNAPSHOTS.md` (components, diff, schema v2) and regenerate REFERENCE/bundle.
