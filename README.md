# Supermarket Management System

A production-oriented, multi-branch supermarket management system built in
reviewed phases. Phase 14 adds branch-aware sales returns, auditable stock
restoration, and return-linked refund settlement on top of the approved Phase 13
tender engine and frozen 54-table database.

The current API reads branch inventory and historical stock transactions,
configures reorder settings and branch lot availability, and atomically posts
adjustments, count corrections, transfer dispatches, and transfer receipts. It operates branch
purchase orders, goods receipts, receipt-time lot allocation, and the
stock-ledger posting required by receiving. It also
operates supplier masters and supplier catalog relationships, configures prices
per branch, and resolves the currently effective variant or package price. It
operates products,
sellable/stockable variants, unit-conversion packages, case-sensitive barcodes,
units of measure, hierarchical categories, brands, tax rates, and the existing
organization and access records. It now also administers individual and
business customer profiles without inventing a financial customer-account
model. It configures physical branch registers, opens and controls cashier till
sessions, records append-only drawer movements, and closes drawers against
persisted cash evidence. It records exact split tender, enforces payment completeness before sale
completion, and preserves payment attempt history. It now also records returned
merchandise separately from the original sale, posts restockable returns through
the inventory ledger, and settles exact return-linked refunds. It retains all
Phase 2-13 behavior.

Phases 5A, 5B, 5C, 6, 7, 8, 9, 10, 11, 12, 13, and 14 do **not** redesign the database. The approved
[`database/schema.sql`](database/schema.sql) and detailed
[`database/README.md`](database/README.md) remain the authority for the existing
54 tables.

## Phase 5A through Phase 14 purpose and boundaries

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
configuration writes: reorder settings and branch lot status. Those Phase 8
writes do not create stock or ledger transactions.

Phase 9 adds controlled adjustment documents, physical-count snapshots and
reconciliation, and two-stage inter-branch transfers. Every committed stock
change posts through the existing append-only inventory ledger and updates its
branch and lot projections in the same transaction.

Phase 10 adds the organization-wide customer master represented by the frozen
`customers` table: individual and business profiles, server-owned customer
numbers, contact and optional loyalty identity, lifecycle status, search,
filtering, exact lookup, and concurrency-safe audited create/update workflows.
Customers have no branch ownership. The frozen schema has no customer-balance,
credit, store-credit, wallet, receivables, loyalty-points, or account-transaction
model, so Phase 10 does not pretend to provide any financial customer account.
Checkout, sales creation, payment mutation, returns, reports, frontend, and
Postman remain excluded.

Phase 11 uses the frozen `pos_registers`, `till_sessions`, and
`till_cash_movements` tables exactly as defined. It adds register configuration,
cashier session lifecycle control, exact drawer reconciliation, branch-aware
authorization, operational employee rechecks, transaction-bound audit, and
concurrency-safe register/session ownership. It reads existing sales and payment
evidence only when closing a till; it does not create or mutate a sale, payment,
customer, inventory balance, lot balance, or inventory-ledger record.

Phase 12 uses the frozen sale and stock tables for OPEN carts, immutable
commercial snapshots, exact pricing/tax arithmetic, and atomic SALE inventory
posting with lot allocation and reconstructed weighted cost.

Phase 13 uses the frozen `payment_methods` and `sale_payments` tables. It
configures global tender methods, records branch sale PAYMENT attempts, supports
split tender, integrates completed funding with till reconciliation, and makes
payment completeness an atomic precondition of future sale completion. It does
not create REFUND rows or implement sales returns.

