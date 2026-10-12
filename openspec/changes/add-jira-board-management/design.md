# Design

## Context

`boardConfig.ts` already reads the board edit model (`GET /rest/greenhopper/1.0/rapidviewconfig/editmodel?rapidViewId=N`) and changes Detail View fields through the internal `detailviewfield` RestfulTable resource, gated by `requireJiraVersion`. Its helpers are module-private, so this change keeps small local equivalents (edit-model read, part settling) instead of editing that file.

## Evidence for internal routes (Jira 11.3.7, GET only)

The board configuration UI script (`/download/contextbatch/js/gh-rapid-config/batch.js`, served anonymously by the instance) contains the exact calls; GET probes confirm each path exists (HTTP 405 = path exists without GET, 404 = no such path):

| Purpose | Request the UI sends | GET probe |
|---|---|---|
| Saved filter | `PUT /rapidviewconfig/filter {id, savedFilterId}` | 405 |
| Columns | `PUT /rapidviewconfig/columns {rapidViewId, currentStatisticsField:{id}, mappedColumns:[{id?, name, min, max, isKanPlanColumn, mappedStatuses:[{id}]}]}` | 405 |
| Swimlane strategy | `PUT /rapidviewconfig/swimlaneStrategy {id, swimlaneStrategyId}` (custom, parentChild, assignee, assigneeUnassignedFirst, epic, project, none) | 405 |
| Query swimlanes | RestfulTable on `/swimlanes/{board}/` — POST create, PUT/DELETE `/{id}`, POST `/{id}/move` | `/swimlanes/{b}` 405, `/{id}` 200, `/{id}/move` 405 |
| Quick filters | RestfulTable on `/quickfilters/{board}/` (name, query, description) | `/quickfilters/{b}` 200, `/{id}` 200, `/{id}/move` 405 |
| Card color strategy | `PUT /cardcolors/{board}/strategy {id, cardColorStrategyId}` (issuetype, priority, assignee, custom, none) | 405 |
| Card colors | `GET /cardcolors/{board}/strategy/{s}?preloadValues=true`; RestfulTable on `/cardcolors/{board}/color/` (PUT row JSON; custom rows POST `{strategy:"custom", value, color}`) | GET 200, `/color` 405 |

Writes are documented as "internal, verified for the 11.3 structure only": the request shapes come from the shipped UI code and the edit model structure, but were not sent to the production instance. Board create and delete use the public agile API (`POST /rest/agile/1.0/board`, `DELETE /rest/agile/1.0/board/{id}`).

## Decisions

### Gates and permissions
Every internal write calls `requireJiraVersion` before anything is planned and refuses with an authorization error when the edit model's `canEdit` (or the section's `canEdit`) is false. Reads do not need the version gate.

### Columns
`columns` is the complete ordered JSON list `[{name, statuses:[id|exact name], min?, max?}]`. Valid statuses are the edit model's mapped plus unmapped statuses (the statuses of the board's project workflows). A status may appear in only one column; unknown statuses, duplicate names and empty lists are refused before sending. Existing column ids are kept: an explicit `id` in a column wins, otherwise the first unused column with the same (case-insensitive) name. Jira allows several columns with one name (seen on the live instance), so names alone are not unique. Ids keep the Kanban backlog flag attached. A status that is mapped today and would become unmapped is refused unless `allow_unmapped=true`; statuses that are unmapped today and stay unmapped are listed, not refused. `constraint` (none, issueCount, issueCountExclSubs) defaults to the current one. Read-back compares names, status ids, min/max and the constraint.

### Swimlanes
`strategy` sets the strategy; `lanes` (only with the custom strategy: refused unless the resulting strategy is custom) is the complete ordered list of query lanes `[{name, query, description?}]`. The default lane (`isDefault`, "Everything Else") is never deleted and stays last. Lanes are matched by name; names and JQL are compared trimmed because Jira stores JQL with trailing blanks as typed (seen on the live instance): removed ones are deleted, changed ones updated, new ones created, then moved into order (moves are computed only over lanes present both on the board and in the list) with `{position:"First"}` or `{after:<absolute row url>}` like the Detail View. Read-back compares strategy and lanes.

### Quick filters
Create (same name and query → already-satisfied, same name otherwise → error), update (by id or exact name), delete (gone → already-satisfied; the plan state carries the quick filter's id and JQL, so a same-name filter recreated after approval drifts). Read back via `GET /quickfilters/{board}`.

### Card colors
`strategy` and/or `colors` `[{value, color}]` with `#rrggbb` colors. For issuetype/priority/assignee, rows are matched by value id or display name and only named rows change. For custom, `colors` is the complete ordered list of JQL rows (created, updated, deleted; reordering is not supported and the result reports the server order). The strategy is switched first, then rows are planned against the new strategy's preloaded rows.

### Create and delete board
Create resolves `filter` as a numeric id (`GET /rest/api/2/filter/{id}`) or an exact favourite filter name (Jira DC cannot search all filters). A board with the same name, type and filter → already-satisfied, provided a requested `project_key` matches the board's location (key or id, from the list item or `GET /board/{id}`); a different or unreadable location → error. Same name otherwise → error. More than 500 boards from the name search → error asking for a more specific name, since a duplicate beyond the cap cannot be ruled out. Delete accepts the board id; the dry-run summary names the board, type, filter, column/quick-filter/swimlane counts and states that issues, the saved filter and sprints are not deleted. Already gone → already-satisfied; read-back expects 404.

## Risks / Trade-offs

- Internal API shapes may change between Jira versions → version gate to 11.3.x and read-back verification.
- Multi-step swimlane and card color changes are not atomic → each step is idempotent, a re-run continues from the current state, and the read-back reports the actual state on mismatch.
- Name matching of columns/lanes keeps ids for renamed items only when names stay the same; a rename is planned as delete + create for lanes (columns: a renamed column gets a new id and its statuses).

## Live verification (Jira 11.3.7, GET only)

A guarded fetch that rejects every non-GET request ran all read tools and write dry runs. On all 40 boards, feeding the current columns (with ids) and the current swimlanes back into `jira_set_board_columns` / `jira_set_board_swimlanes` reports already-satisfied, and so do the current card colors on the 6 boards that use colors; dry runs of every other write produce the expected internal request.
