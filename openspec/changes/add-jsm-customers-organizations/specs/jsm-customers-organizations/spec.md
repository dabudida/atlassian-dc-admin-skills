# Spec Delta

## ADDED Requirements

### Requirement: Read organizations
The system SHALL provide `jira_list_organizations` (all organizations, paged), `jira_get_organization` (one organization by id or exact name with a page of its users as compact rows) and `jira_list_service_desk_organizations` (organizations linked to a service desk given by id or project key, paged). Listings SHALL be bounded by `limit` and report `nextOffset`. An organization name that matches several organizations SHALL be rejected with a validation error that names their ids.

#### Scenario: Organization by name
- **WHEN** an administrator reads organization "Acme" and exactly one organization has that name
- **THEN** the system returns its id, name and the first page of its users

#### Scenario: Ambiguous name
- **WHEN** two organizations are named "Acme"
- **THEN** the system rejects the request and asks for an id

### Requirement: Change organizations and their users
The system SHALL provide `jira_create_organization` ✎, `jira_delete_organization` ✎, `jira_add_organization_users` ✎ and `jira_remove_organization_users` ✎. Each SHALL be a dry run by default, SHALL report already-satisfied when the organization already exists, is already gone, or all users are already (not) members, SHALL send only the users that change, and SHALL read the result back after a confirmed change. The deletion summary SHALL state that deletion is irreversible and removes the organization from every service desk, and its dry run SHALL report how many service desks link the organization. Usernames SHALL be compared case-insensitively, and requests SHALL use the server's spelling of existing members. A numeric organization input that is one organization's id and another's exact name SHALL be refused as ambiguous. When a member or organization list exceeds its scan cap, the system SHALL NOT report a user as a non-member, an organization as missing or a name as free; it SHALL refuse such a decision, and SHALL report verification as partial when a read-back is capped.

#### Scenario: Users already members
- **WHEN** every requested username is already a member of the organization
- **THEN** the system reports already-satisfied and sends nothing

#### Scenario: Username case differs
- **WHEN** an administrator removes `JSmith` from an organization whose member is `jsmith`
- **THEN** the request removes `jsmith`; it is not reported as already-satisfied

#### Scenario: Capped member list
- **WHEN** an organization has more members than the scan cap and a requested user is not among those read
- **THEN** the removal is refused instead of reported as already-satisfied

#### Scenario: Delete a linked organization
- **WHEN** an administrator previews deleting an organization linked to two service desks
- **THEN** the dry run says the deletion is irreversible and names the two linked service desks

### Requirement: Link organizations to service desks
The system SHALL provide `jira_add_service_desk_organizations` ✎ (one or more organizations) and `jira_remove_service_desk_organization` ✎. Already linked (or unlinked) organizations SHALL be skipped, nothing left to do SHALL be already-satisfied, and the desk's organization list SHALL be read back after a confirmed change.

#### Scenario: Link two organizations, one already linked
- **WHEN** an administrator adds organizations A and B to a service desk that already has A
- **THEN** the dry run sends one request for B only

### Requirement: Manage service desk customers honestly
The system SHALL provide `jira_add_service_desk_customers` ✎, `jira_remove_service_desk_customers` ✎ and `jira_create_customer` ✎. Because the public API cannot list service desk customers on JSM 11.3, customer membership SHALL be read from the user actors of the project role "Service Desk Customers". Adding SHALL skip direct members and verify each requested username afterwards; when the role does not exist, the result SHALL state that membership is unverifiable instead of claiming success. Removal SHALL delete the user actor from that role, SHALL report users who are not direct members without changing them, and SHALL refuse when the role does not exist. Creating a customer SHALL send e-mail and full name, SHALL report already-satisfied when a user with that username or e-mail exists, and SHALL read the new user back.

#### Scenario: Customer already added
- **WHEN** every requested username is already a user actor of "Service Desk Customers"
- **THEN** the system reports already-satisfied and sends nothing

#### Scenario: No customer role
- **WHEN** the service desk project has no "Service Desk Customers" role
- **THEN** adding customers reports `verification: unverifiable` and removing customers is rejected

#### Scenario: Customer reaches the desk through a group
- **WHEN** a username to remove is not a direct user actor of the role
- **THEN** the system lists it under `not_direct_customers` and does not change it
