# Supermarket Management System

A production-oriented, multi-branch supermarket management system built in
reviewed phases. Phase 5A adds the secured, organization-wide reference catalog
API on top of the approved 54-table database and the completed Phase 2-4
foundation.

The current API can operate units of measure, hierarchical categories, brands,
and tax rates as well as the existing branches, employees, assignments, users,
roles, permissions, and user-role grants. It retains the Phase 2 health behavior,
Phase 3 authentication/authorization, and Phase 4 organization administration.

Phase 5A does **not** redesign the database. The approved
[`database/schema.sql`](database/schema.sql) and detailed
[`database/README.md`](database/README.md) remain the authority for the existing
54 tables.

## Phase 5A purpose and boundaries

Reference catalog records describe shared business concepts that products will
reference later. They are organization-wide configuration, not branch stock,
sellable SKUs, or prices. Establishing these records first gives later product
and pricing APIs stable validated foreign-key targets.

Phase 5A includes:

- expansion of the canonical access catalog from 10 to 16 permissions;
- unit-of-measure administration with fractional-variant safety;
- acyclic hierarchical category administration with dependency-safe lifecycle rules;
- brand and tax-rate administration with active-product dependency protection;
- transaction-bound audit events, bounded pagination, search, and filters; and
- live MySQL integration tests while preserving every Phase 2-4 regression.

Phase 5A is complete at the database-backed reference-catalog boundary described
here. Phase 5B has not started: there are no product, variant, package, or barcode
APIs. Phase 5C has not started: there is no branch pricing or effective-price
resolver. Suppliers, customers, inventory, purchasing, POS, sales, reports,
frontend, Postman, and Phase 6 work also remain intentionally excluded.

## Technology stack

- Node.js 20+ with ES Modules
- Express 5 REST API
- MySQL 8.0.16+ through `mysql2/promise`
- bcrypt password hashing
- short-lived HS256 JSON Web Tokens
- database-backed, permission-code authorization
- Helmet security headers
- login-specific rate limiting
- `dotenv` environment configuration
- CORS middleware
- nodemon for local development
- Node's built-in test runner for integration tests

No ORM is used. Repository SQL is explicit and parameterized.

## Architecture

HTTP administration requests follow the same layered path as authentication:

```text
route
  -> authentication / password-state / permission middleware
  -> controller
  -> service
  -> repository
  -> MySQL
```

- Routes define URLs and their required application permission.
- Middleware verifies the JWT, reloads the current user, enforces a completed
  required password change, and checks the current global database permission.
- Controllers validate HTTP parameters and bodies and shape responses.
- Services apply workflows and translate expected conflicts into safe HTTP
  errors.
- Repositories own parameterized SQL, row locking, transactions, and audit
  inserts.

All `/api/admin` routes pass through `authenticate` and
`requirePasswordChangeCompleted` before their endpoint-specific
`requirePermission(...)` check. A role name never bypasses authorization.

## Project structure

```text
supermarket-management-system/
├── database/
│   ├── README.md
│   └── schema.sql
├── scripts/
│   ├── lib/
│   │   └── cli-runtime.js
│   ├── bootstrap-admin.js
│   └── seed-access-control.js
├── src/
│   ├── config/
│   │   ├── accessControl.js
│   │   └── database.js
│   ├── controllers/
│   │   ├── auth.controller.js
│   │   ├── brand.controller.js
│   │   ├── branch.controller.js
│   │   ├── category.controller.js
│   │   ├── employee.controller.js
│   │   ├── role.controller.js
│   │   ├── taxRate.controller.js
│   │   ├── unitOfMeasure.controller.js
│   │   └── userAdmin.controller.js
│   ├── middleware/
│   │   ├── auth.middleware.js
│   │   ├── authorization.middleware.js
│   │   ├── errorHandler.js
│   │   └── loginRateLimiter.js
│   ├── repositories/
│   │   ├── accessControlSeed.repository.js
│   │   ├── audit.repository.js
│   │   ├── auth.repository.js
│   │   ├── brand.repository.js
│   │   ├── branch.repository.js
│   │   ├── category.repository.js
│   │   ├── employee.repository.js
│   │   ├── role.repository.js
│   │   ├── taxRate.repository.js
│   │   ├── unitOfMeasure.repository.js
│   │   └── userAdmin.repository.js
│   ├── routes/
│   │   ├── admin/
│   │   │   ├── branch.routes.js
│   │   │   ├── catalog/
│   │   │   │   ├── brand.routes.js
│   │   │   │   ├── category.routes.js
│   │   │   │   ├── index.js
│   │   │   │   ├── taxRate.routes.js
│   │   │   │   └── unit.routes.js
│   │   │   ├── employee.routes.js
│   │   │   ├── index.js
│   │   │   ├── role.routes.js
│   │   │   └── user.routes.js
│   │   ├── auth.routes.js
│   │   └── health.routes.js
│   ├── services/
│   │   ├── auth.service.js
│   │   ├── authorization.service.js
│   │   ├── brand.service.js
│   │   ├── branch.service.js
│   │   ├── category.service.js
│   │   ├── employee.service.js
│   │   ├── role.service.js
│   │   ├── taxRate.service.js
│   │   ├── unitOfMeasure.service.js
│   │   └── userAdmin.service.js
│   ├── utils/
│   │   ├── auditContext.js
│   │   ├── databaseError.js
│   │   ├── httpError.js
│   │   ├── jwt.js
│   │   ├── password.js
│   │   └── record.js
│   ├── validators/
│   │   ├── admin/
│   │   │   ├── branch.validator.js
│   │   │   ├── common.validator.js
│   │   │   ├── employee.validator.js
│   │   │   ├── role.validator.js
│   │   │   └── user.validator.js
│   │   ├── catalog/
│   │   │   ├── brand.validator.js
│   │   │   ├── category.validator.js
│   │   │   ├── taxRate.validator.js
│   │   │   └── unitOfMeasure.validator.js
│   │   └── auth.validator.js
│   ├── app.js
│   └── server.js
├── test/
│   ├── admin.integration.test.js
│   ├── auth.integration.test.js
│   └── catalogReference.integration.test.js
├── .env
├── .env.example
├── .gitignore
├── package-lock.json
├── package.json
└── README.md
```