Phase 14 uses the frozen return, payment, inventory, lot, branch, employee, and
till relationships for dedicated return documents, original-provenance stock
restoration, and return-linked REFUND attempts. It does not change the database
schema or rewrite original sale history.

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
`requirePermission(...)`, including every Phase 6 supplier route and every
Phase 10 customer route. Phase 5C
pricing, Phase 7 purchasing/receiving, and Phase 8/9 inventory operations use
`requireBranchPermission(...)` with the URL branch. Phase 11 register and till
routes use the same branch-aware permission boundary, with an additional
transactional employee check for operational till writes. Phase 12 sales routes use that branch-aware boundary and require the same
transactional operational employee check for every checkout write. Phase 13
payment-method routes are global; sale-payment routes are branch-aware, and all
sale-payment writes repeat the operational employee validation inside their
transaction. Phase 14 return and refund routes are branch-aware and repeat the
same operational actor validation for every mutation. A role name never bypasses authorization.

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
│   │   ├── customer.controller.js
│   │   ├── effectivePrice.controller.js
│   │   ├── employee.controller.js
│   │   ├── goodsReceipt.controller.js
│   │   ├── inventory.controller.js
│   │   ├── inventoryAdjustment.controller.js
│   │   ├── paymentMethod.controller.js
│   │   ├── posRegister.controller.js
│   │   ├── product.controller.js
│   │   ├── productBarcode.controller.js
│   │   ├── productPackage.controller.js
│   │   ├── productVariant.controller.js
│   │   ├── purchaseOrder.controller.js
│   │   ├── role.controller.js
│   │   ├── sale.controller.js
│   │   ├── salePayment.controller.js
│   │   ├── salesReturn.controller.js
│   │   ├── supplier.controller.js
│   │   ├── supplierProduct.controller.js
│   │   ├── supplierProductPackage.controller.js
│   │   ├── stockCount.controller.js
│   │   ├── stockTransfer.controller.js
│   │   ├── taxRate.controller.js
│   │   ├── tillSession.controller.js
│   │   ├── unitOfMeasure.controller.js
│   │   └── userAdmin.controller.js
│   ├── middleware/
│   │   ├── auth.middleware.js
│   │   ├── authorization.middleware.js
│   │   ├── errorHandler.js
│   │   ├── loginRateLimiter.js
│   │   ├── inventoryBranch.middleware.js
│   │   ├── inventoryOperationsBranch.middleware.js
│   │   ├── posBranch.middleware.js
│   │   ├── purchasingBranch.middleware.js
│   │   ├── pricingBranch.middleware.js
│   │   └── salesBranch.middleware.js
│   ├── repositories/
│   │   ├── accessControlSeed.repository.js
│   │   ├── audit.repository.js
│   │   ├── auth.repository.js
│   │   ├── brand.repository.js
│   │   ├── branchPackagePrice.repository.js
│   │   ├── branch.repository.js
│   │   ├── branchVariantPrice.repository.js
│   │   ├── category.repository.js
│   │   ├── customer.repository.js
│   │   ├── effectivePrice.repository.js
│   │   ├── employee.repository.js
│   │   ├── goodsReceipt.repository.js
│   │   ├── inventoryRead.repository.js
│   │   ├── inventoryAdjustment.repository.js
│   │   ├── inventoryMovement.repository.js
│   │   ├── inventoryWrite.repository.js
│   │   ├── paymentMethod.repository.js
│   │   ├── posRegister.repository.js
│   │   ├── product.repository.js
│   │   ├── productBarcode.repository.js
│   │   ├── productCatalog.repository.js
│   │   ├── productPackage.repository.js
│   │   ├── productVariant.repository.js
│   │   ├── purchaseOrder.repository.js
│   │   ├── purchaseReceiptPosting.repository.js
│   │   ├── purchasing.repository.js
│   │   ├── role.repository.js
│   │   ├── sale.repository.js
│   │   ├── saleCompletion.repository.js
│   │   ├── salePayment.repository.js
│   │   ├── saleRefund.repository.js
│   │   ├── salesReturn.repository.js
│   │   ├── supplier.repository.js
│   │   ├── supplierProduct.repository.js
│   │   ├── supplierProductPackage.repository.js
│   │   ├── stockCount.repository.js
│   │   ├── stockTransfer.repository.js
│   │   ├── taxRate.repository.js
│   │   ├── tillSession.repository.js
│   │   ├── unitOfMeasure.repository.js
│   │   └── userAdmin.repository.js
│   ├── routes/
│   │   ├── admin/
│   │   │   ├── branch.routes.js
│   │   │   ├── customer.routes.js
│   │   │   ├── paymentMethod.routes.js
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
│   │   │   ├── inventoryOperations/
│   │   │   │   ├── adjustment.routes.js
│   │   │   │   ├── count.routes.js
│   │   │   │   ├── index.js
│   │   │   │   └── transfer.routes.js
│   │   │   ├── pos/
│   │   │   │   ├── index.js
│   │   │   │   ├── register.routes.js
│   │   │   │   └── till.routes.js
│   │   │   ├── sales/
│   │   │   │   ├── index.js
│   │   │   │   ├── payment.routes.js
│   │   │   └── return.routes.js
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
│   │   ├── customer.service.js
│   │   ├── effectivePrice.service.js
│   │   ├── employee.service.js
│   │   ├── goodsReceipt.service.js
│   │   ├── inventory.service.js
│   │   ├── inventoryAdjustment.service.js
│   │   ├── paymentMethod.service.js
│   │   ├── posRegister.service.js
│   │   ├── product.service.js
│   │   ├── productBarcode.service.js
│   │   ├── productPackage.service.js
│   │   ├── productVariant.service.js
│   │   ├── purchaseOrder.service.js
│   │   ├── role.service.js
│   │   ├── sale.service.js
│   │   ├── salePayment.service.js
│   │   ├── saleRefund.service.js
│   │   ├── salesReturn.service.js
│   │   ├── supplier.service.js
│   │   ├── supplierProduct.service.js
│   │   ├── supplierProductPackage.service.js
│   │   ├── stockCount.service.js
│   │   ├── stockTransfer.service.js
│   │   ├── taxRate.service.js
│   │   ├── tillSession.service.js
│   │   ├── unitOfMeasure.service.js
│   │   └── userAdmin.service.js
│   ├── utils/
│   │   ├── auditContext.js
│   │   ├── barcode.js
│   │   ├── databaseError.js
│   │   ├── exactDecimal.js
│   │   ├── httpError.js
│   │   ├── inventoryQuantity.js
│   │   ├── jwt.js
│   │   ├── password.js
│   │   ├── purchasingDecimal.js
│   │   ├── record.js
│   │   └── salesDecimal.js
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
│   │   ├── customer/
│   │   │   └── customer.validator.js
│   │   ├── inventory/
│   │   │   └── inventory.validator.js
│   │   ├── inventoryOperations/
│   │   │   ├── common.validator.js
│   │   │   ├── inventoryAdjustment.validator.js
│   │   │   ├── stockCount.validator.js
│   │   │   └── stockTransfer.validator.js
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
│   │   ├── payments/
│   │   │   ├── common.validator.js
│   │   │   ├── paymentMethod.validator.js
│   │   │   └── salePayment.validator.js
│   │   ├── pos/
│   │   │   ├── common.validator.js
│   │   │   ├── posRegister.validator.js
│   │   │   └── tillSession.validator.js
│   │   ├── purchasing/
│   │   │   ├── common.validator.js
│   │   │   ├── goodsReceipt.validator.js
│   │   │   └── purchaseOrder.validator.js
│   │   ├── sales/
│   │   │   ├── common.validator.js
│   │   │   ├── sale.validator.js
│   │   │   └── saleItem.validator.js
│   │   ├── returns/
│   │   │   ├── common.validator.js
│   │   │   ├── refund.validator.js
│   │   │   └── salesReturn.validator.js
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
│   ├── customer.integration.test.js
│   ├── inventory.integration.test.js
│   ├── inventoryOperations.integration.test.js
│   ├── pos.integration.test.js
│   ├── pricing.integration.test.js
│   ├── productCatalog.integration.test.js
│   ├── purchasing.integration.test.js
│   ├── payments.integration.test.js
│   ├── returns.integration.test.js
│   ├── sales.integration.test.js
│   └── supplierCatalog.integration.test.js
├── .env
├── .env.example
├── .gitignore
├── package-lock.json
├── package.json
└── README.md
```

`returns.integration.test.js` exercises Phase 14 against MySQL,
`payments.integration.test.js` retains Phase 13 coverage,
`sales.integration.test.js` retains Phase 12 coverage,
`pos.integration.test.js` retains Phase 11 coverage,
`customer.integration.test.js` retains Phase 10 coverage,
`inventoryOperations.integration.test.js` retains Phase 9 coverage,
`inventory.integration.test.js` retains Phase 8 coverage,
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

# Seed/reconcile canonical Phase 4-14 access configuration
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

The idempotent catalog contains 44 canonical Phase 4-14 permissions:

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
| `inventory_adjustments.read` | View branch adjustment documents and ledger evidence in Phase 9 |
| `inventory_adjustments.manage` | Create, approve, post, and cancel branch adjustments in Phase 9 |
| `stock_counts.read` | View physical counts, variances, and reconciliation evidence in Phase 9 |
| `stock_counts.manage` | Configure, conduct, complete, post, and cancel physical counts in Phase 9 |
| `stock_transfers.read` | View transfers involving an authorized branch in Phase 9 |
| `stock_transfers.manage` | Create, progress, dispatch, receive, and cancel stock transfers in Phase 9 |
| `customers.read` | View and search the global customer master in Phase 10 |
| `customers.manage` | Create and update global customer master records in Phase 10 |
| `pos_registers.read` | View branch POS-register configuration in Phase 11 |
| `pos_registers.manage` | Create and update branch POS-register configuration in Phase 11 |
| `till_sessions.read` | View branch till sessions and cash movements in Phase 11 |
| `till_sessions.manage` | Open and operate branch till sessions and record cash movements in Phase 11 |
| `sales.read` | View branch sales and persisted checkout details in Phase 12 |
| `sales.manage` | Operate carts and atomically complete or cancel branch sales in Phase 12 |
| `payment_methods.read` | View global payment-method configuration in Phase 13 |
| `payment_methods.manage` | Create and update global payment-method configuration in Phase 13 |
| `payments.read` | View branch sale-payment attempts and funding summaries in Phase 13 |
| `payments.manage` | Create and transition branch sale-payment attempts in Phase 13 |
| `returns.read` | View branch sales returns, returned items, inventory linkage, and refunds in Phase 14 |
| `returns.manage` | Create, approve, post, cancel, and settle branch sales returns in Phase 14 |

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

Phase 9 permissions are deliberately separate from `inventory.*`:
`inventory_adjustments.read/manage`, `stock_counts.read/manage`, and
`stock_transfers.read/manage` authorize only their matching resources. A global
grant may satisfy permission scope at any branch; a branch-scoped grant only at
that exact branch. The separate employee-assignment gate still applies to every
employee-linked user for either kind of grant. All writes additionally require
an active linked employee with a current assignment and revalidate that actor
inside the mutation transaction; unlinked system accounts remain read-only.
Transfer source actions use the source URL branch, while receipt uses the
destination URL branch. Transfer reads expose a document only when the URL
branch is its source or destination.

Phase 10 uses the global `customers.read` permission for its two GET routes and
the global `customers.manage` permission for its two mutations. Manage does not
imply read, read does not imply manage, a branch-scoped grant cannot satisfy
either global route, and unrelated permission families grant no customer
access. Customer administration is not a stock-moving operational workflow, so
an authorized unlinked system account may use it and no employee branch
assignment is required. `SYSTEM_ADMIN` receives these permissions only through
the same canonical role mappings as every other permission; there is no role
name bypass.

Phase 11 deliberately separates register configuration from till operation.
`pos_registers.read` and `pos_registers.manage` protect register views and
configuration; `till_sessions.read` protects session/movement views, while
`till_sessions.manage` protects opening, lifecycle transitions, closing,
cancelling, and cash-movement creation. A global grant can satisfy permission
scope for any branch and a branch grant only for its exact URL branch. The
separate linked-employee assignment gate still applies to every employee-linked
user for either kind of grant. Register configuration may be performed by an
authorized unlinked system account. Till writes are operational and always
require a linked `ACTIVE` employee with a current URL-branch assignment,
rechecked inside the mutation transaction. An unlinked `SYSTEM_ADMIN` may read
with the relevant permission but cannot perform those operational writes.

Phase 12 similarly separates `sales.read` from `sales.manage`. A global grant
may satisfy permission scope for any branch and a branch-scoped grant only for
its exact URL branch. The independent employee-assignment gate applies to every
employee-linked user for either kind of grant. Authorized unlinked system users
may read sales, but every sale write is operational and revalidates an active
linked employee with a current URL-branch assignment inside the transaction.
Neither permission implies the other or any inventory, till, or payment
permission.

Phase 13 payment-method configuration uses global `payment_methods.read` and
`payment_methods.manage` grants; a branch-scoped grant cannot satisfy those
routes. Sale payments use branch-aware `payments.read` and `payments.manage`.
A global payment grant can satisfy permission scope at any branch and a branch
grant only at its exact URL branch. The separate linked-employee assignment gate
still applies to either qualifying grant. Authorized unlinked accounts may read
sale payments, but every payment write additionally requires an `ACTIVE` linked
employee with a current URL-branch assignment and rechecks that actor inside the
transaction. Payment permissions do not imply sales permissions, and sale
completion remains protected only by `sales.manage`.

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
| sales | `search`, `status`, `customerId`, `cashierEmployeeId`, `posRegisterId`, `tillSessionId`, `from`, `to` |
| payment methods | `search`, `methodType`, `isActive`, `requiresReference` |
| sale payments | `status`, `paymentMethodId`, `paymentType`, `from`, `to` |
| customers | `search`, `customerType`, `status`, `loyaltyNumber`, `email`, `phone` |

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

There is still no endpoint to set on-hand quantity directly, to create/edit/delete
generic ledger rows, or to change global lot status. Phase 9 stock changes are
available only through the controlled business-document workflows below.

## Phase 9 stock adjustments, counts, and transfers

Phase 9 exposes exactly 38 routes below
`/api/admin/branches/:branchId`. There are no document-header DELETE routes and
no aliases.

### Inventory-adjustment routes (11)

| Method and suffix | Permission | Purpose |
| --- | --- | --- |
| `GET /inventory-adjustments` | `inventory_adjustments.read` | Paginated branch adjustments |
| `POST /inventory-adjustments` | `inventory_adjustments.manage` | Create a `DRAFT` adjustment |
| `GET /inventory-adjustments/:inventoryAdjustmentId` | `inventory_adjustments.read` | Header, items, and lot evidence |
| `PATCH /inventory-adjustments/:inventoryAdjustmentId` | `inventory_adjustments.manage` | Edit a draft header |
| `POST /inventory-adjustments/:inventoryAdjustmentId/items` | `inventory_adjustments.manage` | Add a signed movement line |
| `PATCH /inventory-adjustments/:inventoryAdjustmentId/items/:inventoryAdjustmentItemId` | `inventory_adjustments.manage` | Edit a draft line/allocation |
| `DELETE /inventory-adjustments/:inventoryAdjustmentId/items/:inventoryAdjustmentItemId` | `inventory_adjustments.manage` | Remove a draft line |
| `POST /inventory-adjustments/:inventoryAdjustmentId/approve` | `inventory_adjustments.manage` | `DRAFT -> APPROVED` |
| `POST /inventory-adjustments/:inventoryAdjustmentId/post` | `inventory_adjustments.manage` | Atomically post one `ADJUSTMENT` ledger event |
| `POST /inventory-adjustments/:inventoryAdjustmentId/cancel` | `inventory_adjustments.manage` | Cancel an eligible unposted document |
| `GET /inventory-adjustments/:inventoryAdjustmentId/ledger` | `inventory_adjustments.read` | Linked ledger summary |

Create accepts only `adjustmentType` and a required `reason`. Supported types
come directly from the frozen schema: `COUNT_CORRECTION`, `DAMAGE`, `EXPIRY`,
`THEFT`, `SUPPLIER_RETURN`, and `OTHER`. A line accepts immutable
`productVariantId`, signed nonzero `quantityChange`, nullable `unitCost`, an
optional reason, and optional existing-lot allocations. Positive means stock-in;
negative means stock-out. Approval requires at least one valid line and a
different employee from the creator, but changes no stock. Posting changes
`APPROVED -> POSTED`, creates exactly one linked `ADJUSTMENT` transaction, and
updates balances and lot balances atomically. Posted documents are immutable;
a later correction uses another append-only adjustment.

### Physical stock-count routes (15)

| Method and suffix | Permission | Purpose |
| --- | --- | --- |
| `GET /stock-counts` | `stock_counts.read` | Paginated branch counts |
| `POST /stock-counts` | `stock_counts.manage` | Create a count definition |
| `GET /stock-counts/:stockCountId` | `stock_counts.read` | Count, participants, items, and reconciliation |
| `PATCH /stock-counts/:stockCountId` | `stock_counts.manage` | Edit a draft count header |
| `POST /stock-counts/:stockCountId/participants` | `stock_counts.manage` | Add an active assigned employee |
| `DELETE /stock-counts/:stockCountId/participants/:employeeId` | `stock_counts.manage` | Remove a draft participant |
| `POST /stock-counts/:stockCountId/items` | `stock_counts.manage` | Add a variant/lot count scope |
| `PATCH /stock-counts/:stockCountId/items/:stockCountItemId` | `stock_counts.manage` | Enter counted quantity and variance reason |
| `DELETE /stock-counts/:stockCountId/items/:stockCountItemId` | `stock_counts.manage` | Remove a draft count item |
| `POST /stock-counts/:stockCountId/start` | `stock_counts.manage` | Capture locked authoritative snapshots |
| `POST /stock-counts/:stockCountId/complete` | `stock_counts.manage` | Freeze a fully counted session |
| `POST /stock-counts/:stockCountId/post` | `stock_counts.manage` | Reconcile through one count correction |
| `POST /stock-counts/:stockCountId/cancel` | `stock_counts.manage` | Cancel an eligible unposted count |
| `GET /stock-counts/:stockCountId/variance` | `stock_counts.read` | Read exact snapshot/count/variance data |
| `GET /stock-counts/:stockCountId/ledger` | `stock_counts.read` | Read linked adjustment/ledger evidence |

Counts use `DRAFT -> IN_PROGRESS -> COUNTED -> POSTED` or an allowed pre-post
`CANCELLED` transition. `start` requires at least one item and captures balances
under row locks; it does not move stock. `countedQuantity` is an absolute
physical amount. MySQL's stored generated column represents exact
`counted - system` variance, and a nonzero variance requires a reason.
`complete` requires every item to be counted and still does not move stock.

The frozen schema has no separate approve endpoint but requires approval fields
on `POSTED`. Consequently, `post` is the approval/finalization boundary: its
actor must differ from the creator and is stored as both approver and poster.
Nonzero variances create and fully post one linked `COUNT_CORRECTION` adjustment;
that adjustment creates the single `ADJUSTMENT` ledger effect. An all-zero count
is finalized without a meaningless zero ledger row or adjustment link.

Lot scopes follow the schema rather than inventing extra tables. `NONE` uses the
branch-level null-lot scope. `REQUIRED` needs complete per-lot scope for every
positive stocked lot, and its total must remain fully lot-backed. `OPTIONAL` may
combine explicit lot scopes with a null-lot item representing the exact
untracked remainder. At post, every relevant current scope is compared with its
start snapshot. Any intervening receipt, adjustment, or transfer makes the count
stale and returns `409`; Phase 9 never applies a stale variance over legitimate
stock activity. An offsetting, zero-total lot reallocation is rejected because
the frozen adjustment schema forbids zero adjustment lines.

### Inter-branch transfer routes (12)

| Method and suffix | Permission | Purpose |
| --- | --- | --- |
| `GET /stock-transfers` | `stock_transfers.read` | Transfers involving the URL branch |
| `POST /stock-transfers` | `stock_transfers.manage` | Create a source-branch draft |
| `GET /stock-transfers/:stockTransferId` | `stock_transfers.read` | Full document, lot, and dual-ledger evidence |
| `PATCH /stock-transfers/:stockTransferId` | `stock_transfers.manage` | Edit destination/notes while draft |
| `POST /stock-transfers/:stockTransferId/items` | `stock_transfers.manage` | Add a requested variant and planned lots |
| `PATCH /stock-transfers/:stockTransferId/items/:stockTransferItemId` | `stock_transfers.manage` | Edit a draft line |
| `DELETE /stock-transfers/:stockTransferId/items/:stockTransferItemId` | `stock_transfers.manage` | Remove a draft line |
| `POST /stock-transfers/:stockTransferId/request` | `stock_transfers.manage` | `DRAFT -> REQUESTED` at source |
| `POST /stock-transfers/:stockTransferId/approve` | `stock_transfers.manage` | `REQUESTED -> APPROVED` at source |
| `POST /stock-transfers/:stockTransferId/dispatch` | `stock_transfers.manage` | Source stock-out and `TRANSFER_OUT` |
| `POST /stock-transfers/:stockTransferId/receive` | `stock_transfers.manage` | Destination stock-in and `TRANSFER_IN` |
| `POST /stock-transfers/:stockTransferId/cancel` | `stock_transfers.manage` | Cancel before dispatch at source |

Create derives `sourceBranchId` from the URL and accepts only a different
`destinationBranchId` plus optional notes. Draft lines preserve requested,
dispatched, and received quantities separately. Request and approval freeze
content but move no stock. Dispatch accepts every line's explicit
`quantityDispatched` and lot quantities, allows a quantity not exceeding the
request, subtracts source stock, and links exactly one negative `TRANSFER_OUT`
transaction. Receipt must use the destination URL branch, accepts every line's
explicit quantity not exceeding dispatch, increments destination balances, and
links exactly one positive `TRANSFER_IN` transaction. A short receipt remains a
visible discrepancy; it is not silently returned or adjusted. Source stock is
absent from on-hand inventory while in transit, and there is no fake transit
branch.

Lot-tracked transfers preserve the same global `inventory_lot_id` at both
branches. Dispatch requires sufficient source lot stock and rejects expired,
recalled, closed, blocked, or quarantined outbound lots. Receipt never turns an
unsafe lot into available stock: an existing stricter destination state is
preserved, a safe active unexpired lot may become available, and an expired or
globally unsafe identity remains blocked/rejected. `IN_TRANSIT` and `RECEIVED`
documents cannot be cancelled because dispatch history is append-only.

### Exact arithmetic, transactions, and concurrency

All IDs cross the API as decimal strings and all quantities/costs remain exact
decimal strings. Validators reject JSON numbers, exponent notation, overflow,
excess scale, zero movements, and fractional base quantities for nonfractional
variants. Internal quantity arithmetic uses scaled `BigInt`; JavaScript
floating point is never used for inventory decisions. List endpoints use fixed
filters, deterministic ordering, page 1/limit 20 defaults, and a maximum limit
of 100.

Every stock posting runs on one borrowed connection and either commits its
business document, ledger, projections, and audit together or rolls everything
back. The cross-phase lock family is: operational employee; participating
branches in ascending ID order; assignment at the operation branch; products,
variants, and packages in sorted ID order; the document and lines; global lots;
branch inventory; then branch lot inventory. This matches receipt/settings/lot
state ordering and serializes adjustment, count, transfer, receipt, reorder, and
lot-status races. Locked current balances prevent negatives and duplicate
POST/DISPATCH/RECEIVE requests cannot create a second stock effect.

The branch projection is a fast current total; the ledger remains historical
authority. A positive movement may create a missing branch projection without
overwriting reorder settings. A negative movement against a missing/insufficient
projection is `409`. Required-lot totals are checked before commit. Ledger signs
are preserved: adjustment lines retain their sign, transfer-out lines and lot
allocations are negative, and transfer-in lines and allocations are positive.
Historical unit cost is explicit or `NULL`; selling price and current supplier
cost are never substituted.

Expected request failures use `400` for malformed input, `401` for missing or
invalid authentication, `403` for permission/password/operational-actor denial,
`404` for absence or wrong branch ownership, and `409` for lifecycle,
segregation, stock, lot-safety, stale-snapshot, duplicate-action, or concurrency
conflicts. Responses never expose SQL, constraints, credentials, or stacks.

### Phase 9 audit vocabulary

Successful mutations write an audit row in their own transaction; GETs,
no-op PATCHes, rejected writes, and rolled-back writes do not. The exact Phase 9
actions are:

- adjustments: `INVENTORY_ADJUSTMENT_CREATED`, `INVENTORY_ADJUSTMENT_UPDATED`,
  `INVENTORY_ADJUSTMENT_ITEM_CREATED`, `INVENTORY_ADJUSTMENT_ITEM_UPDATED`,
  `INVENTORY_ADJUSTMENT_ITEM_DELETED`, `INVENTORY_ADJUSTMENT_APPROVED`,
  `INVENTORY_ADJUSTMENT_POSTED`, `INVENTORY_ADJUSTMENT_CANCELLED`;
- counts: `STOCK_COUNT_CREATED`, `STOCK_COUNT_UPDATED`,
  `STOCK_COUNT_PARTICIPANT_ADDED`, `STOCK_COUNT_PARTICIPANT_REMOVED`,
  `STOCK_COUNT_ITEM_CREATED`, `STOCK_COUNT_ITEM_UPDATED`,
  `STOCK_COUNT_ITEM_DELETED`, `STOCK_COUNT_STARTED`,
  `STOCK_COUNT_COMPLETED`, `STOCK_COUNT_POSTED`, `STOCK_COUNT_CANCELLED`; and
- transfers: `STOCK_TRANSFER_CREATED`, `STOCK_TRANSFER_UPDATED`,
  `STOCK_TRANSFER_ITEM_CREATED`, `STOCK_TRANSFER_ITEM_UPDATED`,
  `STOCK_TRANSFER_ITEM_DELETED`, `STOCK_TRANSFER_REQUESTED`,
  `STOCK_TRANSFER_APPROVED`, `STOCK_TRANSFER_DISPATCHED`,
  `STOCK_TRANSFER_RECEIVED`, `STOCK_TRANSFER_CANCELLED`.

Transfer audit branch context is source for create/edit/request/approve/dispatch/
cancel and destination for receipt. Safe snapshots retain both branch IDs and
request context without secrets, tokens, SQL, or credentials.

## Phase 10 customer master

Phase 10 exposes exactly four global administration routes. They are mounted at
`/api/admin/customers`, not below a branch, and inherit authentication and the
required-password-change gate from `/api/admin`.

| # | Method and path | Required permission | Purpose |
| ---: | --- | --- | --- |
| 1 | `GET /api/admin/customers` | `customers.read` | Paginated customer search and fixed filters |
| 2 | `POST /api/admin/customers` | `customers.manage` | Create an individual or business customer |
| 3 | `GET /api/admin/customers/:customerId` | `customers.read` | Exact customer-master detail |
| 4 | `PATCH /api/admin/customers/:customerId` | `customers.manage` | Partially update profile or lifecycle status |

There is no customer DELETE/restore route, loyalty alias, branch-scoped customer
route, sales-history route, or account/balance/credit/points/transactions route.
Customer master data is global; no `branch_id` is invented and employee branch
assignment is not an access gate. A future sale may reference a customer, but
historical sale rows are neither read nor rewritten by these routes.

### Customer representation and validation

The API returns `customerId`, `customerNumber`, `customerType`, `firstName`,
`lastName`, `businessName`, `email`, `phone`, `loyaltyNumber`, `dateOfBirth`,
`status`, `createdAt`, and `updatedAt`. IDs remain decimal strings and nullable
database values are returned as `null`. Client JSON uses camelCase and never
exposes raw database names.

Create requires an explicit `customerType`. An `INDIVIDUAL` final state requires
meaningful `firstName` and `lastName`; a `BUSINESS` final state requires a
meaningful `businessName`. The other type's supported name fields are preserved
when supplied instead of being erased. Optional strings accept either a trimmed,
nonblank value within the frozen column length or `null`. Email uses the shared
application validator, phone keeps the client's meaningful trimmed form, and
neither email nor phone is treated as unique because the schema does not make it
unique. `dateOfBirth` is a strict valid `YYYY-MM-DD` calendar date; Phase 10 does
not invent an age or future-date rule.

`customerNumber` is immutable and server-owned. Creation uses a collision-
resistant UUID-derived value that fits its 32-character column, never a row
count, maximum ID, or process-local counter. Only a generated-number collision
is retried within a small bound. Clients may not submit `customerNumber` or any
server-owned, branch, financial-account, credit, balance, points, or audit field.

`loyaltyNumber` is an optional string, so leading zeroes are preserved. Non-null
values are unique under the database's `utf8mb4_0900_ai_ci` collation; that
means comparisons follow MySQL's case/accent-insensitive collation semantics
rather than an invented case-sensitive API rule. Multiple `NULL` loyalty values
remain valid. A duplicate returns `409` without exposing MySQL diagnostics.

The only customer types are `INDIVIDUAL` and `BUSINESS`; the only statuses are
`ACTIVE`, `INACTIVE`, and `BLOCKED`. Status is lifecycle state, not deletion,
financial standing, or a Phase 10 sales rule. PATCH locks the current row, merges
only supplied fields with that locked state, validates the resulting type/name
invariant, and updates only effective changes. Type transitions are allowed only
when the target-type required names exist. An empty PATCH is `400`; an effective
no-op returns the current row without touching `updated_at` or writing an audit.

The customer list defaults to page 1/limit 20, caps limit at 100, and orders by
`customer_number` then `customer_id`. `search` covers customer number, individual
names, business name, email, phone, and loyalty number. `customerType` and
`status` are enum filters; `loyaltyNumber`, `email`, and `phone` are optional
exact filters. Query keys and ORDER BY columns are fixed in code, and all values
are parameterized. Count and page reads are separate ordinary reads, so a
concurrent commit between them may change pagination totals; Phase 10 does not
lock the customer catalog merely to create a list snapshot.

### Customer transactions, concurrency, and audit

Create and PATCH each use one borrowed connection and one transaction. Create
inserts, re-reads, and audits before commit. PATCH uses `SELECT ... FOR UPDATE`,
merges against the locked row, revalidates the final state, updates, re-reads,
and audits before commit. Consequently, concurrent different-field patches do
not silently overwrite one another, competing type/name transitions can commit
only valid final states, and the unique loyalty constraint makes exactly one of
two same-loyalty writes succeed. Expected duplicate conflicts are translated to
safe `409` responses and every failed transaction rolls back.

The only Phase 10 audit actions are `CUSTOMER_CREATED` and `CUSTOMER_UPDATED`.
Their safe before/after snapshots contain customer master fields and normal
request context; they never contain tokens, credentials, or authentication
secrets. GETs, failed writes, duplicate conflicts, no-op PATCHes, and rolled-back
writes create no customer audit event. The authenticated user is always kept as
the actor and an absent linked employee remains `NULL`, never a fabricated ID.

The frozen `sales.customer_id` relationship is optional and restrictive on
delete. Phase 10 deliberately has no physical customer deletion, leaves any
historical sale reference unchanged when a customer is patched, and does not
create a fake permanent walk-in customer: future anonymous sales may continue
to use `sales.customer_id = NULL`.

This phase is a customer profile and loyalty-identity foundation only. The
frozen schema has no customer balance, debt, credit limit, receivables, store
credit, wallet, prepaid balance, loyalty-points balance, rewards transaction, or
account-statement model. None is simulated in JSON, audit data, or derived from
sales. Phase 10 itself did not implement POS registers or till sessions; Phase
11 supplies those two foundations, while checkout, sale/payment mutation,
returns, and sale-driven stock movement remain later-phase work.

## Phase 11 POS registers and till sessions

Phase 11 exposes exactly 13 branch-scoped routes beneath
`/api/admin/branches/:branchId`. There are no global register/session aliases,
generic session PATCH routes, DELETE routes, reopen/force-close shortcuts,
checkout routes, or sale/payment mutation routes.

| # | Method and path | Required permission | Purpose |
| ---: | --- | --- | --- |
| 1 | `GET /api/admin/branches/:branchId/pos-registers` | `pos_registers.read` | Paginated branch-register list |
| 2 | `POST /api/admin/branches/:branchId/pos-registers` | `pos_registers.manage` | Create a branch register |
| 3 | `GET /api/admin/branches/:branchId/pos-registers/:posRegisterId` | `pos_registers.read` | Exact branch-owned register detail |
| 4 | `PATCH /api/admin/branches/:branchId/pos-registers/:posRegisterId` | `pos_registers.manage` | Update register configuration or status |
| 5 | `GET /api/admin/branches/:branchId/till-sessions` | `till_sessions.read` | Paginated branch-session list |
| 6 | `POST /api/admin/branches/:branchId/pos-registers/:posRegisterId/till-sessions` | `till_sessions.manage` | Open a till session on the register |
| 7 | `GET /api/admin/branches/:branchId/till-sessions/:tillSessionId` | `till_sessions.read` | Exact branch-owned session detail |
| 8 | `POST /api/admin/branches/:branchId/till-sessions/:tillSessionId/suspend` | `till_sessions.manage` | Suspend an open drawer |
| 9 | `POST /api/admin/branches/:branchId/till-sessions/:tillSessionId/resume` | `till_sessions.manage` | Resume a suspended drawer |
| 10 | `POST /api/admin/branches/:branchId/till-sessions/:tillSessionId/close` | `till_sessions.manage` | Reconcile and close the drawer |
| 11 | `POST /api/admin/branches/:branchId/till-sessions/:tillSessionId/cancel` | `till_sessions.manage` | Cancel an unused active session |
| 12 | `GET /api/admin/branches/:branchId/till-sessions/:tillSessionId/cash-movements` | `till_sessions.read` | Paginated append-only drawer-movement history |
| 13 | `POST /api/admin/branches/:branchId/till-sessions/:tillSessionId/cash-movements` | `till_sessions.manage` | Record a drawer cash movement |

All `BIGINT UNSIGNED` identifiers remain decimal strings, including the maximum
value `18446744073709551615`. Malformed IDs are `400`; a syntactically valid but
missing or cross-branch resource is `404`. Register lists support `search`,
`status`, `page`, and `limit`. Session lists support status/register/cashier/
opener/closer and opened-date filters. Movement lists support movement type,
recording employee, and occurrence-date filters. Every list is bounded to a
maximum page size of 100 and has deterministic ID-tiebroken ordering.

### Frozen register and till semantics

The only register statuses are `ACTIVE`, `INACTIVE`, and `MAINTENANCE`. Register
code is unique within a branch, while a non-null terminal identifier is unique
globally. A register may open a till only while `ACTIVE`. PATCH locks its target,
updates only effective changes, and produces neither a timestamp change nor an
audit for a no-op. A register with an `OPEN` or `SUSPENDED` session cannot be
moved away from `ACTIVE`.

The only till statuses are `OPEN`, `SUSPENDED`, `CLOSED`, and `CANCELLED`.
The frozen generated `active_register_guard` equals `pos_register_id` only for
`OPEN`/`SUSPENDED` rows; its unique key permits at most one active session per
register. Likewise, `active_cashier_guard` equals `cashier_employee_id` only for
those active states and permits at most one active session per cashier. Both
guards become `NULL` in terminal states. They are database backstops in addition
to transactional application checks and are never exposed in API responses.

Opening accepts a cashier ID, a non-negative `openingCashAmount`, and optional
notes. The server generates the session number and timestamp, copies
`branches.currency_code`, and keeps every close field null. Cashier identity is
distinct from operational actor identity: `cashier_employee_id` identifies the
selected employee using the drawer, `opened_by_employee_id` records the
authenticated actor who opened it, and `closed_by_employee_id` records the
authenticated actor who closed or cancelled it. Opener, closer, movement actor,
and cashier need not be the same employee, but each operational actor and the
selected opening cashier must independently be active and currently assigned
to the URL branch.

The allowed lifecycle is `OPEN -> SUSPENDED`, `SUSPENDED -> OPEN`, and either
active state to `CLOSED` or `CANCELLED`. Suspend/resume use empty bodies and do
not alter immutable session identity, opening cash, currency, notes, or closing
fields. A suspended session still reserves both register and cashier but pauses
drawer activity, so it cannot accept a cash movement. `CLOSED` and `CANCELLED`
are terminal and cannot be resumed, closed/cancelled again, or receive a new
movement.

All Phase 11 money uses `DECIMAL(19,2)` and API decimal strings. Validation
rejects JSON numbers, scientific notation, negative values where forbidden,
excess scale/precision, and malformed values. Business arithmetic uses scaled
`BigInt`, never binary floating point. Returned money is normalized to exactly
two decimal places, while a closing difference may be negative.

Cash movements use exactly `CASH_IN`, `CASH_OUT`, `CASH_DROP`, or `PAYOUT`.
Stored amounts are always strictly positive magnitudes: `CASH_IN` increases the
drawer expectation and the other three decrease it. The server owns recording
employee and occurrence time. A non-null reference number is unique only within
its session; multiple null references and the same reference in another session
are valid. Movement rows are append-only operational evidence, so there is no
PATCH or DELETE route.

### Closing, cancellation, and persisted evidence

Close is allowed directly from `OPEN` or `SUSPENDED` and accepts only the
non-negative physical count `actualClosingCashAmount`. Expected cash is computed
exactly from persisted evidence:

```text
expected closing cash
  = opening cash
  + completed CASH payments for sales linked to this till
  - completed CASH refunds for sales linked to this till
  + CASH_IN
  - CASH_OUT
  - CASH_DROP
  - PAYOUT

