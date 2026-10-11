# Jira administration capabilities: design for review

Status: design approved by the user on 2026-10-09; the first delivery slice covers items 4 and 7. This document plans all eleven requested items; it does not authorize production writes or claim implementation.

## Approach

Recommended: extend the existing CLI with focused modules and add concise workflow skills/references that use it. Keep one common configuration, version discovery, confirmation mechanism and change-plan implementation. Deliver the work through separate OpenSpec proposal/apply cycles so each capability can be reviewed and verified independently.

Alternatives:

- One large OpenSpec change covering all eleven items: fewer planning artifacts, but independent API uncertainties would delay delivery and make validation difficult.
- Eleven independent skill packages with their own scripts: direct mapping to the request, but duplicates authentication, confirmation, version gates and drift checks.

The recommended approach groups implementation by dependencies rather than treating every requested item as a separate executable skill. A dedicated JC investigation skill remains useful because it orchestrates several existing and new tools.

## Observed repository state

- `src/tools/jira/requestTypes.ts` already manages request types and forms. `jira_update_request_type_field` writes `sdRequired` and verifies that stored flag. The form reader reports `required = sdRequired || jiraRequired`. Therefore a successful portal-flag update does not necessarily prove that the field became optional. This is a diagnostic hypothesis, not a reproduced JSM 11.3.8 root cause.
- `test/unit/jsmRequestTypes.test.ts` tests adding a required field and refusing to hide Jira-required fields without a preset. It does not contain a dedicated `required=false` update regression scenario.
- `src/tools/jira/workflows.ts` reads designer models and manages drafts. It cannot currently export a complete descriptor or compare validator/condition/post-function contents.
- `src/tools/jira/scriptrunner.ts` supports allowlisted metadata reads and restricted updates; Behaviours configuration is explicitly unsupported. Changing that policy requires new evidence and tests, rather than relabeling the existing reader.
- `src/tools/jira/scriptRoot.ts` and `scriptSync.ts` support file export, push, pull and synchronization. Synchronization reports deletions without applying them. Reuse their path checks, root selection and content hashes for explicit deletion.
- `src/confirm.ts`, `src/plan.ts` and the CLI already implement Apply/Cancel, batch selection, dry-run defaults and drift detection. New write tools must integrate with them.
- The tool registry has no dedicated Jira Automation or Script Console modules.
- A repository search found no jira-config snapshot generator. The user explicitly removed the dependency on a previously mentioned custom snapshot endpoint. Plan the requested snapshot and XML capabilities within this repository, without requiring that endpoint's source or preserving its undocumented contract.
- Existing `add-scriptrunner-script-sync` remains open with an unchecked full-suite task. Its historical failure note must be reconciled against a fresh baseline before closing that change; this work must not silently archive it.

## Coverage and acceptance criteria