`catalogReference.integration.test.js` exercises Phase 5A against MySQL,
`admin.integration.test.js` retains Phase 4 coverage, and
`auth.integration.test.js` retains the detailed Phase 2 and Phase 3 regression
coverage. The test runner executes them serially so their isolated database
fixtures and connection pools cannot interfere with one another.

## Prerequisites and configuration

Install:

- Node.js 20 or newer;
- npm;
- MySQL 8.0.16 or newer;
- the existing `supermarket_management` database; and
- a dedicated `supermarket_app` MySQL account with the API's required privileges.

MySQL `root` is an administrative account and should not run the Node.js
application. Real local credentials belong in `.env`, which is Git-ignored. The
tracked `.env.example` contains placeholders only.

Install the locked dependencies:

```bash
npm ci
```

Create local configuration when necessary:

```bash
cp .env.example .env
```

Required configuration:

```dotenv
NODE_ENV=development
PORT=5000

DB_HOST=localhost
DB_PORT=3306
DB_USER=supermarket_app
DB_PASSWORD=replace_with_your_mysql_password
DB_NAME=supermarket_management
DB_CONNECTION_LIMIT=10

JWT_SECRET=replace_with_a_private_random_secret_of_at_least_48_characters
JWT_EXPIRES_IN=15m
JWT_ISSUER=supermarket-management-system
JWT_AUDIENCE=supermarket-api
BCRYPT_ROUNDS=12
```

Generate a real JWT secret locally and save it only in `.env`:

```bash
openssl rand -base64 48
```

Startup validates the configuration, makes a read-only database connection test,
confirms the active database name, and only then opens the HTTP port. It never
prints a database password or JWT secret.

## Commands

```bash
# Start with automatic source reload
npm run dev

# Start normally
npm start

# Seed/reconcile canonical Phase 4/5 access configuration
npm run seed:access

# Secure interactive initial-administrator bootstrap
npm run bootstrap:admin

# Run the integration suite
npm test
```

The seed and bootstrap tools are explicit operator commands. Neither runs on
every server startup.

## Access-control catalog

Permissions are application-defined capabilities. A permission code is useful
only because application routes check that exact code, so administrators cannot
invent permission definitions through the HTTP API.

The idempotent catalog contains 16 canonical Phase 4/5 permissions:

| Permission code | Meaning |
| --- | --- |
| `branches.read` | View branch lists and details |
| `branches.manage` | Create and update branches |
| `employees.read` | View employees and assignment history |
| `employees.manage` | Create/update/terminate employees and manage assignments |
| `users.read` | View internal accounts and grants |
| `users.manage` | Provision/update accounts and reset passwords |
| `roles.read` | View roles and their permissions |
| `roles.manage` | Create/update roles and replace permission sets |
| `permissions.read` | View the read-only permission catalog |
| `user_roles.manage` | Assign and revoke scoped user-role grants |
| `catalog.read` | View shared reference catalog configuration |
| `catalog.manage` | Create and update shared reference catalog configuration |
| `products.read` | View products, variants, packages, and barcodes in Phase 5B |
| `products.manage` | Create and update products, variants, packages, and barcodes in Phase 5B |
| `pricing.read` | View branch pricing configuration in Phase 5C |
| `pricing.manage` | Create and update branch pricing configuration in Phase 5C |

The seed inserts missing canonical permissions, reconciles their human-readable
metadata, preserves unrelated permissions and roles, ensures the
`SYSTEM_ADMIN` / `System Administrator` role exists, and grants it every
canonical permission. Re-running the command produces the same logical
configuration and does not duplicate rows.

