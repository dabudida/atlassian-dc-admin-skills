# Proposal

## Why

Configuration questions ("which validator runs on this transition", "why is this field hidden on the portal", "which behaviour touches this field", "who holds this permission") need data the REST tools cannot reach: workflow functions, behaviours and Automation rules have no public read API, and answering from live REST takes hundreds of calls per question. Administrators also had to download the ScriptRunner report and the Automation export by hand.

## What Changes

- Add `adapters/config-snapshot/JiraConfigSnapshotEndpoint.groovy`, a read-only ScriptRunner REST endpoint that returns one zip: projects, schemes, workflows and drafts as XML, screens, fields with contexts and options, field configurations, permission/notification/security schemes, role members, global permissions and lookups (Java API); JSM request types with forms, portal groups, queues and SLAs, the Assets structure, the ScriptRunner report and the Automation export (REST from inside the server under the caller's session).
- Add `adapters/config-snapshot/ProbeExportEndpoints.groovy`, a read-only Script Console script that lists the export URLs of ScriptRunner and Automation from the `@Path` annotations in their jars.
- Add the `jira-config` skill: `SKILL.md` (where to look for each question), `scripts/unpack.py` (zip into `<root>/<instance>/jira-config`, instance resolved from `meta.baseUrl` through `instances.json`), `scripts/build_indexes.py` (ScriptRunner and Automation indexes).
- Document the skill in README; ignore `jira-config/instances.json`.

## Capabilities

### New Capabilities

- `jira-config-snapshot`: building, unpacking and querying a local snapshot of a Jira DC configuration.

### Modified Capabilities

None.

## Impact

New files only, outside `src/`: no change to the CLI, its tools or tests. The endpoint runs on the Jira server and needs ScriptRunner; JSM, Assets and Automation sections are skipped with an error entry where those apps are absent.
