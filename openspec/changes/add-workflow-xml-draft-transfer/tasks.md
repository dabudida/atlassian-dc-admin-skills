# Tasks

Execute sequentially using `superpowers:executing-plans`, after preserving existing working-tree changes. Each implementation group starts with a failing regression and ends with its passing rerun. Local compilation and fixtures are not deployed Jira proof. No endpoint installation, live draft write, publishing, commit or archive is implicit in this plan.

## 1. One-attempt mutation transport

- [x] 1.1 Add regressions to `test/unit/clientResilience.test.ts` for an explicit no-retry PUT receiving HTTP 429 and losing its response. Run `node --import tsx --test test/unit/clientResilience.test.ts` and verify the 429 assertion fails on the current client while existing default retry cases remain green.
- [x] 1.2 Add an opt-in retry-disable property to `RequestOptions` in `src/client.ts` and enforce it in `send` for status and exception branches. Verify the mutation makes exactly one attempt for 429, timeout and connection loss; existing callers retain their default retry behavior.

## 2. Secure descriptor support and compile evidence

- [x] 2.1 Create the adapter fixture suite and compile runner under `test/workflow-xml/`, with minimal valid descriptor, rule/script sentinel, DOCTYPE/entity, malformed descriptor, unknown status and unknown screen fixtures. Record selected Jira/API/core/Atlassian OSWorkflow, ScriptRunner, Groovy, Jakarta and Beehive jar versions/hashes; verify the runner reports missing jars as unavailable, not passed, and does not execute fixture scripts or load production credentials.
- [x] 2.2 Create `atlassian-dc-admin/scripts/workflow-xml/WorkflowXmlSupport.groovy` with fail-closed DOM parsing, no DOCTYPE/entities/DTD/XInclude/network resolution, UTF-8 serialization and sanitized line/column diagnostics. Compile and run descriptor fixtures; verify valid exported XML round-trips and malicious/malformed XML fails before any workflow-manager call.
- [x] 2.3 Add structural `WorkflowDescriptor(Element).validate()` and Jira status/screen reference checks without instantiating embedded rule classes or scripts. Verify missing references fail and a sentinel script remains inert.
- [x] 2.4 Add a typed draft subclass using the protected `JiraDraftWorkflow(String, WorkflowManager, WorkflowDescriptor)` constructor, with persistence through `WorkflowManager.updateWorkflow(user,draft)`. Compile against the selected jars and verify inherited draft mode; do not use reflection, a descriptor setter, live-store writes or audit bypasses.
- [x] 2.5 Implement raw and normalized descriptor SHA-256, excluding only verified Jira-managed author/date metadata constants from the normalized form. Verify audit-only differences compare equal while script, rule, description, status and transition differences compare unequal.

## 3. Authenticated protocol and guarded draft mutation

- [x] 3.1 Create the ScriptRunner 10.x/Jakarta endpoint wrapper `atlassian-dc-admin/scripts/workflow-xml/WorkflowXmlEndpoints.groovy` for GET `jiraWorkflowXml`, POST `jiraWorkflowXmlValidate` and PUT `jiraWorkflowXmlDraft`. Require an explicitly configured administrator registration group and authenticated Jira ADMINISTER checks for every route. Verify unauthenticated/unauthorized access, missing group, unsupported Jira/SR pair and invalid protocol are rejected without manager mutations.
- [x] 3.2 Implement protocol-v1 metadata/export and non-mutating validation responses with actual versions, workflow identity, live/draft hashes, normalized desired hash, bounded usage and structural counts. Verify GET/validation never call `createDraftWorkflow`; missing draft is reported without substituting live XML.
- [x] 3.3 Add server fixture regressions for inactive/system targets, changed live/draft fingerprints, validation failure and concurrent adapter writes. Implement a workflow-keyed Beehive cluster lock, reread/check under lock and validate before draft creation. Verify all rejected requests make no persistence call and two adapter writes cannot bypass stale-state rejection.
- [x] 3.4 Implement confirmed PUT create/update and independent read-back, checking desired normalized draft and unchanged raw live fingerprint. Verify already-satisfied makes no write, save failure after creation reports a remaining draft, ignored saves fail verification and no code path publishes/deletes/switches schemes.
- [x] 3.5 Add server limits for XML bytes and response metadata, with errors containing identity/status only. Verify oversized XML is refused before parsing and embedded XML/script sentinels never appear in error output.

## 4. Atomic local export and provenance

