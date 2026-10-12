# Tasks

## 1. Evidence and contract

- [x] 1.1 Probe the live 11.3.7 instance with GET only: board list, edit model structure, card color strategy reads, 405/404 probes of internal write paths, and the shipped board configuration script; record the routes in design.md.
- [x] 1.2 Write the spec delta for `jira-board-management` and validate with `openspec validate add-jira-board-management --strict`.

## 2. Tests first

- [x] 2.1 Create `test/unit/jiraBoardManagement.test.ts` with a fake board (edit model, quick filters, swimlanes, card colors, agile board) and failing cases for every tool: dry run, already-satisfied, refusal cases, executed write and read-back.

## 3. Implementation

- [x] 3.1 `jira_create_board` and `jira_delete_board` over the public agile API.
- [x] 3.2 `jira_set_board_filter` with version gate and edit rights.
- [x] 3.3 `jira_get_board_columns` and `jira_set_board_columns` with status validation and unmapped-status guard.
- [x] 3.4 `jira_get_board_swimlanes` and `jira_set_board_swimlanes`.
- [x] 3.5 Quick filter list/create/update/delete.
- [x] 3.6 `jira_get_board_card_colors` and `jira_set_board_card_colors`.
- [x] 3.7 Review fixes, test first: create-board location comparison and 500-board search cap, lanes only with the custom strategy, moves over common lanes only, quick filter id and JQL in the delete's plan state.

## 4. Verification

- [x] 4.1 Run the unit tests and the typecheck for the new files.
- [x] 4.2 Run the read tools and write dry runs against the live instance (GET only).
