# JSM request-form configuration snapshots

`jira_export_config` captures the request-type forms of one service desk, selected by id or project key. The first component is `request-type-forms`; other Jira configuration areas are not captured. All remote requests are GET. It does not create portal requests or change Jira configuration.

Create an ignored local output directory, then export:

```sh
mkdir -p .scratch/jsm-before
node atlassian-dc-admin/scripts/atlassian-admin.mjs jira_export_config '{"service_desk":"BANK","output_dir":".scratch/jsm-before"}'
```

Optional selection uses ids or exact names; ambiguous names require an id:

```json
{"service_desk":"3","output_dir":".scratch/jsm-before","request_types":["83","Incident"]}
```

The artifact is `jira-config-<serviceDeskId>.json`, schema version 1. It records source/version evidence, capture interval, inventory coverage, request-type identity and ordered visible/hidden fields. Visible positions start at 1. `sdRequired` and `jiraRequired` remain separate; effective `required` is true if either is true, false only if both are false, otherwise null. Missing/non-boolean flags are unknown, never optional by inference.

Public discovery is paged; hidden discovery and form routes use internal JSM resources under the existing 11.3.x policy. Actual observed versions are recorded. Unsupported/404 sources and malformed form sources are explicitly unavailable; successful peers remain in the snapshot. Authorization or malformed discovery fails the export. Inventory completeness does not prove transaction consistency: capture spans multiple GETs and is explicitly non-atomic.

Hidden preset values are omitted by default and marked `presetOmitted:true`. `include_presets:true` retains sensitive values only in the local artifact. Keep those artifacts in ignored storage and review them before sharing. Tool output contains metadata, coverage, hashes and bounded diagnostics, not field descriptions or values.

Defaults are 100 inventoried request types and 20 MiB serialized JSON. `max_request_types` allows 1–1,000; `max_total_bytes` allows 1–209,715,200. Limits apply before file publication. Explicit selection does not bypass the inventory cap. `output_dir` must already exist. Symlinks/non-regular destination files are refused.

A different existing file produces `CONFLICT` and stays unchanged. Use a new directory per capture, or pass `overwrite:true` to back up and replace it. Capture timestamps normally make repeat exports different. An identical byte sequence is `ALREADY-SATISFIED`. A conflict result's hash describes the proposed bytes, not the retained old artifact; only WRITTEN/REPLACED/ALREADY-SATISFIED identify the published bytes.

Local fixtures establish serialization, coverage and file-handling behavior. They do not establish exact-version live compatibility, restorability, validation of scripts or a complete Jira backup.