cash difference = actual closing cash - expected closing cash
```

Only `sale_payments.status = 'COMPLETED'` rows whose payment method type is
`CASH` participate; no sale-status filter is invented. Both ordinary and
return-linked completed cash refunds reduce expected cash. Every included
payment currency must equal the session currency. A mismatch, arithmetic
overflow, or negative expected result is `409`; no currency conversion or
zero-clamping is attempted. Successful close atomically stores expected,
actual, signed difference, closer, close timestamp, and `CLOSED` status without
rewriting any sale or payment.

Cancellation represents an unused aborted drawer. It is allowed from `OPEN` or
`SUSPENDED` only when the session has no cash movement and no sale reference.
It sets the closer/time and `CANCELLED` status while leaving expected, actual,
and difference null. Any movement or sale requires normal reconciliation and
causes cancellation to return `409`.

### Authorization, locking, concurrency, and audit

Permission scope and employee access remain separate. A global Phase 11 grant
may satisfy its permission for any branch; a branch grant only for the matching
URL branch. A linked user also needs a current active assignment for either
grant. Register administration is configuration, so an authorized unlinked
system user may perform it. Open, suspend, resume, close, cancel, and movement
creation are operational writes: they require a linked `ACTIVE` employee with a
current URL-branch assignment and transactionally recheck that identity. Reads
remain available to an authorized unlinked system user. Permission success
never reveals a resource owned by another branch.

The deterministic Phase 11 lock order is: employee IDs in unsigned-BIGINT-
sorted order, branch, current assignment rows, POS register, till session, till
cash movements, session-linked sales, sale payments, then payment methods.
Opening locks both actor/cashier identities and the register before deciding;
same-register and same-cashier races therefore have one winner, with the frozen
unique guards as final backstops. Register-status change and opening share the
register lock. Lifecycle, cancellation, close, and movement creation lock the
session before deciding, so duplicate close, close-versus-movement, and
cancel-versus-movement races cannot commit contradictory final states.

Phase 11 writes exactly these transaction-bound audit actions:
`POS_REGISTER_CREATED`, `POS_REGISTER_UPDATED`, `TILL_SESSION_OPENED`,
`TILL_SESSION_SUSPENDED`, `TILL_SESSION_RESUMED`, `TILL_SESSION_CLOSED`,
`TILL_SESSION_CANCELLED`, and `TILL_CASH_MOVEMENT_CREATED`. GETs, failed writes,
rolled-back races, and no-op register PATCHes write no Phase 11 audit event.
Snapshots contain safe business state and request context, never guard columns,
passwords, tokens, credentials, raw SQL, or database diagnostics.

Phase 11 creates or mutates no production sale, sale item, payment, customer,
inventory, lot, or stock-ledger row. Future Phase 12 sale writers and Phase 13
payment writers must join the same lock discipline: lock and revalidate the
target till before committing, require its branch/register/cashier identity to
match the sale evidence, and require status `OPEN` (not merely
`SUSPENDED`). They must serialize till -> sales -> payments consistently so a
close cannot omit a concurrently committed transaction. Phase 11 documents
that contract but does not implement checkout or payment mutation.

### Phase 11 final validation

The definitive focused Phase 11 run discovered 15 tests: 15 passed, 0 failed,
0 skipped, and 0 cancelled in 7,003.119072 ms. The definitive full Phase 2-11
regression discovered 141 tests: 141 passed, 0 failed, 0 skipped, and 0
cancelled in 66,189.57768 ms. Static JavaScript syntax, application-import, and
Git whitespace checks passed, and static route inspection confirmed exactly 13
Phase 11 routes.

Two consecutive access-control seed runs each reported 36 canonical permissions
assigned to `SYSTEM_ADMIN`. Final read-only verification confirmed the active
`supermarket_management` database on MySQL 8.0.46 with 54 base tables, 36
canonical permissions, one `SYSTEM_ADMIN` role, all 36 canonical mappings, and
zero remaining `TEST_P11_*` fixtures. The frozen schema documents retained
their approved hashes, package files remained unchanged, and the real `.env`
remained ignored and untracked.

At the Phase 11 checkpoint, Phase 12 — Sales / Checkout Engine had not yet
been started.

## Phase 12 sales and checkout engine

Phase 12 uses the frozen `sales`, `sale_items`, and `sale_item_lots` tables and
the existing branch inventory, lot projection, and append-only inventory ledger.
It added exactly two canonical permissions, `sales.read` and `sales.manage`,
for the then-current total of 38. At the Phase 12 checkpoint no schema, package
dependency, payment, refund, return, void, frontend, or Phase 13 implementation
was part of that phase.

### Exact routes

All nine routes are branch-scoped below `/api/admin/branches/:branchId`:

| # | Method and path | Permission | Purpose |
| ---: | --- | --- | --- |
| 1 | `GET /sales` | `sales.read` | List branch sales using stable pagination and filters |
| 2 | `POST /till-sessions/:tillSessionId/sales` | `sales.manage` | Open a cart on an OPEN till |
| 3 | `GET /sales/:saleId` | `sales.read` | Read a sale, ordered items, and final lot allocations |
| 4 | `PATCH /sales/:saleId` | `sales.manage` | Change an OPEN sale's customer or notes |
| 5 | `POST /sales/:saleId/items` | `sales.manage` | Add a server-priced item snapshot |
| 6 | `PATCH /sales/:saleId/items/:saleItemId` | `sales.manage` | Change quantity or discount on an OPEN line |
| 7 | `DELETE /sales/:saleId/items/:saleItemId` | `sales.manage` | Remove an OPEN line without renumbering others |
| 8 | `POST /sales/:saleId/complete` | `sales.manage` | Atomically post stock and complete the sale |
| 9 | `POST /sales/:saleId/cancel` | `sales.manage` | Cancel an OPEN sale without a stock movement |

The list permits exactly `search`, `status`, `customerId`,
`cashierEmployeeId`, `posRegisterId`, `tillSessionId`, `from`, `to`, `page`,
and `limit`. Dates filter `sales.created_at`, so OPEN and CANCELLED carts remain
discoverable. Ordering is `created_at DESC, sale_id DESC`. There is no sale
DELETE, void, payment, tender, refund, return, reopen, restore, checkout alias,
barcode-lookup alias, or generic inventory mutation route.

### Authorization and operational identity

A global permission grant satisfies permission scope at any branch; a
branch-scoped grant satisfies it only at its exact URL branch. The separate
employee-assignment gate still applies whenever a user is employee-linked,
regardless of which grant supplied the permission. Reads require no operational
employee identity, so an authorized unlinked system account may list and inspect
sales. Every write additionally revalidates, inside its transaction, that the
actor is linked to an `ACTIVE` employee with a current assignment to the URL
branch. Consequently an unlinked `SYSTEM_ADMIN` may read but may not operate a
checkout.

The sale cashier is copied from the locked till session and need not equal the
authenticated actor. Sale creation and completion also revalidate that cashier
as `ACTIVE` and currently assigned. New sales, line changes, and completion
require an `OPEN` till. Cancellation is the deliberate exception: an OPEN sale
may be cancelled after its till is `SUSPENDED` or `CLOSED`, but not after the
till itself is `CANCELLED`.

### Cart identity, pricing, tax, and exact arithmetic

Sale numbers are collision-resistant, bounded-retry server values. New sales
copy branch, register, till, cashier, and currency from the locked till and
start with zero totals and no stock transaction. An optional customer must be
`ACTIVE` when selected and is rechecked at completion. Multiple OPEN sales may
belong to one OPEN till.

A new line accepts exactly one identity mode: an exact case-sensitive barcode,
or a variant plus an optional package ID. A variant-level barcode or null
explicit package resolves the variant's single active base package. The current
product, variant, and package must be active, the package must belong to the
variant and be sellable, and package quantity follows its unit's fractional
rule. The stored base quantity is the package quantity multiplied by the exact
six-place conversion and rounded HALF-UP to three places.

Package price precedence is unchanged from Phase 5C: an active due branch
package price, then package default, then the effective variant price multiplied
by package conversion. Effective variant price is an active due branch variant
price or the variant default. Each line resolution uses one captured database
UTC timestamp. Product tax comes from `products.tax_rate_id`; no tax means
`0.0000`. Inclusive shelf prices are converted to a four-place tax-exclusive
unit price with exact scaled-`BigInt` HALF-UP arithmetic.

For each line, gross is `ROUND_HALF_UP(quantity * unit_price, 2)`, discount may
not exceed gross, tax is `ROUND_HALF_UP((gross - discount) * rate / 100, 2)`,
and line total is gross minus discount plus tax. Header subtotal, discount, tax,
and total are rebuilt from persisted line snapshots after every effective line
change. IDs and decimals remain strings at the API boundary; business
arithmetic never uses binary floating point.

Product description, SKU, package name, barcode identity, conversion, unit
price, and tax rate are commercial snapshots at line creation. Quantity and
discount PATCHes recalculate derived amounts but never reprice. A no-op sale or
line PATCH returns the current representation without changing timestamps or
writing audit evidence.

### Atomic completion, weighted cost, and lots

Completion is the only Phase 12 stock-changing transition. In one transaction
it locks and revalidates actor/branch/catalog/customer/register/till/sale/items,
aggregates base quantity per variant, locks inventory, reconstructs valuation,
allocates eligible lots, creates one `SALE` inventory transaction, writes one
negative transaction item per sale line and negative lot allocations, decrements
branch and allocated lot projections, writes positive `sale_item_lots`, snapshots
four-place unit cost on each sale item, sets `sold_at` and `COMPLETED`, and writes
`SALE_COMPLETED`. Any failure rolls back every one of those effects.

Because `branch_inventory` has no average-cost column, current weighted-average
cost is reconstructed from branch/variant ledger history ordered by
`occurred_at`, transaction ID, line number, and item ID. Positive known-cost
movements add carrying value; known-cost negative movements subtract it; a
negative NULL-cost movement consumes the current rounded weighted cost. A
positive NULL-cost movement makes valuation unknown until stock later reaches
exactly zero, which resets both quantity and valuation certainty. Reconstructed
quantity must exactly equal the locked branch projection, may never pass below
zero, and must have known valuation while positive. Otherwise completion returns
`409` rather than inventing a cost.

`REQUIRED` lot variants must be fully allocated; `OPTIONAL` variants use all
eligible lot stock available and may leave the remainder unallocated; `NONE`
variants create no lot evidence. Eligible lots are globally `ACTIVE`, branch
`AVAILABLE`, positive, and unexpired. FEFO sorts non-null expiry dates first,
then non-expiring lots, with inventory-lot ID as the tie-breaker. A depleted
branch lot becomes `DEPLETED`; global lot identity/status is never changed.

The deterministic Phase 12 lock family adapts the earlier writers as follows:
sorted actor/cashier employees, branch, current assignments, sorted catalog
reference rows (category/brand/tax/UOM), products, variants, packages and
barcodes where needed, pricing rows, customer, POS register, till, sale, sale
items, global lots, branch inventory, branch-lot inventory, then the ordered
ledger history used for valuation. This preserves the Phase 11
register-before-till-before-sale relationship and the Phase 7-9
global-lot-before-branch-projection order. Parent sale and till locks serialize
line mutation, completion, cancellation, till close, and duplicate requests.

### Lifecycle, audits, and Phase 12 boundary

Phase 12 implements only `OPEN -> COMPLETED` and `OPEN -> CANCELLED`.
Cancellation sets the database timestamp and preserves abandoned-cart items but
creates no inventory transaction, lot allocation, payment, or return. Completed
and cancelled sales are immutable through these routes. Phase 13 now supplies
tender/payment completeness without changing the sale route permissions.
`VOIDED`, reversal inventory transactions, refunds, sales returns, and stock
reversal coordination remain later work.

The only Phase 12 audit vocabulary is `SALE_CREATED`, `SALE_UPDATED`,
`SALE_ITEM_CREATED`, `SALE_ITEM_UPDATED`, `SALE_ITEM_DELETED`, `SALE_COMPLETED`,
and `SALE_CANCELLED`. Each effective audit shares the business transaction;
failed and no-op operations leave no audit row.

## Phase 13 payments and tender handling

Phase 13 uses the approved schema without alteration. `payment_methods` is the
global tender configuration master. `sale_payments` is immutable payment-attempt
evidence linked to one sale, one method, and the employee that processed it. The
frozen nullable `sales_return_id` and `REFUND` enum exist for Phase 14; every
Phase 13 write deliberately uses `sales_return_id = NULL` and
`payment_type = PAYMENT`.

The phase adds exactly four canonical permissions, increasing both the canonical
catalog and `SYSTEM_ADMIN` mappings from 38 to 42:

- `payment_methods.read` and `payment_methods.manage` are global permissions;
- `payments.read` and `payments.manage` are branch-aware permissions.

A branch-scoped grant never satisfies the global payment-method API. For sale
payments, a global grant satisfies permission scope at any branch and a branch
grant only at its exact URL branch. Permission scope and operational identity
remain separate: an employee-linked user needs a current assignment to the URL
branch even when the permission came from a global grant. Reads may be performed
by an authorized unlinked account; writes additionally require an active linked
employee and current assignment, rechecked transactionally. An unlinked
`SYSTEM_ADMIN` therefore may configure global methods and read branch payment
history, but cannot create or transition a sale payment.

### Exact routes

Phase 13 adds exactly ten routes. The first four are below `/api/admin`; the last
six are below `/api/admin/branches/:branchId`.

| # | Method and path | Permission | Purpose |
| ---: | --- | --- | --- |
| 1 | `GET /payment-methods` | `payment_methods.read` | List global methods with stable pagination |
| 2 | `POST /payment-methods` | `payment_methods.manage` | Create a global payment method |
| 3 | `GET /payment-methods/:paymentMethodId` | `payment_methods.read` | Read one method |
| 4 | `PATCH /payment-methods/:paymentMethodId` | `payment_methods.manage` | Update mutable method configuration |
| 5 | `GET /sales/:saleId/payments` | `payments.read` | List attempts and the sale funding summary |
| 6 | `POST /sales/:saleId/payments` | `payments.manage` | Reserve a new PENDING PAYMENT attempt |
| 7 | `GET /sales/:saleId/payments/:salePaymentId` | `payments.read` | Read one payment attempt |
| 8 | `POST /sales/:saleId/payments/:salePaymentId/complete` | `payments.manage` | Complete a PENDING PAYMENT |
| 9 | `POST /sales/:saleId/payments/:salePaymentId/fail` | `payments.manage` | Mark a PENDING PAYMENT failed |
| 10 | `POST /sales/:saleId/payments/:salePaymentId/cancel` | `payments.manage` | Cancel a PENDING PAYMENT attempt |

There is no delete, edit-payment, refund, callback, capture alias, generic tender,
or processor-specific route. Action bodies must be empty. Reads never create an
audit or mutate payment/sale/till state.

### Payment-method configuration

Create accepts exactly `methodCode`, `methodName`, `methodType`,
`requiresReference`, and optional `isActive`. The method type must be one of
`CASH`, `CARD`, `BANK_TRANSFER`, `MOBILE_MONEY`, `VOUCHER`, or `OTHER`. PATCH
accepts only code, name, reference requirement, and active state; method type is
immutable. Codes are trimmed and uppercased. Code and name remain independently
unique. A no-op PATCH returns the current row without changing `updated_at` or
writing audit evidence. Inactive methods remain readable and historical payment
rows retain their method reference, but an inactive method cannot start a new
payment.

The method list permits exactly `search`, `methodType`, `isActive`,
`requiresReference`, `page`, and `limit`. Search covers code and name. Ordering
is `method_code ASC, payment_method_id ASC`.

### Payment identity, exact money, and summaries

Payment creation accepts exactly:

```json
{
  "paymentMethodId": "1",
  "amount": "100.00",
  "externalReference": "optional-provider-evidence",
  "notes": "optional operator note"
}
```

`amount` is a strictly positive DECIMAL(19,2) string. Numeric JSON, scientific
notation, excess scale, overflow, zero, and negative values are rejected before
SQL. IDs stay strings so the full `BIGINT UNSIGNED` domain is safe. The server
generates a bounded-retry `PAY-` plus 32-uppercase-hex payment number, copies the
sale currency, stores the authenticated actor employee, forces `PAYMENT` and
`PENDING`, and leaves `paid_at` null. A method marked `requires_reference` needs
a non-null reference. The frozen unique `(payment_method_id,
external_reference)` rule allows the same reference under a different method but
rejects reuse under the same method.

The payment list filters `created_at` using exact `from`/`to` dates, orders by
`created_at ASC, sale_payment_id ASC`, and returns stable pagination plus:

```json
{
  "summary": {
    "completedPaymentAmount": "0.00",
    "pendingPaymentAmount": "0.00",
    "activePaymentAmount": "0.00",
    "outstandingAmount": "100.00",
    "isFullyPaid": false
  }
}
```

Only `PAYMENT` rows contribute to this Phase 13 funding summary. Amounts are
computed with scaled `BigInt`, never binary floating point. REFUND history may be
listed but is never netted into checkout funding.

### Lifecycle, commitment, and sale integration

The only Phase 13 transitions are:

```text
PENDING -> COMPLETED
PENDING -> FAILED
PENDING -> CANCELLED
```

COMPLETED, FAILED, and CANCELLED rows are terminal and never deleted. Retrying
creates a new attempt, preserving reference, employee, and audit history.
Completion sets authoritative database UTC `paid_at`; failed/cancelled attempts
keep it null. Method deactivation after creation does not invalidate an existing
attempt, so a PENDING attempt may still complete, fail, or cancel.

An active tender is a PAYMENT in PENDING or COMPLETED state. For an OPEN sale:

```text
activePaymentAmount    = PENDING PAYMENT + COMPLETED PAYMENT
completedPaymentAmount = COMPLETED PAYMENT
outstandingAmount      = sale total - completedPaymentAmount
```

Creation requires `activePaymentAmount + new amount <= sale total`. PENDING is
a reservation, so two simultaneous requests cannot each reserve the same
remaining balance. Split tender is allowed when the exact active total stays at
or below the sale total. The stored CASH amount is the amount applied to the
sale; the frozen schema has no `cash_received` or `change_due` field.

Once active tender exists, Phase 12 sale header and item mutations return `409`:
commercial totals cannot move beneath reserved or completed money. FAILED- or
CANCELLED-only history releases that freeze. Sale cancellation similarly rejects
PENDING or COMPLETED PAYMENT history but may proceed after only failed/cancelled
attempts. It never auto-cancels or auto-refunds a payment.

The existing `POST /sales/:saleId/complete` route remains protected only by
`sales.manage`. Under the locked sale it locks payment rows immediately, then
requires:

- no REFUND history conflict;
- no PENDING PAYMENT;
- exact completed PAYMENT total equal to `sales.total_amount`.

Incomplete or overpaid history rolls back before inventory or audit changes.
A valid zero-total sale needs no fake payment. Existing Phase 12 completed sales
are not backfilled, reopened, or rewritten; payment creation is rejected for an
already completed sale.

Creation and completion require an OPEN sale, matching branch/register/till/
cashier identity, an active branch, currency equality across branch/till/sale,
and an OPEN till. Cleanup transitions to FAILED or CANCELLED are deliberately
allowed while the original till is OPEN, SUSPENDED, or CLOSED so stranded
reservations can be released; cleanup is rejected if the till is CANCELLED.

### Locking, till reconciliation, and audits

Operational payment writes use this order:

```text
sorted operational employees
-> branch
-> current assignments
-> POS register
-> till session
-> sale
-> sale payments by ID
-> payment method
```

This is compatible with Phase 11 till close (`register/till -> sales ->
sale_payments -> payment_methods`) and avoids method-before-till inversion.
Payment creation serializes with cart edits, method deactivation, competing
reservations, sale completion, sale cancellation, and till close. Till close
continues to count only COMPLETED CASH PAYMENT rows as cash inflow; PENDING,
FAILED, CANCELLED, and noncash payments do not change expected cash. Phase 13
does not alter the existing completed CASH REFUND subtraction used for historical
or future return evidence.

Exactly six new transaction-bound audit actions exist:

- `PAYMENT_METHOD_CREATED`
- `PAYMENT_METHOD_UPDATED`
- `SALE_PAYMENT_CREATED`
- `SALE_PAYMENT_COMPLETED`
- `SALE_PAYMENT_FAILED`
- `SALE_PAYMENT_CANCELLED`

Method audits use entity `PAYMENT_METHOD` with no branch. Payment audits use
entity `SALE_PAYMENT` and the sale branch. GETs, no-op method PATCHes, failed
validation/authorization, rejected overpayment, duplicate references, invalid
transitions, losing races, and rolled-back sale completion create no Phase 13
audit.

### Phase 14 boundary

Phase 13 is persistence and workflow for incoming sale PAYMENT rows only. It
does not contact card networks, banks, Paystack, Flutterwave, or mobile-money
providers; an external reference is caller-supplied evidence, not a claim of
processor integration. It adds no REFUND writer, sale return, returned item,
restock, refund allocation, void, reversal, chargeback, store-credit, customer
wallet, frontend, or Postman collection. Those refund/return responsibilities
belong to Phase 14.

`Phase 14` is now implemented as documented below; the Phase 13 section remains
the incoming-PAYMENT contract.

## Phase 14 sales returns and refunds

Phase 14 uses the frozen schema without alteration. `sales_returns` is the
header for a return against one original sale at that sale's branch. It records
the original customer reference, processing/approval/cancellation employees,
lifecycle timestamps, exact refundable total, and optional inventory transaction.
`sales_return_items` links each line to its original `sale_items` row and
preserves variant/package/description/SKU snapshots, exact quantity and package
conversion, condition, restockability, reason, and refundable amount.

There is no dedicated return-item-lot table. For restockable stock with known
original lot provenance, the `CUSTOMER_RETURN` inventory transaction item uses
the same server-owned line number as its return item, and
`inventory_transaction_lot_allocations` records each restored lot. The nullable
`sales_return_items.inventory_lot_id` is populated only when the entire returned
base quantity maps to one original lot; multi-lot and aggregate restorations
leave it null. `branch_inventory` remains the aggregate projection and
`branch_lot_inventory` the lot projection.

The exact return lifecycle is:

```text
DRAFT (no approval required) -> COMPLETED
DRAFT (approval required) -> PENDING_APPROVAL -> APPROVED -> COMPLETED
DRAFT / PENDING_APPROVAL / APPROVED -> CANCELLED
```

Items are editable only in `DRAFT`. The employee who processed the return cannot
approve it. Completion and cancellation are explicit actions and terminal
states are immutable. A completed return containing no restockable item has a
null `inventory_transaction_id`; restockable completion posts its stock,
lifecycle change, linkage, and audit atomically. The original sale stays
`COMPLETED`, and its item, lot, inventory-transaction, and PAYMENT evidence is
never rewritten.

Phase 14 adds exactly two canonical permissions, increasing the catalog and
`SYSTEM_ADMIN` mappings from 42 to 44:

- `returns.read` reads branch returns, items, inventory linkage, and refunds;
- `returns.manage` creates, edits, submits, approves, completes, cancels, and
  settles branch returns.

A global grant can satisfy permission scope at any branch; a branch grant only
at its exact URL branch. The separate employee-assignment gate still applies to
every employee-linked user regardless of grant scope. Authorized unlinked users
may read, but every mutation rechecks an `ACTIVE` linked employee with a current
assignment inside the transaction.

### Exact Phase 14 routes

All routes are below `/api/admin/branches/:branchId/sales/:saleId`:

| # | Method and suffix | Permission | Purpose |
| ---: | --- | --- | --- |
| 1 | `GET /returns` | `returns.read` | List returns with status/date filters and pagination |
| 2 | `POST /returns` | `returns.manage` | Create a DRAFT return for a completed sale |
| 3 | `GET /returns/:salesReturnId` | `returns.read` | Read header, ordered items, inventory link, refunds, and summary |
| 4 | `POST /returns/:salesReturnId/items` | `returns.manage` | Add an original sale item and returned quantity |
| 5 | `PATCH /returns/:salesReturnId/items/:salesReturnItemId` | `returns.manage` | Edit allowed DRAFT fields |
| 6 | `DELETE /returns/:salesReturnId/items/:salesReturnItemId` | `returns.manage` | Remove a DRAFT item |
| 7 | `POST /returns/:salesReturnId/submit` | `returns.manage` | Submit an approval-required return |
| 8 | `POST /returns/:salesReturnId/approve` | `returns.manage` | Approve with a different employee |
| 9 | `POST /returns/:salesReturnId/complete` | `returns.manage` | Finalize evidence and restore eligible stock |
| 10 | `POST /returns/:salesReturnId/cancel` | `returns.manage` | Cancel an unposted return without active refunds |
| 11 | `GET /returns/:salesReturnId/refunds` | `returns.read` | List linked refunds and exact summary |
| 12 | `POST /returns/:salesReturnId/refunds` | `returns.manage` | Create a PENDING REFUND |
| 13 | `POST /returns/:salesReturnId/refunds/:salePaymentId/complete` | `returns.manage` | Complete a pending refund |
| 14 | `POST /returns/:salesReturnId/refunds/:salePaymentId/fail` | `returns.manage` | Fail a pending refund |
| 15 | `POST /returns/:salesReturnId/refunds/:salePaymentId/cancel` | `returns.manage` | Cancel a pending refund |

The submit and approve routes are required by the frozen five-state enum. There
is no generic refund PATCH/DELETE, refund-all, exchange, store-credit,
chargeback, sale-void, gateway callback, report, or analytics route.

### Quantity, historical value, and inventory cost

Only a `COMPLETED` sale is eligible. A client identifies the original sale item
and supplies exact DECIMAL(15,3) quantity, reason, condition, restockability,
and optional note. Product/package identity, historical descriptions, money,
cost, branch/sale linkage, document/line numbers, status, and timestamps are
server-owned. Whole-only variants require whole returned base quantities.

The original sale and all sale items are locked before existing return headers
and items. Every non-cancelled return reserves quantity, so concurrent documents
cannot cumulatively exceed what was sold. Money comes only from immutable
`sale_items.line_total`; current prices, discounts, and tax configuration are
never queried. Allocation uses scaled `BigInt` and deterministic HALF_UP against
cumulative returned quantity. The final remaining quantity consumes the exact
residual so repeated partial returns finish at the original line total. The
frozen return-item schema has no separate return discount/tax fields, so their
historical effects remain represented within `refund_amount` rather than
invented columns.

Restockable posting requires the original non-null `sale_items.unit_cost` and
copies that DECIMAL(19,4) cost to positive ledger and lot-allocation rows. It
never substitutes current weighted average and never writes an average-cost
column. A zero-value item can return to inventory, but `sale_payments.amount`
remains strictly positive so no fake zero refund row is created.

### Original-provenance stock restoration

Restockable quantities post positive `CUSTOMER_RETURN` movements through the
shared inventory engine. Non-restockable items preserve commercial return
evidence without increasing stock. Projection/version changes, ledger rows,
return linkage/state, and audit commit or roll back together.

`sale_item_lots` is authoritative. Original allocations are consumed in
deterministic `sale_item_lot_id` order after subtracting prior completed return
allocations derived through return header -> transaction -> matching return line
-> lot allocation. No lot can receive more than the original sale consumed.
`REQUIRED` variants need full original provenance. `OPTIONAL` variants restore
the attributable portion to original lots and an originally unallocated portion
only to aggregate stock. `NONE` variants restore aggregate stock without a fake
lot. Existing lot-state policy prevents an expired, recalled, closed,
quarantined, or blocked lot from becoming sellable merely because quantity is
returned.

### Refund settlement and frozen cash-till limitation

Refunds reuse `sale_payments` with `payment_type = REFUND`, the original
`sale_id`, and the composite-FK-compatible `sales_return_id`. New attempts are
`PENDING`; only `PENDING -> COMPLETED`, `PENDING -> FAILED`, and
`PENDING -> CANCELLED` are valid. The server generates the existing `PAY-` plus
32-uppercase-hex number, copies sale currency, records the current employee, and
sets database UTC `paid_at` only on completion. New attempts need an active
payment method and any required external reference; an already-pending attempt
may be resolved after method deactivation.

PENDING plus COMPLETED refunds reserve return entitlement. Across the sale they
cannot exceed either all completed return entitlement or the original COMPLETED
PAYMENT money collected. FAILED and CANCELLED attempts release commitment.
Partial/split refunds are supported, while sale/return/payment locks serialize
overcommit and duplicate completion. The Phase 13 funding summary still counts
PAYMENT only. Return reads expose separate `returnTotal`, completed, pending,
active, outstanding, and `isFullyRefunded` values.

The frozen schema has no refund `till_session_id`. Phase 11 can find a refund
only via `sale_payments.sale_id -> sales.till_session_id`, so it cannot attribute
a later cash refund to a different drawer. CASH refund creation/completion is
therefore allowed only while the original sale till remains `OPEN`. Completion
locks register -> till -> sale before payment rows: either it commits first and
till close subtracts it exactly once, or close commits first and refund returns
`409`. Noncash refunds do not affect drawer cash and may settle after the till
closes. A future approved schema change is required for later cash refunds at a
new till; Phase 14 does not fake this association.

### Lock order and audits

Return posting uses:

```text
operational employees -> branch -> current assignment
-> catalog roots/packages -> original sale -> sale items -> sale-item lots
-> return headers/items -> prior return ledger evidence -> global lots
-> branch inventory -> branch-lot inventory -> new ledger/audit
```

Refund writes use operational context, register/till when cash, sale, return
family, ordered payment rows, and payment method. This preserves the established
parent-before-method and global-lot-before-projection order across till close,
receiving, adjustments, counts, transfers, and sales.

Effective writes use `SALES_RETURN_CREATED`,
`SALES_RETURN_ITEM_CREATED/UPDATED/DELETED`, `SALES_RETURN_SUBMITTED`,
`SALES_RETURN_APPROVED`, `SALES_RETURN_COMPLETED`,
`SALES_RETURN_CANCELLED`, and `SALE_REFUND_CREATED/COMPLETED/FAILED/CANCELLED`.
GETs, authorization/validation failures, rejected caps, number-collision losers,
duplicate action losers, and rolled-back operations create no audit row.

Phase 14 does not implement void/reversal, exchange, store credit, chargeback,
processor integration, reports, analytics, frontend, or Postman collections.
Phase 15 reporting and analytics has not started.

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
rejected for `SYSTEM_ADMIN` unless all 44 canonical permissions remain.

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
node --test --test-concurrency=1 test/payments.integration.test.js
node --test --test-concurrency=1 test/sales.integration.test.js
node --test --test-concurrency=1 test/pos.integration.test.js
node --test --test-concurrency=1 test/customer.integration.test.js
npm test
```

