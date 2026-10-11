# Design

## Context

See proposal.md and item 2 of the approved roadmap. The repository has no previous custom endpoint source to reuse, and the user excluded that comment. Existing designer methods expose counts and draft operations but not complete XML. Current `JiraWorkflow` has no setter, and `JiraDraftWorkflow` has no public descriptor setter; do not plan to call a nonexistent method.

Discovery on 2026-10-09 checked Jira API/core and Atlassian OSWorkflow 11.3.6 jar signatures locally. `WorkflowDescriptor(Element)`, `validate()` and `writeXML(PrintWriter,int)` exist; `WorkflowManager` exposes read/create-draft/update and its implementation dispatches draft writes according to `isDraftWorkflow()`. `JiraDraftWorkflow` has a protected `(String, WorkflowManager, WorkflowDescriptor)` constructor. `GlobalPermissionKey` is in `com.atlassian.jira.permission`, and `ClusterLockService` is provided by Beehive. These are binary/API observations, not a runtime deployment proof.

Primary documentation: [Jira 11.3 WorkflowManager](https://docs.atlassian.com/software/jira/docs/api/11.3.0/com/atlassian/jira/workflow/WorkflowManager.html), [ScriptRunner REST endpoints](https://docs.adaptavist.com/sr4js/latest/features/rest-endpoints/), and [ScriptRunner breaking changes](https://docs.adaptavist.com/sr4js/latest/release-notes/breaking-changes/). ScriptRunner 10.x uses Jakarta in its endpoint examples; do not reuse the javax example for this target.

## Goals / Non-Goals

**Goals:** complete descriptor export and a verifiable file-to-draft round trip tied to the original instance/workflow. **Non-Goals:** cross-instance imports, creating/cloning a new workflow, publishing, editing inactive live workflows, running embedded validators/scripts, generic Script Console, adapter installation through an unverified API, or full Jira backup.

## Decisions

### Repository-owned adapter with an explicit protocol

Supply a ScriptRunner 10.x/Jakarta endpoint file and testable support code under `adapters/workflow-xml/`, copied by `pnpm build` into the skill at `atlassian-dc-admin/scripts/workflow-xml/`. Initial target is Jira 11.3.x/SR 10.x, independently of the broader Script Root matrix. No SR 9/javax variant is silently assumed. The wrapper checks authenticated user and Jira ADMINISTER permission on every operation; its registration groups must be configured to the existing administrator group, and omission must not open anonymous access.

Protocol v1 uses three named custom routes: GET `jiraWorkflowXml` for metadata/full selected XML; POST `jiraWorkflowXmlValidate` for non-mutating validation/normalized desired hash; PUT `jiraWorkflowXmlDraft` for the guarded mutation. The validation POST is explicitly side-effect-free and does not call createDraftWorkflow. Each response declares protocol and actual product versions. Missing/old endpoints return Unsupported. No request can specify a different target URL or invoke arbitrary script/function names.

### Complete XML and same-origin provenance

Canonical export uses `WorkflowDescriptor.writeXML` with a UTF-8 declaration and no DOCTYPE; the manifest retains workflow name/mode/source base URL/versions, original live/draft hashes and file hash. Use SHA-derived filenames rather than raw workflow names as paths. Export selected XML and manifest together after validating output paths and budgets, using a generation subdirectory staged and atomically renamed so a failed pair write cannot publish mismatched provenance. Existing complete generations are immutable; `overwrite=true` backs up a generation before replacing it. Export defaults to live and never creates a draft.

Importer requires the manifest even when XML was edited. Its original file hash records export integrity, not a constraint that forbids intended edits. Compute the new XML hash from actual current bytes, require manifest workflow/source to equal the request target, and bind the manifest hash plus current XML hash to preview/approval. The provenance is an accidental-target guard, not cryptographic attestation against deliberate manifest editing.

### Secure parser and draft object

Parse using a configured DOM factory with external entities/DTDs/XInclude disabled, no DOCTYPE acceptance and an error handler that emits sanitized line/column only. Build `WorkflowDescriptor` from the validated root Element and call `validate()`; resolve referenced Jira status/screen ids without evaluating class names, conditions or script bodies. Size-limit the body before parsing. The tool's own exported no-DOCTYPE XML is accepted; imported legacy XML with DOCTYPE is refused with conversion guidance, never fetched from its system URL.

Implementation review demonstrated that OSWorkflow silently discards unknown elements before `validate()`. Validate the source DOM against Jira's bundled `META-INF/workflow_2_8.dtd` first, using only a fixed trusted urn resolved to that classpath resource. Caller DOCTYPE declarations and arbitrary resolution remain refused. Grammar failure is sanitized; no rule executes.

Use a small typed subclass of `JiraDraftWorkflow` to pass the new descriptor through its protected constructor. It carries the existing workflow name and returns draft mode by inheritance. Persist through `WorkflowManager.updateWorkflow(user,draft)`, never `saveWorkflowWithoutAudit`, the live store, or `overwriteActiveWorkflow`. Compile this constructor/inheritance path against the selected Jira jars before enabling the operation. There is no dynamic descriptor-field reflection or nonexistent `draft.setDescriptor` call.

Live/system eligibility and known descriptor references are checked before draft creation. Creating a missing draft happens only inside the confirmed PUT after every validation/fingerprint check. If creation succeeds but saving fails, report that draft as partial state; do not delete it automatically.

### Fingerprints, verification and concurrent editing

Preview contains original instance/name, usage count with bounded affected project identities, whether a draft will be created/replaced, current live/draft hashes, and normalized desired hash. Plan request body contains only placeholders and metadata; the real XML exists only in the immediate validation/mutation request and files.

The server mutation acquires a Beehive cluster lock keyed by workflow identity, rereads live/draft fingerprints, checks exact caller expectations and validates again, then creates/updates a draft. It verifies normalized desired draft content and unchanged live XML after persistence. Normalize only Jira-managed updated-date/update-author metadata using verified `JiraWorkflow` constants; preserve all functional rule/description/status/transition content. Record raw hashes as well for exact drift evidence.

Cluster locks serialize this adapter's writes, not all native Jira UI edits. The API inspection found no general compare-and-swap update; do not claim atomic protection from an administrator editing through another entry point during the final check/save window. Documentation requires an exclusive editing window for draft replacement, and reports this limitation. Fingerprint checks still reject changes observed after preview and before save.

The existing HTTP client retries 429 for non-GET methods as well as read retries. Add an explicit opt-out in request options for this adapter's mutation so 429/timeout/connection-loss cannot automatically repeat draft writes. Keep the default retry contract of existing callers unchanged. Validation can be retried only when its non-mutating contract is confirmed.

### Local export and compatibility boundaries

Reuse path/hash helpers from Script Root modules without their ScriptRunner-specific root discovery. Export/import limits: 5 MiB XML default with a hard cap of 20 MiB, bounded manifest and bounded response metadata. Import rejects symlinks/non-regular XML/manifest files. Error paths never print payloads or scripts. Construct existing workflow admin links but mark them unverified until target-instance checks occur.

The existing tsup output directory also contains the shipped adapter sources. Disable wholesale output cleaning for the single fixed CLI bundle; verify all four Groovy files and their hashes survive an actual build. A packaging regression checks source presence alongside the generated CLI.

## Risks / Trade-offs

- Core draft class is installation/version sensitive → compile/inheritance tests and fail closed for unsupported pairs; exact deployed behavior remains NOT_RUN until separately tested.
- Jira may add audit metadata → compare normalized functional content and separately verify unchanged live descriptor.
- Native UI edits do not share the adapter lock → disclose the editing-window requirement rather than promise transaction-level isolation.
- A saved draft may require additional publishing constraints → do not claim that structural validation proves publishability or runtime behavior. Publishing remains a separate administrative action.
- Deployment is unavailable → local code/tests may complete with no live evidence; tools clearly require adapter installation and no installation is implicit.

## Migration Plan

Build/test the CLI and adapter locally, provide protocol/compatibility evidence and WORKFLOW_XML deployment/rollback guidance, then separately select the target Jira/ScriptRunner pair and administrator group. Install the adapter only through an explicit confirmed administrator operation. Verify GET export first; live draft writes require their own concrete preview and existing CLI confirmation. Rollback disables/removes the installed adapter and reverts the package revision without publishing or deleting drafts. No production deployment is part of this proposal.

## Local Implementation Evidence (2026-10-09)

Implemented and reviewed locally, including source grammar validation, post-validation file rechecks and bounded observation after failed PUT. Repeat actual build retained the hashes of all four Groovy sources. Final Node suite: 976/976 pass; typecheck/build/strict validation/diff checks pass. Adapter sources compile and inert parser/draft/service/concurrency fixtures pass with the explicit classpath in `test/workflow-xml/classpath.json`; jar hashes and local evidence are recorded in `test/workflow-xml/compile-evidence.json`. The local fixture CLI Cancel test exits 12 and sends no PUT. Compilation/fixtures establish no exact deployed compatibility: adapter installation, live draft writes, publishing and target-instance URL verification remain NOT_RUN. No change is committed or archived.
