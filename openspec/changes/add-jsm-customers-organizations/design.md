# Design

## Context

The public Service Desk REST API of JSM 11.3 (plugin 21.3.2, resources `OrganizationResource`, `OrganizationServiceDeskResource`, `ServiceDeskCustomerResource`, `CustomerResource`) offers:

- `GET/POST /organization`, `GET/DELETE /organization/{id}`, `GET/POST/DELETE /organization/{id}/user` (body `{usernames: [...]}`).
- `GET/POST/DELETE /servicedesk/{id}/organization` (body `{organizationId: N}`, one organization per call).
- `POST /servicedesk/{id}/customer` (body `{usernames: [...]}`) only. `GET` answers 405 (surfaced as HTTP 500 by the instance) and there is no `DELETE`.
- `POST /customer` with `{email, fullName}`; the new customer's username is the e-mail address.

All calls need `X-ExperimentalApi: opt-in` (`sdGet`, `OPT_IN` from `servicedesk.ts`). Service desks are resolved with `resolveServiceDesk` from `requestTypes.ts`.

## Goals / Non-Goals

**Goals:** bounded organization reads; idempotent, verified writes for organizations, links and customers; honest reporting where membership cannot be read back.
**Non-Goals:** organization cleanup (`/organization/cleanup`), customer invitations, portal-only settings, group-based customer access, request sharing.

## Decisions

### Organization identity
`organization` arguments accept a numeric id or an exact, case-insensitive name. A numeric value is first read as an id; if no organization has that id, it is matched as a name. Names are resolved against the full paged listing (capped at 5,000 organizations); several matches raise a ValidationError naming the ids.

### Customer membership through the project role
JSM keeps directly added customers as user actors of the project role "Service Desk Customers". The customer tools read that role (`/rest/api/2/project/{key}/role` → role URL → `actors`) before and after a change:

- add: usernames that are already user actors are skipped; all present → already-satisfied; after the POST each requested username must be a user actor, otherwise VerificationError.
- remove: the public API has no removal route, so removal deletes the user actor from the role (`DELETE /rest/api/2/project/{key}/role/{id}?user=`). Users who are not direct actors (they may reach the desk through a group or organization) are reported as `not_direct_customers` and left alone.
- When the project has no "Service Desk Customers" role, adding still works but the result says `verification: "unverifiable"` and the dry run warns; removal stops with a ValidationError because it has no route.

Customers that reach a desk through groups, organizations or public sign-up are outside this read; the tools say so in their descriptions.

### Writes
All writes are dry run by default (`dryRunShape`, `guardedWrite`), declare `invalidates: []`, and return already-satisfied when nothing would change. Organization deletion is irreversible: the summary states that it removes the organization from every service desk and drops its memberships, and the dry run reports how many service desks link it (scan capped at 100 desks) and whether it has users. Adding several organizations to a desk sends one POST per missing organization. Read-back uses the organization listing, its users or the desk links.

### Customer creation
`jira_create_customer` takes `email` and `display_name` (sent as `fullName`, the DC field name). An existing user whose username or e-mail equals the address makes it already-satisfied; after the POST the user is read back by username.

## Risks / Trade-offs

- Role-based membership is an inference about JSM's storage → read-back failures raise VerificationError instead of reporting success; the dry run shows what was checked.
- Name resolution needs the full organization listing → capped and paged; ids avoid it.
- Deletion impact scan reads every service desk's organizations → capped at 100 desks; a larger estate reports the scan as partial.

## Live verification

GET-only on JSM 11.3.7: organization listings answer with `{size,start,limit,isLastPage,values}`; `GET …/servicedesk/{id}/customer` fails with 405; the project role "Service Desk Customers" exists and lists actors. Writes were checked as dry runs only.

## Local Implementation Evidence (2026-10-11)

`test/unit/jsmCustomers.test.ts`: 17 tests pass (reads, ambiguity, already-satisfied paths, read-back failures, role-based customers, unverifiable mode, fullName body). Live GET-only run on JSM 11.3.7: organization listings, a missing-name lookup, create/add-customers dry runs, delete/remove already-satisfied paths; the "Service Desk Customers" role was found and read; no non-GET request was sent. Registration in `src/tools/index.ts` and the reference documentation are left to the integrator.
