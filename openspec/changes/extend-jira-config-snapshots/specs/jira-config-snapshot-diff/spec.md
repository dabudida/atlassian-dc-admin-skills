# Spec Delta

## ADDED Requirements

### Requirement: Local snapshot comparison
The system SHALL provide `jira_diff_config` to compare two local snapshot files given by path, without any network request. It SHALL accept schema v1 and v2 snapshots, reading v1 through a compatibility view. It SHALL refuse unreadable, non-regular, oversized, non-JSON and non-snapshot files and unsupported schema versions with a validation error that does not echo file content.

#### Scenario: Unchanged instance
- **WHEN** two captures of an unchanged instance are compared
- **THEN** the result reports identical with zero added, removed and changed items

#### Scenario: Not a snapshot
- **WHEN** one file is not JSON, or is JSON without the snapshot structure, or has an unsupported schemaVersion
- **THEN** the tool fails with a validation error and does not print the file content

### Requirement: Bounded structured diff per component
For each component the result SHALL list added and removed items by stable key, and changed items with field-level before→after values. Item and field lists SHALL be capped, with totals. An added or removed parent SHALL be reported once, without its children. Hidden preset values SHALL never be printed; a hidden row's `values` SHALL be compared as one opaque item, whatever its shape, so no part of it appears in keys, names or field values. The result SHALL report identical as false when a component exists in one snapshot only, and SHALL NOT report identical as true when a requested component is in neither snapshot. Strings SHALL appear only as short truncated previews. The result SHALL warn when scopes or instances differ, when a component was captured on one side only, and when coverage is partial or differs.

#### Scenario: Changed form label
- **WHEN** a request-type form field label differs between the snapshots
- **THEN** the field's row is reported as changed with the label's before and after values

#### Scenario: Preset value changed
- **WHEN** a hidden field's preset value differs
- **THEN** the change is reported as a hidden values change, and neither value appears in the output

#### Scenario: Object-shaped preset values
- **WHEN** a hidden field's preset values are a list of objects with ids, names and values
- **THEN** only one hidden values change is reported for the row, and no id, name or value of those objects appears in the output

#### Scenario: Component on one side only
- **WHEN** a component is captured in only one of the snapshots
- **THEN** the result is not reported as identical
