# Design

## Context

Read tools for both scheme types live in `src/tools/jira/schemes.ts` and stay unchanged. `jira_assign_project_scheme` (`projectSchemes.ts`) already assigns notification schemes via `PUT /project/{key}` and already models UI-only assignments as manual changes. `fieldOptions.ts` shows the manual-item shape with steps (`request: {method: "MANUAL", url, body: {steps}}`, `manual: {reason, editUrl}`), which the CLI skips when asking for confirmation.

## Findings (read-only on Jira DC 11.3.7: WADL and GET requests, nothing written)

**REST (`/rest/api/2/application.wadl`, 396 resource methods).** The only routes for these objects are reads:
`GET /notificationscheme`, `GET /notificationscheme/{id}`, `GET /project/{key}/notificationscheme`,
`GET /issuesecurityschemes`, `GET /issuesecurityschemes/{id}`, `GET /securitylevel/{id}`,
`GET /project/{key}/issuesecuritylevelscheme`, `GET /project/{key}/securitylevel`. `PUT /project/{projectIdOrKey}` exists.

**Probed and absent (HTTP 404 on GET):** `/rest/api/2/notificationscheme/{id}/notification`, `/rest/api/2/issuesecurityschemes/{id}/level`, `/rest/api/2/issuesecurityschemes/level`. No internal REST route for these admin screens was found; Jira 11 still uses the classic webwork forms.

**Admin forms (GET):** `AddNotificationScheme!default.jspa`, `AddNotification!default.jspa?schemeId=`, `DeleteNotification!default.jspa?id=&schemeId=`, `EditNotifications!default.jspa?schemeId=`, `AddIssueSecurityScheme!default.jspa`, `EditIssueSecurities!default.jspa?schemeId=`, `AddIssueSecurity!default.jspa?schemeId=`, `DeleteIssueSecurity!default.jspa`, `/secure/project/SelectProjectIssueSecurityScheme!default.jspa?projectId=` all answer with the websudo prompt ("Administrator Access"). A non-existent action (`EditIssueSecurity`, `NonExistentThing`) answers differently, so the websudo prompt confirms the action exists. A personal access token cannot pass websudo (see `jira-project-scheme-assignment`), so none of these can be driven by the tool.

**Notification scheme shape:** `GET /notificationscheme/{id}?expand=all` returns `notificationSchemeEvents[]` with `event {id, name}` and `notifications[] {id, notificationType, parameter?}`; the `id` is the one `DeleteNotification` takes. **Security scheme shape:** levels `{id, name, description}` and `defaultSecurityLevelId`; no members. The live instance has no issue security schemes, so the security tools were verified against fixtures only.

**Project assignment of an issue security scheme:** `issueSecurityScheme` is a documented field of the project input bean that `POST/PUT /rest/api/2/project` accept (with `permissionScheme` and `notificationScheme`; the latter is already used by `jira_assign_project_scheme`). It is not live-tested with a write; the read-back through `GET /project/{key}/issuesecuritylevelscheme` (404 = none) verifies every execution.

## Decisions

### Manual items with exact steps, verified on re-run

Every scheme-content change is a manual item built by `manualStep()` in `manualSteps.ts`: absolute admin URL, steps, the websudo reason, `identity` and `state` for plan drift. `dry_run=false` raises `Unsupported` with the URL and steps, so `apply` never pretends to have changed anything. Before returning a manual item each tool reads the current state and returns `already_satisfied` when it holds, so a re-run after the UI change verifies it:

| Tool | Check | Admin page |
| --- | --- | --- |
| `jira_create_notification_scheme` | name in `GET /notificationscheme` (paged, cap 1000) | `AddNotificationScheme!default.jspa` |
| `jira_add_notification` | event + recipient in `GET /notificationscheme/{id}?expand=all` | `AddNotification!default.jspa?schemeId=` |
| `jira_remove_notification` | same; the found notification id goes into the link | `DeleteNotification!default.jspa?id=&schemeId=` |
| `jira_create_issue_security_scheme` | name in `GET /issuesecurityschemes` | `AddIssueSecurityScheme!default.jspa` |
| `jira_add_issue_security_level` | level name (and default) in `GET /issuesecurityschemes/{id}` | `EditIssueSecurities!default.jspa?schemeId=` |
| `jira_add_issue_security_level_member` | none possible | `AddIssueSecurity!default.jspa?schemeId=` |

Recipients use Jira's `notificationType` values (`Group`, `ProjectRole`, `User`, `EmailAddress`, `UserCustomField`, `GroupCustomField` take a parameter; the others take none). Project roles are accepted by id or exact name (`GET /role`) because Jira stores the role id. Single Users are given by username and resolved through `GET /user?username=` to the user key, because Jira stores `User` recipients by key (e.g. `JIRAUSER10100`); a returned `user.name` also matches. Events are accepted by id or exact name from the scheme; an unlisted numeric id is passed through.

The level-member tool sets `unverifiable` and its note says the result must be checked in the UI, because Jira DC has no REST read of security level members.

### The one REST write: assigning an issue security scheme

`jira_assign_issue_security_scheme` reads the project's current scheme; the same scheme is `already_satisfied`. If the project already has a scheme, its issues may carry levels that Jira's UI would remap; a `/search` count cannot prove there are none, because it only sees issues the caller may browse. The tool never changes issue security levels, so any switch from an existing scheme is a manual item for `SelectProjectIssueSecurityScheme`. Only a project without a scheme sends `PUT /project/{key}` `{issueSecurityScheme: id}` (dry run first) and fails with `VerificationError` unless the project reads back with the new scheme. Removing a scheme from a project is out of scope.

## Risks / Trade-offs

- Manual items are not automation → they are explicit about it, verify on re-run where possible, and never claim success.
- `PUT /project` with `issueSecurityScheme` was not executed on the live instance (writes are forbidden there) → documented field plus mandatory read-back.
- Admin form URLs can change between Jira versions → each was confirmed on 11.3.7 by GET; a wrong link is a UI inconvenience, not a wrong write.
- Member additions cannot be verified → declared `unverifiable`.

## Migration Plan

Register `jiraSchemeWriteTools` in `src/tools/index.ts` (suggested group: "Jira notification & issue security schemes") and add the tools to the skill reference. No state migration; rollback removes the module.
