# Supermarket Management System

A production-oriented, multi-branch supermarket management system built in
reviewed phases. Phase 8 adds branch-scoped inventory projections, lot state,
and read-only stock-ledger views on top of Phase 7 atomic receiving and the
approved 54-table database.

The current API reads branch inventory and historical stock transactions and
configures reorder settings and branch lot availability. It operates branch
purchase orders, goods receipts, receipt-time lot allocation, and the
stock-ledger posting required by receiving. It also
operates supplier masters and supplier catalog relationships, configures prices
per branch, and resolves the currently effective variant or package price. It
operates products,
sellable/stockable variants, unit-conversion packages, case-sensitive barcodes,
units of measure, hierarchical categories, brands, tax rates, and the existing
organization and access records. It retains all Phase 2-7 behavior.

Phases 5A, 5B, 5C, 6, 7, and 8 do **not** redesign the database. The approved
[`database/schema.sql`](database/schema.sql) and detailed
[`database/README.md`](database/README.md) remain the authority for the existing
54 tables.

## Phase 5A through Phase 8 purpose and boundaries

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

Phase 5B builds on those references and includes:

- product administration with active-reference lifecycle protection;
- variant administration with exact decimal fields, fractional-unit validation,
  lot-policy stability, and atomic active-variant/base-package creation;
- package administration with exact base-quantity conversions, one active base
  per active variant, PATCH-based lifecycle configuration, and downstream-use
  immutability;
- variant- and package-scoped barcode administration with GS1/GTIN validation,
  PATCH-based atomic primary switching, exact lookup, controlled unused-barcode
  deletion, and sale-history stability; and
- global authorization, bounded lists, transaction-bound audit events, and
  concurrency-safe row locking across all four resources.

Phase 5C builds on the product master and includes:

- one variant-price configuration per branch and variant;
- one package-price configuration per branch and package;
- branch-aware `pricing.read` and `pricing.manage` authorization;
- exact, time-aware effective variant and package price resolution;
- idempotent, concurrency-safe PUT operations with transaction-bound audits;
  and
- explicit verification that pricing never creates stock, lot, or stock-ledger
  state.

Phase 6 builds on the product master and includes:

- supplier master creation, lookup, filtering, and lifecycle updates;
- supplier-to-variant relationships with supplier SKU, lead time, minimum
  order quantity, and preferred-supplier configuration;
- supplier-to-package relationships with supplier package SKU, minimum package
  quantity, and active state;
- global supplier permissions, transaction-bound audit, ownership checks, and
  lock ordering compatible with Phase 5B; and
- explicit verification that supplier configuration creates no stock,
  purchasing, or receiving transactions.

Phase 7 builds on supplier configuration and includes:

- branch-scoped purchase-order and goods-receipt administration;
- immutable product, package-conversion, description, cost, and currency
  transaction snapshots with exact decimal calculations;
- approval, partial-receipt, completion, and cancellation state transitions;
- concurrency-safe over-receipt prevention and optional/required lot handling;
- atomic receipt posting through `inventory_transactions`, including the
  branch and lot balance projections; and
- transaction-bound audits, duplicate-post protection, bounded lists, and
  full Phase 2-6 regression coverage.

Phase 8 adds read-only branch stock, lot, and ledger views plus two operational
configuration writes: reorder settings and branch lot status. It does not
create stock or ledger transactions. Stock adjustments, counts, transfers,
customers, POS/checkout, sales, reports, frontend, and Postman remain excluded.
Phase 9 — Stock Adjustments, Counts & Transfers has not started.

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
  required password change, and checks the current database permission and
  scope.
- Controllers validate HTTP parameters and bodies and shape responses.
- Services apply workflows and translate expected conflicts into safe HTTP
  errors.
- Repositories own parameterized SQL, row locking, transactions, and audit
  inserts.