Only `catalog.read` and `catalog.manage` are used by Phase 5A routes. The product
and pricing permissions are seeded now as stable reserved capabilities, but no
Phase 5B or Phase 5C endpoint exists yet.

If `SYSTEM_ADMIN` already exists but is inactive, the seed deliberately leaves
it inactive and prints a warning instead of silently reversing an emergency or
operator-initiated disable. Bootstrap also refuses to attach a new privileged
account to that inactive role; an authorized operator must review and reactivate
the role deliberately.

`SYSTEM_ADMIN` is a normal database role. Its authority comes only from
`user_roles -> roles -> role_permissions -> permissions`; there is no
`if (role === 'ADMIN')` or superuser bypass. To prevent an accidental lockout,
the administration API protects its canonical code and name, prevents its
deactivation, and refuses a permission replacement that omits any canonical
permission. It may still hold additional custom application permissions.

## Initial administrator bootstrap

Run the seed first, then start the one-time interactive flow:

```bash
npm run seed:access
npm run bootstrap:admin
```

The bootstrap tool:

- requires an interactive terminal;
- prompts visibly for username and email;
- reads and confirms the password without echoing it;
- applies the same 10-character and 72-UTF-8-byte password boundaries as the
  application;
- hashes the password with bcrypt before storage;
- creates an active user with `employee_id = NULL` and
  `must_change_password = false`;
- assigns `SYSTEM_ADMIN` globally with `user_roles.branch_id = NULL` in the same
  transaction; and
- never prints the password or bcrypt hash.

There is no HTTP registration route and no hard-coded/default administrator
credential. If an active global `SYSTEM_ADMIN` already exists, bootstrap refuses
to silently create another and directs the operator to normal user
administration. The non-echoed password chosen by the bootstrap operator is the
account's initial final password, not an administrator-issued temporary secret;
that is why bootstrap does not force an immediate replacement. In contrast,
passwords provisioned or reset through the HTTP administration API always set
`must_change_password = true`.

## API conventions

Send a Phase 3 access token on every administrative request:

```http
Authorization: Bearer ACCESS_TOKEN
Content-Type: application/json
```

MySQL primary keys use `BIGINT UNSIGNED`. IDs are accepted and returned as JSON
strings so values beyond JavaScript's safe integer range are never rounded.
Bodies reject unknown fields, and dynamic SQL identifiers are never taken from
request input.

### Pagination

Every list endpoint uses bounded pagination:

```text
?page=1&limit=20
```

- default page: `1`;
- default limit: `20`;
- maximum limit: `100`; and
- page and limit must be positive integers.

Successful list shape:

```json
{
  "success": true,
  "data": {
    "items": [],
    "pagination": {
      "page": 1,
      "limit": 20,
      "totalItems": 0,
      "totalPages": 0
    }
  }
}
```

Supported filters:

| List | Filters |
| --- | --- |
| branches | `status`, `search` |
| employees | `employmentStatus`, `branchId`, `search` |
| users | `isActive`, `employeeId`, `search` |
| roles | `isActive`, `search` |
| permissions | `search` |
| catalog units | `allowsFraction`, `search` |
| catalog categories | `isActive`, `parentCategoryId`, `search` |
| catalog brands | `isActive`, `search` |
| catalog tax rates | `isActive`, `isInclusive`, `search` |

Ordering is code-controlled and includes stable ID tie-breakers. Search and
filters use parameterized values rather than client-supplied SQL fragments.

### Status codes

| Status | Meaning |
| --- | --- |
| `200` | Successful read or update/workflow action |
| `201` | Resource or association created |
| `400` | Invalid shape, field, ID, enum, date, password, or pagination input |
| `401` | Missing or invalid authentication/current account |
| `403` | Authenticated but password change or permission requirement is unmet |
| `404` | Requested administration or reference-catalog record does not exist |
| `409` | Uniqueness, lifecycle, dependency, hierarchy, self-lockout, scope, or concurrent-state conflict |
| `429` | Login rate limit exceeded |
| `500` | Unexpected internal failure |
| `503` | Live database unavailable or a serialized administration operation is temporarily busy |

Responses never expose SQL, constraint names, stack traces, JWT internals,
passwords, or password hashes.

## Existing health and authentication endpoints

| Method and path | Access | Purpose |
| --- | --- | --- |
| `GET /api/health` | public | Confirms Express is responding |
| `GET /api/health/database` | public | Runs a lightweight query through the shared pool |
| `POST /api/auth/login` | public, rate-limited | Login by username or email |
| `GET /api/auth/me` | authenticated | Safe current user plus current scoped grants |
| `POST /api/auth/change-password` | authenticated | Verify and replace the current user's password |

Login returns a short-lived JWT containing only the user ID in `sub` plus
standard issue/expiry/issuer/audience claims. Every protected request verifies
HS256, issuer, audience, expiry, and then reloads the current active user from
MySQL. Permissions remain database-current instead of being trusted from JWT
claims.

## Phase 4 endpoints and required permissions

