# Tasks

Work in `src/tools/jira/jsmRequests.ts` and `test/unit/jsmRequests.test.ts` only. For each group write the failing test first, verify the failure, implement, and rerun.

## 1. Reads

- [x] 1.1 Test and implement `jira_get_request` (compact view, SLA summary, participant count, links, cut field values).
- [x] 1.2 Test and implement `jira_get_request_comments` (visibility filter, paging, body cut) and `jira_get_request_status_history`.
- [x] 1.3 Test and implement `jira_get_request_participants` and `jira_get_request_approvals` (capped approvers).
- [x] 1.4 Test and implement `jira_get_request_feedback` (field discovery, JQL rating probe, comment property, not submitted).

## 2. Writes

- [x] 2.1 Test and implement `jira_add_request_comment` (internal by default, visibility in the summary, read-back of the flag).
- [x] 2.2 Test and implement `jira_add_request_participants` and `jira_remove_request_participants` (already-satisfied, read-back).
- [x] 2.3 Test and implement `jira_answer_request_approval` (already-satisfied for the same answer, refusal for a different answer or a final approval, read-back).

## 3. Verification

- [x] 3.1 Run `node --import tsx --test test/unit/jsmRequests.test.ts` and typecheck the new files.
- [x] 3.2 Verify read tools live with GET only and write tools as dry runs.
- [x] 3.3 Run `openspec validate add-jsm-request-agent-operations --strict`.
