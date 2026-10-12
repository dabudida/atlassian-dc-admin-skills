# Tasks

Read-only toward the live instance (WADL and GETs; dry runs only). New files only; registration in `src/tools/index.ts` is left to the integrator.

## 1. Research

- [x] 1.1 List the priority, resolution, priority scheme and project priority scheme routes in `/rest/api/2/application.wadl`; record that `/priority` and `/resolution` have no write.
- [x] 1.2 GET the list, scheme and project priority scheme responses and the admin pages; record shapes and websudo answers in design.md.

## 2. Implementation (TDD)

- [x] 2.1 Write `test/unit/jiraPriorities.test.ts` against a stateful fake Jira; verify it fails because the module does not exist.
- [x] 2.2 Add the read tools (local paging, capped project keys, default priority as `{id, name}` or null).
- [x] 2.3 Add create, update and delete of priority schemes (name/id resolution, idempotence, default-scheme guard, read-back).
- [x] 2.4 Add `jira_assign_priority_scheme` (PUT with read-back; manual when issues would migrate).
- [x] 2.5 Add the manual `jira_create_priority` and `jira_create_resolution`; run the tests and the typecheck for the new files.

## 3. Verification

- [x] 3.1 Live, GET only: the read tools and dry runs of every write tool with all non-GET requests blocked.
- [x] 3.2 `openspec validate add-jira-priorities-resolutions --strict`.
- [ ] 3.3 Integrator: register `jiraPriorityTools`, document the tools, run the full suite and build.
