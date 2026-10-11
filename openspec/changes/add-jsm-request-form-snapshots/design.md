# Design

## Context

See proposal.md and the approved roadmap for item 11. The previous custom-endpoint comment is excluded. The earlier `fix-jsm-required-state-and-portal-checks` change is implemented locally but not archived; its working-tree implementation is the prerequisite baseline for mandatory-state semantics. Do not overwrite or archive it.

Existing `resolveServiceDesk`, `resolveRequestType` and the form reader in `requestTypes.ts` cover the required routes. `listRequestTypes` silently stops at 1,000 items, so it cannot prove snapshot completeness. The internal hidden list uses `/rest/servicedesk/1/servicedesk/{projectId}/request-type-groups/hidden/request-types` in current fixtures. `scriptRoot.ts` supplies localTarget/writeLocal/sha256 and conflict/backup behavior; `.scratch/` is already ignored.

## Goals / Non-Goals

**Goals:** produce a reusable request-form component with stable identities and explicit coverage in a repository-owned Jira-config file. **Non-Goals:** every Jira administration component, workflow XML, issue content, restoration/import, server adapters, browser interactions or changes to existing form-tool semantics.

## Decisions

### One scoped read tool and one artifact

Add `jira_export_config` with `service_desk`, required `output_dir`, optional `request_types` (ids or exact names), `include_presets=false`, `overwrite=false`, `max_request_types=100` (hard cap 1,000), and `max_total_bytes=20 MiB` (hard cap 200 MiB). Only `request-type-forms` is captured; schema v1 declares `components.requestTypeForms` and a scope note rather than inventing empty Automation/Behaviours/workflow sections.

Save `jira-config-<numeric-service-desk-id>.json` under the selected output directory. Collection precedes any directory/file creation. Version and capture timestamps make repeat snapshots different, so conflicts are normal; use a new output directory per capture or explicitly request backup-and-replace. Local artifact writes follow existing export tools and are GET-only toward Jira; they are not modeled as Jira mutations.

### Reuse routes, preserve unknowns

Extract/export a narrowly scoped raw form reader shared with existing form tools, or expose the existing reader and retain a raw view only for snapshot serialization. The current reader coerces missing flags with `!!`; the snapshot must inspect raw response flags and represent absent/non-boolean flags as null plus a coverage warning. Do not change required-field write semantics or silently broaden the prior fix in this change.

Inventory is paged through the existing public route with limit 50 until `isLastPage=true`; reject duplicate/non-progressing pages and more items than the configured cap. Merge the internal hidden array by numeric id, preferring public identity and filling hidden-only issue type ids from `issueType.id`. Validate response shape; record unsupported/404 hidden discovery as partial. Existing public ids repeated between sources are deduplicated; conflicting names or issue-type identities are a diagnostic rather than guessed mappings. Explicit selection is resolved only after discovery, and ambiguous names fail.

For each selected request type collect visible/hidden rows and preserve server array order; addable rows are outside the snapshot scope. A missing or unsupported form is `UNAVAILABLE`; HTTP 401/403 fail the operation. Preserve separate source statuses when visible or hidden data cannot be read. Unexpected non-array data or missing row identity must not become a successful empty form.

Schema fields: `schemaVersion`, `source` (base URL without credentials/query, observed versions), `capture` (start/end and `atomic:false`), `scope` (serviceDesk/project/component/selection), `coverage` (inventory sources and complete/partial/unavailable counts), `requestTypes` (id/name/issueTypeId/portal visibility and form status), and form `visible`/`hidden` arrays. Raw flags are true/false/null. Effective required is true if either flag is true, false only if both are false, otherwise null. Preset omission is explicit and is not a coverage failure when requested policy is satisfied.

### Local integrity and bounded output

Serialize complete JSON once, enforce byte budget before local creation, then use `localTarget` and `writeLocal` with regular-file/symlink checks. Do not copy script-root-specific warnings or dependencies into the snapshot module. Return artifact path/hash/bytes/outcome, selected and unavailable counts, capture interval and coverage; cap any diagnostic identity list at 50 with a total. Error text includes field/request-type identity and status only, without descriptions/presets/raw payloads.

## Risks / Trade-offs

- Hidden inventory is an internal installation-specific API → retain the existing JSM 11.3.x policy and record exact observed versions; unsupported routes are partial coverage.
- Multi-request capture can mix concurrent changes → label the artifact non-atomic and capture its interval. Do not promise restoration or cross-node transaction consistency.
- Existing form coercion loses unknown flags → snapshot uses a raw view without changing old tools' contracts.
- Sensitive values in an explicit preset export → recommend ignored `.scratch/` output and keep the opt-in artifact local; CLI output remains content-free.
- Output may be large → bounded inventory/byte budgets and collect-before-write prevent partial artifact publication.

## Migration Plan

Implement after the earlier JSM correctness slice, add the registry entry, tests and a focused CONFIG_SNAPSHOTS reference, then build the bundle/reference. No production installation or state migration is required. Rollback removes the new export tool/package revision and does not delete exported evidence. Full local checks and review are required; exact-instance verification is separate and read-only.

## Local Implementation Evidence (2026-10-09)

Implemented and reviewed locally. Eighteen snapshot tests cover ordering, unknown mandatory flags, presets, paged/hidden inventory, numeric exact names, coverage/auth failures, limits and local conflicts. Review's numeric-name finding has a regression and fix. Final combined repository suite: 976/976 pass; typecheck, build, strict OpenSpec validation and diff checks pass. Exact-instance live snapshot evidence remains NOT_RUN. The earlier JSM change remains unarchived and its working-tree changes are retained.