| Item | Proposed deliverable | Acceptance criterion |
| --- | --- | --- |
| 1. Automation | Dedicated CLI module plus an Automation reference/workflow skill | Export production rules to local files, inspect one rule, enable/disable one rule, and import from a file. Import previews mapping, conflicts and intended state, requires confirmation, detects drift, and independently verifies created/changed rules. |
| 2. Workflow XML | CLI file export/import with a narrowly scoped server adapter if needed | Export exactly one named production workflow. Import XML only into the draft of that same workflow; reject target changes and never publish automatically. No dependency on an existing custom snapshot endpoint. |
| 3. Behaviours | Configuration reader and guarded field addition using a local script file | Read fields, script references and mappings; save script bodies to local files for inspection. Add a selected field without changing unrelated configuration; independently read back the field and script association. |
| 4. JSM optional-field defect | Investigation and regression-tested fix in `requestTypes.ts` | Reproduce the 11.3.8 symptom. Distinguish portal-required, Jira-required and effective required state; ignored writes raise a verification error and Jira-required constraints are explained explicitly. |
| 5. Script Console | File-based execution tool using existing confirmation | Default preview performs no remote script execution. Confirmed execution binds approval to the exact script bytes and returns the result, diagnostics and failure state to the agent with bounded output/file export. |
| 6. Administration links | Shared link helper and focused reference | Relevant readers/writers return the object administration URL. Record URL verification separately for the target instance; report unverified candidates honestly. |
| 7. Portal validation | Portal form testing checklist and supported no-submission checks | Test supported field/Behaviour validation without request creation. No automatic request submission or test notification. Distinguish these checks from create-transition validators and end-to-end tests. |
| 8. JC investigation | Dedicated `jira-jc-task-analysis` skill, name proposed | Reread the issue and follow request type → project/issue type → workflow → Behaviours → Automation → permissions. Produce an evidence-backed dependency map, shared-object impact and an ordered deployment plan. |
| 9. Script Root deletion | Explicit single-file delete tool | Preview exact instance/root/path/hash and references where discoverable, require confirmation, recheck the file hash, delete only that file and verify absence. No recursive deletion or automatic sync deletion. |
| 10. Groovy preflight | Local syntax/type-check command and workflow guidance | Check a local script against a versioned Jira/ScriptRunner jar classpath before upload, return diagnostics, and distinguish syntax/compilation/type checks from runtime proof. |
| 11. Request forms in snapshot | Repository-owned jira-config export with ordered JSM form data | Include request-type identity and fields in order, labels, visibility, portal-required, Jira-required and effective required state. Mark unavailable sections explicitly; retain stable machine-readable identifiers. |

## Design boundaries

### Confirmation and exact inputs

Reuse the CLI's `write: true`, default dry-run, desktop/terminal confirmation and plan model. File-based writes carry file SHA-256 and target identity in their approval fingerprint; reread the file and target before applying. A changed file or target must produce drift rather than silently applying new content. Do not print script bodies, workflow XML or credentials in previews, plans or errors.

Script Console requires two distinct concepts: a CLI preview and script-level simulation. A CLI preview must not execute arbitrary Groovy. Supplying `DRY_RUN=true` to a script is only a cooperative script contract, not a guarantee that it cannot write. If simulation execution is offered, treat execution itself as a confirmed action and report the selected binding. Confirmed Apply can pass `DRY_RUN=false` explicitly. Do not automatically retry script execution after an ambiguous network failure because it could duplicate changes.

Proposed import default for new Automation rules: create disabled, then enable through a separate confirmed operation. The preview must make this choice visible. Preserve the state of existing rules unless explicitly changed; verify available import semantics before committing to the API implementation.

### Server adapters and compatibility

First capture sanitized read-only version/endpoint evidence for the explicitly selected instance. Use official APIs when suitable; installation-specific internal APIs need dedicated compatibility tests and separate allowed-versus-verified version evidence.

Determine whether installed Jira APIs can provide complete XML export and same-workflow draft replacement; if they cannot, provide a narrowly scoped ScriptRunner adapter as part of this repository. Its export and draft-update operations require an administrator, use the same exact workflow identity across export/import, and validate the descriptor before creating or replacing a draft. Compare both live and existing draft state so approval cannot overwrite an intervening edit. Preserve unrelated descriptors and never activate/publish the draft. Reject external XML entities and network resolution while retaining compatibility with Jira's descriptor format. Adapter installation is a separate confirmed deployment action.

Behaviours reads must separate metadata from script bodies, which stay in files. Adding a field may upload a script and associate it as separate plan items. If one step fails, report the partial state and stop; do not delete or overwrite unrelated configuration as a rollback shortcut.

Groovy checks use an explicit classpath manifest recording product/plugin versions and jar hashes. Compilation must not run the script; compiler transforms may still execute, so run the checker in an isolated environment without production credentials. Preserve UTF-8, Unicode paths and compiler exit codes. Dynamic ScriptRunner DSLs may not be statically type-checkable: expose the check mode and unsupported context instead of promising complete validation. Do not modify script source merely to make checks pass.

### Read-back, links and portal checks

JSM verification must compare the requested user-visible result, not just the changed storage flag. Do not silently relax a shared Jira field configuration to make one portal field optional. A global requirement is a separate proposed change with its own shared impact and confirmation.

