# Tasks

Use the existing OpenSpec apply workflow and `superpowers:executing-plans` for inline execution. This is the implementation plan for the approved first slice. Its architecture and scope are in design.md; its behavior contracts are in the two delta specs. All local implementation tasks are complete; verification evidence and live-instance limitations are recorded in design.md.

## 1. Establish the mandatory-state regression

Files: `test/unit/jsmRequestTypes.test.ts`, `src/tools/jira/requestTypes.ts`.

- [x] 1.1 Run `node --import tsx --test test/unit/jsmRequestTypes.test.ts test/unit/jsmShared.test.ts` and record the baseline; inspect the selected optional-field rows and current update/read paths. Verification: test summary recorded, no live requests or source edits before regression tests.
- [x] 1.2 Add the Jira-required false-success regression below for both the boolean and string false inputs, then run `node --import tsx --test --test-name-pattern='optional state' test/unit/jsmRequestTypes.test.ts`. Verification: it fails because the current tool returns already-satisfied for Priority; record the failure before implementation.

```ts
it("rejects optional state when Jira requires the field", async () => {
  for (const required of [false, "false"]) {
    const r = await run("jira_update_request_type_field", {
      service_desk: "BANK", request_type: 83, field: "priority",
      required, dry_run: false,
    }, fakeJsm({ jsm: "11.3.8" }).responder);
    assert.equal(r.res.ok, false);
    assert.equal(r.error.type, "ValidationError");
    assert.match(r.error.message, /Priority.*required by Jira/i);
    assert.equal(r.calls.filter((c) => c.method !== "GET").length, 0);
  }
});
```

- [x] 1.3 Add a combined-request regression with `field: "summary", required: false, label: "New title"`, and an add-field regression with `field: "priority", required: false`. Verification: both reject without non-GET calls or label changes, and the current implementation fails these assertions before the fix.
- [x] 1.4 Add the raw-flag reader regression below and run it to observe failure before changing the reader. Verification: absent `sdRequired`/`jiraRequired` output fails the assertions while the existing field order and hidden preset tests still pass.

```ts
it("reads mandatory-state provenance in field order", async () => {
  const r = await run("jira_get_request_type_form", {
    service_desk: "BANK", request_type: 83,
  }, fakeJsm().responder);
  assert.ok(r.res.ok, JSON.stringify(r.error));
  assert.deepEqual(r.value.visible.map((f: any) =>
    [f.fieldId, f.sdRequired, f.jiraRequired, f.required]), [
    ["summary", true, true, true],
    ["description", false, false, false],
    ["priority", false, true, true],
    ["components", false, false, false],
  ]);
});
```

## 2. Implement the smallest preflight and reader correction

Files: `src/tools/jira/requestTypes.ts`, `test/unit/jsmRequestTypes.test.ts`.

- [x] 2.1 Add `sdRequired: r.sdRequired, jiraRequired: r.jiraRequired` to each visible-row result alongside the existing `required` expression. Verification: task 1.4 and the existing ordered/hidden/addable reader tests pass; hidden-row schema remains unchanged.
- [x] 2.2 Add the helper below near the form helpers. Invoke it in update after resolving the visible row and before creating `attrs` or returning already-satisfied. In add, invoke it for the selected existing visible row and for the resolved unused row before any POST or already-satisfied return. Verification: tasks 1.2–1.3 pass, and label-only edits of Jira-required fields remain available.

```ts
function rejectJiraRequiredOptional(row: FormRow, required: boolean | undefined): void {
  if (required === false && row.jiraRequired) {
    throw new ValidationError(
      `${row.name} (${row.fieldId}) is required by Jira; ` +
      "required=false cannot make it optional on this portal. " +
      "Review the shared Jira field configuration separately.",
    );
  }
}
```

- [x] 2.3 Add a test for an already-optional Description field and a test for a label-only Summary edit. Verification: the first returns already-satisfied with GETs only; the second changes the label without changing `sdRequired` or `jiraRequired`. Run `node --import tsx --test test/unit/jsmRequestTypes.test.ts` and record the result.

## 3. Verify explicit false and races independently

Files: `test/unit/jsmRequestTypes.test.ts`, `src/tools/jira/requestTypes.ts`.

- [x] 3.1 Add a successful optional-state test for boolean false and string false with `jsm: "11.3.8"`. Start Description at `sdRequired=true, jiraRequired=false`; assert dry-run shows `{sdRequired:false}` and makes GETs only, confirmed update includes false in its PUT body, subsequent GETs occur, and read-back shows both flags false. Verification: targeted tests pass and the recorded HTTP calls prove false was not omitted.
- [x] 3.2 Add a responder wrapper that ignores the selected PUT and another that applies it but sets `jiraRequired=true`, using the code below. Verification: ignored-write handling passes its existing failure assertion; the race assertion fails on the old verification logic before changing it. Add the corresponding add-field post-write race by identifying its settings PUT; verify no successful result when read-back is effectively required.

```ts
it("detects a Jira requirement introduced during the write", async () => {
  const jsm = fakeJsm({ jsm: "11.3.8" });
  const row = jsm.forms["83"].visible.find((f: any) => f.fieldId === "description");
  row.sdRequired = true;
  const responder = (c: Call) => {
    const reply = jsm.responder(c);
    if (c.method === "PUT" && path(c).endsWith(`/visible/${row.id}`)) {
      row.jiraRequired = true;
    }
    return reply;
  };
  const r = await run("jira_update_request_type_field", {
    service_desk: "BANK", request_type: 83, field: "description",
    required: false, dry_run: false,
  }, responder);
  assert.equal(r.res.ok, false);
  assert.equal(r.error.type, "VerificationError");
});
```

