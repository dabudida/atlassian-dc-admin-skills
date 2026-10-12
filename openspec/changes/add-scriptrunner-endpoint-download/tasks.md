# Tasks

GET only toward the live instance.

## 1. Implementation (TDD)

- [x] 1.1 Write `test/unit/srCustomEndpoint.test.ts` (file name from Content-Disposition, fallback name, name validation before any request, CONFLICT, max_bytes, endpoint error with timeout restore); verify it fails because the tool does not exist.
- [x] 1.2 Add `contentDisposition` to `Download` in `client.getBytes`.
- [x] 1.3 Add `jira_download_scriptrunner_endpoint` to `jiraScriptRootTools`; run the new tests, `readBounds.test.ts` and the typecheck.
- [x] 1.4 Point `jira-config/SKILL.md` at the tool for refreshing the snapshot.

## 2. Verification

- [x] 2.1 Live, GET only: the same code patched into the bundle downloaded `jiraConfigSnapshot` on Jira DC 11.3.8 / ScriptRunner 10.17.0 (16 s, snapshot with 0 errors).
- [x] 2.2 Full suite on Windows: the only failures are the 16 that also fail on `main` there (symlinks, CRLF, document sizes).
- [x] 2.3 Rebuild the bundle (tsup) and regenerate `REFERENCE.md`.
- [ ] 2.4 `openspec validate add-scriptrunner-endpoint-download --strict`.
