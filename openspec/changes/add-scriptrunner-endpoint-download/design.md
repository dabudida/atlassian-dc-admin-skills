# Design

## Decisions

- **Path:** only `/rest/scriptrunner/latest/custom/<name>` with `name` matching `[A-Za-z0-9_-]+`, checked by the input schema before any request, so the tool cannot reach other REST resources. `client.getBytes` already refuses hosts other than `baseUrl`, so the token never leaves the instance.
- **Read-only:** GET only. The tool is as safe as the endpoint it calls; the description says so. It is registered as a read tool and bounded by `max_bytes` (default 200 MB, cap `MAX_BYTES_CAP`): a larger response writes nothing.
- **Timeout:** snapshots take longer than the default request timeout (60 s), so the client timeout is raised to `timeout_s` (default 600 s, max 1800) for this call only and restored in `finally`.
- **File:** `out`, else `output_dir` (default `~/Downloads`) plus the `Content-Disposition` file name passed through `basename`, else `<name>-<timestamp>.<ext>` by content type. `writeLocal` keeps a different existing file (`CONFLICT`) and reports an identical one as `ALREADY-SATISFIED`.
- **Output:** path, size, SHA-256, content type and outcome; the body is never printed, like the Script Root tools.

## Verification

On Jira DC 11.3.8 with ScriptRunner 10.17.0 the same code (patched into the bundle) downloaded `jiraConfigSnapshot` in 16 s; the snapshot had 0 errors, including the sections the endpoint reads over REST with the forwarded token (JSM, Assets, ScriptRunner report, Automation).
