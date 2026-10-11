# Portal form checks without submitting a request

Use this workflow when checking a request type's form or a field validator and submission would create a request or trigger mail. It does not execute scripts or create requests.

## Read the configuration

Use the dispatcher from SKILL.md, with the explicitly selected Jira configuration:

```bash
$A describe jira_get_request_type_form
$A jira_get_request_type_form service_desk=PROJECT request_type=123 --format=json
```

Replace `PROJECT` and `123` with the actual project/service desk and request type from the task. Record the instance, Jira and JSM versions, project, request type and field identifiers. Read the ordered visible fields, labels, descriptions and mandatory flags:

- `sdRequired`: the portal configuration requires the field.
- `jiraRequired`: Jira requires the field independently of the portal flag.
- `required`: the logical OR of those flags; the effective mandatory state reported by configuration.

`required=false` in add/update requests means the field must become optional under both flags. A Jira-required field is rejected before any mutation, even if its portal flag is already false. Review the shared Jira field configuration as a separate change; do not relax it just to test one portal. Confirmed updates read back the field and report verification failure when the server ignores the request or the field remains required. This checks stored form configuration, not every workflow validator.

Keep hidden preset values in local evidence files if sensitive; do not paste them into general reports. Use `include_addable=true` only when investigating fields that can be added. Reads do not change the form.

## Inspect before interacting

Identify the customer role/account whose form is being checked. Administrator access alone does not prove that a customer sees the same form or has the same permissions.

Before opening or changing a dynamic form, inspect the available Behaviour/field scripts and mappings. Opening the page can run initializers; change/blur actions can run scripts with writes or notification side effects. If scripts cannot be inspected, or their side effects are unclear, mark those live interactions UNAVAILABLE and use an isolated test instance. The current metadata-only ScriptRunner reader does not prove that a Behaviour script is safe. Do not depend on a future Behaviours configuration tool.

Where this inspection is possible and side effects have been ruled out, an administrator can open the actual customer form and check it manually. Browser automation is not required by this workflow.

## No-submission checklist

1. Compare visible fields, their order, labels, descriptions and mandatory markers against the configuration read. Check hidden fields remain hidden.
2. For each selected field, prepare empty, valid and invalid input with the expected field-level message. Avoid real sensitive customer data.
3. Use only supported non-submitting interactions, such as typing, changing a selection or moving focus. Check errors, conditional visibility and field dependencies at each step. Do not press Submit, Enter in a context that submits the form, or any create-request action.
4. Record the input, interaction and observed message/mandatory state for each case. An error that appears only after submission is not validated by this procedure.
5. Leave the form without submitting it. Record whether a request was created separately from any notification observations. Absence of a new request does not prove arbitrary field scripts cannot send mail.

Do not create an issue/request through the CLI as a test fallback, disable production mail, or execute an arbitrary server script under the assumption that `DRY_RUN=true` makes it safe.

## What each check proves

| Layer | Supported evidence | Limit |
| --- | --- | --- |
| Configuration | Field order, visibility, stored portal/Jira mandatory flags | Does not execute validator code |
| Browser field/Behaviour interaction | Observed customer-form reactions for inspected, non-submitting actions | Does not prove server create-transition validators |
| Isolated script test | Result for explicit inputs in an existing isolated harness | Does not prove production permissions, mappings or side effects |
| Server create-transition validator | Requires a supported isolated harness or a separate approved end-to-end test | UNAVAILABLE without such a harness; do not submit production requests by default |
| End-to-end request submission | Actual request creation and downstream behavior | Outside this no-submission checklist; requires separate authorization for its side effects |

## Evidence template

Use PASS for an observed expected result, FAIL for a mismatch, UNAVAILABLE for a check that cannot safely be performed through the available method, and NOT_RUN for a check that was not attempted. Include a reason for unavailable/not-run checks. Never promote configuration evidence to runtime evidence.

| Instance/version | Project/request type/field | Customer role | Layer | Input/action | Expected | Observed | Status | No request created | Notification observation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Selected instance and observed versions | Selected identifiers | Relevant customer role | Configuration | GET form | Both mandatory flags false | Both flags false | PASS | GETs only | Not assessed |
| Same instance | Same identifiers | Same role | Behaviour runtime | Not attempted | Invalid input rejected | Scripts unavailable for inspection | NOT_RUN | No interaction | Not assessed |
| Same instance | Same identifiers | Same role | Create-transition validator | No harness available | Rule rejects invalid input | No safe no-submission method available | UNAVAILABLE | No submission | Not assessed |

These rows are examples, not captured instance evidence. Replace them with actual observations. If a later end-to-end test is needed, report why the no-submission evidence is insufficient and specify the target, expected request and notification side effects before that separate action.