All `/api/admin` routes pass through `authenticate` and
`requirePasswordChangeCompleted`. Organization-wide administration uses
`requirePermission(...)`, including every Phase 6 supplier route. Phase 5C
pricing, Phase 7 purchasing/receiving, and Phase 8 inventory use
`requireBranchPermission(...)` with the URL branch. A role name never bypasses
authorization.

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
│   │   ├── branchPackagePrice.controller.js
│   │   ├── branch.controller.js
│   │   ├── branchVariantPrice.controller.js
│   │   ├── category.controller.js
│   │   ├── effectivePrice.controller.js
│   │   ├── employee.controller.js
│   │   ├── goodsReceipt.controller.js
│   │   ├── inventory.controller.js
│   │   ├── product.controller.js
│   │   ├── productBarcode.controller.js
│   │   ├── productPackage.controller.js
│   │   ├── productVariant.controller.js
│   │   ├── purchaseOrder.controller.js
│   │   ├── role.controller.js
│   │   ├── supplier.controller.js
│   │   ├── supplierProduct.controller.js
│   │   ├── supplierProductPackage.controller.js
│   │   ├── taxRate.controller.js
│   │   ├── unitOfMeasure.controller.js
│   │   └── userAdmin.controller.js
│   ├── middleware/
│   │   ├── auth.middleware.js
│   │   ├── authorization.middleware.js
│   │   ├── errorHandler.js
│   │   ├── loginRateLimiter.js
│   │   ├── inventoryBranch.middleware.js
│   │   ├── purchasingBranch.middleware.js
│   │   └── pricingBranch.middleware.js
│   ├── repositories/
│   │   ├── accessControlSeed.repository.js
│   │   ├── audit.repository.js
│   │   ├── auth.repository.js
│   │   ├── brand.repository.js
│   │   ├── branchPackagePrice.repository.js
│   │   ├── branch.repository.js
│   │   ├── branchVariantPrice.repository.js
│   │   ├── category.repository.js
│   │   ├── effectivePrice.repository.js
│   │   ├── employee.repository.js
│   │   ├── goodsReceipt.repository.js
│   │   ├── inventoryRead.repository.js
│   │   ├── inventoryWrite.repository.js
│   │   ├── product.repository.js
│   │   ├── productBarcode.repository.js
│   │   ├── productCatalog.repository.js
│   │   ├── productPackage.repository.js
│   │   ├── productVariant.repository.js
│   │   ├── purchaseOrder.repository.js
│   │   ├── purchaseReceiptPosting.repository.js
│   │   ├── purchasing.repository.js
│   │   ├── role.repository.js
│   │   ├── supplier.repository.js
│   │   ├── supplierProduct.repository.js
│   │   ├── supplierProductPackage.repository.js
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
│   │   │   ├── inventory/
│   │   │   │   └── index.js
│   │   │   ├── products/
│   │   │   │   ├── index.js
│   │   │   │   ├── product.routes.js
│   │   │   │   ├── productBarcode.routes.js
│   │   │   │   ├── productPackage.routes.js
│   │   │   │   └── productVariant.routes.js
│   │   │   ├── purchasing/
│   │   │   │   ├── goodsReceipt.routes.js
│   │   │   │   ├── index.js
│   │   │   │   └── purchaseOrder.routes.js
│   │   │   ├── pricing/
│   │   │   │   ├── effectivePrice.routes.js
│   │   │   │   ├── index.js
│   │   │   │   ├── packagePrice.routes.js
│   │   │   │   └── variantPrice.routes.js
│   │   │   ├── role.routes.js
│   │   │   ├── suppliers/
│   │   │   │   ├── index.js
│   │   │   │   ├── supplier.routes.js
│   │   │   │   ├── supplierProduct.routes.js
│   │   │   │   └── supplierProductPackage.routes.js
│   │   │   └── user.routes.js
│   │   ├── auth.routes.js
│   │   └── health.routes.js
│   ├── services/
│   │   ├── auth.service.js
│   │   ├── authorization.service.js
│   │   ├── brand.service.js
│   │   ├── branchPackagePrice.service.js
│   │   ├── branch.service.js
│   │   ├── branchVariantPrice.service.js
│   │   ├── category.service.js
│   │   ├── effectivePrice.service.js
│   │   ├── employee.service.js
│   │   ├── goodsReceipt.service.js
│   │   ├── inventory.service.js
│   │   ├── product.service.js
│   │   ├── productBarcode.service.js
│   │   ├── productPackage.service.js
│   │   ├── productVariant.service.js
│   │   ├── purchaseOrder.service.js
│   │   ├── role.service.js
│   │   ├── supplier.service.js
│   │   ├── supplierProduct.service.js
│   │   ├── supplierProductPackage.service.js
│   │   ├── taxRate.service.js
│   │   ├── unitOfMeasure.service.js
│   │   └── userAdmin.service.js
│   ├── utils/
│   │   ├── auditContext.js
│   │   ├── barcode.js
│   │   ├── databaseError.js
│   │   ├── exactDecimal.js
│   │   ├── httpError.js
│   │   ├── jwt.js
│   │   ├── password.js
│   │   ├── purchasingDecimal.js
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
│   │   ├── inventory/
│   │   │   └── inventory.validator.js
│   │   ├── products/
│   │   │   ├── common.validator.js
│   │   │   ├── product.validator.js
│   │   │   ├── productBarcode.validator.js
│   │   │   ├── productPackage.validator.js
│   │   │   └── productVariant.validator.js
│   │   ├── pricing/
│   │   │   ├── branchPackagePrice.validator.js
│   │   │   ├── branchVariantPrice.validator.js
│   │   │   └── common.validator.js
│   │   ├── purchasing/
│   │   │   ├── common.validator.js
│   │   │   ├── goodsReceipt.validator.js
│   │   │   └── purchaseOrder.validator.js
│   │   ├── suppliers/
│   │   │   ├── common.validator.js
│   │   │   ├── supplier.validator.js
│   │   │   ├── supplierProduct.validator.js
│   │   │   └── supplierProductPackage.validator.js
│   │   └── auth.validator.js
│   ├── app.js
│   └── server.js
├── test/
│   ├── admin.integration.test.js
│   ├── auth.integration.test.js
│   ├── catalogReference.integration.test.js
│   ├── inventory.integration.test.js
│   ├── pricing.integration.test.js
│   ├── productCatalog.integration.test.js
│   ├── purchasing.integration.test.js
│   └── supplierCatalog.integration.test.js
├── .env
├── .env.example
├── .gitignore
├── package-lock.json
├── package.json
└── README.md
```

`inventory.integration.test.js` exercises Phase 8 against MySQL,
`purchasing.integration.test.js` retains Phase 7 coverage,
`supplierCatalog.integration.test.js` retains Phase 6 coverage,
`pricing.integration.test.js` retains Phase 5C coverage,
`productCatalog.integration.test.js` retains Phase 5B coverage,
`catalogReference.integration.test.js` retains Phase 5A coverage,
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

The idempotent catalog contains 24 canonical Phase 4-8 permissions:

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
| `products.manage` | Create/update product master data and delete unused barcodes in Phase 5B |
| `pricing.read` | View branch pricing configuration in Phase 5C |
| `pricing.manage` | Create and update branch pricing configuration in Phase 5C |
| `suppliers.read` | View supplier masters and supplier catalog configuration in Phase 6 |
| `suppliers.manage` | Create and update supplier masters and supplier catalog configuration in Phase 6 |
| `purchasing.read` | View branch purchase orders and receiving progress in Phase 7 |
| `purchasing.manage` | Create, edit, and progress branch purchase orders in Phase 7 |
| `receiving.read` | View branch goods receipts and posted lot evidence in Phase 7 |
| `receiving.manage` | Create, edit, cancel, and atomically post branch goods receipts in Phase 7 |
| `inventory.read` | View branch stock projections, branch lots, and stock-ledger history in Phase 8 |
| `inventory.manage` | Configure reorder settings and branch lot operational state in Phase 8 |

The seed inserts missing canonical permissions, reconciles their human-readable
metadata, preserves unrelated permissions and roles, ensures the
`SYSTEM_ADMIN` / `System Administrator` role exists, and grants it every
canonical permission. Re-running the command produces the same logical
configuration and does not duplicate rows.

Phase 5A uses `catalog.read` and `catalog.manage`; Phase 5B uses `products.read`
and `products.manage`. Those four are global administration permissions. Phase
5C uses `pricing.read` and `pricing.manage` as branch-aware permissions. For the
permission-scope check, a global pricing grant
(`user_roles.branch_id IS NULL`) can satisfy the required permission for any
branch, while a branch-scoped grant can satisfy it only for its exact branch.
The employee-assignment check is a separate access gate: whenever the user is
linked to an employee, the employee must also have a current active assignment
to the target branch, regardless of whether the qualifying permission came from
a global or branch-scoped grant. An unlinked system user is not subject to this
employee-assignment gate. Catalog or product permissions never imply pricing
access.

Phase 6 uses `suppliers.read` for all supplier GET routes and
`suppliers.manage` for all supplier writes. Supplier administration is global:
only a global role grant (`user_roles.branch_id IS NULL`) satisfies these
routes. A branch-scoped supplier grant does not satisfy them, and catalog,
product, or pricing permissions do not imply supplier access.

Phase 7 uses `purchasing.read`/`purchasing.manage` for purchase orders and
`receiving.read`/`receiving.manage` for goods receipts. Permission scope and
employee access are separate checks: a global grant can satisfy the permission
for any branch, while a branch grant can satisfy it only for that exact branch.
Whenever a user is employee-linked, that employee must also have a current
active assignment at the URL branch, regardless of which grant supplied the
permission. An unlinked system user may read with a qualifying grant, but every
Phase 7 write additionally requires an active linked employee with a current
assignment; the repository rechecks that operational identity inside the same
transaction as the mutation.

Phase 8 uses `inventory.read` for six GET routes and `inventory.manage` for
the two configuration writes. A global grant can satisfy the permission-scope
check for any branch; a branch grant satisfies it only for that branch. A
linked employee still needs a current active assignment to the target branch
for **either** grant. An authorized unlinked system user can read, but neither
a global role nor `SYSTEM_ADMIN` bypasses the active linked-employee requirement
for writes. Catalog, product, pricing, supplier, purchasing, or receiving
permissions do not imply inventory access; `inventory.manage` does not imply
`inventory.read`.

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
| products | `search`, `status`, `categoryId`, `brandId`, `taxRateId` |
| product variants | `search`, `status`, `unitOfMeasureId`, `isFractional`, `lotTrackingMode`, `requiresExpiryDate` |
| product packages | `search`, `status`, `packageUnitOfMeasureId`, `isBaseUnit`, `isPurchasable`, `isSellable` |
| product barcodes | `search`, `barcodeType`, `productPackageId`, `isPrimary` |
| branch variant prices | `search`, `isActive`, `effectiveStatus` |
| branch package prices | `search`, `isActive`, `effectiveStatus` |

Ordering is code-controlled and includes stable ID tie-breakers. Search and
filters use parameterized values rather than client-supplied SQL fragments.
Pricing `effectiveStatus` accepts `EFFECTIVE`, `FUTURE`, or `INACTIVE` and is
evaluated against one database clock expression per query.

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

## Phase 5B endpoints and required permissions

Product master data is organization-wide. Every route inherits authentication
and required-password-change enforcement from `/api/admin`, then requires a
current **global** product permission. A branch-scoped grant does not satisfy
these endpoints.

| # | Method and path | Required permission | Purpose |
| ---: | --- | --- | --- |
| 1 | `GET /api/admin/catalog/products` | `products.read` | Paginated product list |
| 2 | `GET /api/admin/catalog/products/:productId` | `products.read` | Product detail |
| 3 | `POST /api/admin/catalog/products` | `products.manage` | Create a product |
| 4 | `PATCH /api/admin/catalog/products/:productId` | `products.manage` | Update a product |
| 5 | `GET /api/admin/catalog/products/:productId/variants` | `products.read` | Paginated variants owned by a product |
| 6 | `POST /api/admin/catalog/products/:productId/variants` | `products.manage` | Create a variant, optionally with its base package |
| 7 | `GET /api/admin/catalog/variants/:variantId` | `products.read` | Resolve a variant directly by ID |
| 8 | `PATCH /api/admin/catalog/variants/:variantId` | `products.manage` | Update a variant resolved directly by ID |
| 9 | `GET /api/admin/catalog/variants/:variantId/packages` | `products.read` | Paginated packages owned by a variant |
| 10 | `POST /api/admin/catalog/variants/:variantId/packages` | `products.manage` | Create a package definition for a variant |
| 11 | `GET /api/admin/catalog/packages/:packageId` | `products.read` | Resolve a package directly by ID |
| 12 | `PATCH /api/admin/catalog/packages/:packageId` | `products.manage` | Update a package definition resolved directly by ID |
| 13 | `GET /api/admin/catalog/variants/:variantId/barcodes` | `products.read` | Paginated barcodes owned by a variant |
| 14 | `POST /api/admin/catalog/variants/:variantId/barcodes` | `products.manage` | Create a variant- or package-level barcode |
| 15 | `GET /api/admin/catalog/barcodes/:barcodeId` | `products.read` | Resolve a barcode directly by ID |
| 16 | `PATCH /api/admin/catalog/barcodes/:barcodeId` | `products.manage` | Update a barcode, including primary preference |
| 17 | `GET /api/admin/catalog/barcodes/lookup?barcode=<exact-value>` | `products.read` | Exact case-sensitive barcode lookup |
| 18 | `DELETE /api/admin/catalog/barcodes/:barcodeId` | `products.manage` | Delete one unused barcode |

Products and variants have no DELETE route, and package definitions are retired
through lifecycle status rather than deleted. Barcodes are the controlled
exception because they have no lifecycle status: an unused barcode may be
deleted, while a sale-referenced barcode returns `409`. Direct variant, package,
and barcode resource routes resolve their own owning chain internally. Parent
ownership remains explicit and validated on product-variant, variant-package,
and variant-barcode collection/create routes. The exact barcode lookup route is
registered before the dynamic `:barcodeId` route.

## Phase 5C endpoints and required permissions

Pricing configuration is branch-specific. Every route inherits authentication
and required-password-change enforcement from `/api/admin`, then checks its
permission against `:branchId` using the branch-aware authorization path. A
global or exact-branch grant may satisfy the permission scope, but every
employee-linked user must independently have a current active assignment to the
target branch. Unlinked system users do not require an employee assignment.

| # | Method and path | Required permission | Purpose |
| ---: | --- | --- | --- |
| 1 | `GET /api/admin/branches/:branchId/prices/variants` | `pricing.read` for that branch | Paginated branch variant-price configurations |
| 2 | `GET /api/admin/branches/:branchId/prices/variants/:variantId` | `pricing.read` for that branch | One branch/variant configuration row |
| 3 | `PUT /api/admin/branches/:branchId/prices/variants/:variantId` | `pricing.manage` for that branch | Create or replace the branch/variant configuration |
| 4 | `GET /api/admin/branches/:branchId/prices/packages` | `pricing.read` for that branch | Paginated branch package-price configurations |
| 5 | `GET /api/admin/branches/:branchId/prices/packages/:packageId` | `pricing.read` for that branch | One branch/package configuration row |
| 6 | `PUT /api/admin/branches/:branchId/prices/packages/:packageId` | `pricing.manage` for that branch | Create or replace the branch/package configuration |
| 7 | `GET /api/admin/branches/:branchId/prices/effective/variants/:variantId` | `pricing.read` for that branch | Resolve the variant's current effective price |
| 8 | `GET /api/admin/branches/:branchId/prices/effective/packages/:packageId` | `pricing.read` for that branch | Resolve the package's current effective price |

These are the exact eight Phase 5C routes. There are no aliases and no pricing
DELETE route. Send `isActive: false` through PUT to disable an override while
preserving its configuration row.

## Branch pricing behavior

### Configuration rows and PUT

The approved composite primary keys enforce at most one row per branch/variant
and one row per branch/package. A first PUT creates that row; later PUTs replace
its three business values in the same row. It does not create history rows. GET
detail describes only this branch-specific configuration and returns `404` when
the branch and item exist but the configuration does not. Defaults and derived
prices are returned only by the `/effective/...` endpoints.

Both PUT bodies contain exactly:

```json
{
  "sellingPrice": "12.5000",
  "effectiveFrom": "2026-09-09T08:00:00.000000Z",
  "isActive": true
}
```

`sellingPrice` is a non-negative decimal string within `DECIMAL(19,4)` and is
normalized to four places. JavaScript numbers, signs, exponent notation,
excess scale, and out-of-range values are rejected. `isActive` is a strict JSON
Boolean. `effectiveFrom` is a strict UTC timestamp in
`YYYY-MM-DDTHH:mm:ss[.ffffff]Z` form; future values are valid.
`updatedByEmployeeId` is never accepted from the client. It is derived from the
authenticated user's employee link, or stored as `NULL` for a valid system user.

A PUT whose persisted business values are already identical returns `200` with
the current row, preserves its updater, and emits no misleading update audit.
Concurrent PUTs lock in the existing product hierarchy order and serialize on
the branch/item rows, leaving exactly one complete committed request state.

### Effective-price precedence

Variant resolution uses this fixed order:

1. an active branch/variant row whose `effectiveFrom` is due — source
   `BRANCH_VARIANT`;
2. otherwise `product_variants.default_selling_price` — source
   `VARIANT_DEFAULT`.

Package resolution uses this fixed order:

1. an active, due branch/package row — source `BRANCH_PACKAGE`;
2. otherwise a non-null package default — source `PACKAGE_DEFAULT`;
3. otherwise the effective variant price multiplied by
   `conversion_to_base_quantity` — source `DERIVED_FROM_VARIANT`.

The source vocabulary is limited to `BRANCH_VARIANT`, `VARIANT_DEFAULT`,
`BRANCH_PACKAGE`, `PACKAGE_DEFAULT`, and `DERIVED_FROM_VARIANT`. Each resolver
captures `UTC_TIMESTAMP(6)` once in its database query, so a request cannot
cross an effective-time boundary between separate clock reads.

Derived package multiplication uses scaled `BigInt`: four-place money times a
six-place conversion, followed by deterministic round-half-up to four monetary
places. No binary floating-point calculation is used. Derived responses also
identify the effective variant price/source and the conversion so the result is
explainable.

A future PUT replaces the only override row. Until its UTC time arrives, that
override is ignored and the normal fallback applies. Multiple scheduled rows,
price history, promotion rules, tax-at-checkout calculation, and automatic
activation jobs are outside Phase 5C.

### Audit and the stock boundary

Changed PUTs write one audit row in the same transaction using
`BRANCH_VARIANT_PRICE_CREATED`, `BRANCH_VARIANT_PRICE_UPDATED`,
`BRANCH_PACKAGE_PRICE_CREATED`, or `BRANCH_PACKAGE_PRICE_UPDATED`. Create
snapshots use `beforeValues: null`; updates capture safe before and after data.
GETs, effective reads, failed PUTs, and no-op PUTs do not write audit rows.

Pricing is configuration only. These endpoints read/write
`branch_variant_prices` and `branch_package_prices`; they never create or move
stock and never create `branch_inventory`, `inventory_lots`, or
`inventory_transactions` rows. Inventory and checkout workflows remain future
phases.

## Product-master behavior

### Products and active references

A product is the shared merchandising identity. It references one category and
optional brand and tax rate; it does not contain a barcode or stock quantity.
Product codes are trimmed and uppercased, while names and descriptions preserve
meaningful casing. An `ACTIVE` product may reference only active catalog rows.
Reference rows are locked and revalidated before the product row so a concurrent
Phase 5A deactivation cannot commit an invalid active reference.

Products use `ACTIVE`, `INACTIVE`, and `DISCONTINUED` states. Moving an active
product out of service is rejected while any active variant remains, and no
variant is changed implicitly. A newly created active product may have no
variant while an administrator completes configuration.

### Variants, exact values, and lot policy

A product variant is the sellable/stockable SKU and owns the base inventory unit.
SKUs are globally unique and uppercased; variant names are unique within their
product. Size and units-per-pack use exact `DECIMAL(12,3)` strings, and the
catalog fallback selling price uses an exact nonnegative `DECIMAL(19,4)` string.
JSON numbers, exponent notation, excess precision, and out-of-range values are
rejected before SQL.

Fractional variants require a unit whose `allowsFraction` flag is true. Expiry
tracking requires `OPTIONAL` or `REQUIRED` lot tracking. After operational
inventory/history exists, this implementation conservatively rejects any actual
lot-mode or expiry-policy change rather than inventing or rewriting historical
allocations. A variant's base UOM cannot change after any package exists or after
base-quantity configuration/history (including a supplier-product mapping) has
established its meaning.

Creating an active variant requires a nested base-package definition. Both rows
and both audit events commit atomically. Activating an existing variant requires
an active parent product and exactly one active base package.

### Packages and the active-base invariant

A package converts a buying or selling unit into the variant's base inventory
quantity; it never creates separate stock. Conversion values are exact positive
`DECIMAL(18,6)` strings. Optional package fallback prices are exact nonnegative
`DECIMAL(19,4)` strings. Package codes are uppercased and unique within a
variant.

Every active variant must have exactly one package where `isBaseUnit` is true
and status is `ACTIVE`. Every package marked as a base definition, including an
inactive one, must use the variant UOM and conversion `1.000000`.
`isBaseUnit` is a writable structural field on normal package PATCH requests,
but a request that would create two active base packages or leave an active
variant with none returns `409`. There is no implicit multi-row base switch.
Administrators reconfigure the base lifecycle explicitly by making the variant
inactive, retiring or changing the old definition, establishing exactly one
valid active base package, and then reactivating the variant. Package rows are
never changed implicitly.

Once a package is used by supplier-package configuration, a branch package
price, purchase item, sale item, or sales-return item, its structural UOM,
conversion, and base designation are immutable. Descriptive/current-use fields
remain editable subject to lifecycle rules. Historical conversion snapshots are
never rewritten; administrators retire the old package and create a new
definition when identity must change.

### Barcodes and primary scopes

Barcodes remain case-sensitive strings, preserving leading zeroes and display
case. They are globally unique and may belong to the whole variant or one package
owned by that variant. `EAN_8`, `UPC_A`, `EAN_13`, and `GTIN_14` require the exact
digit length and a valid GS1 check digit; `PLU` requires four or five digits.
`CODE_128`, `INTERNAL`, and `OTHER` accept a nonblank string up to 64 characters.

Primary preference is independent per scope: one variant-level primary and one
primary for each package may coexist. Setting `isPrimary` to `true` through
barcode PATCH locks the exact destination scope, demotes an existing primary,
and promotes the target in one transaction without disturbing unrelated package
scopes. Setting it to `false` demotes only the target, and zero primaries in a
scope is valid. If a still-primary barcode moves to another package scope, the
same destination-scope switch is applied atomically. Once a barcode ID appears
in a sale item, its value, type, and package scope are immutable; current primary
preference may still change.

Exact lookup accepts one required `barcode` query string without normalization
or numeric conversion, so leading zeroes and case remain significant. An unused
barcode may be deleted physically together with a `PRODUCT_BARCODE_DELETED`
audit record; sale history blocks deletion with `409`. Deleting a primary does
not nominate a replacement because zero primary barcodes are permitted.

### Product pagination, audit, and locking

All four collection routes use page `1`, limit `20`, maximum `100`, parameterized
filters, and fixed ID-backed ordering. `brandId=null`, `taxRateId=null`, and
barcode `productPackageId=null` select rows whose corresponding nullable column
is SQL `NULL`; omission means no filter.

Successful changes use `PRODUCT_CREATED`, `PRODUCT_UPDATED`,
`PRODUCT_VARIANT_CREATED`, `PRODUCT_VARIANT_UPDATED`,
`PRODUCT_PACKAGE_CREATED`, `PRODUCT_PACKAGE_UPDATED`,
`PRODUCT_BARCODE_CREATED`, `PRODUCT_BARCODE_UPDATED`, and
`PRODUCT_BARCODE_DELETED`. A PATCH-based primary switch audits both the promoted
barcode and any barcode it demotes as `PRODUCT_BARCODE_UPDATED`. A delete audit
retains the safe deleted snapshot as its before-value and stores a null
after-value. Safe snapshots, actor/request context, and the mutation share one
transaction. Failed and no-op requests produce no misleading audit row.

The cross-phase lock order is catalog/reference rows, product, variant, package,
barcode, then downstream dependency rows. IDs within a level are locked in
deterministic order. Variant-row serialization ensures concurrent base-package
lifecycle or primary-barcode PATCH operations cannot violate their final-state
invariants, and it keeps variant activation from racing an active base out of
existence.

## Phase 6 endpoints and required permissions

Supplier configuration is organization-wide. Every route inherits authentication
and required-password-change enforcement from `/api/admin`, then requires the
named **global** supplier permission.

| # | Method and path | Required permission | Purpose |
| ---: | --- | --- | --- |
| 1 | `GET /api/admin/suppliers` | `suppliers.read` | Paginated supplier list |
| 2 | `GET /api/admin/suppliers/:supplierId` | `suppliers.read` | Supplier detail |
| 3 | `POST /api/admin/suppliers` | `suppliers.manage` | Create a supplier |
| 4 | `PATCH /api/admin/suppliers/:supplierId` | `suppliers.manage` | Update master/lifecycle fields |
| 5 | `GET /api/admin/suppliers/:supplierId/products` | `suppliers.read` | Paginated supplier-to-variant relationships |
| 6 | `POST /api/admin/suppliers/:supplierId/products` | `suppliers.manage` | Create a supplier-to-variant relationship |
| 7 | `GET /api/admin/suppliers/:supplierId/products/:supplierProductId` | `suppliers.read` | One supplier-to-variant relationship |
| 8 | `PATCH /api/admin/suppliers/:supplierId/products/:supplierProductId` | `suppliers.manage` | Update a supplier-to-variant relationship |
| 9 | `GET /api/admin/suppliers/:supplierId/products/:supplierProductId/packages` | `suppliers.read` | Paginated packages for one supplier product |
| 10 | `POST /api/admin/suppliers/:supplierId/products/:supplierProductId/packages` | `suppliers.manage` | Create a supplier-to-package relationship |
| 11 | `GET /api/admin/suppliers/:supplierId/product-packages/:supplierProductPackageId` | `suppliers.read` | Resolve one supplier package directly |
| 12 | `PATCH /api/admin/suppliers/:supplierId/product-packages/:supplierProductPackageId` | `suppliers.manage` | Update a supplier-to-package relationship |

These are the exact 12 Phase 6 routes. There are no aliases or DELETE routes,
and no purchase-order, receipt, procurement, or inventory route was added.

## Supplier and supplier-catalog behavior

### Frozen-schema interpretation and resource identity

`suppliers` uses the surrogate `supplier_id` primary key. Its exposed business
fields are `supplierCode`, `supplierName`, `contactName`, `email`, `phone`,
`taxIdentifier`, the six address/location fields, `paymentTermsDays`, and
`status`. Status is the strict schema enum `ACTIVE`, `INACTIVE`, or `BLOCKED`.
Codes and the two-letter country code are trimmed and uppercased; meaningful
display text retains its casing. The database uniquely enforces supplier code
and each non-null tax identifier.

`supplier_products` has no surrogate ID. Its primary key is
`(supplier_id, product_variant_id)`, so the route's `supplierProductId` is the
`product_variant_id` component within the URL supplier. Responses expose both
names explicitly. The row stores the optional supplier SKU, preferred flag,
optional lead-time days, and minimum order quantity. Supplier SKU is unique
within its supplier; the generated unique preferred guard permits at most one
preferred supplier for a variant across all suppliers.

`supplier_product_packages` likewise has no surrogate ID. Its primary key is
`(supplier_id, product_package_id)`, so `supplierProductPackageId` is the
`product_package_id` component within the URL supplier. Its composite foreign
keys require both an existing supplier/variant relationship and a package owned
by that same variant. It stores the optional supplier package SKU, minimum
package quantity, and active flag. Direct detail/update resolves and verifies
the whole supplier → supplier product → supplier package chain; a cross-supplier
or otherwise mismatched route returns `404` without exposing another supplier's
configuration.

Neither supplier catalog table contains a supplier cost column. Phase 6 does
not invent one: purchase-item cost is a Phase 7 transaction value and the
approved purchase tables preserve that historical snapshot.

### Lifecycle and exact-value rules

Creating a supplier relationship requires an active supplier, parent product,
and variant. Creating a supplier package also requires an active, purchasable
package. Setting an existing relationship to preferred, or an existing package
relationship to active, rechecks the same current lifecycle state while holding
locks. Administrators may still clear a preferred flag, disable a package
relationship, or correct non-identity metadata when retiring configuration.

Changing a supplier to `INACTIVE` or `BLOCKED` does not cascade into
`supplier_products`, `supplier_product_packages`, or historical purchase rows.
The status itself is the current eligibility signal that the Phase 7 service
enforces before creating a purchase order. This lets a supplier be retired
without destroying its catalog or history.

`minimumOrderQuantity` and `minimumPackageQuantity` are positive exact
`DECIMAL(15,3)` strings. JavaScript numbers, signs, exponent notation, excess
scale, zero, and out-of-range values are rejected rather than rounded through
binary floating point. `paymentTermsDays` and `leadTimeDays` follow the schema's
unsigned-small-integer range, and Boolean fields require real JSON Booleans.
Unknown body/query fields, client timestamps, and generated guard columns are
not accepted.

### Lists, history, no-op, and audit behavior

All three Phase 6 collection forms use page `1`, limit `20`, maximum `100`,
fixed parameterized filters, and deterministic ordering with an ID tie-breaker.
Suppliers support `search` and `status`; supplier products support `search`,
`productVariantId`, and `isPreferred`; supplier packages support `search`,
`productPackageId`, and `isActive`.

The relationship identity columns cannot be changed by PATCH. Existing purchase
orders and items depend on supplier and variant/package identities but keep
their own item, quantity, conversion, and cost snapshots; Phase 6 never rewrites
those rows. The mutable supplier SKU, lead-time, minimum-quantity, preferred,
and active values remain current purchasing configuration, not historical
transaction facts. Physical deletion is deliberately unavailable.

Successful changes emit exactly one of `SUPPLIER_CREATED`, `SUPPLIER_UPDATED`,
`SUPPLIER_PRODUCT_CREATED`, `SUPPLIER_PRODUCT_UPDATED`,
`SUPPLIER_PRODUCT_PACKAGE_CREATED`, or
`SUPPLIER_PRODUCT_PACKAGE_UPDATED` in the same transaction as the mutation.
Supplier audit rows have a null branch context and safe before/after snapshots.
GETs, rejected writes, and PATCH requests with no persisted business change do
not write audit rows or touch `updated_at`.

### Locking and the operational boundary

Supplier relationship writes preserve the Phase 5B order: product, variant,
all packages for that variant, supplier, then supplier relationship rows.
Rows at each level are locked deterministically. This makes duplicate creates,
preferred-supplier changes, conflicting PATCH requests, and concurrent Phase 5B
structural mutations serialize to a complete valid final state. Supplier-only
master updates lock only the supplier root because they neither rewrite nor
delete child configuration.

Supplier configuration never inserts or updates `branch_inventory`, inventory
lots, stock ledgers, purchase orders, or goods receipts. It records who may
supply an already-defined variant or package; it does not order, receive, or
move goods. Phase 7 transactionally revalidates supplier/catalog lifecycle,
copies historical purchasing snapshots, and posts receipts through the
inventory ledger.

## Phase 7 endpoints and required permissions

All Phase 7 routes are branch-aware, inherit authentication and forced-password
change enforcement from `/api/admin`, and use only these exact paths:

| # | Method and path | Permission | Purpose |
| ---: | --- | --- | --- |
| 1 | `GET /api/admin/branches/:branchId/purchase-orders` | `purchasing.read` | Paginated purchase-order headers |
| 2 | `POST /api/admin/branches/:branchId/purchase-orders` | `purchasing.manage` | Create a DRAFT order |
| 3 | `GET /api/admin/branches/:branchId/purchase-orders/:purchaseOrderId` | `purchasing.read` | Order, items, and posted receiving progress |
| 4 | `PATCH /api/admin/branches/:branchId/purchase-orders/:purchaseOrderId` | `purchasing.manage` | Edit allowed DRAFT header fields |
| 5 | `POST /api/admin/branches/:branchId/purchase-orders/:purchaseOrderId/items` | `purchasing.manage` | Add a DRAFT line |
| 6 | `PATCH /api/admin/branches/:branchId/purchase-orders/:purchaseOrderId/items/:purchaseOrderItemId` | `purchasing.manage` | Edit allowed DRAFT line values |
| 7 | `DELETE /api/admin/branches/:branchId/purchase-orders/:purchaseOrderId/items/:purchaseOrderItemId` | `purchasing.manage` | Delete a DRAFT line, not the document |
| 8 | `POST /api/admin/branches/:branchId/purchase-orders/:purchaseOrderId/submit` | `purchasing.manage` | Submit a valid non-empty order |
| 9 | `POST /api/admin/branches/:branchId/purchase-orders/:purchaseOrderId/approve` | `purchasing.manage` | Approve a submitted order |
| 10 | `POST /api/admin/branches/:branchId/purchase-orders/:purchaseOrderId/cancel` | `purchasing.manage` | Cancel an eligible unreceived order |
| 11 | `GET /api/admin/branches/:branchId/goods-receipts` | `receiving.read` | Paginated receipt headers |
| 12 | `POST /api/admin/branches/:branchId/goods-receipts` | `receiving.manage` | Create a DRAFT receipt for an open approved order |
| 13 | `GET /api/admin/branches/:branchId/goods-receipts/:goodsReceiptId` | `receiving.read` | Receipt, items, and posted lot evidence |
| 14 | `PATCH /api/admin/branches/:branchId/goods-receipts/:goodsReceiptId` | `receiving.manage` | Edit allowed DRAFT receipt fields |
| 15 | `POST /api/admin/branches/:branchId/goods-receipts/:goodsReceiptId/items` | `receiving.manage` | Add a DRAFT receipt line |
| 16 | `PATCH /api/admin/branches/:branchId/goods-receipts/:goodsReceiptId/items/:goodsReceiptItemId` | `receiving.manage` | Edit allowed DRAFT line values |
| 17 | `DELETE /api/admin/branches/:branchId/goods-receipts/:goodsReceiptId/items/:goodsReceiptItemId` | `receiving.manage` | Delete a DRAFT line, not the receipt |
| 18 | `POST /api/admin/branches/:branchId/goods-receipts/:goodsReceiptId/post` | `receiving.manage` | Atomically post accepted stock |
| 19 | `POST /api/admin/branches/:branchId/goods-receipts/:goodsReceiptId/cancel` | `receiving.manage` | Cancel a DRAFT receipt |

There are no item-detail aliases, document DELETE routes, generic inventory or
lot routes, supplier-payment routes, or automatic-reordering routes. A valid ID
under the wrong branch or parent document returns `404`; malformed IDs return
`400`. All `BIGINT` IDs enter and leave the API as strings.

## Purchase-order behavior

Creation accepts only `supplierId`, nullable `expectedAt`, nullable
`supplierQuoteNumber`, `shippingAmount` (default `"0.00"`), and nullable
`notes`. The server locks and validates the active branch, active supplier, and
operational employee; generates a collision-resistant `PO-` number; takes the
branch currency; and creates a zero-line `DRAFT` without changing stock.
Foreign-currency purchasing is deliberately unavailable because the schema has
no exchange-rate model.

Only a DRAFT header may PATCH `expectedAt`, `supplierQuoteNumber`,
`shippingAmount`, or `notes`; supplier, branch, number, currency, status,
actors, lifecycle timestamps, and totals are server-owned. A line create
accepts `productVariantId`, nullable `productPackageId`,
`orderedPackageQuantity`, `unitCost`, and optional `discountAmount` and
`taxRatePercent`. A line PATCH may change only the latter four value fields.
Changing product/package identity means deleting the DRAFT line and creating a
new one.

Each line copies a human-readable item description and the locked package
conversion (`1.000000` for direct base-unit purchasing). The server derives
base quantity with positive HALF-UP rounding to scale 3 and assigns line
numbers while holding the parent order lock. It requires active product,
variant, purchasable package, supplier-product, and supplier-package state as
applicable, including both base and package minimum quantities. Preferred
supplier status is not required.

Money and quantity inputs must be exact unsigned decimal strings at their
schema scales. JavaScript numbers, signs, exponent notation, malformed values,
excess scale, and overflow are rejected. Scaled `BigInt` arithmetic implements:

```text
gross = ROUND(orderedQuantity * unitCost, 2, HALF-UP)
tax   = ROUND((gross - discountAmount) * taxRatePercent / 100, 2, HALF-UP)
lineTotal = gross - discountAmount + tax