These are the exact 25 Phase 4 endpoints. Every row also requires authentication
and a completed required password change. Permission checks are **global**:
a branch-scoped grant does not satisfy an administration endpoint.

| # | Method and path | Required permission | Purpose |
| ---: | --- | --- | --- |
| 1 | `GET /api/admin/branches` | `branches.read` | Paginated branch list |
| 2 | `GET /api/admin/branches/:branchId` | `branches.read` | Branch detail |
| 3 | `POST /api/admin/branches` | `branches.manage` | Create a branch |
| 4 | `PATCH /api/admin/branches/:branchId` | `branches.manage` | Update/deactivate/close a branch |
| 5 | `GET /api/admin/employees` | `employees.read` | Paginated employee list |
| 6 | `GET /api/admin/employees/:employeeId` | `employees.read` | Employee plus assignment history |
| 7 | `POST /api/admin/employees` | `employees.manage` | Create an employee |
| 8 | `PATCH /api/admin/employees/:employeeId` | `employees.manage` | Update a non-terminated employee |
| 9 | `POST /api/admin/employees/:employeeId/terminate` | `employees.manage` | Atomic termination workflow |
| 10 | `POST /api/admin/employees/:employeeId/assignments` | `employees.manage` | Create a branch assignment |
| 11 | `POST /api/admin/employees/:employeeId/assignments/:assignmentId/end` | `employees.manage` | End an assignment without deleting history |
| 12 | `POST /api/admin/employees/:employeeId/assignments/:assignmentId/make-primary` | `employees.manage` | Atomically switch the primary assignment |
| 13 | `GET /api/admin/users` | `users.read` | Paginated safe-account list |
| 14 | `GET /api/admin/users/:userId` | `users.read` | Safe account and role-grant detail |
| 15 | `POST /api/admin/users` | `users.manage` | Provision an internal account |
| 16 | `PATCH /api/admin/users/:userId` | `users.manage` | Update safe account fields/state |
| 17 | `POST /api/admin/users/:userId/reset-password` | `users.manage` | Set a bcrypt temporary password |
| 18 | `POST /api/admin/users/:userId/roles` | `user_roles.manage` | Create a global or branch role grant |
| 19 | `DELETE /api/admin/users/:userId/roles/:userRoleId` | `user_roles.manage` | Revoke only the association |
| 20 | `GET /api/admin/roles` | `roles.read` | Paginated role list |
| 21 | `GET /api/admin/roles/:roleId` | `roles.read` | Role with permission information |
| 22 | `POST /api/admin/roles` | `roles.manage` | Create a role |
| 23 | `PATCH /api/admin/roles/:roleId` | `roles.manage` | Update/deactivate a role |
| 24 | `PUT /api/admin/roles/:roleId/permissions` | `roles.manage` | Atomically replace a role's permission set |
| 25 | `GET /api/admin/permissions` | `permissions.read` | Read-only application permission catalog |

There are no branch, employee, user, role, or permission master-data DELETE
routes. The only DELETE endpoint removes a `user_roles` association.

## Phase 5A endpoints and required permissions

Reference catalog data is shared organization-wide. Every route below inherits
authentication and required-password-change enforcement from `/api/admin`, then
uses a **global** permission check. A branch-scoped catalog grant never satisfies
one of these routes.

| # | Method and path | Required permission | Purpose |
| ---: | --- | --- | --- |
| 1 | `GET /api/admin/catalog/units` | `catalog.read` | Paginated unit list |
| 2 | `GET /api/admin/catalog/units/:unitOfMeasureId` | `catalog.read` | Unit detail |
| 3 | `POST /api/admin/catalog/units` | `catalog.manage` | Create a unit |
| 4 | `PATCH /api/admin/catalog/units/:unitOfMeasureId` | `catalog.manage` | Update a unit |
| 5 | `GET /api/admin/catalog/categories` | `catalog.read` | Paginated category list |
| 6 | `GET /api/admin/catalog/categories/:categoryId` | `catalog.read` | Category detail |
| 7 | `POST /api/admin/catalog/categories` | `catalog.manage` | Create a category |
| 8 | `PATCH /api/admin/catalog/categories/:categoryId` | `catalog.manage` | Update/re-parent a category |
| 9 | `GET /api/admin/catalog/brands` | `catalog.read` | Paginated brand list |
| 10 | `GET /api/admin/catalog/brands/:brandId` | `catalog.read` | Brand detail |
| 11 | `POST /api/admin/catalog/brands` | `catalog.manage` | Create a brand |
| 12 | `PATCH /api/admin/catalog/brands/:brandId` | `catalog.manage` | Update/deactivate a brand |
| 13 | `GET /api/admin/catalog/tax-rates` | `catalog.read` | Paginated tax-rate list |
| 14 | `GET /api/admin/catalog/tax-rates/:taxRateId` | `catalog.read` | Tax-rate detail |
| 15 | `POST /api/admin/catalog/tax-rates` | `catalog.manage` | Create a tax rate |
| 16 | `PATCH /api/admin/catalog/tax-rates/:taxRateId` | `catalog.manage` | Update/deactivate a tax rate |

