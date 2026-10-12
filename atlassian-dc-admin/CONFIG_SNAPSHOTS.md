# Jira configuration snapshots and diff

`jira_export_config` captures the request-type forms of one service desk, selected by id or project key. `components` selects what is captured (default `request-type-forms`): service-desk components `request-type-forms`, `jsm-queues`, `jsm-sla`; project components (`project_key`, or the service desk's project) `project-schemes`, `project-fields`, `project-screens`. Field configuration schemes, screen schemes and issue type screen schemes have no public route on 11.3 and are recorded as UNAVAILABLE areas, so `project-fields`/`project-screens` are PARTIAL there. `project-fields` may scan many field configurations; select it only when needed. All remote requests are GET. It does not create portal requests or change Jira configuration.

Create an ignored local output directory, then export:

```sh
mkdir -p .scratch/jsm-before
node atlassian-dc-admin/scripts/atlassian-admin.mjs jira_export_config '{"service_desk":"BANK","output_dir":".scratch/jsm-before"}'
```

Optional selection uses ids or exact names; ambiguous names require an id:

```json
{"service_desk":"3","output_dir":".scratch/jsm-before","request_types":["83","Incident"]}
```

The forms-only artifact is `jira-config-<serviceDeskId>.json`; other selections are named after scope and components (`jira-config-sd<id>[-<PROJECT>]-<components>.json`, `jira-config-<PROJECT>-<components>.json`). Schema version 2 (`kind: jira-config-snapshot`, per-component status); components contain no timestamps and are stably sorted. It records source/version evidence, capture interval, inventory coverage, request-type identity and ordered visible/hidden fields. Visible positions start at 1. `sdRequired` and `jiraRequired` remain separate; effective `required` is true if either is true, false only if both are false, otherwise null. Missing/non-boolean flags are unknown, never optional by inference.

Public discovery is paged; hidden discovery and form routes use internal JSM resources under the existing 11.3.x policy. Actual observed versions are recorded. Unsupported/404 sources and malformed form sources are explicitly unavailable; successful peers remain in the snapshot. Authorization or malformed discovery fails the export. Inventory completeness does not prove transaction consistency: capture spans multiple GETs and is explicitly non-atomic.

Hidden preset values are omitted by default and marked `presetOmitted:true`. `include_presets:true` retains sensitive values only in the local artifact. Keep those artifacts in ignored storage and review them before sharing. Tool output contains metadata, coverage, hashes and bounded diagnostics, not field descriptions or values.

Defaults are 100 inventoried request types and 20 MiB serialized JSON. `max_request_types` allows 1–1,000; `max_total_bytes` allows 1–209,715,200. Limits apply before file publication. Explicit selection does not bypass the inventory cap. `output_dir` must already exist. Symlinks/non-regular destination files are refused.

A different existing file produces `CONFLICT` (exit 4) and stays unchanged; a missing or non-directory `output_dir` is a validation error (exit 7). Use a new directory per capture, or pass `overwrite:true` to back up and replace it. Capture timestamps normally make repeat exports different. An identical byte sequence is `ALREADY-SATISFIED`. A conflict result's hash describes the proposed bytes, not the retained old artifact; only WRITTEN/REPLACED/ALREADY-SATISFIED identify the published bytes.

## Diff

`jira_diff_config before=FILE after=FILE` compares two local snapshots (v1 or v2) without network access: added, removed and changed items per component with field-level before→after, capped by `max_items`/`max_fields` with totals. Long strings are truncated and hidden preset values shown as `[hidden]`. It warns when scopes, instances or coverage differ. Two captures of an unchanged instance diff as `identical: true`. A component captured on one side only gives `identical: false`; a requested component in neither file gives `identical: null` with `identicalReason`. `scope.projectId` is the captured project's own id; `scope.serviceDeskProjectId` is the service desk's project.

Local fixtures establish serialization, coverage and file-handling behavior. They do not establish exact-version live compatibility, restorability, validation of scripts or a complete Jira backup.
