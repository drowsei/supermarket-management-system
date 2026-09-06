# Supermarket Management System

A production-oriented, multi-branch supermarket management system being built in
deliberate phases. Phase 3 adds the reusable authentication and authorization
foundation to the approved 54-table database and the Phase 2 Express/MySQL
foundation.

The current API supports health checks, staff login, current-account inspection,
and authenticated password changes. It also supplies permission, branch-scope,
and forced-password-change middleware for later business routes. Product,
inventory, purchasing, POS, sales, reports, frontend pages, and Postman
collections are intentionally outside this phase.

Detailed database design remains in [database/README.md](database/README.md).

## Technology stack

- Node.js 20+ with ES Modules
- Express 5 REST API
- MySQL with `mysql2/promise`
- bcrypt password hashing
- short-lived JSON Web Tokens (JWT)
- Helmet security headers
- endpoint-specific login rate limiting
- `dotenv` environment configuration
- CORS middleware
- nodemon for local development
- Node's built-in test runner for integration tests

## Project structure

```text
supermarket-management-system/
├── database/
│   ├── README.md
│   └── schema.sql
├── src/
│   ├── config/
│   │   └── database.js
│   ├── controllers/
│   │   └── auth.controller.js
│   ├── middleware/
│   │   ├── auth.middleware.js
│   │   ├── authorization.middleware.js
│   │   ├── errorHandler.js
│   │   └── loginRateLimiter.js
│   ├── repositories/
│   │   └── auth.repository.js
│   ├── routes/
│   │   ├── auth.routes.js
│   │   └── health.routes.js
│   ├── services/
│   │   ├── auth.service.js
│   │   └── authorization.service.js
│   ├── utils/
│   │   ├── httpError.js
│   │   ├── jwt.js
│   │   └── password.js
│   ├── validators/
│   │   └── auth.validator.js
│   ├── app.js
│   └── server.js
├── test/
│   └── auth.integration.test.js
├── .env
├── .env.example
├── .gitignore
├── package-lock.json
├── package.json
└── README.md
```

The authentication request path is deliberately separated:

```text
route -> middleware -> controller -> service -> repository -> MySQL
```

Routes define URLs, controllers translate HTTP input and output, services apply
security and workflow rules, and repositories own parameterized SQL. This keeps
database concerns out of HTTP handlers and makes each layer easier to test.

## Prerequisites

- Node.js 20 or newer
- npm
- MySQL 8.0.16 or newer
- The existing `supermarket_management` database created from
  `database/schema.sql`
- The dedicated MySQL application account `supermarket_app`, with the privileges
  required by the API and tests

MySQL `root` is an administrative account; it should not run the Node.js
application. Keep real local credentials in `.env`, which is Git-ignored. The
tracked `.env.example` contains placeholders only.

## Install and configure

Install exactly the versions recorded in the lockfile:

```bash
npm ci
```

For normal dependency installation while developing, use:

```bash
npm install
```

If `.env` does not already exist, copy the safe template and edit the new local
file:

```bash
cp .env.example .env
```

Generate a strong JWT secret locally, then save its output as `JWT_SECRET` in
`.env`. Do not paste the output into source code, documentation, Git, logs, or
chat:

```bash
openssl rand -base64 48
```

### Environment variables

| Variable | Required | Purpose | Safe example |
| --- | --- | --- | --- |
| `NODE_ENV` | yes | Runtime mode | `development` |
| `PORT` | yes | HTTP listening port | `5000` |
| `DB_HOST` | yes | MySQL host | `localhost` |
| `DB_PORT` | yes | MySQL port | `3306` |
| `DB_USER` | yes | Dedicated application account | `supermarket_app` |
| `DB_PASSWORD` | yes | Local MySQL password | `replace_with_your_mysql_password` |
| `DB_NAME` | yes | Existing database | `supermarket_management` |
| `DB_CONNECTION_LIMIT` | no | Maximum pooled connections | `10` |
| `JWT_SECRET` | yes | Private JWT signing key | `replace_with_a_private_random_secret_of_at_least_48_characters` |
| `JWT_EXPIRES_IN` | yes | Access-token lifetime | `15m` |
| `JWT_ISSUER` | yes | Expected token issuer | `supermarket-management-system` |
| `JWT_AUDIENCE` | yes | Expected token audience | `supermarket-api` |
| `BCRYPT_ROUNDS` | yes | bcrypt work factor | `12` |