There are no DELETE routes for these four master-data types. Unknown DELETE
requests receive the normal JSON `404` response.

No business reference rows such as `EACH`, `KG`, `LITRE`, or `VAT` are seeded
automatically. Those values are organization policy and must be created
deliberately through the authorized catalog API.

## Reference catalog behavior

### Units of measure

Units expose `unitOfMeasureId`, `unitCode`, `unitName`, `symbol`,
`allowsFraction`, and timestamps. Codes are trimmed and uppercased; names and
symbols retain meaningful display casing. `allowsFraction` defaults to `false`
and accepts only a JSON Boolean.

Changing `allowsFraction` from `true` to `false` is rejected with `409` whenever
any product variant using the unit is fractional, regardless of that variant's
status. Unit rows are never deleted because variants and packages may reference
them.

### Hierarchical categories

Categories expose their optional `parentCategoryId` but not the generated
`parentScopeId`. Codes are globally unique; names are unique within their parent
or the root scope. An active category may only have an active parent.

All creates and hierarchy-changing updates share a category-hierarchy lock and
transactional row locks. Parent ancestry is validated before writing, preventing
self-parenting, two-node cycles, deep cycles, and competing re-parent operations
from committing a cycle.

Deactivation is rejected with `409` if the subtree contains an active descendant
or an active product attached to the target or any descendant. Nothing is
cascade-deactivated; administrators must explicitly reconcile dependencies.

### Brands

Brand codes and names are independently globally unique. Descriptions are
nullable and nonblank when supplied. Brands use `isActive` rather than deletion.
Deactivation is rejected while any active product references the brand; products
are never modified implicitly. Reactivation is allowed.

### Tax rates

Tax codes are globally unique; tax names intentionally are not. `ratePercent` is
a decimal string from `0.0000` through `100.0000` with at most four fractional
digits. Scientific notation, binary floating-point numbers, negative values, and
out-of-range values are rejected. API and audit output preserve MySQL's
four-decimal string representation.

`isInclusive` and `isActive` are strict JSON Booleans. A tax rate cannot be
deactivated while an active product references it, but changing the current
percentage or inclusive setting is allowed because future transaction rows store
their own tax snapshots.

### Catalog pagination and filters

All four collection routes use the standard page `1`, limit `20`, maximum `100`
contract and deterministic ordering. Supported filters are:

| Collection | Filters |
| --- | --- |
| units | `search`, `allowsFraction` |
| categories | `search`, `isActive`, `parentCategoryId` |
| brands | `search`, `isActive` |
| tax rates | `search`, `isActive`, `isInclusive` |

For categories, `parentCategoryId=null` selects roots, a positive BIGINT string
selects one parent, and omission applies no parent filter. Search values and all
other filter values are parameterized; ordering is fixed in repository code.

### Catalog audit and transaction policy

Successful catalog changes write one of
`UNIT_OF_MEASURE_CREATED`, `UNIT_OF_MEASURE_UPDATED`, `CATEGORY_CREATED`,
`CATEGORY_UPDATED`, `BRAND_CREATED`, `BRAND_UPDATED`, `TAX_RATE_CREATED`, or
`TAX_RATE_UPDATED`. The safe before/after state and actor/request context are
written on the same connection and in the same transaction as the master-data
change. A failed change therefore creates neither catalog state nor an audit row.

Dependency-changing operations lock the reference row and relevant dependent
rows. Future product/variant services must follow the same reference-first lock
ordering and revalidate current reference state; direct SQL writers that bypass
the service layer are outside this application-level invariant.

## Branch administration

Branch requests follow the exact schema fields: `branchCode`, `branchName`,
`phone`, `email`, `addressLine1`, `addressLine2`, `city`, `stateRegion`,
`postalCode`, `countryCode`, `currencyCode`, `timezone`, `openedOn`, and `status`.
Codes are normalized appropriately; display names and addresses retain their
meaningful casing.

Allowed statuses are `ACTIVE`, `INACTIVE`, and `CLOSED`. Deactivation or closure
preserves the branch row and all historical foreign-key relationships. Duplicate
branch codes return `409` instead of leaking a MySQL duplicate-key error.

Example creation:

```json
{
  "branchCode": "GRA-01",
  "branchName": "GRA Branch",
  "phone": "+2348000000000",
  "email": "gra@example.com",
  "addressLine1": "1 Example Road",
  "addressLine2": null,
  "city": "Lagos",
  "stateRegion": "Lagos",
  "postalCode": "100001",
  "countryCode": "NG",
  "currencyCode": "NGN",
  "timezone": "Africa/Lagos",
  "openedOn": "2026-09-06",
  "status": "ACTIVE"
}
```

## Employee and assignment administration

An employee is the staff/personnel record. It can exist without a login. Employee
fields are `employeeNumber`, `firstName`, `lastName`, `email`, `phone`,
`hireDate`, `terminationDate`, and `employmentStatus`. Allowed normal states are
`ACTIVE` and `ON_LEAVE`; `TERMINATED` is reached only through the dedicated
workflow.