For the ignored-write wrapper, intercept the selected PUT before `jsm.responder(c)` and return `{body: row}` without mutating the row. For the disappearing-field case, let the PUT complete and remove that field from the fake's visible array before the independent GETs. Assert `VerificationError` and an explicit missing-field diagnostic.

- [x] 3.3 In update, keep checking sent attributes but include the effective optional-state condition below. On a failed check throw `Verification` inside the callback with request type, field identity and observed flags (or missing-field state), before returning the successful callback result. Add the same effective condition to add-field's final verification. Verification: ignored/raced/disappeared scenarios return the diagnostic; success and true/label-only updates still pass.

```ts
const optionalOk = args.required !== false || (!!back && !back.sdRequired && !back.jiraRequired);
const storedOk = !!back && Object.entries(attrs).every(([k, v]) => (back as any)[k] === v);
if (!storedOk || !optionalOk) {
  throw new Verification(`${summary}: the read-back does not show the requested field state`, {
    requestTypeId: rt.id, fieldId: row.fieldId, missing: !back,
    ...(back ? {
      sdRequired: back.sdRequired, jiraRequired: back.jiraRequired,
      required: back.sdRequired || back.jiraRequired,
    } : {}),
  });
}
```

In add's existing final condition, append `(args.required !== false || (!!added && !added.sdRequired && !added.jiraRequired))` and use the same diagnostic shape with `add.fieldId`. Do not use update's `row` variable in the add handler.

## 4. Bind approval to the relevant Jira requirement

Files: `test/unit/jsmRequestTypes.test.ts`, `src/tools/jira/requestTypes.ts`.

- [x] 4.1 Add a dry-run state regression and a plan integration regression using existing `addResultToPlan`, `applyPlan`, `readPlan` helpers. Plan an optional-state update with both flags permitting it, then set only the selected row's `jiraRequired=true` before apply. Verification: the dry-run test fails before fingerprint changes; apply sends no mutation and reports blocked/failed or drifted instead of DONE. Keep unrelated-field and multiple-form-change tests passing.
- [x] 4.2 Extend update's `state` with `...(args.required === false ? { jiraRequired: row.jiraRequired } : {})`; extend add's existing state with the selected row's Jira requirement when explicit false is requested. Verification: state regressions pass, the plan refuses stale optional state, and changing another field does not invalidate this plan.

## 5. Deliver the portal checklist and dispatch routing

Files: create `atlassian-dc-admin/PORTAL_TESTING.md`; modify `atlassian-dc-admin/SKILL.md`.

- [x] 5.1 Write the reference with this sequence: describe/read `jira_get_request_type_form` for the selected service desk/request type; record ordered fields and both mandatory flags; identify the customer role and available dynamic scripts; inspect the rendered form; test empty, valid and invalid input using supported change/blur interactions without Submit only when scripts have been inspected or in isolation; record each layer separately. Verification: a reviewer can follow it without request creation, script execution, a guessed new tool or a dependency on the future Behaviours module.
- [x] 5.2 Include the evidence table columns `Instance/version | Project/request type/field | Customer role | Layer | Input/action | Expected | Observed | Status | No request created | Notification observation`. Define `PASS`, `FAIL`, `UNAVAILABLE`, `NOT_RUN`. Mark create-transition validators unavailable without a supported isolated harness; include an example where configuration passes but Behaviour runtime is NOT_RUN. Verification: review each scenario in `jsm-portal-no-submission-checks/spec.md` against this artifact, and ensure no generic promise that no mail can be sent by arbitrary field scripts.
- [x] 5.3 Link the reference from SKILL.md only for portal form/validator checks, state effective `required=false` semantics in the tool descriptions, and preserve existing confirmation instructions. Verification: links resolve, comments/instructions are English, and `pnpm build` generates the updated tool descriptions/reference/bundle successfully. Do not add wording-matching documentation tests.

## 6. Integrate, review and record evidence

- [x] 6.1 Run `node --import tsx --test test/unit/jsmRequestTypes.test.ts test/unit/jsmShared.test.ts`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `git diff --check` and `openspec validate fix-jsm-required-state-and-portal-checks --strict`. Verification: each command's exit and summary are recorded; any failing check remains unfinished and is investigated. A fake-server bind error requires the normal sandbox escalation, not a skipped test.
- [x] 6.2 Apply `superpowers:requesting-code-review` to the completed non-trivial diff and resolve supported feedback. Verification: reviewer checks preflight ordering, false preservation, read-back, drift state, the no-submission limits and generated outputs; subsequent checks cover any new edits.
- [x] 6.3 Record local fixture evidence and exact-version evidence separately in design.md and the final implementation report. If an explicitly selected target-instance configuration is available, read the version and affected form through the CLI with GETs only, retaining sanitized flags. Verification: no production mutation, issue creation or script execution occurs as part of this task; if live evidence is unavailable, the report explicitly leaves the original 11.3.8 runtime symptom unverified. A live corrective PUT is a separate preview/confirmation action and is not required for local delivery.

The umbrella roadmap remains the inventory for all eleven requested items. This change ends after items 4 and 7 are locally implemented and verified; later capabilities require their own proposal/apply cycles. No archive or commit/push is implicit in these tasks.
