# Tasks

The endpoint only reads the instance. New files only; nothing under `src/` changes.

## 1. Research

- [x] 1.1 Find the ScriptRunner report and Automation export resources with the probe script (`@Path` in the plugin jars); record them in design.md.
- [x] 1.2 Confirm the JSM internal form and SLA routes against the CLI's request type and SLA tools.

## 2. Implementation

- [x] 2.1 Endpoint: Java API sections, then REST sections through the caller's session with per-part error capture.
- [x] 2.2 Embed the ScriptRunner report and the Automation export.
- [x] 2.3 `unpack.py` with instance resolution through `instances.json`, report extraction and index rebuild.
- [x] 2.4 `build_indexes.py` preferring the embedded sources.
- [x] 2.5 `SKILL.md` lookup table, README section, `.gitignore` entry.

## 3. Verification

- [x] 3.1 Live, read-only: the endpoint on Jira DC 11.3.8 / ScriptRunner 10.17.0 returned 80 projects, 10 service desks, 100 request types, 5 Assets schemas, the ScriptRunner report (944 KB) and 116 Automation rules with 0 errors.
- [x] 3.2 `unpack.py` and `build_indexes.py` run against that zip: unknown host refused, `--instance` unpacked, 99 features, 403 workflow functions, 116 rules indexed.
- [ ] 3.3 The probe script in this generic form (both plugins, one filter) has not been run; its two earlier filtered variants were.
- [ ] 3.4 `openspec validate add-jira-config-snapshot --strict`.