The complete Phase 2-13 validation suite covers:

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
  and zero unrelated catalog/pricing/supplier/document mutation;
- Phase 9's exact 38-route matrix, six isolated permissions, operational actor
  rules, adjustment segregation and signed ledger posting, count snapshots and
  stale-count rejection, lot-preserving partial transfer dispatch/receipt,
  duplicate-action protection, competing negative adjustments, audit
  boundaries, and the customer-route absence required at the Phase 9 checkpoint;
- Phase 10's exact four-route matrix, two isolated global permissions,
  individual/business final-state validation, server-owned customer numbers,
  loyalty uniqueness and collation behavior, lifecycle status, fixed search and
  filters, no-op/audit/rollback boundaries, BIGINT-safe IDs, historical-sale
  stability, concurrent patch/type/loyalty behavior, and the absence of delete,
  branch-scoped, financial-account, POS, and sales-creation routes;
- Phase 11's exact 13-route matrix, four isolated branch permissions, separate
  permission-scope and linked-employee assignment gates, register lifecycle and
  uniqueness, operational actor/cashier checks, active register/cashier guards,
  till lifecycle and cancellation safety, append-only cash movements, exact
  persisted-evidence reconciliation, eight audit actions, rollback and
  concurrency outcomes, and zero unrelated-domain mutation;
