# Spec Delta

## Purpose

Allow administrators to export one complete workflow descriptor to local XML and safely apply an edited file only to the draft of the same workflow on its source instance.

## ADDED Requirements

### Requirement: Export one complete workflow descriptor
The system SHALL provide `jira_export_workflow_xml` with an exact workflow name, optional live/draft selection and local output directory. It SHALL export a complete XML descriptor and a provenance manifest containing source instance, workflow identity, selected mode, live/draft fingerprints, adapter protocol/version and artifact integrity metadata. Reads SHALL neither create drafts nor publish changes. Complete rule/script/XML contents SHALL stay in local files; tool output SHALL carry bounded metadata, structural counts and paths/hashes only. Local conflicts and symlinks SHALL be rejected unless an explicit supported overwrite-with-backup option resolves the conflict.

#### Scenario: Production descriptor export
- **WHEN** an administrator exports one live workflow
- **THEN** its XML includes its conditions, validators and post-functions, its provenance identifies that workflow, and no server state changes

#### Scenario: Missing draft
- **WHEN** an administrator explicitly requests a draft that does not exist
- **THEN** export reports no draft and does not create one or substitute the live workflow

### Requirement: Preview and confirm same-workflow draft import
The system SHALL provide `jira_import_workflow_xml_draft` with target workflow, edited local XML and its export manifest. Default dry-run SHALL perform only reads and non-mutating validation, identify draft creation/replacement, affected workflow usage and the hashes bound to approval, and SHALL not echo XML in output, errors or plan files. The target instance and workflow name SHALL match export provenance exactly. Missing manifests, malformed XML, unrecognized adapter contracts, unsupported product pairs, inactive/system targets, missing Jira references or invalid descriptor structure SHALL be rejected before creating a draft or writing.

The edited-file hash, provenance identity and observed live/draft fingerprints SHALL be bound to confirmation and rechecked before persistence. A changed file, workflow or draft SHALL prevent the write. Existing CLI Apply/Cancel and plan confirmation SHALL gate the mutation. Declining SHALL result in no draft creation or write.

#### Scenario: Edited file targets its source workflow
- **WHEN** an administrator previews an edited descriptor for its original active workflow
- **THEN** the preview identifies the same workflow and its draft target while no draft is created

#### Scenario: Cross-workflow or cross-instance import
- **WHEN** export provenance identifies a different workflow or source instance
- **THEN** the importer refuses before any server mutation

#### Scenario: Changed approved inputs
- **WHEN** the local XML, live descriptor or existing draft changes after preview/approval
- **THEN** application reports stale/conflicting state without persisting the changed inputs

### Requirement: Persist only a draft and verify it
The adapter SHALL authorize an authenticated Jira administrator independently of CLI confirmation. It SHALL parse descriptors without external entity or network resolution, validate without executing embedded scripts, serialize its own concurrent writes per workflow across cluster nodes, and create/update only that workflow's draft. It SHALL never save a live descriptor, publish a draft or switch workflow schemes. Independent read-back SHALL verify the intended normalized draft descriptor and unchanged live fingerprint. If desired draft content already holds, the importer SHALL report already-satisfied without another write. A failed or ambiguous write SHALL be reported with observable state and SHALL not be automatically retried or rolled back by publishing/deleting.

#### Scenario: Confirmed draft replacement
- **WHEN** a valid descriptor is applied after confirmation and fingerprint checks
- **THEN** read-back shows the desired draft, the live descriptor remains unchanged and publishing is a separate operation

#### Scenario: XML attempts external resolution
- **WHEN** imported XML declares external entities or a document type requiring external resolution
- **THEN** validation rejects it without filesystem/network resolution or workflow mutation

#### Scenario: Server ignores or ambiguously completes a write
- **WHEN** persistence read-back mismatches or the mutation response is lost
- **THEN** the tool reports verification/indeterminate state and requires a new read before another user-approved attempt

### Requirement: Separate adapter installation and compatibility evidence
The repository SHALL provide deployable adapter code and installation/rollback instructions. Installation SHALL be a separate administrator action, and the tool SHALL report an unavailable adapter rather than installing it implicitly. Allowed product pairs, compiled API evidence and live verified pairs SHALL be recorded separately. Administration links SHALL include their verified/unverified status.

#### Scenario: Adapter is not installed
- **WHEN** a user invokes XML transfer on a Jira without the required adapter
- **THEN** the tool reports Unsupported with installation guidance and changes nothing
