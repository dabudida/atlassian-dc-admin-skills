# Spec Delta

## MODIFIED Requirements

### Requirement: Read a request type form
The system SHALL provide `jira_get_request_type_form` (request type id or exact name, with service desk or project key). It SHALL return the visible fields in order (field id, Jira name, label, description, required), the hidden fields with their preset values, and the fields that could still be added. Addable fields SHALL remain opt-in through `include_addable`; the default result SHALL retain the addable count. Visible fields SHALL also expose `sdRequired` and `jiraRequired`; the existing `required` property SHALL represent their logical OR and SHALL not be renamed.

#### Scenario: Form with hidden preset
- **WHEN** an administrator reads a form that hides Priority with the preset "High"
- **THEN** the result lists Priority among the hidden fields with the preset "High"

#### Scenario: Required by Jira only
- **WHEN** a visible field has `sdRequired=false` and `jiraRequired=true`
- **THEN** the result shows those two flags and `required=true`, preserving the field's position

#### Scenario: Optional field
- **WHEN** both mandatory flags are false for a visible field
- **THEN** the result shows `required=false` and both flags as false

### Requirement: Change form fields
The system SHALL provide these tools:
- `jira_add_request_type_field` ✎: field, optional label, description, required and 1-based position;
- `jira_remove_request_type_field` ✎;
- `jira_move_request_type_field` ✎: position or `after` another field;
- `jira_update_request_type_field` ✎: label, description and/or required;
- `jira_hide_request_type_field` ✎: optional `preset` value;
- `jira_show_request_type_field` ✎.

Fields SHALL be accepted by id or exact name. A field that is already present (add) or absent (remove), already at the target position, or already has the requested values SHALL be reported as already-satisfied. A field that Jira requires and that has no preset SHALL NOT be hidden. Each change SHALL depend only on the state it acts on: the field's presence, its anchor, or its stored values. Several changes to one form in a plan therefore do not drift each other. After a confirmed change the system SHALL read the form back and verify it.

An explicit `required=false` SHALL mean that the visible field becomes optional under both the portal and Jira mandatory flags. If Jira requires the selected field, add/update SHALL reject the optional-state request before any mutation or already-satisfied outcome, including a request that also changes a label or description. It SHALL name the blocking field and explain the Jira requirement; it SHALL not automatically change shared Jira field configuration. Boolean false and the CLI string `false` SHALL preserve the same intent. When applying a plan for optional state, changes to the field's Jira mandatory flag SHALL invalidate the prior approval before mutation. Verification SHALL reject ignored portal-flag updates, a missing field, or a Jira requirement introduced after the mutation, with a diagnostic carrying the observed requirement state.

#### Scenario: Required field with a description
- **WHEN** an administrator adds "Severity" at position 2 as required, with the description "1 = critical … 4 = low"
- **THEN** after confirmation the form shows Severity second, required, with that description

#### Scenario: Hide a required field without preset
- **WHEN** an administrator hides a field Jira requires and gives no preset
- **THEN** the system rejects the change and names the field

#### Scenario: Preset on a hidden field
- **WHEN** an administrator hides Priority with preset "High"
- **THEN** after confirmation the form lists Priority as hidden with preset "High"

#### Scenario: Several form changes in one plan
- **WHEN** a plan removes two fields and adds one to the same form
- **THEN** applying it executes all three without reporting drift

#### Scenario: Explicit false is applied
- **WHEN** a field is portal-required but not Jira-required and an administrator confirms `required=false`
- **THEN** the write includes an explicit false value and independent read-back proves that both mandatory flags are false

#### Scenario: Optional state already holds
- **WHEN** an administrator requests `required=false` and both mandatory flags are already false
- **THEN** the system reports already-satisfied and sends no mutation

#### Scenario: Jira-required field cannot become optional
- **WHEN** an administrator requests `required=false` for a Jira-required field, even if its portal flag is already false
- **THEN** the system reports the blocking Jira requirement without applying any part of the request or reporting already-satisfied

#### Scenario: Ignored write or changed requirement
- **WHEN** read-back after a confirmed optional-state write shows the portal flag still true or the Jira mandatory flag true
- **THEN** the system returns a verification error identifying the field and observed mandatory flags

#### Scenario: Approval becomes stale
- **WHEN** Jira makes the field mandatory after the optional-state plan was approved but before its mutation
- **THEN** application does not mutate the field and reports the stale or blocked state

#### Scenario: Label-only change on a Jira-required field
- **WHEN** an administrator changes only a field's label or description without requesting optional state
- **THEN** the existing guarded update remains available and preserves both mandatory flags