- Phase 12's exact nine-route matrix, two isolated branch permissions, strict
  operational actor and till-state gates, server-owned catalog and price
  snapshots, exact decimal and tax arithmetic, cart lifecycle, atomic SALE
  ledger posting, weighted-average cost reconstruction, REQUIRED/OPTIONAL/NONE
  lot behavior with FEFO, seven audit actions, rollback and concurrency
  outcomes, and zero refund/return or unrelated-domain mutation;
- Phase 13's exact ten-route matrix, four isolated permissions, global method
  configuration, branch-aware operational tender, exact split-payment
  commitment, cart/cancellation freeze, sale-completion funding, till drawer
  integration, six audit actions, terminal attempt history, and concurrency-safe
  payment/till/sale/method races;
- Phase 14's exact 15-route matrix, two isolated permissions, immutable sale
  evidence, cumulative quantity and money caps, approval lifecycle, atomic
  CUSTOMER_RETURN posting, deterministic original-lot restoration, split refunds,
  cash-till reconciliation, rollback and concurrency outcomes; and
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
order. Phase 9 creates isolated `TEST_P9_*` organization/catalog/stock
prerequisites, performs stock changes only through Phase 9 APIs, and verifies
exact reverse-FK cleanup. Phase 10 creates only unmistakable `TEST_P10_*`
access-control and customer prerequisites, uses any direct historical-sale row
only as an isolated FK-stability fixture, and removes its exact reverse-FK
closure. Phase 11 creates isolated `TEST_P11_*` access, organization, register, till,
and minimum sale/payment evidence fixtures, mutates Phase 11 state only through
its API, and removes the exact reverse-FK closure. Phase 12 creates isolated
`TEST_P12_*` access, organization, catalog, price, till, lot, and stock fixtures,
performs sale changes only through its API and uses isolated direct-SQL
COMPLETED-payment prerequisites only to preserve the Phase 12 inventory test
purpose. Phase 13 creates isolated `TEST_P13_*` access, branch, till, catalog,
stock, method, sale, and payment fixtures, performs payment mutations through
its API, and removes their exact reverse-FK closure. No suite operates real development records. Phase 14 creates isolated
`TEST_P14_*` access, branch, till, catalog, stock, sale, return-reason, and
payment-method prerequisites; it performs return and refund mutations through
the API and removes their exact reverse-FK closure. No suite implements loyalty
points or customer financial accounts.

