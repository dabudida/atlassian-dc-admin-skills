# Design

## Context

Scheme tools follow the patterns of `queues.ts` and `schemes.ts`: id-or-exact-name resolution, dry run by default, `already_satisfied` when nothing would change, read-back after the write and `VerificationError` when it does not hold. Plan drift uses `identity` and `state`.

## Findings (read-only on Jira DC 11.3.7: WADL and GET requests, nothing written)

**WADL (`/rest/api/2/application.wadl`):** `GET /priority`, `GET /priority/page`, `GET /priority/{id}`, `GET /resolution`, `GET /resolution/page`, `GET /resolution/{id}`; `GET|POST /priorityschemes`; `GET|PUT|DELETE /priorityschemes/{schemeId}`; `GET|PUT /project/{projectKeyOrId}/priorityscheme`; `DELETE /project/{projectKeyOrId}/priorityscheme/{schemeId}`. There is **no** POST/PUT/DELETE for `/priority` or `/resolution`; `/rest/api/2/priorityscheme` (singular) is 404.

**GET shapes:** `/priority` → `[{id, name, description, statusColor, iconUrl}]`; `/resolution` → `[{id, name, description}]`; `/priorityschemes?expand=schemes.projectKeys` → `{startAt, maxResults, total, schemes: [{id, name, description, defaultOptionId?, optionIds[], defaultScheme, projectKeys[]}]}` (a scheme may have no `defaultOptionId`); `/project/{key}/priorityscheme` → the scheme object, the same as `/priorityschemes/{id}`.

**Admin pages (GET):** `ViewPriorities.jspa`, `ViewResolutions.jspa`, `ViewPrioritySchemes.jspa`, `EditPriorityScheme!default.jspa`, `AssociatePriorityScheme!default.jspa?projectId=` answer with the websudo prompt (the actions exist); `AddPriority!default.jspa` and `AddResolution!default.jspa` are not GET pages (the add forms sit on the View pages); `SelectProjectPriorityScheme` does not exist.

## Decisions

### Reads

Priorities and resolutions are small global lists: fetched whole, filtered by `name_contains` and paged locally. Priority schemes are read through the paged endpoint with `expand=schemes.projectKeys` (cap 1000), then filtered and paged locally; project key lists are capped with `capList` (`full_lists=true` for all). Rows show the default priority as `{id, name}` or `null`.

### Priority scheme writes

The POST/PUT body is `{name, description, defaultOptionId?, optionIds}` as the scheme reads back; idempotence compares exactly that, so order matters. Priorities and the default are accepted by id or exact name; unknown or duplicate priorities and a default outside the list are validation errors.

- **Create:** same name and settings → `already_satisfied`; same name with other settings → error pointing to update. Read back by name.
- **Update:** unspecified fields keep their current values; the dry run shows `before`/`after` with names. Read back through `GET /priorityschemes/{id}`. Jira refuses an update that would need an issue migration; that error is passed through.
- **Delete:** missing → `already_satisfied`; the summary names the projects that fall back to the default scheme; read back that the scheme is gone.
- **Default scheme:** Jira keeps it with all priorities; update and delete refuse it before any request.
- **Assign:** current scheme from `GET /project/{key}/priorityscheme`; same → `already_satisfied`. If `project = KEY AND priority not in (<scheme priorities>)` finds issues, Jira would migrate them; the tool never migrates issues and returns a manual item for `AssociatePriorityScheme`. Otherwise `PUT /project/{key}/priorityscheme` `{id}` and read back.

### Priorities and resolutions: manual

`jira_create_priority` and `jira_create_resolution` return `already_satisfied` for an existing name (case-insensitive) and otherwise a MANUAL item for `ViewPriorities.jspa` / `ViewResolutions.jspa` with steps; executing it raises `Unsupported`. A re-run verifies through `GET /priority` / `GET /resolution`. Editing or deleting priorities and resolutions is out of scope.

## Risks / Trade-offs

- POST/PUT/DELETE were not executed on the live instance (forbidden there) → each execution is read back and fails loudly when the state differs.
- Refusing to edit the default scheme is conservative; if a Jira version allows it, the UI remains available.
- `priority not in (...)` ignores issues without a priority, which Jira does not migrate either.

## Migration Plan

Register `jiraPriorityTools` in `src/tools/index.ts` (suggested group: "Jira priorities & resolutions") and add the tools to the skill reference. No state migration; rollback removes the module.
