---
name: jira-config
description: >-
  Local snapshot of a Jira Data Center configuration in <instance>/jira-config: projects, schemes,
  workflows and their XML, screens, fields with contexts and options, required/hidden fields,
  permission/notification/security schemes, roles, JSM request type forms, queues and SLAs, the
  Assets structure, and indexes of ScriptRunner scripts and Automation rules. Use it for questions
  about how Jira is configured (which workflow an issue type uses, which fields are on a screen,
  whether a field is required, why a field is not visible, which script or validator runs on a
  transition, which listener/behaviour/job/Automation rule exists, who holds a permission, what a
  request type form looks like) and when asked to refresh or unpack a snapshot (a downloaded
  jira-config-*.zip).
---

# Jira configuration snapshot

The snapshot lives in `<root>/<instance>/jira-config/`. It is a cache: never edit it by hand.
`<instance>` comes from `instances.json` next to this file (host → folder, see `instances.example.json`).

It is produced by the ScriptRunner REST endpoint `adapters/config-snapshot/JiraConfigSnapshotEndpoint.groovy`
(deployed as a file in the Script Root; Jira 11 needs `jakarta.*`). One zip carries the Jira configuration,
the ScriptRunner report and the Automation export.

## Refresh the snapshot

1. The user opens, as a Jira administrator: `<baseUrl>/rest/scriptrunner/latest/custom/jiraConfigSnapshot`.
   `jira-config-<timestamp>.zip` is downloaded.
   - `?exclude=Category1,Category2` leaves out projects of those categories.
   - `?skip=jsm,assets,scriptrunner,automation,drafts,options` leaves out slow sections.
2. Unpack (the instance is resolved from `baseUrl` inside the zip; without `--zip` the newest zip in Downloads/Desktop is used):
   ```
   python ".claude/skills/jira-config/scripts/unpack.py"
   python ".claude/skills/jira-config/scripts/unpack.py" --zip "<path>/jira-config-YYYYMMDD-HHMMSS.zip"
   ```
   The script replaces only `<instance>/jira-config/`, unpacks the embedded ScriptRunner report into
   `jira-config/scriptrunner/`, keeps the Automation export as `jira-config/automation-rules.json` and rebuilds the indexes.

Rebuild only the indexes (for example after unpacking a ScriptRunner report by hand):
```
python ".claude/skills/jira-config/scripts/build_indexes.py" --instance <instance>
```

Tell the user the lines the scripts printed, including every `error` (objects the endpoint could not read).
Do not open the snapshot content unless a question needs it.

## Answering configuration questions

Find the instance first. Never read whole exports: grep one index in `<instance>/jira-config/index/`, then open one JSON or XML file.

| Question | Where to look |
|---|---|
| Snapshot date, base URL, Jira version | `sources.json`, `meta.json` |
| Issue types, workflow per type, create/edit/view screens, project schemes, lead, components, roles | `projects/<KEY>.json` |
| Project → category / scheme ids / lead | `index/projects.tsv` |
| Scheme by id | `workflow-schemes/`, `issue-type-schemes/`, `issue-type-screen-schemes/`, `screen-schemes/`, `field-layout-schemes/` → `<id>.json` |
| Scheme by name | grep `index/<scheme-type>.tsv`, then one JSON |
| Workflow statuses | `workflows/<slug>.json`, slug from `index/workflows.tsv` |
| Steps, transitions, conditions, validators, post-functions | one XML in `workflow-xml/`, file name from `index/workflow-xml.tsv` (all workflows, column `active`). Do not list the folder |
| Unpublished workflow draft | `workflow-xml-drafts/`, index `index/workflow-xml-drafts.tsv` |
| Fields of a screen | `screens/<id>.json` |
| Screens a field is on | grep `index/screen-fields.tsv`, not `screens/` |
| Field type and contexts | `fields/<customfield_id>.json`, system fields in `fields/system.json`, id by name in `index/fields.tsv` |
| Select field options (option ids) | grep `index/field-options.tsv` (`parentOptionId` for cascading selects) |
| Hidden / required / renderer | grep `index/field-layout-items.tsv`. `field-layouts/` holds exceptions only: no row means visible and optional. The project's field configuration scheme is `fieldConfigurationScheme` in `projects/<KEY>.json` |
| Who is in a project role | grep `index/project-roles.tsv` |
| Who holds a permission | grep `index/permission-grants.tsv`; the project's scheme in `index/projects.tsv`; whole scheme in `permission-schemes/<id>.json` |
| Notifications | grep `index/notifications.tsv`, `notification-schemes/<id>.json` |
| Issue security levels | grep `index/issue-security-levels.tsv`, `issue-security-schemes/<id>.json` |
| Statuses, priorities, resolutions, link types, categories, roles, events, global permissions | `globals/<name>.json` |
| JSM request types and forms (labels, required, hidden fields with preset values) | grep `index/jsm-request-types.tsv` and `index/jsm-request-type-fields.tsv`, then `jsm/<KEY>/request-types/<id>.json` |
| JSM portal groups, queues, SLAs | `jsm/<KEY>/service-desk.json`, queues in `index/jsm-queues.tsv` |
| Assets object types, attributes, statuses (no objects) | grep `index/assets-object-types.tsv` / `index/assets-attributes.tsv`, then `assets/<schemaId>.json` |
| Script on a transition | grep `index/sr-workflow-functions.tsv` (column `draft` for draft functions); JSON in `scriptrunner/workflowFunctions/<id>.json`; code in `scriptrunner/default_script_root_scripts/<script>` |
| Listeners, jobs, behaviours, REST endpoints, fragments, script fields, JQL functions | grep `index/sr-features.tsv`, then `scriptrunner/<folder>/<id>.json` or the script file |
| Automation rule | grep `index/automation-rules.tsv`, then that rule by id in the export (path in `sources.json`). Never read the whole export |

Common traps:

- A field is on the screen but not on the issue: its context does not cover the project or issue type (`fields/<id>.json`).
- An empty `script` in `sr-*.tsv` means inline code: it is inside the feature JSON.
- The snapshot is a point-in-time copy (`configGeneratedAt`). After a recent change, read the live instance instead.
- JSM, Assets, ScriptRunner and Automation are read over REST from inside the server under the session of whoever opened the link. HTTP 401/403 in `errors.json` for those scopes means the session did not reach the call or the user lacks rights; the rest of the snapshot is still complete.
- After a plugin upgrade the export URLs may move: run `adapters/config-snapshot/ProbeExportEndpoints.groovy` in the Script Console to list the current ones.
- The snapshot holds script code, internal URLs and role members: keep it local.