The approved pre-edit Phase 10 baseline was the full Phase 9 regression: 114
tests passed, 0 failed, 0 skipped, and 0 cancelled. It confirmed the active
`supermarket_management` database with its frozen 54 tables and the then-current
30 canonical permissions/mappings before the two Phase 10 permissions were
seeded. Results are environment-specific, so run the focused customer suite and
then `npm test` again after relevant code, configuration, or database changes.

The definitive focused Phase 10 run discovered 12 tests: 12 passed, 0 failed,
0 skipped, and 0 cancelled in 1,834.576738 ms. The definitive full Phase 2-10
regression discovered 126 tests: 126 passed, 0 failed, 0 skipped, and 0
cancelled in 34,017.453603 ms. Final read-only verification confirmed
`supermarket_management` on MySQL 8.0.46 with 54 base tables, 32 canonical
permissions, one `SYSTEM_ADMIN` role, all 32 canonical mappings, and zero
remaining `TEST_P10_*` fixtures.

The definitive focused Phase 11 run discovered 15 tests: 15 passed, 0 failed,
0 skipped, and 0 cancelled in 7,003.119072 ms. The definitive full Phase 2-11
regression discovered 141 tests: 141 passed, 0 failed, 0 skipped, and 0
cancelled in 66,189.57768 ms. Final read-only verification confirmed
`supermarket_management` on MySQL 8.0.46 with 54 base tables, 36 canonical
permissions, one `SYSTEM_ADMIN` role, all 36 canonical mappings, and zero
remaining `TEST_P11_*` fixtures.