Return links on read results and on dry-run/applied/already-satisfied results when a target URL can be constructed. Verification records contain the exact product/version, object and check date. Do not claim that a constructed link was tested on the target instance until it actually was.

Portal tests cover form rendering, effective mandatory state, field-level messages and supported Behaviour reactions without pressing Submit. Client-side checks alone do not prove server/create-transition validators. Arbitrary validator scripts may have side effects and cannot be executed as a generic safe validation service. Use isolated fixtures/test instances for those cases; mark unsupported no-submission checks clearly. Never suppress production mail globally as a testing shortcut.

The snapshot preserves ordered form rows and separate required flags so the JC investigation can explain their provenance. Missing or unsupported sections are unknown/incomplete, not empty success. Save full snapshot data to local files with explicit scope; return bounded metadata to the agent and avoid printing script bodies, credentials or sensitive defaults.

## Proposed delivery order

1. **JSM correctness and portal testing foundation (4, 7).** Diagnose 11.3.8 with sanitized GET evidence, write failing regressions for explicit false/ignored writes/Jira-required fields, implement the smallest verified fix, and document no-submission test limits.
2. **Snapshot and workflow adapter (11, 2).** Define a repository-owned export contract using the existing request-form readers first, then implement one-workflow XML export and confirmed same-workflow draft import. Use separate OpenSpec changes without a dependency on another repository's custom endpoint.
3. **Script safety and execution (10, 5, 9).** Implement local Groovy preflight, confirmed console execution and explicit file deletion as independently verifiable changes. Reuse existing Script Root helpers and confirmation.
4. **Automation and Behaviours (1, 3).** Build separate adapters and scenario guidance; verify read operations before enabling writes on a supported pair.
5. **Links and orchestration (6, 8).** Add links alongside each adapter as it lands, then publish the consolidated target-instance URL reference and JC analysis skill with an evidence/impact/deployment checklist.

This order prioritizes the reported correctness defect and avoids making the JC skill promise tools that do not exist yet. Read-only JC analysis can be drafted earlier with explicit unavailable sections.

## Verification plan

Each implementation change starts with observable failing tests and ends with targeted passing tests, `pnpm typecheck`, `pnpm test`, `pnpm build`, `git diff --check` and strict validation of its OpenSpec artifacts. Use an HTTP fake to prove that previews and declined confirmation cause no writes or script executions. Verify changed files/targets, permissions, ignored writes, malformed inputs, oversized output and ambiguous responses.

Record local fixture results separately from exact-version live evidence. Production export/GET checks do not authorize configuration changes, endpoint installation, script execution, deletions, draft replacement or issue creation. Live write checks require a concrete preview and the existing confirmation mechanism. Do not create a portal request as a default test.

## Decisions and missing inputs for review

Fresh local baseline on 2026-10-09: `node --import tsx --test test/unit/jsmRequestTypes.test.ts test/unit/scriptRoot.test.ts test/unit/scriptSync.test.ts test/unit/scriptrunner.test.ts` passed 67/67 tests. The first sandboxed run passed 66 tests and failed to bind the integration fake server with `listen EPERM`; the approved rerun outside the sandbox passed all 67. This is a targeted baseline of existing behavior, not a reproduction of the 11.3.8 defect, a full-suite result or live-instance verification.

- Approve the phased CLI-plus-workflow-skills approach and the first JSM defect/portal-testing slice.
- Confirm the proposed Script Console distinction between non-executing default preview and cooperative `DRY_RUN` execution.
- Review the proposed disabled-by-default Automation import behavior.
- The previous custom-endpoint comment is excluded at the user's request. Snapshot generation belongs to this repository; any server adapter deployment remains separate from local implementation.
- Identify the exact target instance/configuration before live verification. Do not infer it from old JC issues or a different configured Jira.

After design approval, generate the first focused OpenSpec proposal/specs/design/tasks. Use `writing-plans` to turn the agreed design into an actionable implementation plan within that change, then start a separate apply phase when requested. Keep all eleven requirements in this coverage matrix until their individual delivery evidence is recorded.
