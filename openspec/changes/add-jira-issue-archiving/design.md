# Design

## Context

Observed on Jira DC 11.3.7 (GET only; no write was sent to the live instance):
- The REST WADL (`/rest/api/2/application.wadl`) lists `PUT issue/{issueIdOrKey}/archive` and `PUT issue/{issueIdOrKey}/restore`, each with query `notifyUsers` (default true), and `POST issue/archive` with query `notifyUsers` (default false), an `application/json` request body and a `text/plain` response. The JSON body is the JQL as a JSON string (for example `"project = PROJ AND resolved < -365d"`).
- `GET /rest/api/2/issue/{key}?fields=archiveddate,archivedby` returns both fields as `null` for an issue that is not archived; a missing issue answers 404 "Issue Does Not Exist".
- The system fields `archiveddate` ("Archived") and `archivedby` ("Archiver") exist, but they are not searchable (`archiveddate is not EMPTY` answers 400) and there is no `archivedIssues()` JQL function: JQL search never returns archived issues. `/rest/api/2/index/summary` reports `countInArchive`.
- No archived issue existed on the instance, so the GET answer for an archived issue could not be observed. Atlassian documents archived issues as read-only and still viewable by key; the tools therefore treat a non-null `archiveddate` as archived and handle a 404 defensively (below).

## Goals / Non-Goals

**Goals:** safe single and bulk archiving with dry runs, caps, idempotency and verification. **Non-Goals:** project archiving (exists elsewhere), browsing archived issues, archiving through the UI's export of results.

## Decisions

### State and idempotency

- Archive: read the issue; 404 is a validation error; `archiveddate` set is already satisfied. A response without an `archiveddate` key means the instance does not offer issue archiving: `Unsupported` before any write.
- Restore: `archiveddate` null is already satisfied. A 404 on the pre-read does not stop the dry run (an archived issue might not be readable on some versions); the result carries a warning that the state is unknown, and the executed request lets Jira decide.
- Read-back: after archive, `archiveddate` must be set; a 404 is reported as `verified: false` with a note instead of failing a write Jira accepted. After restore, `archiveddate` must be null.

### Bulk archive

- `jql` is required; `max_issues` default 100, hard cap 10,000; `sample` default 10, max 50 issues (key, summary, status).
- The dry run counts with `GET /search?jql&maxResults=<sample>` (archived issues are never matched, so the count is what would be archived). Zero matches is already satisfied; more than `max_issues` is refused before any write and the message names the count. The dry run then pages the matching ids (`fields=id`, 500 per page, refused above `max_issues`) and carries `state: {matched, ids}` where `ids` is a 16-hex SHA-256 of the sorted ids, so a plan apply detects a changed set even with an unchanged count.
- Execution re-counts, refuses when the cap is now exceeded, re-reads the ids and refuses when they differ from an optional `approved_ids_hash` (the `state.ids` of the approved dry run). It sends `POST /issue/archive?notifyUsers=<bool>` with the JSON-string body `issue in (<ids>) AND (<jql>)`, one request per 500 ids, so only the approved set can be archived and issues that match later slip nowhere. It cuts the text response to 2,000 characters, then re-counts each restricted JQL: any remaining match is a `VerificationError` naming the remaining count.
- One request archives all matches, so the tool is a single plan item, not a `batch` of per-issue changes.

### Unsupported instances

An HTTP 501, or a 400/403/404/405 whose body mentions archiving together with licensing, Data Center or availability, becomes `UnsupportedError("Issue archiving is not available on this instance (Data Center license required)")`. On the bulk endpoint, 404 and 405 always mean the resource is missing. Other errors surface unchanged.
