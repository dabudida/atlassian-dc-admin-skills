# Tasks

## 1. Single issue archive and restore

- [x] 1.1 Write failing tests in `test/unit/issueArchive.test.ts`: dry run by default, already archived / not archived, missing issue, missing `archiveddate` field as Unsupported, executed write with read-back, 404 read-back after archive, restore with a 404 pre-read, license error mapped to Unsupported.
- [x] 1.2 Implement `jira_archive_issue` and `jira_restore_issue` in `src/tools/jira/issueArchive.ts`; verify the tests pass.

## 2. Bulk archive by JQL

- [x] 2.1 Write failing tests: dry run with count, sample and `state`, zero matches already satisfied, cap refusal, executed POST with JSON-string body and `notifyUsers`, read-back with remaining matches as VerificationError, 405 as Unsupported.
- [x] 2.2 Implement `jira_archive_issues`; verify the tests pass.
- [x] 2.3 Write failing tests, then pin the approved id set: ids hash in `state`, `approved_ids_hash` refusal, POST restricted to `issue in (<ids>) AND (<jql>)` in chunks of 500, issues matching after the id read never archived.

## 3. Verification

- [x] 3.1 Typecheck the new files; run the dry runs live (GET only, `dry_run` left at its default).
- [x] 3.2 `openspec validate add-jira-issue-archiving --strict` passes.
