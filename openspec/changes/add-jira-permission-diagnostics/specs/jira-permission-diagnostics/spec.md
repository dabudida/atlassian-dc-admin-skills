# Spec Delta

## Purpose

Explain a user's effective Jira DC project permission from Jira's own check plus the permission scheme, and summarise one user's access across a bounded set of projects.

## ADDED Requirements

### Requirement: Explain a user's project permission
The system SHALL provide read-only `jira_explain_permission` taking `username` (name or key), `permission` (scheme key or legacy alias, any case), and `project_key` and/or `issue_key`. It SHALL report a verdict (`granted`, `denied` or `unknown`), Jira's own answer from `/rest/api/2/user/permission/search` (using the legacy permission name and exact user matching, `issueKey` when an issue is given), the project's permission scheme, every grant of that permission with whether it matches the user (`yes`, `no`, `conditional`, `unknown`) and why, and the user's active state and application access. It SHALL use GET requests only.

#### Scenario: Grant through a project role group
- **WHEN** the permission is granted to a project role whose actors include a group the user belongs to
- **THEN** that grant matches with a reason naming the role and the group, and the verdict agrees with Jira's answer

#### Scenario: Legacy alias
- **WHEN** the permission is given as `BROWSE` or `create_issue`
- **THEN** grants are matched under `BROWSE_PROJECTS` or `CREATE_ISSUES` and Jira's check is asked with the legacy name

### Requirement: Report disagreements instead of guessing
When the computed explanation and Jira's answer differ, the result SHALL say so explicitly and name holders it could not evaluate (for example custom-field or plugin holder types). When Jira's check is unavailable for the permission name, the result SHALL say that the verdict comes from the grants alone, and an inconclusive computed result SHALL yield `unknown`.

#### Scenario: Jira denies what the grants allow
- **WHEN** a grant matches but Jira's check does not return the user
- **THEN** the verdict is `denied`, agreement is `disagree` and a note states the disagreement

#### Scenario: Ground truth unavailable
- **WHEN** Jira answers 400 for the permission name and only issue-dependent holders could match
- **THEN** the ground truth is `unavailable`, the computed result is `conditional` and the verdict is `unknown`

### Requirement: Issue context
With `issue_key`, the tool SHALL use the issue's current project, evaluate reporter, assignee and user/group custom-field holders against the issue, and report its security level. Because level members are not readable via REST, membership SHALL be reported as inferred from Jira's answer (`granted-by-ground-truth`, `likely-not`, `unknown`) or `no-level`.

#### Scenario: Secured issue denial
- **WHEN** the scheme grants the permission but Jira denies it on an issue with a security level
- **THEN** the result states that the security level most likely excludes the user

### Requirement: Summarise one user's access within a request budget
The system SHALL provide read-only `jira_user_access_summary` returning the user's active and deleted state, last login, application access, groups (preview-capped) and, per project, the roles the user holds directly or via a group. Projects SHALL be the given keys or all projects, paged (default 20, max 50). The tool SHALL read the global role list once and then one role per project, SHALL shrink the page so projects × roles stays within 200 requests and report that, SHALL allow narrowing by role, and SHALL report a failed project read as a per-project error.

#### Scenario: Budgeted page
- **WHEN** 10 roles exist and 50 projects are requested
- **THEN** 20 projects are returned with `nextOffset` 20 and a note on the reduced page