subtotalAmount = SUM(line gross)
discountAmount = SUM(line discounts)
taxAmount      = SUM(line taxes)
totalAmount    = subtotalAmount - discountAmount + taxAmount + shippingAmount
```

The server rejects discounts above gross and derived quantity/money overflow.
Header totals are recomputed from persisted line snapshots inside every DRAFT
line or shipping mutation transaction. Decimal response values remain strings.

Submission performs `DRAFT -> SUBMITTED`, requires at least one line, locks and
revalidates current supplier/catalog eligibility and totals, and sets one
server-owned `orderedAt`. Approval performs `SUBMITTED -> APPROVED`, repeats
that validation, and records the employee and one `approvedAt`. Cancellation is
limited to unreceived `DRAFT`, `SUBMITTED`, or `APPROVED` orders; an existing
non-cancelled receipt must be cancelled explicitly first. The optional cancel
reason is audit context because the frozen order table has no reason column.
There are no backwards transitions or post-submission content edits.

Lists use page 1, limit 20, maximum 100 and stable newest-first ordering.
Purchase-order filters are `search`, `status`, `supplierId`,
`createdByEmployeeId`, `from`, `to`, `page`, and `limit`; `from`/`to` apply to
the order creation date. Detail derives `acceptedQuantity` and
`remainingQuantity` from POSTED receipts without persisting report columns.

## Goods-receipt and stock-posting behavior

A receipt can be created only for an `APPROVED` or `PARTIALLY_RECEIVED` order.
Creation accepts `purchaseOrderId`, nullable `supplierDeliveryNote`, nullable
`supplierInvoiceNumber`, and nullable `notes`. Branch and supplier come from
the order, the employee comes from the authenticated operational actor, and the
server owns the `GR-` number, `receivedAt`, and DRAFT status. The supplier
invoice is unique per supplier. Only DRAFT receipts may PATCH the three
documentary fields; no-op changes do not update or audit.

Receipt lines identify one item from that same purchase order and accept exact
`packageQuantityAccepted`, `packageQuantityRejected`, `actualUnitCost`, and
optional discount/tax amounts. They copy the PO line's historical variant and
conversion and derive base accepted/rejected quantities. At least one quantity
must be positive. Payable line total uses accepted stock only:

```text
grossAccepted = ROUND(quantityAccepted * actualUnitCost, 2, HALF-UP)
lineTotal = grossAccepted - discountAmount + taxAmount
```

Rejected quantity never consumes order fulfilment, creates a ledger item, or
increases inventory. DRAFT validation gives early over-receipt feedback, while
POST locks the order and all relevant receipts/items and authoritatively ensures
cumulative accepted quantities from POSTED receipts never exceed the order.
A rejected-only receipt cannot POST because the schema ties POSTED receipts to
a real stock transaction; it may be corrected or cancelled.

Posting accepts only optional `lotAllocations`. `NONE` variants reject lots;
`OPTIONAL` variants permit either none or full allocation; `REQUIRED` variants
require full allocation. Allocations must exactly equal the accepted base
quantity. Each lot uses either `inventoryLotId` or a case-sensitive
`lotNumber` with optional manufacture/expiry dates. Existing same-variant lots
are reused only when supplied immutable metadata agrees. Expiry-required
variants require it, and `RECALLED`/`CLOSED` or wrong-variant lots are rejected.
Receipt posting may create a necessary lot record but exposes no generic lot
administration API.

The POST operation is one transaction: it rechecks the actor/branch and
document state, locks current catalog roots and document rows in deterministic
order, validates receipt limits and lots, creates/reuses lots, creates exactly
one `PURCHASE_RECEIPT` inventory transaction, adds one positive ledger item per
accepted receipt item, writes both lot-evidence bridges when allocated,
increments `branch_inventory` and `branch_lot_inventory`, links and marks the
receipt POSTED, recalculates the order status, audits, and commits. Any failure
rolls everything back. A second or concurrent duplicate POST cannot create a
second transaction or stock increase.

`branch_inventory` remains the fast branch/variant projection: the first
receipt creates the row and later receipts increment quantity/version under
lock. `branch_lot_inventory` is changed only for allocated accepted stock and
preserves quarantine. The append-only inventory transaction and its items are
the stock authority; projections, receipt state, lot evidence, and ledger all
move together. Receiving never changes selling prices, product/catalog state,
or supplier configuration.

After each POST, accepted quantities from POSTED receipts produce
`APPROVED` (none), `PARTIALLY_RECEIVED` (some), or `RECEIVED` (every line
complete). A POSTED receipt, its lines, allocations, and transaction link are
immutable. A DRAFT receipt may instead become `CANCELLED`, which posts no stock
and cannot be reopened. Lists support `search`, `status`, `purchaseOrderId`,
`supplierId`, `receivedByEmployeeId`, `from`, `to`, `page`, and `limit`;
receipt date filters apply to `receivedAt`.

## Phase 7 history, audit, and locking

PO creation/submission/approval uses current supplier and product eligibility.
Once approved, receiving uses the PO line's historical identity, conversion,
and cost structure rather than later catalog values; a later supplier disable
does not invalidate an already approved receipt. Existing Phase 5B dependency
guards continue to protect incompatible package/variant structural changes,
and Phase 6 configuration is consulted but never rewritten.

The purchasing audit actions are `PURCHASE_ORDER_CREATED`,
`PURCHASE_ORDER_UPDATED`, `PURCHASE_ORDER_ITEM_CREATED`,
`PURCHASE_ORDER_ITEM_UPDATED`, `PURCHASE_ORDER_ITEM_DELETED`,
`PURCHASE_ORDER_SUBMITTED`, `PURCHASE_ORDER_APPROVED`, and
`PURCHASE_ORDER_CANCELLED`. Receiving uses `GOODS_RECEIPT_CREATED`,
`GOODS_RECEIPT_UPDATED`, `GOODS_RECEIPT_ITEM_CREATED`,
`GOODS_RECEIPT_ITEM_UPDATED`, `GOODS_RECEIPT_ITEM_DELETED`,
`GOODS_RECEIPT_POSTED`, and `GOODS_RECEIPT_CANCELLED`. Each committed mutation
and safe before/after snapshot shares a transaction with its audit. GETs,
rejected writes, and no-op PATCH requests write no audit.

Cross-phase writes discover IDs with pre-reads, then lock authoritative catalog
roots in the existing product -> variant -> package -> supplier relationship
order before locking documents. Document operations serialize the purchase
order, its items, receipts, receipt items, then lots and sorted branch balance
rows. All decisions are revalidated after locks; rollback and connection
release remain mandatory on every error. This prevents torn line PATCHes, lost
header totals, over-receiving, double posts, duplicated lot evidence, and lost
stock increments without introducing a broad automatic retry framework.

## Phase 8 inventory engine

Phase 8 exposes exactly eight branch-scoped routes under
`/api/admin/branches/:branchId/inventory`:

| Method and path suffix | Permission | Purpose |
| --- | --- | --- |
| `GET /` | `inventory.read` | Paginated branch inventory projections |
| `GET /variants/:variantId` | `inventory.read` | One branch/variant projection and its branch lots |
| `PUT /variants/:variantId/settings` | `inventory.manage` | Reorder configuration only |
| `GET /lots` | `inventory.read` | Paginated lots with state at this branch |
| `GET /lots/:inventoryLotId` | `inventory.read` | Branch lot and up to ten recent ledger allocations |
| `PATCH /lots/:inventoryLotId/status` | `inventory.manage` | Branch operational lot state only |
| `GET /transactions` | `inventory.read` | Paginated stock-ledger headers |
| `GET /transactions/:inventoryTransactionId` | `inventory.read` | Header, items, and lot allocations |

Every route inherits authentication and forced-password-change protection.
Branch permission scope and the separate linked-employee assignment gate are
both enforced by the existing authorization middleware. Writes additionally
recheck an active linked employee and current branch assignment inside their
transaction; unlinked system accounts may read but cannot write. A global
inventory grant satisfies permission scope across branches, whereas a branch
grant satisfies it only for the matching branch. No unrelated permission
implies inventory access.

`branch_inventory` is the fast branch/variant balance and reorder projection;
`inventory_transactions` plus items and lot allocations are the historical
stock authority. The inventory list returns only existing projection rows and
supports `search`, `productVariantId`, `categoryId`, `brandId`, `stockStatus`,
`lotTrackingMode`, `page`, and `limit`. Lots list only rows with
`branch_lot_inventory` at the URL branch and supports `search`,
`productVariantId`, `branchLotStatus`, `lotStatus`, `expiresBefore`,
`expiresAfter`, `page`, and `limit`. All lists default to page 1/limit 20,
limit at 100, and have deterministic ID tie-breakers. Search uses fixed,
parameterized fields; no client-supplied SQL sort expression is accepted.

Stock status is based on **total** `quantity_on_hand`, not the quantity in
currently available lots: `OUT_OF_STOCK` means zero; `LOW_STOCK` means positive
stock with positive reorder level and on-hand stock at or below that level;
`IN_STOCK` means positive stock otherwise. A negative legacy value is reported
as `INCONSISTENT`, never clamped. `trackedLotQuantity` is the sum of branch lot
balances and `untrackedQuantity` is exact total minus tracked, computed without
floating-point arithmetic. Read-only consistency warnings flag negative
balances, lot totals exceeding branch totals, unexpected lots for `NONE`, or
a tracked/total mismatch for `REQUIRED`. `OPTIONAL` may have both tracked and
untracked stock. No GET creates a projection or repairs a mismatch.

`PUT /variants/:variantId/settings` accepts **only** both nonnegative
DECIMAL(15,3) strings `reorderLevel` and `reorderQuantity`. Nonfractional
variants require whole base units. It may create a zero-stock projection
before a first receipt; this is configuration, not an `OPENING_BALANCE` or
other stock movement. A persisted change increments `version_number` (new
rows begin at 0); an identical PUT does not touch the row, increment the
version, or audit. Reorder configuration does not automatically place orders.

The branch lot status enum is `AVAILABLE`, `QUARANTINED`, `BLOCKED`,
`DEPLETED`. Clients may select `AVAILABLE`, `QUARANTINED`, or `BLOCKED` only.
`DEPLETED` is system-owned. Making a branch lot `AVAILABLE` requires positive
branch quantity, globally `ACTIVE` lot state, and an unexpired lot according
to the database UTC date. The global lot's status, identity, expiry, and
quantity do not change through this route. A status no-op changes nothing.
Lot reads expose global and branch status separately, and classify expiry as
`NO_EXPIRY`, `VALID`, or `EXPIRED` using MySQL's UTC date; reading does not
automatically change either status. Exact lot-number identity remains
case-sensitive in storage.

The transaction list supports `search`, `transactionType`,
`productVariantId`, `inventoryLotId`, `createdByEmployeeId`, `from`, `to`,
`page`, and `limit`; dates filter `occurred_at`, inclusive by UTC calendar day.
Item/lot filters use `EXISTS` so one header cannot be duplicated by joins.
Detail preserves exact signed `quantity_change` and the stored nullable
historical `unit_cost`; it never substitutes current selling or supplier cost.
Each item's lot allocations and read-only quantity-consistency result are
included. All `BIGINT UNSIGNED` IDs are JSON strings and all stock DECIMALs
remain exact strings.

Both Phase 8 writes use a transaction with this order: active employee,
branch, and assignment; product; variant; then the branch inventory row for
settings, or global lot then branch lot row for status. The latter matches
Phase 7 receipt posting's catalog → lot → branch balance order. Row locks
serialize conflicting settings/status requests and concurrent receipt posts
without lost quantities, torn reorder pairs, or lost status/version updates.
Audit records commit with writes using composite record IDs
`branchId:productVariantId` and `branchId:inventoryLotId`; the only actions
are `BRANCH_INVENTORY_SETTINGS_CREATED`,
`BRANCH_INVENTORY_SETTINGS_UPDATED`, and `BRANCH_LOT_STATUS_UPDATED`. Audit
includes user, linked employee, branch, request, network context, and safe
before/after values. GETs, failed writes, and no-ops produce no Phase 8 audit.

There is no Phase 8 endpoint to edit on-hand quantities, create/modify/delete
ledger entries, change global lot status, or run adjustments, counts, or
transfers. Receipt posting remains the only implemented stock movement. Phase 9
— Stock Adjustments, Counts & Transfers has not started.

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
rows. The Phase 5B product/variant services follow the same reference-first lock
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
rejected for `SYSTEM_ADMIN` unless all 24 canonical permissions remain.

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

The complete Phase 2-8 validation run covers:

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
  catalog audit actions;
- Phase 5B global product authorization, all 18 product-master endpoints, exact
  decimal handling, collection ownership and direct-resource resolution,
  active-reference and active-base lifecycle rules, GTIN/UPC validation, exact
  case-sensitive lookup, controlled barcode deletion, package/barcode history
  stability, PATCH-based primary switching, and conflicting-operation
  final-state checks;
- Phase 5C branch-aware pricing authorization, all eight locked routes,
  one-row PUT semantics, strict UTC and exact-money validation, all five
  effective-price sources, scaled-`BigInt` derived prices, no-op and failed-write
  audit suppression, concurrency final states, and zero inventory side effects;
- Phase 6 global supplier authorization, all 12 locked routes, supplier master
  lifecycle, composite supplier-product/package ownership, exact minimum
  quantities, preferred uniqueness, no-op and failed-write audit suppression,
  cross-phase race serialization, and zero inventory/purchasing side effects;
- Phase 7 branch authorization and operational-actor gating, all 19 locked
  routes against Phase 4-6 unrelated permissions, exact PO/receipt calculations
  and snapshots, invalid and legal lifecycle changes, purchasing eligibility,
  partial/rejected receiving, over-receipt and duplicate-post protection,
  required/optional/no-lot policies, lot identity and metadata rules, atomic
  ledger/projection posting and rollback, transaction-bound audit, and
  concurrency-safe final states;
- Phase 8 all eight branch inventory routes, permission/actor matrix, exact
  quantities and signed historical costs, projection/lot/ledger filters,
  read-only consistency diagnostics, strict settings and lot-state writes,
  no-op/failed-write audit suppression, receipt races, boundary-method absence,
  and zero unrelated catalog/pricing/supplier/document mutation; and
- exact reverse-FK cleanup of uniquely identified `TEST_*` access-control,
  organization, product-dependency, reference-catalog, pricing, bridge, and
  audit rows.

Canonical seed permissions and `SYSTEM_ADMIN` configuration may remain because
they are intentional application configuration rather than test fixtures. Tests
must never drop/recreate the database or touch unrelated development data.
Phase 5A creates only uniquely identified reference rows and direct dependency
fixtures. Phase 5B creates uniquely identified product-master rows and only the
minimum zero-balance/history rows needed to verify immutability. Phase 5C creates
isolated organization/product/pricing prerequisites directly in SQL. Phase 6
creates isolated access/product prerequisites, exercises supplier APIs, and
verifies that neither inventory nor Phase 7 operational rows appear. Phase 7
creates isolated branch, catalog, supplier, document, lot, and stock fixtures
and deletes their exact reverse-FK closure after testing. Phase 8 creates
isolated `TEST_P8_*` organization/catalog prerequisites and posts actual Phase 7
receipts for stock history; one direct SQL ledger row tests negative/null read
preservation. Every suite removes its temporary rows in reverse foreign-key
order. No suite operates real development records or implements Phase 9
adjustments/counts/transfers, POS, sales, returns, or payments.

The latest local validation on 2026-09-13 passed all 96 discovered test entries:
the 82 retained Phase 2-7 entries plus 14 Phase 8 entries. It confirmed the
active `supermarket_management` database with 54 tables on MySQL 8.0.46, 24
canonical permissions, one active `SYSTEM_ADMIN` role with all 24 canonical
mappings, and zero remaining `TEST_P8_*` fixtures in the checked tables. The
full run completed with 96 passed, 0 failed, 0 skipped, and 0 cancelled in
26,496.484968 ms. Results are environment-specific, so run `npm test` again
after relevant code, configuration, or database changes.

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

Phase 5A stops after shared reference-catalog administration. Phase 5B stops
after organization-wide product, variant, package, and barcode administration.
Phase 5C stops after branch price configuration and read-only effective-price
resolution. Phase 6 stops after supplier master and supplier catalog
configuration. Phase 7 stops after purchase-order administration and atomic
purchase-receipt stock posting. Phase 8 stops after branch stock/lot/ledger
reads and reorder/branch-lot-status configuration. Phase 9 — Stock Adjustments,
Counts & Transfers was NOT started.
