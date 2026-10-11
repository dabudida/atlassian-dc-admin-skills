# Proposal

## Why

Item 2 of the approved roadmap requires exporting XML for one production workflow and writing edited XML into the draft of that same workflow. Existing designer REST tools expose status models and rule counts, not a complete descriptor or a guarded XML round trip.

## What Changes

- Add `jira_export_workflow_xml` for one exact workflow and `jira_import_workflow_xml_draft` for confirmed same-instance, same-workflow draft updates from a local file.
- Supply a repository-owned ScriptRunner adapter for metadata/descriptor export, non-mutating validation and draft persistence, independent of the excluded custom snapshot endpoint comment.
- Bind export provenance, local file hash, live/draft hashes and target identity to previews and approval; validate descriptor structure and Jira references before creating or replacing a draft.
- Keep exported XML and complete descriptors in files. Return only metadata, hashes, structural counts, verification state and administration links, with link verification status.
- Refuse inactive/system targets for draft import; never publish, modify the live descriptor, execute embedded scripts or automatically retry an ambiguous write.

## Capabilities

### New Capabilities

- `jira-workflow-xml-transfer`: file-based complete descriptor export and guarded same-workflow draft import through a separately installed adapter.

### Modified Capabilities

- `jira-workflow-reading`: qualify the existing designer-only rules gap so an installed XML adapter can expose a complete descriptor to a local artifact without claiming the designer reader itself gained rule contents.

## Impact

Add `src/tools/jira/workflowXml.ts`, a deployable Groovy adapter/support code under `adapters/workflow-xml/` (shipped as `atlassian-dc-admin/scripts/workflow-xml/`), unit/adapter tests and `atlassian-dc-admin/WORKFLOW_XML.md`; register tools and regenerate the CLI/reference. Keep existing publishing tools and their confirmation separate. No production endpoint installation or workflow mutation is authorized by this planning phase.

Initial adapter target is Jira 11.3.x with ScriptRunner 10.x/Jakarta; allowed and exact-pair verified evidence remain separate. Other pairs receive Unsupported instead of a guessed javax/Jakarta fallback. Cross-instance migration, workflow cloning, deletion and automated publishing are outside this change.