Generic PATCH cannot set `terminationDate` or directly set `TERMINATED`. The
termination endpoint accepts:

```json
{
  "terminationDate": "2026-09-06"
}
```

In one transaction it locks and reloads the employee, validates the date, sets
the terminal state, ends applicable open assignments, clears primary flags,
deactivates the optional linked user, writes audit events, and commits. Repeating
the same completed request is safe; a conflicting termination date returns
`409`. No employee row is deleted.

Assignment creation accepts:

```json
{
  "branchId": "7",
  "jobTitle": "Cashier",
  "startedOn": "2026-09-06",
  "isPrimary": true
}
```

The employee must exist and not be terminated, the branch must be appropriate,
the start cannot predate hire, and overlapping duplicate branch assignments are
rejected. When a new assignment becomes primary, the employee row and relevant
assignments are locked, the previous open primary is cleared, and the selected
assignment is set atomically. An ended or not-yet-started assignment cannot be
made primary.

Assignment `started_on` and `ended_on` are inclusive `DATE` values. An assignment
ended on `2026-09-06` is valid through that business date; it is no longer current
on `2026-09-07`. This matches Phase 3's current-assignment query and should not be
mistaken for timestamp-level immediate revocation. Termination still disables
the linked user immediately because account and employee state are changed in
the same workflow.

## User provisioning and password reset

A user is a login/security principal, not an employee record. A normal staff
account links to one non-terminated employee. The schema allows a deliberately
unlinked system account with `employeeId: null`, which is how the initial
bootstrap principal is represented.

Internal provisioning example:

```json
{
  "employeeId": "123",
  "username": "cashier.one",
  "email": "cashier@example.com",
  "temporaryPassword": "a-private-temporary-password"
}
```

The service validates the employee and one-account-per-employee constraint,
checks the username/email login namespace, hashes the temporary password before
opening its write transaction, stores only the bcrypt hash, and forces
`must_change_password = true`. Neither the temporary password nor hash appears in
the response or audit log.

PATCH accepts only `employeeId`, `username`, `email`, and `isActive`. It never
accepts `password_hash`, a raw password, or an arbitrary
`must_change_password`. The current administrator cannot deactivate their own
account through this endpoint. Changing or removing an employee link is blocked
while branch-scoped grants exist because unlinking would otherwise remove Phase
3's employee-assignment access gate; administrators must first reconcile those
grants. An account linked to a terminated employee cannot be activated again;
the employee lifecycle must remain the authoritative security boundary.

Administrative reset accepts:

```json
{
  "temporaryPassword": "another-private-temporary-password"
}
```

It validates and hashes before the transaction, locks the target user, replaces
the hash, sets `must_change_password = true`, writes `USER_PASSWORD_RESET`, and
commits atomically. It does not require the target's old password. Already-issued
JWTs are stateless and are not revoked merely by changing a password; deactivate
the account when immediate lockout is required, because authentication checks
`users.is_active` on every protected request.

## Role and permission administration

Role fields are `roleCode`, `roleName`, `description`, and `isActive`. Codes and
names are independently unique, and conflicts return `409`. Deactivation leaves
existing `user_roles` rows in place but Phase 3 ignores the inactive role, so it
grants no permissions unless later reactivated. Roles are never physically
deleted by the API.

The read-only permission catalog returns `permissionId`, `permissionCode`,
`permissionName`, and `description`. There is intentionally no POST, PATCH, or
DELETE permission endpoint.

Replace a role's complete permission set with:

```json
{
  "permissionIds": ["1", "2", "3"]
}
```

Duplicate IDs are rejected. The repository locks the role, verifies every ID,
preserves bridge rows already present, deletes removed `role_permissions`, inserts
new ones, and audits sorted before/after permission codes in one transaction. An
empty array intentionally removes every permission from an ordinary role. It is
rejected for `SYSTEM_ADMIN` unless all 16 canonical permissions remain.

## Global and branch-scoped user roles

Create a global role grant:

```json
{
  "roleId": "4",
  "branchId": null
}
```

Create a branch grant:

```json
{
  "roleId": "8",
  "branchId": "7"
}
```

`branchId: null` means global. A branch ID means only that exact branch. New
grants require an existing user and active role; branch grants also require an
existing branch. For an employee-linked user, a branch grant additionally
requires a current employee assignment at that branch. The schema intentionally
allows an unlinked system account to receive a branch grant without an employee
assignment.

The server always stores the authenticated administrator as
`assigned_by_user_id`; the client cannot submit or spoof that value. The schema's
generated scope guard makes each `(user, role, global-or-branch scope)` grant
unique, including under concurrency.

Revocation verifies that `userRoleId` belongs to the target user and removes only
that association. It does not delete the role. An administrator cannot revoke
their own role assignment through this endpoint; another administrator with the
current global `user_roles.manage` permission must perform that action.