Startup validates the database and authentication configuration. It requires a
JWT secret of at least 48 UTF-8 bytes and rejects the tracked placeholder, limits
`JWT_EXPIRES_IN` to an explicitly unit-suffixed value from 60 seconds through one
hour, and accepts bcrypt costs from 10 through 14. No secret value is printed.
The server opens its HTTP port only after a real read-only MySQL connection test
succeeds.

## Packages and their responsibilities

- `express` supplies routing and the HTTP middleware pipeline.
- `mysql2` supplies Promise-based, parameterized MySQL queries and pooling.
- `dotenv` loads local environment configuration before application imports.
- `cors` supplies development-time cross-origin response policy.
- `bcrypt` hashes and verifies passwords using a configurable work factor.
- `jsonwebtoken` signs and verifies short-lived HS256 access tokens.
- `express-rate-limit` throttles repeated login attempts.
- `helmet` adds safe default HTTP security headers.
- `nodemon` is the only development dependency; it restarts the server after
  source changes. Runtime packages are under `dependencies` because the deployed
  application needs them; nodemon is under `devDependencies` because production
  does not.

## Commands

```bash
# Development server with automatic restart
npm run dev

# Normal server
npm start

# Automated Phase 2 regression and Phase 3 integration tests
npm test
```

A successful startup reports the connected database and port, but never logs a
database password or JWT secret:

```text
Database connection successful.
Connected database: supermarket_management
Server running on port 5000
```

On `SIGINT` or `SIGTERM`, graceful shutdown first stops accepting HTTP requests,
then closes the HTTP server and MySQL pool.

## API endpoints

### Health checks

| Method and path | Authentication | Purpose | Success |
| --- | --- | --- | --- |
| `GET /api/health` | none | Confirms Express is responding | `200` |
| `GET /api/health/database` | none | Executes a lightweight query through the shared pool | `200` |
| any unknown route | as applicable | Consistent JSON not-found response | `404` |

The database health endpoint returns `503` if its live MySQL query fails and does
not disclose connection details.

### Login

`POST /api/auth/login` is public but rate-limited.

```json
{
  "identifier": "username-or-email",
  "password": "user-password"
}
```

On success (`200`):

```json
{
  "success": true,
  "data": {
    "accessToken": "<access-token>",
    "tokenType": "Bearer",
    "expiresIn": "15m",
    "user": {
      "userId": "123",
      "username": "cashier.one",
      "email": "cashier@example.com",
      "employeeId": "456",
      "mustChangePassword": false
    }
  }
}
```

IDs are JSON strings because MySQL `BIGINT UNSIGNED` values can exceed
JavaScript's safe integer range. A missing field returns `400`. A nonexistent
identifier, incorrect password, ambiguous identifier, or inactive account all
use the same generic `401` response so the endpoint does not confirm which
accounts exist. The single-process limiter allows 10 attempts per client IP in a
15-minute window; further attempts return a clean `429` response.

### Current account

`GET /api/auth/me` requires a valid Bearer token:

```bash
curl -i \
  -H "Authorization: Bearer ACCESS_TOKEN" \
  http://localhost:5000/api/auth/me
```

On success (`200`), the endpoint returns safe account fields plus current global
and branch-scoped role and permission grants:

```json
{
  "success": true,
  "data": {
    "user": {
      "userId": "123",
      "employeeId": "456",
      "username": "cashier.one",
      "email": "cashier@example.com",
      "isActive": true,
      "mustChangePassword": false,
      "lastLoginAt": "2026-09-05T12:00:00.000Z"
    },
    "authorization": {
      "globalRoles": [
        { "roleCode": "STAFF", "roleName": "Staff" }
      ],
      "branchRoles": [
        {
          "branchId": "7",
          "roleCode": "CASHIER",
          "roleName": "Cashier"
        }
      ],
      "permissions": {
        "global": ["account.view_self"],
        "byBranch": { "7": ["sale.create"] }
      }
    }
  }
}
```

The role and permission codes above only illustrate the response shape; the
endpoint returns grants that actually exist in the database. It never returns a
password hash, JWT secret, token, or database credentials. Missing, malformed,
invalid, expired, wrongly issued, or wrongly targeted tokens return the same safe
`401` authentication response. The endpoint remains available while
`mustChangePassword` is true so a client can discover the restriction.

### Change password

`POST /api/auth/change-password` requires a valid Bearer token.

```json
{
  "currentPassword": "current-user-password",
  "newPassword": "new-user-password"
}
```

The new password must contain at least 10 characters, must fit bcrypt's supported
72 UTF-8-byte input boundary, and cannot be exactly the current password. The
service verifies the current password, creates a fresh bcrypt hash, updates the
account, clears `must_change_password`, and records a password-change audit entry
without including either password or any token. Password fields are deliberately
not trimmed or normalized.

