# Proposal

## Why

Administrators can archive/restore projects, assign schemes and manage versions, but they cannot create a project, change its basic details, manage project categories or components, or create a project that shares another project's configuration (the usual way new JSM desks are set up). These steps are still done by hand in the Jira UI.

## What Changes

- Add `jira_create_project` (`POST /rest/api/2/project`): key, name, project type, lead, optional template, description, url, assignee type, category and permission/notification/issue security scheme ids. `from_project` reads the scheme assignments, category and type of an existing project and passes those ids; explicit values win. The dry run validates the key with Jira's own `projectvalidate/key`, the name, the lead and the type.
- Add `jira_update_project` (`PUT /rest/api/2/project/{key}`) for name, lead, description, url, assignee type and category.
- Add `jira_list_project_categories` plus create/update/delete category writes (`/rest/api/2/projectCategory`).
- Add component create/update/delete writes (`/rest/api/2/component`, delete with optional `moveIssuesTo`); reads stay with `jira_get_project_components`.
- Add `jira_create_project_shared` using the internal `POST /rest/project-templates/1.0/createshared/{existingProjectId}` route, evidenced by the plugin WADL and the Jira dialog's web resource.
- Every write is dry-run by default, idempotent (already-satisfied) and verified by reading the result back.

## Capabilities

### New Capabilities

- `jira-project-lifecycle`: create and change projects, project categories and components, and create projects with shared configuration.

### Modified Capabilities

None. Archive/restore (`projects.ts`), scheme assignment (`projectSchemes.ts`) and versions (`projectMeta.ts`) keep their contracts.

## Non-Goals

- Project deletion (irreversible and removes every issue) is deliberately not offered.
- Setting workflow, issue type, issue type screen or field configuration schemes at creation: `POST /project` does not accept them on DC; use `jira_create_project_shared` or `jira_assign_project_scheme`.

## Impact

New `src/tools/jira/projectLifecycle.ts` exporting `jiraProjectLifecycleTools` and `test/unit/projectLifecycle.test.ts`. The integrator registers the array in `src/tools/index.ts`, adds `jira_list_project_categories` handling to docs/reference, and regenerates the bundle. No new dependency.
