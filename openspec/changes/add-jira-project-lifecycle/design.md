# Design

## Context

Existing tools: `jira_archive_project`/`jira_restore_project` and `jira_set_project_permission_scheme` (projects.ts), `jira_assign_project_scheme` (projectSchemes.ts), versions and `jira_get_project_components` (projectMeta.ts). There was no project creation, project update, category or component write. Routes were checked in the Jira 11.3.7 `rest/api/2/application.wadl`: `POST /project`, `GET|PUT /project/{key}`, `GET /projectvalidate/key`, `GET|POST /projectCategory`, `GET|PUT|DELETE /projectCategory/{id}`, `POST /component`, `GET|PUT|DELETE /component/{id}` (`moveIssuesTo`) and `GET /component/{id}/relatedIssueCounts`.

## Goals / Non-Goals

**Goals:** guarded, idempotent, read-back-verified project creation and update, category and component lifecycle, and shared-configuration project creation. **Non-Goals:** project deletion; setting workflow/issue type/screen/field configuration schemes through `POST /project`; changing existing tools.

## Decisions

### Project creation and `from_project`

The body follows the DC `ProjectInputBean`: `key, name, projectTypeKey, lead`, optional `projectTemplateKey, description, url, assigneeType, categoryId, permissionScheme, notificationScheme, issueSecurityScheme`. `from_project` reads `/project/{src}/permissionscheme`, `/notificationscheme`, `/issuesecuritylevelscheme` (404 → none), the category and the project type, and fills the matching fields unless given explicitly. The result names the scheme types that are not copied (workflow, issue type, issue type screen, field configuration) and points to `jira_create_project_shared` or `jira_assign_project_scheme`.

The dry run validates before describing: an existing key with the same name, type and lead (case-insensitive) and the requested category and scheme ids is already-satisfied; another category or scheme is an error pointing to `jira_update_project` / `jira_assign_project_scheme`, other name/type/lead an error pointing to `jira_update_project`. `GET /project/{key}` follows renamed keys, so the existing project counts only when its key equals the requested key; a former key is an error naming the project; `GET /projectvalidate/key` checks pattern, length, reserved words and uniqueness exactly as Jira does (probed live: `{errors:{projectKey:...}}`); name uniqueness against the project list (archived included); the lead through `GET /user`; the type against `/project/type`. After the write the project and the requested scheme ids are read back.

### Project update

Only fields that differ from the current project are sent; nothing to change is already-satisfied. Category is an id or exact name. The dry run shows before/after; the read-back compares the changed fields.

### Categories and components

Categories and components accept an id or exact (case-insensitive) name; an ambiguous name is an error. Create is already-satisfied when the same name exists with the given settings, and refuses a same-named object with other settings (pointing to the update tool). Category delete names the projects that lose the category (preview capped with a total). Component delete states the related issue count and accepts `move_issues_to` (same project, not the component itself). Component reads reuse the same `GET /project/{key}/components` call as `jira_get_project_components`; because projectMeta.ts inlines it in the handler, a small local reader is used rather than editing that file.

### Shared configuration (JSM and others)

`POST /rest/project-templates/1.0/createshared/{existingProjectId}` is listed in the project-templates plugin's `application.wadl` on 11.3.7 (`createSharedProject`, JSON). The "Create with shared configuration" dialog's web resource sends JSON `{key, name, lead}` (no XSRF header needed for JSON) and reads `{projectId, projectKey, projectName, returnUrl}`. The tool validates key, name and lead like `jira_create_project`, then verifies that the new project uses the source's permission, notification, issue type (scanned through `/issuetypescheme/{id}/associations`, as DC has no per-project route) and workflow schemes. A scheme unreadable on either side is not a match: the result carries `verification: {status: "partial", unverified}`. An existing target with the same name, type and shared schemes is already-satisfied. The route is internal: a later Jira version may change it; the read-back turns such a change into a verification error rather than a silent success.

### Invalidation

Project creation (both tools) invalidates `workflow-usage` and `screen-usage` scans; other writes invalidate nothing.

## Risks / Trade-offs

- `createshared` is an internal route → evidenced on 11.3.7 only; the read-back detects behavior changes.
- Name uniqueness reads the full project list → one bounded call per create; acceptable for an admin write.
- Component create compares only the settings the caller gives → "ensure exists" semantics; a conflicting given setting is an error.

## Migration Plan

Register `jiraProjectLifecycleTools` in `src/tools/index.ts` (suggested group "Jira project lifecycle"), add `jira_list_project_categories` to the reference, regenerate the bundle. Rollback removes the file and registration; no instance state is migrated.

## Local Implementation Evidence (2026-10-11)

20 unit tests (fake Jira) cover dry runs, validation failures, `from_project` copying and overrides, read-back verification failures, already-satisfied paths and no-argument safety. Live 11.3.7 checks with a GET-only fetch guard: category listing, dry runs of project create (with `from_project`), project update, category create, component create and shared create; an invalid key is rejected by `projectvalidate/key`. No write was sent.