Success returns `200` with:

```json
{
  "success": true,
  "message": "Password changed successfully"
}
```

Other expected statuses are `400` for invalid new-password data, `401` for
missing/invalid authentication or an incorrect current password, and `409` if a
concurrent password update makes the checked credentials stale. `500` is
reserved for an unexpected internal failure. The update and audit insert use a
transaction so they succeed or roll back together.

There is deliberately no public `/register` or `/signup` route. Staff accounts
will be provisioned later through an authorized administrative workflow.

## Authentication design

The login service finds the username or email with parameterized SQL and verifies
the stored bcrypt hash. On success it conditionally updates `last_login_at` and
signs a short-lived access token.

The token contains the user ID as the standard `sub` claim and only JWT timing,
issuer, and audience metadata. It does not contain password hashes, employee
details, roles, or permission lists. Tokens are signed and verified explicitly
with HS256, the configured issuer and audience, and an expiration time.

Every protected request verifies the Bearer token and then reloads the current
user from MySQL. A deleted, missing, or inactive account is rejected even if its
token signature is valid. The middleware attaches only a safe current-user
object to the request for downstream handlers.

## Authorization design

Authentication proves which current account made a request; authorization asks
what that account may do. Authorization follows the existing normalized chain:

```text
users
  -> user_roles (global or branch scope)
  -> active roles
  -> role_permissions
  -> permissions (checked by permission_code)
```

Role names organize grants; they are not hard-coded as authorization bypasses.
Reusable middleware supports a global permission check and a branch-targeted
permission check.

- `user_roles.branch_id IS NULL` grants a permission globally.
- A non-null `branch_id` grants it only for that exact branch.
- A Branch A grant never authorizes Branch B.
- Disabled roles grant nothing.
- For an employee-linked account, operational branch access also requires that
  employee's current active assignment to the target branch.

A global grant or an exact matching branch grant can satisfy a target-branch
permission check, subject to the employee-assignment rule. Future business
modules must derive a resource's branch from trusted database data; they must not
authorize a resource merely from a client-supplied branch ID.

Roles and permissions are read from MySQL at authorization time instead of being
trusted from stale JWT claims. Removing a grant or disabling a role therefore
takes effect on subsequent checks without waiting for the token to expire.
Queries use `DISTINCT` and bounded query counts to avoid duplicated result sets
and N+1 database access.

The reusable forced-password-change middleware returns `403` for future business
routes while `must_change_password` is true. It is intentionally not applied to
`/api/auth/me` or `/api/auth/change-password`.

## Security behavior and boundaries

- Passwords are never trimmed, logged, stored, returned, or embedded in JWTs as
  plaintext. Identifiers may be trimmed before lookup.
- bcrypt applies a per-password random salt and configurable cost before storage.
- Repository SQL is parameterized; request values are never concatenated into
  statements.
- Helmet adds defensive HTTP response headers. CORS remains development-
  permissive until the frontend origin is chosen and must be restricted before
  production.
- Login limiting applies only to the login route. Its in-memory store is suitable
  for the current single-process development setup; horizontally scaled
  production instances require a shared store such as Redis and proxy-aware key
  configuration.
- `audit_logs` is append-only by policy. Successful password changes record safe
  metadata only—never hashes, passwords, tokens, or secrets.
- `mysql2` returns `BIGINT` identifiers as strings to preserve exact values.
- API errors use `400`, `401`, `403`, `404`, `429`, `500`, and `503` as
  appropriate, without exposing stack traces, SQL text, driver internals, or JWT
  verification details.
- Access tokens are stateless. Changing a password cannot immediately revoke a
  token already issued to that account. Short expiry limits this exposure;
  refresh tokens and server-side revocation are intentionally deferred.
- There is no fake logout endpoint: a client logs out by securely deleting its
  token. Server-side session/revocation support requires a future design.
- MFA, password reset email, refresh tokens, public signup, and full account CRUD
  are not part of Phase 3.

## Testing

The integration suite is designed to cover Phase 2 regressions and Phase 3
authentication, password-change, and authorization behavior against the real
test-configured MySQL database. It creates uniquely named authentication-only
fixtures and removes them in reverse foreign-key order, including audit records,
after the run. It does not modify product, inventory, purchase, sale, POS,
transfer, or stock-count data and never drops or recreates the database.

Run it only against a suitable local/development database and application
account:

```bash
npm test
```

The intended checks include:

- health `200`, database health `200`, unknown route `404`, and graceful shutdown;
- login validation `400`, generic invalid credentials `401`, successful login
  `200`, safe response fields, and an updated `last_login_at`;
- missing/malformed/invalid/expired token `401` and valid `/me` access `200`;
- inactive-account rejection and exposed `must_change_password` state;
- password validation, bcrypt storage, audit insertion, flag clearing, and login
  with the changed password;
- global permission success, matching-branch success, cross-branch denial,
  missing-permission denial, inactive-role denial, and active employee assignment
  enforcement;
- login throttling with a clean `429` response;
- complete cleanup of every temporary authentication fixture.

The latest local validation on 2026-09-05 passed all 19 tests. It confirmed the
configured `supermarket_management` connection, all documented HTTP status
behaviors, both graceful-shutdown signals, and zero remaining temporary fixture
rows. Results are environment-specific, so rerun `npm test` after relevant code,
configuration, or database changes.

For quick manual Phase 2 checks after startup:

```bash
curl -i http://localhost:5000/api/health
curl -i http://localhost:5000/api/health/database
curl -i http://localhost:5000/something-that-does-not-exist
```

## Practical concepts

1. **Authentication vs authorization:** authentication establishes the current
   user; authorization checks whether that user has a required capability in the
   applicable scope.
2. **bcrypt:** bcrypt is a deliberately slow, one-way password-hashing function.
   Its cost makes high-volume password guessing more expensive.
3. **Hashing instead of encryption:** an application verifies a password but
   does not need to recover it. A one-way hash avoids storing a decryptable copy.
4. **Salts:** a salt makes identical passwords produce different hashes and
   defeats reusable precomputed hash tables. bcrypt creates and stores the random
   salt and cost inside each encoded hash.
5. **JWT:** a JWT is a compact signed set of claims that the client presents on
   later requests.
6. **This JWT's contents:** the only application identity claim is `sub`, holding
   the user ID as a string. Standard issuer, audience, issued-at, and expiry
   metadata constrain its use.
7. **Signature verification:** the server recomputes and verifies the signature
   before trusting claims. A modified token fails verification.
8. **Secret privacy:** anyone with `JWT_SECRET` can mint tokens that appear valid,
   so it belongs only in secret configuration and must never be committed or
   returned.
9. **Expiration:** expiry limits how long a stolen or stale access token remains
   usable and forces periodic reauthentication.
10. **Bearer authentication:** `Authorization: Bearer <token>` means possession
    of that token is the credential; clients must protect it like a password.
11. **Middleware:** middleware runs common logic before a route handler—for
    example security headers, token authentication, permissions, rate limits,
    and error handling.
12. **Request user context:** after verification and a current database lookup,
    authentication middleware places safe account fields on the request so later
    code does not reparse or blindly trust the token.
13. **Permission chain:** a user receives scoped roles through `user_roles`; an
    active role receives capabilities through `role_permissions`; endpoints ask
    for stable `permission_code` values.
14. **Global vs branch role:** a null role scope applies system-wide; a branch ID
    applies only to that branch. Employee-linked operational access additionally
    requires a current assignment.
15. **Database-current checks:** keeping large permission lists out of JWTs lets
    grant removal and role disabling affect the next authorization decision.
16. **`must_change_password`:** this account flag lets future business routes
    require an initial or administratively reset password to be replaced first.
17. **No public signup:** this is an internal staff system; account creation must
    eventually be an authorized administrative action, not anonymous enrollment.
18. **No fake JWT logout:** stateless access tokens cannot be invalidated merely
    by returning a logout response. The client deletes its token; immediate
    revocation needs persisted server-side state.
19. **Short-lived tokens:** short expiry reduces exposure while refresh-token and
    revocation infrastructure is absent.
20. **Parameterized SQL:** placeholders send values separately from SQL syntax,
    reducing SQL-injection risk and keeping database access consistent.
21. **Generic login failures:** using the same message for unknown users, wrong
    passwords, and inactive accounts prevents easy account enumeration.
22. **Login rate limiting:** throttling repeated attempts raises the cost of
    online guessing without restricting ordinary authenticated API traffic.

## Version control and phase boundary

`.gitignore` excludes `node_modules/`, the real `.env`, npm debug logs, and local
operating-system metadata. It keeps `.env.example`, source files, tests, and both
database documents trackable.

Phase 3 stops at reusable authentication and authorization. It does not include
the frontend, Postman collections, product or stock workflows, POS, sales,
reports, deployment configuration, public registration, refresh tokens, password
reset, MFA, or OAuth. Those require separately reviewed later phases.
