# Proposal

## Why

Administrators can read a Jira Software board's configuration and change its Detail View fields (`jira-board-configuration-management`), but cannot create or delete boards, switch the saved filter, or change columns, swimlanes, quick filters and card colors. These changes are routine board administration and today require clicking through the board configuration screens one board at a time.

## What Changes

- Add `src/tools/jira/boardManagement.ts` exporting `jiraBoardManagementTools`.
- Board lifecycle over the public agile API: `jira_create_board` ✎ (name, scrum|kanban, filter id or favourite filter name, optional project location) and `jira_delete_board` ✎ (destructive, explicit impact summary).
- Board settings over the internal Jira Software (greenhopper) API, gated to Jira 11.3.x and to board administrators:
  `jira_set_board_filter` ✎, `jira_get_board_columns` and `jira_set_board_columns` ✎ (ordered columns, statuses per column, min/max, constraint; statuses must belong to the board's workflows; newly unmapped statuses refused unless explicit),
  `jira_get_board_swimlanes` and `jira_set_board_swimlanes` ✎ (strategy and query swimlanes),
  `jira_get_board_quick_filters`, `jira_create_board_quick_filter` ✎, `jira_update_board_quick_filter` ✎, `jira_delete_board_quick_filter` ✎,
  `jira_get_board_card_colors` and `jira_set_board_card_colors` ✎.
- Every write is a dry run by default, reports already-satisfied when nothing would change, and reads the board back after a confirmed change.

## Capabilities

### New Capabilities

- `jira-board-management`: board create/delete, saved filter, columns and status mapping, swimlanes, quick filters and card colors.

### Modified Capabilities

None. `jira_get_board_configuration` and the Detail View tools keep their contracts.

## Impact

New file `src/tools/jira/boardManagement.ts` and `test/unit/jiraBoardManagement.test.ts`. The integrator registers the array in `src/tools/index.ts` (suggested group label "Jira — board management") and regenerates the CLI reference. No new dependency. Internal routes are taken from the board configuration JavaScript that Jira 11.3.7 serves and checked with GET only (see design.md).
