# Design

## Context

See proposal.md for motivation and the approved eleven-item roadmap in `docs/superpowers/specs/2026-10-09-jira-admin-capabilities-design.md`. The user approved the phased approach and this first slice. The custom snapshot endpoint comment is excluded.

`FormRow` already contains `sdRequired` and `jiraRequired`. The reader exposes only their OR. Update currently builds changed attributes against `sdRequired`, may return already-satisfied before considering `jiraRequired`, and verifies only sent attributes. `boolArg` already parses the CLI string `false` correctly; do not assume parsing caused the reported defect. The HTTP fake in `test/unit/jsmRequestTypes.test.ts` supports mutable form rows and an overridable responder, allowing ignored writes and requirement races to be reproduced locally.

## Goals / Non-Goals

**Goals:** make the distinction between configured portal state and effective mandatory state observable; enforce the approved meaning of `required=false`; provide the requested no-submission checklist.

**Non-Goals:** relax shared field configurations, invent a new internal API payload without evidence, create portal requests, execute validators or scripts, introduce browser automation, expand JSM version ranges, or implement later roadmap items.

## Decisions

### Keep the existing model and output key

Add raw mandatory flags to visible-field results while keeping `required` as the OR. This is an additive output change. Avoid renaming the existing field or replacing the form reader because consumers already rely on it and ordered form data is needed by later snapshot work.

### Reject impossible optional-state requests before building mutations

Check `required === false && row.jiraRequired` before already-satisfied and attribute filtering. Apply the same check to the selected addable/already-visible row in add-field operations so add/update do not contradict one another. Reject the entire combined request before any label/description mutation. A shared Jira requirement must be handled as a separate administrative decision.

Keep setting `sdRequired` explicitly when a change is needed. Verify both the intended stored attribute and effective optional state after independent GETs. If the field disappears or becomes Jira-required, return the existing `VerificationError` with field identity and observed flags; report partial state, not automatic rollback. Do not infer portal UI success from HTTP success.

### Include only relevant requirement state in plan drift checks

For requests for optional state, include the current Jira mandatory flag in the dry-run state in addition to existing changed attribute values. Unrelated form order and unrelated field changes remain outside this fingerprint. An add-field preview includes the selected row's requirement state. Existing confirmation and plan behavior remain unchanged; a newly blocking requirement may fail re-planning before digest comparison and must still prevent mutation.

### Use a checklist for this first portal testing capability

Create `atlassian-dc-admin/PORTAL_TESTING.md` and link it from the dispatcher at the point where form testing is requested. Use `jira_get_request_type_form` for configuration evidence and administrator-operated portal interaction for supported field checks. Do not add a tool that claims to run arbitrary validators safely. This satisfies the user's checklist-or-method requirement without creating test requests or adding the still-unimplemented Behaviours reader as a dependency.

The reference must instruct readers to inspect available dynamic scripts before interactions or use an isolated environment when side effects cannot be ruled out. No browser automation or script execution is part of this apply change. Documentation verification is a review of the workflow and evidence template, not tests that merely match headings or phrases.

### Separate reproduced defects from version-specific reports

Write failing tests for Jira-required false-success paths, then test ignored writes and races through the fake. The reported JSM 11.3.8 endpoint behavior remains unverified until sanitized evidence from the exact selected instance is available. Preserve current routes and payloads unless that evidence demonstrates another defect. If it requires different API semantics, revise the design before expanding implementation. Local defensive fixes and checklist delivery can proceed without production writes; the final report must retain this live-evidence limit.

## Risks / Trade-offs

- A different 11.3.8 server-side cause → report the local fix's evidence precisely and keep exact-version verification unclaimed; capture before/after GET evidence only when the instance is explicitly selected and any write is confirmed.
- A requirement imposed between PUT and GET → return verification failure and the observed state; do not retry or relax shared configuration.
- Dynamic form interactions can have side effects → use the inspection/isolation prerequisite and mark unsupported checks unavailable.
- Existing consumers compare full result objects → preserve existing keys and hidden rows; update only expectations affected by the additive visible-field flags.
- Internal APIs vary by installation → keep existing version policy and distinguish policy allowance from captured exact-pair evidence.

## Migration Plan

Implement and test within the existing CLI/skill package, then regenerate the bundle/reference. No server migration or production deployment is needed for local delivery. Rollback is a normal code/package revision; it does not attempt to reverse previously confirmed customer configuration changes. Keep this change open until required local checks and documentation review pass. No archive or production write is included in planning.

## Implementation evidence — 2026-10-09

- Baseline: 17/17 selected JSM tests passed before edits.
- Red: 10 assertions failed against the original implementation, demonstrating false-success preflight, missing provenance/diagnostics, effective-required races and stale approval. The original implementation was temporarily restored for verification and the implemented source restored immediately afterward. These are local synthetic scenarios, not captured production responses.
- Green: 30/30 selected JSM tests passed, including the later add-field disappearance regression. That regression initially produced HTTP404 and now produces `VerificationError` with `missing=true` without a move request.
- Full suite: 939/939 tests passed, zero skipped, in the final run outside the sandbox. The sandbox run stalled in the local-server CLI test and was stopped; intermediate unrestricted runs exposed the review regression and a SKILL.md character-budget failure. Both were corrected before the passing final run.
- `pnpm typecheck`, `pnpm build`, `git diff --check` and strict validation of this change passed. The generated CLI's `describe jira_update_request_type_field` exposes effective optional-state semantics. REFERENCE.md regeneration succeeded and its catalogue had no content change.
- Independent read-only code review found one add-field disappearance issue, which was regression-tested and corrected. Follow-up review reported no remaining supported findings. Portal checklist scenarios and the dispatcher link were reviewed; the SKILL.md body remains within its 6,000-character budget.
- No production GET/write, portal submission, script execution or target-instance change was performed. The exact target instance and affected request type were not supplied for this slice. The original installation-specific JSM 11.3.8 runtime symptom remains unverified; fake responses declaring that version prove local behavior only.
- Local source, tests, documentation and generated bundle are ready for review. This change is not archived, committed or pushed; later roadmap items remain separate work.
