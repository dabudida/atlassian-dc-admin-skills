# Tasks

Implementation prerequisite: retain the locally implemented JSM mandatory-state fix. Execute sequentially using `superpowers:executing-plans`; do not archive other changes, install adapters or mutate Jira. For each code group, run the stated regression first, record the expected failure, implement the smallest change, then rerun it. All comments and guidance are English.

## 1. Snapshot contract and raw form evidence

- [x] 1.1 Create `test/unit/configSnapshot.test.ts` using `testContext` from `test/unit/helpers.ts`, temporary output directories and an HTTP fake; add a `jira_export_config` case with two ordered visible rows, one hidden preset and differing portal/Jira flags. Run `node --import tsx --test test/unit/configSnapshot.test.ts` and record failure because the tool is not registered. Assert every remote call is GET and no preset/description appears in the result.
- [x] 1.2 Extract a narrowly scoped raw form reader in `src/tools/jira/requestTypes.ts`, preserving existing caller behavior. Add missing/non-boolean flag fixtures; verify the raw view retains unknown values and `node --import tsx --test test/unit/jsmRequestTypes.test.ts` still passes.
- [x] 1.3 Create `src/tools/jira/configSnapshot.ts` with schema-v1 serialization: source URL stripped of credentials/query, observed versions, capture interval with `atomic:false`, explicit request-form-only scope, request-type identity, ordered visible rows with 1-based positions and separate hidden rows. Compute required as true if either raw flag is true, false only if both are false, otherwise null. Verify ordered/unknown/true/false cases in `configSnapshot.test.ts`.
- [x] 1.4 Add the read-only tool schema and registry import in `src/tools/index.ts`: service desk, required output directory, optional selection, preset/overwrite opt-ins and the designed inventory/byte limits. Verify registration, schema rejection before HTTP access, no dry-run argument for this read tool and default omission markers for hidden presets.

## 2. Complete inventory and explicit availability

- [x] 2.1 Add failing inventory tests for two public pages, a hidden-only request type with `issueType.id`, duplicate identities across sources and conflicting names/issue types. Verify the tests fail before replacing any capped discovery behavior.
- [x] 2.2 Implement limit-50 public pagination until `isLastPage=true`, merge hidden inventory by stable numeric id and preserve source statuses. Do not treat the existing 1,000-item list helper as completeness evidence. Verify all fixture identities are present once and conflicts have bounded identity diagnostics.
- [x] 2.3 Add failing selection tests for ids, exact names, ambiguous names and missing selections; resolve selection after inventory and refuse ambiguity before local writes. Verify selected scope is recorded accurately and the old artifact remains unchanged on refusal.
- [x] 2.4 Add failing coverage tests for unsupported/404 hidden discovery, one unavailable form source, malformed discovery/form shapes, missing field identity and HTTP 401/403. Implement complete/partial/unavailable source and form statuses; verify good forms survive unavailable peers, authorization fails the export, and malformed data never becomes an empty successful array.
- [x] 2.5 Add repeated-page/non-progress and request-type-cap tests; implement default cap 100, hard cap 1,000 and fail before output creation. Verify these failures leave an empty output directory or preserve its existing contents.

## 3. Local artifact integrity and output bounds

- [x] 3.1 Add failing tests for serialized UTF-8 byte limits, a destination symlink/non-regular file, conflict, identical content and explicit backup-and-replace. Verify failures preserve existing artifacts and do not publish partial JSON.
- [x] 3.2 Collect and serialize before writing, enforce the default 20 MiB/hard 200 MiB byte budget, then reuse `localTarget`, `writeLocal` and `sha256` from `src/tools/jira/scriptRoot.ts` for `jira-config-<serviceDeskId>.json`. Verify atomic outcomes and original-byte preservation in overwrite backups.
- [x] 3.3 Add opt-in preset and large-diagnostic fixtures; return only path/hash/bytes/outcome, capture/coverage counts and at most 50 diagnostic identities plus the total. Verify the preset is present only in the opted-in local artifact and a sentinel preset/description/raw error body is absent from CLI results and errors.

## 4. Documentation and release verification

- [x] 4.1 Create `atlassian-dc-admin/CONFIG_SNAPSHOTS.md` with one-service-desk examples, `.scratch/` output, explicit selection/limits, unknown mandatory flags, sensitive preset opt-in, conflict/backup behavior and non-atomic coverage limitations. Add a short dispatcher link without exceeding the SKILL body budget; verify examples match the registered schema and do not promise a full Jira backup.
- [x] 4.2 Run `node --import tsx --test test/unit/configSnapshot.test.ts test/unit/jsmRequestTypes.test.ts`, `pnpm typecheck`, `pnpm test` and `pnpm build`; verify all pass and the generated CLI/reference includes the new tool. Record local fixture evidence separately from exact-instance live evidence; live verification may remain NOT_RUN.
- [x] 4.3 Request code review of the snapshot diff, address supported findings, then run `openspec validate add-jsm-request-form-snapshots --strict` and `git diff --check`. Verify coverage of every spec scenario, no remote write path and no unrelated first-slice changes; do not commit, archive or deploy without a separate instruction.

## 5. Review follow-ups

- [x] 5.1 Make request-type and byte budget errors name the argument to raise and its hard cap, without changing the budget semantics. Verify the messages in `configSnapshot.test.ts`.