## Audit behavior

Administrative mutation and its `audit_logs` insert share a transaction wherever
consistency requires it. Audit rows identify the authenticated actor, optional
actor employee, affected branch context, action, entity/table type, record ID,
before/after JSON, IP address, user-agent, and optional request ID.

Phase 4 action types include:

- `BRANCH_CREATED`, `BRANCH_UPDATED`;
- `EMPLOYEE_CREATED`, `EMPLOYEE_UPDATED`, `EMPLOYEE_TERMINATED`;
- `EMPLOYEE_BRANCH_ASSIGNED`, `EMPLOYEE_BRANCH_ASSIGNMENT_ENDED`,
  `EMPLOYEE_PRIMARY_BRANCH_CHANGED`;
- `USER_CREATED`, `USER_UPDATED`, `USER_PASSWORD_RESET`;
- `ROLE_CREATED`, `ROLE_UPDATED`, `ROLE_PERMISSIONS_CHANGED`; and
- `USER_ROLE_ASSIGNED`, `USER_ROLE_REVOKED`.

`audit_logs.employee_id` is the actor's linked employee ID, not the affected
employee. The target is represented by `entity_type` and `entity_record_id`.
Passwords, hashes, JWTs, JWT secrets, and database credentials are forbidden from
all audit JSON and notes. Audit records remain append-only by service policy.

## Transactions and concurrency

Multi-table writes use a borrowed pool connection with `beginTransaction`,
commit on success, rollback on failure, and release in `finally`. Slow bcrypt
work happens before a transaction where it can be safely revalidated afterward.

`SELECT ... FOR UPDATE` is used where another request could otherwise change a
decision between validation and writing, including termination, primary
assignment switching, account changes, password reset, permission replacement,
and user-role grants. Unique constraints remain a final concurrency backstop and
expected duplicate-key errors are translated to `409` without revealing MySQL
details.

The database has separate unique keys for `users.username` and `users.email`.
Because login accepts either field, user administration serializes credential
namespace mutations and also checks cross-column collisions so it does not create
an ambiguous identifier. Phase 3 login remains fail-closed if legacy or externally
inserted data is ambiguous.

## Security behavior and limitations

- Passwords are never trimmed, logged, returned, or put in JWTs. bcrypt embeds a
  random salt and configurable work factor in each stored hash.
- JWTs are explicitly signed/verified with HS256, issuer, audience, and a short
  expiry. The signing secret exists only in ignored environment configuration.
- Every protected request reloads current user state; permission checks join
  current active roles and permission rows.
- Administrative permissions must be global. A branch role cannot accidentally
  become organization administration authority.
- `must_change_password` blocks all `/api/admin` routes while leaving `/me` and
  `/change-password` available.
- All SQL values are parameterized. Dynamic assignment lists and placeholder
  counts come only from code-controlled whitelists and validated arrays.
- Helmet is active. CORS remains development-permissive until a frontend origin
  is selected and must be restricted before production.
- The login limiter uses process memory; multiple production instances require a
  shared store and correct trusted-proxy configuration.
- Access tokens are stateless. There are no refresh tokens, revocation table,
  MFA, OAuth, or fake server-side logout in this phase.
- The bootstrap is secure only in a real interactive TTY and intentionally has no
  command-line password option.
- Database grants should enforce append-only audit policy and forbid direct
  destructive master-data access outside controlled migrations/operations.

## Testing and verification

Run the complete suite against the configured local/development database:

```bash
npm test
```

The complete Phase 2-5A validation run covers:

- Phase 2 health, database health, JSON 404, and graceful SIGINT/SIGTERM;
- Phase 3 login, JWT enforcement, password-change gating, current account state,
  global/branch permissions, inactive roles, and login limiting;
- no token (`401`), forced-password user (`403`), missing permission (`403`),
  correct global permission success, and branch-only admin grant denial;
- branch create/read/list/update, duplicate code `409`, and no DELETE route;
- employee create/read/update, assignment create/primary switch/end,
  termination, and linked-user deactivation;
- account creation with bcrypt and forced change, safe responses, uniqueness,
  reset, and self-deactivation protection;
- role create/read/update, catalog read, atomic permission replacement, and
  inactive-role behavior;
- global/branch user-role grants, linked employee assignment validation,
  server-owned `assigned_by_user_id`, duplicate grant, revoke, and self-revoke
  protection;
- expected secret-free audit events and pagination validation;
- Phase 5A global catalog authorization, all 16 reference endpoints, strict
  validation, bounded pagination, exact filters, category-cycle concurrency,
  dependency-safe lifecycle changes, decimal-safe tax rates, and all eight
  catalog audit actions; and
- exact reverse-FK cleanup of uniquely identified `TEST_*` access-control,
  organization, product-dependency, reference-catalog, bridge, and audit rows.

