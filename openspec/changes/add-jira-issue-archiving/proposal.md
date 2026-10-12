# Proposal

## Why

Jira Data Center can archive issues to keep the index and boards small without deleting history, but archiving today needs the Jira UI or hand-written REST calls. Administrators want the same dry-run, idempotent and verified workflow that other write tools offer, plus a safe bulk archive by JQL with a hard cap.

## What Changes

- Add three write tools in `src/tools/jira/issueArchive.ts` (exported as `jiraIssueArchiveTools`):
  - `jira_archive_issue` ✎: `PUT /rest/api/2/issue/{key}/archive`.
  - `jira_restore_issue` ✎: `PUT /rest/api/2/issue/{key}/restore`.
  - `jira_archive_issues` ✎: `POST /rest/api/2/issue/archive` with the JQL as the JSON body; the dry run shows the matched count and a sample, and `max_issues` caps the operation.
- State is read with `GET /rest/api/2/issue/{key}?fields=archiveddate,archivedby`: a set `archiveddate` means archived. Writes are dry-run by default, already-archived / not-archived issues are reported as already satisfied, and every executed write is read back.
- When the instance says that archiving is unavailable (no Data Center license, endpoint missing), the tools fail with a clear `Unsupported` error.

## Capabilities

### New Capabilities

- `jira-issue-archiving`: archive and restore single issues and archive issues in bulk by JQL, with dry runs, caps and read-back verification.

### Modified Capabilities

None.

## Impact

- New file `src/tools/jira/issueArchive.ts` and `test/unit/issueArchive.test.ts`; the integrator registers `jiraIssueArchiveTools` in `src/tools/index.ts`.
- No cached scan is affected (`invalidates: []`).
