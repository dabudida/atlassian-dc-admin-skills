# Design

## Context

`configSnapshot.ts` already provides collect-before-write, sanitized errors (`safeRead`), local conflict/backup (`localTarget`/`writeLocal`), byte budgets and CONFLICT exit code 4. Endpoints probed with GET on Jira/JSM 11.3.7: `/rest/api/2/project/{key}/priorityscheme` works. `/project/{key}/issuesecuritylevelscheme` returns 404 when the project has no scheme. The public screen scheme, issue type screen scheme and field configuration scheme resources return 404.

## Decisions

### Explicit components, explicit scope

`components` takes a list from `request-type-forms`, `jsm-queues`, `jsm-sla`, `project-schemes`, `project-fields` and `project-screens`, and is stored sorted. Service-desk components need `service_desk`. Project components need `project_key`, or default to the service desk's project. A missing scope, an unknown component, or `request_types` without `request-type-forms` is refused before any HTTP call. The JSM version gate runs only when a service-desk component is selected, so a project-only snapshot makes no JSM call.

### Reuse existing readers

- project-schemes: `resolveProjectConfig` gives the scheme references and workflow mappings. Then GET the permission scheme (grants as `permission|holder`, labeled like `jira_get_permission_scheme`), the notification scheme (events and notification labels), the issue security scheme (levels), the issue type scheme (ordered types and default), and the project priority scheme with names from `/priority`. If the shared reader reports a reference error, that area is UNAVAILABLE. A missing issue security scheme is COMPLETE with id null.
- project-fields: the `jira_get_field_configuration` handler gives the issue type → configuration groups and resolves ids. It is then paged by `field_configuration_id` with a page cap. Configurations that cannot be resolved are UNAVAILABLE. `fieldConfigurationScheme` is always UNAVAILABLE (no REST resource), so this component is PARTIAL on 11.3.
- project-screens: per issue type, create and edit screens come from "Where is my field", and the view screen from the project-config plugin. The tabs and fields of each distinct screen come from `readScreen`. Screen scheme and issue type screen scheme ids are recorded per usage row when the plugin names them; their definitions are UNAVAILABLE. Issue types and screens are capped at 200 each, beyond which coverage is PARTIAL. A 403/404 from a plugin endpoint makes that row UNAVAILABLE.
- jsm-queues: `listQueues`, keeping server order with an explicit `position`. Reaching the 500-queue cap makes coverage PARTIAL.
- jsm-sla: the `jira_get_sla_configuration` handler (condition names, goals with formatted target and calendar name) and the `jira_list_sla_calendars` handler.

Within a component, 404/405/501/Unsupported and malformed shapes become UNAVAILABLE with a reason. Other HTTP errors (401/403 on core routes) fail the export without the upstream body, as before.

### Normalization

Collections whose order Jira does not define are sorted (ids numerically, other keys by code point): issue types, grants, events, notifications, levels, workflow mappings, configurations, fields, usage rows, screens, metrics and calendars. Configured order (queues, issue type scheme, priority scheme, screen tabs and fields, SLA goals, form rows) is kept and recorded as `position`. Components contain no timestamps; capture times are only in `capture`.

### Schema v2 and naming

v2 adds `kind: "jira-config-snapshot"`, `components.<key>.status` and `coverage.components`, and records null scope ids when a scope is not used. Every area is either a scheme object with its own `status`, or the component has `sources` listing per-area statuses. Names:

- `jira-config-<sdId>.json` for the request-form-only export (unchanged).
- `jira-config-sd<sdId>[-<PROJECT>]-<components joined by +>.json` when a service desk is given.
- `jira-config-<PROJECT>-<components>.json` otherwise.

### Diff

`jira_diff_config(before, after, components?, max_items=25, max_fields=10)` reads local files only. It refuses non-regular, oversized (more than 210 MiB), non-JSON and non-snapshot files, and unsupported schema versions, and never echoes their content. v1 files are read as v2: their request-form component gets the v1 coverage status. Each component is flattened into items. Array elements are keyed by `key`/`id`/`fieldId`/`name`, falling back to the index, and duplicates get a suffix. A component's top-level object areas are items of their own. Added and removed items are listed once at their highest level, so a removed request type does not also list its rows. Changed items list sorted field changes as before→after previews: strings over 60 characters are cut, and `values*` fields are collapsed into a single `[hidden]` entry. Lists are capped and always carry totals. Warnings report different scopes or instances, components captured on one side only, and partial or differing coverage.

## Risks / Trade-offs

- Field configuration id resolution can scan up to 2,000 ids (existing tool behavior) when a non-default configuration is used. `project-fields` is opt-in for this reason.
- `resolveProjectConfig` scans issue type scheme associations: one GET per scheme.
- Captures are not atomic (`capture.atomic: false`).
- Comparisons across instances are possible, but ids may differ; the diff warns about this.