Canonical seed permissions and `SYSTEM_ADMIN` configuration may remain because
they are intentional application configuration rather than test fixtures. Tests
must never drop/recreate the database or touch unrelated development data.
Phase 5A creates only uniquely identified reference rows and the minimum direct
product/variant dependency fixtures, then removes them in reverse FK order; it
does not touch inventory, purchasing, POS, sales, returns, payments, transfers,
or stock-count data.

The latest local validation on 2026-09-07 passed all 43 discovered tests: 14
Phase 4 suite/test entries, 19 retained Phase 2/3 suite/test entries, and 10
Phase 5A suite/test entries. It confirmed both graceful-shutdown signals, the
active `supermarket_management` database with 54 tables, all 16 canonical
permissions, one `SYSTEM_ADMIN` role with all 16 canonical mappings, and zero
remaining temporary Phase 3/4/5A fixtures.
Results are environment-specific, so run `npm test` again after relevant code,
configuration, or database changes.

Quick Phase 2 smoke checks after startup:

```bash
curl -i http://localhost:5000/api/health
curl -i http://localhost:5000/api/health/database
curl -i http://localhost:5000/something-that-does-not-exist
```

## Practical learning summary

1. **Why branches and employees come first:** later stock and money operations
   need a valid physical branch and an accountable staff actor before they can
   be trustworthy.
2. **Employee versus user:** an employee is a personnel/business identity; a
   user is a security principal that can authenticate and receive access.
3. **Employee without a login:** many staff members do not need system access,
   but their employment and operational history still belongs in the database.
4. **System user without `employee_id`:** automation or an initial bootstrap
   administrator may need a controlled identity without pretending to be a staff
   record.
5. **Employee branch assignments:** the bridge records where an employee works,
   their title, effective dates, and which open assignment is primary.
6. **Why assignment history is preserved:** past assignments explain who could
   act at a branch on a historical business date and support investigations and
   reporting.
7. **Why termination is a workflow:** changing several related security and
   assignment records atomically cannot be represented safely by deleting one
   employee row.
8. **Why termination disables the login:** a terminated employee must not retain
   usable credentials after their staff status and assignments end.
9. **Role versus permission:** a permission is one application capability; a
   role is a manageable bundle of those capabilities.
10. **Why permission codes are application-defined:** code such as
    `employees.manage` has meaning because a route explicitly checks it; an
    arbitrary database string does not implement new behavior.
11. **Why permissions are seeded:** an idempotent catalog keeps code and database
    configuration synchronized without exposing a misleading permission-creation
    API.
12. **How `SYSTEM_ADMIN` works:** it is authorized through the same active-role
    and permission joins as every other role, while safety rules protect the
    canonical administration capabilities from accidental lockout.
13. **Global versus branch-scoped roles:** a null `branch_id` grants the role
    system-wide; a real ID limits it to that branch and cannot satisfy a global
    administration check.
14. **Meaning of `assigned_by_user_id`:** it records which authenticated
    administrator created a user-role grant and is never trusted from client
    input.
15. **Why temporary passwords force a change:** an administrator may know the
    initial/reset secret, so the target user must replace it before accessing
    administrative or future business functions.
16. **Why hashes are never returned:** even one-way hashes are sensitive offline
    guessing material and have no legitimate API response purpose.
17. **Why important writes use transactions:** the main mutation and its related
    records/audit must all commit or all roll back; partial administration state
    can cause unauthorized access or lockouts.
18. **Why `SELECT ... FOR UPDATE` matters:** it prevents two transactions from
    both making decisions from the same stale row, such as each choosing a
    different primary assignment.
19. **Why audit logs matter:** administration changes affect identity and access;
    before/after evidence and actor/request context support accountability and
    incident investigation.
20. **Why master records are deactivated:** branches, employees, users, and roles
    are referenced by history. Status flags preserve that history while stopping
    future use.
21. **Why lists need pagination:** bounded queries protect database/API resources
    and give clients predictable navigation as the organization grows.
22. **Why API IDs remain strings:** MySQL `BIGINT UNSIGNED` can exceed
    JavaScript's exact integer range, so string transport prevents silent identity
    corruption.

## Phase 3 security refresher

Authentication proves the current identity; authorization checks its current
capability and scope. bcrypt is deliberately slow and salted, while JWT signing
detects tampering but does not encrypt token contents. Bearer tokens must be
protected like passwords. Generic login failures reduce account discovery,
short expiration limits token exposure, rate limiting raises the cost of online
guessing, and parameterized SQL separates untrusted values from SQL syntax.

There is no public signup and no fake JWT logout. Clients log out by deleting
their access token; true immediate token revocation requires future persisted
revocation/session design.

## Version control and stopping point

`.gitignore` excludes `node_modules/`, the real `.env`, npm debug logs, and local
operating-system metadata. It keeps `.env.example`, source, tests, scripts, and
both database documents trackable.

Phase 5A stops after shared reference-catalog administration. Phase 5B product,
variant, package, and barcode work must not begin until this implementation,
MySQL integration evidence, fixture cleanup, documentation, and concurrency
rules are reviewed and approved.