- [x] 4.1 Create `test/unit/workflowXml.test.ts` with protocol-v1 HTTP fixtures and temporary directories. Add failing tests for exact live export, explicit missing draft, full rule/script XML in files only, missing endpoint and unsupported protocol/product versions. Run `node --import tsx --test test/unit/workflowXml.test.ts` and record the unregistered-tool failure.
- [x] 4.2 Create `src/tools/jira/workflowXml.ts` and register `jira_export_workflow_xml` in `src/tools/index.ts`; use exact workflow identity, default live mode, bounded XML (5 MiB default/20 MiB hard cap) and bounded manifest. Verify export sends GET only and missing/unsupported adapter returns installation guidance without installation attempts.
- [x] 4.3 Implement SHA-derived export generation paths and stage XML plus manifest together before atomic publication. Reuse path/hash protections without Script Root discovery. Add failure-injection, symlink, non-regular destination, conflict and backup-and-replace tests; verify a failed pair write never publishes mismatched files or destroys the previous complete generation.
- [x] 4.4 Record safe source URL, workflow/mode, protocol/versions, original live/draft fingerprints and original exported-file hash in the manifest. Verify hashes match actual exported bytes, workflow names cannot become paths and tool output contains metadata/paths/hashes without XML.

## 5. Confirmed file-to-draft import

- [x] 5.1 Add failing tests for missing/invalid provenance, different source/workflow, symlink/non-regular files, oversized input and deliberately edited XML. Implement `jira_import_workflow_xml_draft` as `write:true` using the existing preview/confirmation model. Verify intentional edits are allowed while mismatched identity or unsafe files are refused before PUT.
- [x] 5.2 Implement preview using metadata GET and non-mutating validation POST; bind current XML hash, manifest hash, same-origin/name identity, live/draft fingerprints and normalized desired hash to approval. Store only placeholders/metadata in plan request bodies. Verify preview shows draft creation/replacement and bounded affected projects, sends no PUT and prints no XML/script sentinel in results, plans or errors.
- [x] 5.3 Add declined-confirmation and changed-input regressions covering XML, manifest, live workflow and existing draft. Recheck approved local bytes and server state before the mutation; verify decline/drift produces zero PUTs and no draft creation.
- [x] 5.4 Invoke confirmed PUT with transport retries disabled, then perform an independent GET to verify normalized draft and unchanged live. Verify satisfied-state no-op, ignored-write mismatch, lost response and HTTP 429; report indeterminate/partial state without replay, publish or delete. Any later attempt requires fresh observed state and new confirmation.
- [x] 5.5 Add bounded administration-link output with explicit unverified status. Update `RULES_GAP` in `src/tools/jira/workflows.ts` to describe the designer API limitation and separate XML export route; verify existing workflow tests still report unavailable rule bodies and do not imply an installed adapter.

## 6. Deployment guidance and completion evidence

- [x] 6.1 Create `atlassian-dc-admin/WORKFLOW_XML.md` covering protocol/routes, initial Jira 11.3.x/SR 10.x support, administrator-group setup, separate installation/rollback, live export/edit/manifest/import commands, legacy DOCTYPE rejection, partial failures and the exclusive editing window required because native Jira edits do not share the adapter lock. Verify examples match tool schemas and no instruction publishes or installs implicitly.
- [x] 6.2 Add the focused SKILL dispatcher link and generate the CLI/reference with `pnpm build`. Verify both new tools appear, the SKILL body stays within its budget and no source XML/script is embedded in previews or generated examples.
- [x] 6.3 Run `node --import tsx --test test/unit/workflowXml.test.ts test/unit/clientResilience.test.ts`, the adapter compile/fixture runner, `pnpm typecheck` and `pnpm test`. Verify passing local evidence includes actual jar versions/hashes; record deployment, exact-version live verification and target-instance URL checks as NOT_RUN unless separately authorized and performed.
- [x] 6.4 Request review of transport/CLI/adapter changes and address supported findings; run `openspec validate add-workflow-xml-draft-transfer --strict` and `git diff --check`. Verify each delta scenario is covered, deployment limits are stated honestly and the workflow designer contract is preserved; leave commit, deployment, spec sync and archive for separate instructions.

## 7. Review follow-ups

- [x] 7.1 Return adapter-defined rejection reasons (`AdapterRejection`, `AdapterConflict`) and keep all other exception text generic. Allowlist those reasons in `src/tools/jira/workflowXml.ts`, report a 501 product-pair rejection separately from a missing adapter, and add a test that every reason thrown in the adapter sources is allowlisted.
- [x] 7.2 Validate grammar on the submitted text with the trusted DOCTYPE inserted in place, so grammar errors report the caller's line and column. Verify multi-line, XML-declaration and single-line cases in `test/workflow-xml/fixtures.groovy`.
- [x] 7.3 Replace the all-project usage scan with the statically compiled `WorkflowUsage` scheme lookup; scan projects only for Jira's default workflow. Pin `embedded-crowd-api` 7.1.5 (Jira 11.3.6 platform) and `entityengine-share` 4.0.3 for compilation and fixtures.
- [x] 7.4 Move adapter sources to `adapters/workflow-xml/`, copy them into the skill during `pnpm build` and restore tsup `clean: true`. Verify the shipped copy is byte-identical in `test/unit/workflowAdapterPackaging.test.ts`.
- [x] 7.5 Keep PUT retries disabled for HTTP 429 as decided in design, rather than relaxing the no-automatic-retry requirement.

