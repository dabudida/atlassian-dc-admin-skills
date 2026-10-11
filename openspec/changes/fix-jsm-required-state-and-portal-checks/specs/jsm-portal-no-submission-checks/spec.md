# Spec Delta

## Purpose

Provide administrators with a repeatable portal form checklist that captures validation evidence without creating customer requests or sending submission-triggered notifications.

## ADDED Requirements

### Requirement: Portal checks without request submission
The skill SHALL route portal form validation requests to a focused reference describing how to read ordered form configuration and inspect a rendered form as the relevant customer. The checklist SHALL cover field visibility/order/labels, mandatory-state provenance, empty/valid/invalid input and field-level validation after supported non-submitting interactions. It SHALL prohibit Submit and request/issue creation as default tests. Before interacting with a dynamic field whose scripts may have side effects, it SHALL require inspection of the available script/configuration or use an isolated test instance; unknown side effects SHALL not be presented as safe.

#### Scenario: Field validation without creating a request
- **WHEN** an administrator needs to test a field-level rule on a portal form
- **THEN** the checklist identifies non-submitting interactions and records their results without creating a request

#### Scenario: Side effects are unknown
- **WHEN** a Behaviour or field script cannot be inspected or has possible write/notification side effects
- **THEN** the checklist marks that live interaction unavailable and directs execution to an isolated environment

### Requirement: State validation limits and evidence
The reference SHALL distinguish configuration inspection, browser field/Behaviour checks, isolated script tests, server create-transition validators and end-to-end request submission. It SHALL not claim that a browser check proves server validators or that arbitrary scripts become safe by setting `DRY_RUN=true`. It SHALL provide an evidence template with target instance/version, project/request type/field, customer role, input, action, expected/observed result, check layer and status. Status SHALL distinguish passed, failed, unavailable and not run. No-request confirmation SHALL be recorded separately from the absence of unrelated notifications. Production mail suppression SHALL not be a workaround.

#### Scenario: Create-transition validator
- **WHEN** a requested rule runs only during issue creation and no supported isolated test harness is available
- **THEN** the report marks it unavailable without submission and does not claim runtime verification from form inspection

#### Scenario: Partial portal evidence
- **WHEN** mandatory-state inspection passes but the Behaviour interaction was not executed
- **THEN** the report records the configuration result and the Behaviour result separately, with the latter not run
