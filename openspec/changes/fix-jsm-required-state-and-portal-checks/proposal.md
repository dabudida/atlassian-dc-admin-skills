# Proposal

## Why

The user reports that `jira_update_request_type_field required=false` silently fails to make a field optional on JSM 11.3.8. Current code verifies the portal flag while the form reader combines portal and Jira mandatory flags, and repeated portal submissions used for testing send mail to Information Security.

## What Changes

- Expose `sdRequired`, `jiraRequired` and effective `required` for visible form fields while preserving field order and existing output keys.
- Reject an optional-field request when Jira requires the field, including the already-satisfied path, without changing shared field configuration.
- Verify explicit `false` using independent form read-back and fail visibly on ignored writes or newly imposed Jira requirements; include the relevant requirement state in drift checks.
- Add regressions for the reported class of failure and separate local evidence from exact-version live evidence.
- Add a focused portal-testing reference and skill routing with a no-submission checklist, evidence format and explicit limits for server validators.

## Capabilities

### New Capabilities

- `jsm-portal-no-submission-checks`: an administrator checklist for supported portal checks without creating a request or executing arbitrary server validators.

### Modified Capabilities

- `jsm-request-type-form`: expose mandatory-state provenance and verify the requested effective optional state before reporting success.

## Impact

Modify `src/tools/jira/requestTypes.ts` and `test/unit/jsmRequestTypes.test.ts`; extend fixtures only if sanitized observed data adds information beyond the HTTP fake. Update `atlassian-dc-admin/SKILL.md`, add `atlassian-dc-admin/PORTAL_TESTING.md`, and regenerate the existing reference/bundle with `pnpm build` during apply.

The change keeps the existing JSM internal routes, confirmation, dry-run defaults and version policy. It adds no dependencies, browser automation, issue creation, script execution or production configuration writes. Items 1–3, 5–6 and 8–11 remain in the approved roadmap for later changes. The `jiraConfigSnapshot` comment is excluded as requested.