The definitive focused Phase 12 run discovered 23 tests: 23 passed, 0 failed,
0 skipped, and 0 cancelled in 3,467.509631 ms. The definitive full Phase 2-12
regression discovered 164 tests: 164 passed, 0 failed, 0 skipped, and 0
cancelled in 44,523.581199 ms. Final read-only verification confirmed `supermarket_management` on MySQL 8.0.46
with 54 base tables, 38 canonical permissions, one `SYSTEM_ADMIN` role, all 38
canonical mappings, and zero remaining `TEST_P12_*` fixtures.

The definitive focused Phase 13 run discovered 20 tests: 20 passed, 0 failed,
0 skipped, and 0 cancelled in 11,407.331158 ms. The definitive full Phase 2-13
regression discovered 184 tests: 184 passed, 0 failed, 0 skipped, and 0
cancelled in 132,261.279257 ms. Final read-only verification confirmed
`supermarket_management` on MySQL 8.0.46 with 54 base tables, 42 canonical
permissions, one `SYSTEM_ADMIN` role, all 42 canonical mappings, and zero
remaining `TEST_P13_*` fixtures.

The mandatory pre-edit Phase 13 baseline discovered 184 tests: 184 passed, 0
failed, 0 skipped, and 0 cancelled in 136,491.948366 ms. The definitive focused
Phase 14 run discovered 17 tests: 17 passed, 0 failed, 0 skipped, and 0 cancelled
in 7,526.502006 ms. The definitive full Phase 2-14 regression discovered 201
tests: 201 passed, 0 failed, 0 skipped, and 0 cancelled in 89,571.317825 ms.
Final read-only verification confirmed `supermarket_management` on MySQL 8.0.46
with 54 base tables, 44 canonical permissions, one `SYSTEM_ADMIN` role, all 44
canonical mappings, and zero remaining `TEST_P14_*` fixtures.

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
reads and reorder/branch-lot-status configuration. Phase 9 stops after stock
adjustments, physical stock counts, and inter-branch stock transfers. Phase 10
stops after global customer master/profile and loyalty-identity administration;
it does not invent financial customer accounts. Phase 11 stops after branch POS register configuration, till-session lifecycle,
cash movements, and exact drawer reconciliation. Phase 12 stops after OPEN-cart
management, atomic sale completion and stock posting, or cancellation. Phase 13 stops after payment-method configuration, PAYMENT tender attempts,
split tender, payment completeness, and till reconciliation. Phase 14 stops
after dedicated sales returns, stock restoration, and return-linked REFUND
settlement. Sale void/reversal, exchanges, store credit, gateway integrations,
reports, analytics, and frontend work remain later phases.
