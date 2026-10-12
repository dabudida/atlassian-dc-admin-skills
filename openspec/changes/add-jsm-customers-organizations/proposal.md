# Proposal

## Why

Jira Service Management administrators manage who may raise requests through customer organizations, service desk organization links and individual customers. The skill can read service desks, queues and request types but cannot list organizations, change their members, link them to service desks or add and remove customers, so this routine access work still needs the browser.

## What Changes

- Add read tools for organizations: the global organization listing, one organization with a page of its users, and the organizations of a service desk. All listings are paged and return compact rows.
- Add guarded write tools: create and delete an organization, add and remove organization users, add and remove organizations on a service desk, add and remove service desk customers, and create a customer account.
- Every write is a dry run by default, reports already-satisfied when nothing would change, and reads the result back after a confirmed change.
- Organizations are accepted by id or exact name; an ambiguous name is rejected.
- Customer membership is read from the service desk's "Service Desk Customers" project role, because `GET /rest/servicedeskapi/servicedesk/{id}/customer` answers 405 on JSM 11.3 and the public API offers no customer removal route.

## Capabilities

### New Capabilities

- `jsm-customers-organizations`: read and change JSM organizations, their users, service desk links and service desk customers.

### Modified Capabilities

None.

## Impact

Add `src/tools/jira/jsmCustomers.ts` (export `jiraJsmCustomerTools`) and `test/unit/jsmCustomers.test.ts`. The integrator registers the array in `src/tools/index.ts`, adds the reference documentation and regenerates the bundle. No new dependency. Writes use the public `/rest/servicedeskapi` (with `X-ExperimentalApi: opt-in`) and, for customer removal and read-back, the Jira project role API `/rest/api/2/project/{key}/role`.
