import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import bcrypt from 'bcrypt';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const [{ default: app }, { pool }, accessControl, { ensureAccessControl }, jwt] =
  await Promise.all([
    import('../src/app.js'),
    import('../src/config/database.js'),
    import('../src/config/accessControl.js'),
    import('../src/repositories/accessControlSeed.repository.js'),
    import('../src/utils/jwt.js'),
  ]);

const { ACCESS_CONTROL_PERMISSIONS, SYSTEM_ADMIN_ROLE } = accessControl;
const { signAccessToken } = jwt;
const TEST_TIMEOUT_MS = 600_000;
const TEST_USER_AGENT = 'TEST_PHASE10_CUSTOMERS/1.0';
const MAX_UNSIGNED_BIGINT = '18446744073709551615';

function fixtureDefinition() {
  const token = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();

  return {
    token,
    lower: token.toLowerCase(),
    prefix: `TEST_P10_${token}`,
    requestCounter: 0,
    customerIds: [],
    userIds: [],
    roleIds: [],
    saleNumbers: [],
    setupComplete: false,
    cleaned: false,
  };
}

function placeholders(values) {
  return values.map(() => '?').join(', ');
}

async function lastInsertId(connection) {
  const [rows] = await connection.execute(
    'SELECT CAST(LAST_INSERT_ID() AS CHAR) AS insertedId',
  );
  return rows[0].insertedId;
}

function assertId(value) {
  assert.equal(typeof value, 'string');
  assert.match(value, /^[1-9]\d*$/);
}

function startServer() {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1');
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

function stopServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function send(fixture, baseUrl, path, options = {}) {
  fixture.requestCounter += 1;
  const requestId = `${fixture.prefix}_${fixture.requestCounter}_${options.label ?? 'REQUEST'}`.slice(
    0,
    100,
  );
  const headers = new Headers(options.headers);
  const token = Object.hasOwn(options, 'token')
    ? options.token
    : fixture.tokens.admin;

  if (token) headers.set('authorization', `Bearer ${token}`);
  headers.set('user-agent', TEST_USER_AGENT);
  headers.set('x-request-id', requestId);
  let body;

  if (options.body !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(options.body);
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body,
  });
  const responseText = await response.text();

  return {
    response,
    responseText,
    json: responseText ? JSON.parse(responseText) : null,
    requestId,
  };
}

function assertStatus(result, expectedStatus) {
  assert.equal(result.response.status, expectedStatus, result.responseText);
}

function assertSafeError(result, expectedStatus) {
  assertStatus(result, expectedStatus);
  assert.equal(result.json?.success, false);
  const serialized = JSON.stringify(result.json);

  for (const forbidden of [
    'ER_',
    'sqlMessage',
    'sqlState',
    'uq_customers',
    'constraint',
    'stack',
    'DB_PASSWORD',
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
}

async function createFixture(fixture) {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    const firstSeed = await ensureAccessControl(connection);
    const secondSeed = await ensureAccessControl(connection);

    assert.deepEqual(
      [
        firstSeed.permissionCount,
        firstSeed.assignedPermissionCount,
        secondSeed.permissionCount,
        secondSeed.assignedPermissionCount,
      ],
      [36, 36, 36, 36],
    );
    assert.equal(ACCESS_CONTROL_PERMISSIONS.length, 36);
    assert.equal(new Set(ACCESS_CONTROL_PERMISSIONS.map(({ code }) => code)).size, 36);

    const permissionCodes = ACCESS_CONTROL_PERMISSIONS.map(({ code }) => code);
    const [permissionRows] = await connection.execute(
      `SELECT CAST(permission_id AS CHAR) AS permissionId,
              permission_code AS permissionCode
       FROM permissions
       WHERE permission_code IN (${placeholders(permissionCodes)})`,
      permissionCodes,
    );
    const permissionIds = Object.fromEntries(
      permissionRows.map((row) => [row.permissionCode, row.permissionId]),
    );

    await connection.execute(
      `INSERT INTO branches (
         branch_code, branch_name, address_line_1, city,
         country_code, currency_code, timezone, status
       ) VALUES (?, ?, '10 Customer Test Street', 'Lagos',
                 'NG', 'NGN', 'Africa/Lagos', 'ACTIVE')`,
      [`T10B_${fixture.token}`, `${fixture.prefix} Branch`],
    );
    fixture.branchId = await lastInsertId(connection);

    await connection.execute(
      `INSERT INTO employees (
         employee_number, first_name, last_name, email,
         hire_date, employment_status
       ) VALUES (?, 'Phase', 'Ten', ?, '2020-01-01', 'ACTIVE')`,
      [
        `T10E_${fixture.token}`,
        `test_p10.employee.${fixture.lower}@example.invalid`,
      ],
    );
    fixture.employeeId = await lastInsertId(connection);

    const roleDefinitions = {
      read: ['customers.read'],
      manage: ['customers.manage'],
      both: ['customers.read', 'customers.manage'],
      unrelated: permissionCodes.filter(
        (code) => !code.startsWith('customers.'),
      ),
      scoped: ['customers.read', 'customers.manage'],
      none: [],
    };
    fixture.roleIdsByName = {};

    for (const [name, codes] of Object.entries(roleDefinitions)) {
      await connection.execute(
        `INSERT INTO roles (role_code, role_name, description, is_active)
         VALUES (?, ?, 'Temporary Phase 10 role', 1)`,
        [
          `T10_${name.toUpperCase()}_${fixture.token}`,
          `${fixture.prefix} ${name}`,
        ],
      );
      const roleId = await lastInsertId(connection);
      fixture.roleIds.push(roleId);
      fixture.roleIdsByName[name] = roleId;

      for (const code of codes) {
        await connection.execute(
          'INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
          [roleId, permissionIds[code]],
        );
      }
    }

    const [systemRows] = await connection.execute(
      `SELECT CAST(role_id AS CHAR) AS roleId, is_active AS isActive
       FROM roles
       WHERE role_code = ?`,
      [SYSTEM_ADMIN_ROLE.code],
    );
    assert.equal(systemRows.length, 1);
    assert.equal(systemRows[0].isActive, 1);
    fixture.systemRoleId = systemRows[0].roleId;

    const passwordHash = await bcrypt.hash(
      `Phase10-${fixture.token}-Password!`,
      Number(process.env.BCRYPT_ROUNDS),
    );
    const userDefinitions = [
      ['admin', 0, fixture.systemRoleId, null],
      ['must', 1, fixture.systemRoleId, null],
      ['read', 0, fixture.roleIdsByName.read, null],
      ['manage', 0, fixture.roleIdsByName.manage, null],
      ['both', 0, fixture.roleIdsByName.both, null],
      ['unrelated', 0, fixture.roleIdsByName.unrelated, null],
      ['scoped', 0, fixture.roleIdsByName.scoped, fixture.branchId],
      ['none', 0, fixture.roleIdsByName.none, null],
    ];
    fixture.tokens = {};

    for (const [name, mustChange, roleId, branchId] of userDefinitions) {
      await connection.execute(
        `INSERT INTO users (
           username, email, password_hash, is_active, must_change_password
         ) VALUES (?, ?, ?, 1, ?)`,
        [
          `t10.${name}.${fixture.lower}`,
          `t10.${name}.${fixture.lower}@example.invalid`,
          passwordHash,
          mustChange,
        ],
      );
      const userId = await lastInsertId(connection);
      fixture.userIds.push(userId);
      await connection.execute(
        `INSERT INTO user_roles (
           user_id, role_id, branch_id, assigned_by_user_id
         ) VALUES (?, ?, ?, NULL)`,
        [userId, roleId, branchId],
      );
      fixture.tokens[name] = signAccessToken(userId).accessToken;
    }

    await connection.commit();
    fixture.setupComplete = true;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function cleanupFixture(fixture) {
  if (!fixture.setupComplete || fixture.cleaned) return;
  const connection = await pool.getConnection();
  const marker = `${fixture.prefix}%`;

  try {
    await connection.beginTransaction();
    await connection.execute(
      'DELETE FROM audit_logs WHERE request_id LIKE ?',
      [marker],
    );
    await connection.execute(
      'DELETE FROM sales WHERE sale_number LIKE ?',
      [marker],
    );
    await connection.execute(
      `DELETE FROM customers
       WHERE first_name LIKE ? OR last_name LIKE ? OR business_name LIKE ?
          OR email LIKE ? OR phone LIKE ? OR loyalty_number LIKE ?`,
      [marker, marker, marker, marker, marker, marker],
    );
    await connection.execute(
      `DELETE FROM users
       WHERE username LIKE 't10.%' AND email LIKE ?`,
      [`t10.%.${fixture.lower}@example.invalid`],
    );

    if (fixture.roleIds.length > 0) {
      await connection.execute(
        `DELETE FROM roles WHERE role_id IN (${placeholders(fixture.roleIds)})`,
        fixture.roleIds,
      );
    }

    await connection.execute(
      'DELETE FROM employees WHERE employee_number = ?',
      [`T10E_${fixture.token}`],
    );
    await connection.execute(
      'DELETE FROM branches WHERE branch_code = ?',
      [`T10B_${fixture.token}`],
    );
    await connection.commit();

    const checks = [
      ['audit_logs', 'request_id', marker],
      ['sales', 'sale_number', marker],
      ['customers', 'email', marker],
      ['roles', 'role_name', marker],
      ['branches', 'branch_name', marker],
    ];

    for (const [table, column, value] of checks) {
      const [rows] = await connection.execute(
        `SELECT COUNT(*) AS count FROM ${table} WHERE ${column} LIKE ?`,
        [value],
      );
      assert.equal(rows[0].count, '0', `${table} cleanup left TEST_P10 rows`);
    }

    const [customerRows] = await connection.execute(
      `SELECT COUNT(*) AS count
       FROM customers
       WHERE first_name LIKE ? OR last_name LIKE ? OR business_name LIKE ?
          OR phone LIKE ? OR loyalty_number LIKE ?`,
      [marker, marker, marker, marker, marker],
    );
    assert.equal(customerRows[0].count, '0');
    fixture.cleaned = true;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

function customerBody(fixture, suffix, overrides = {}) {
  return {
    customerType: 'INDIVIDUAL',
    firstName: `${fixture.prefix}_${suffix}_FIRST`,
    lastName: `${fixture.prefix}_${suffix}_LAST`,
    email: `${fixture.prefix}.${suffix}@example.invalid`.toLowerCase(),
    phone: `${fixture.prefix}_${suffix}`.slice(0, 30),
    ...overrides,
  };
}

async function createCustomer(fixture, baseUrl, suffix, overrides = {}, options = {}) {
  const result = await send(fixture, baseUrl, '/api/admin/customers', {
    method: 'POST',
    label: `CREATE_${suffix}`,
    token: options.token ?? fixture.tokens.admin,
    body: customerBody(fixture, suffix, overrides),
  });

  if (result.response.status === 201) {
    const customer = result.json.data.customer;
    assertId(customer.customerId);
    fixture.customerIds.push(customer.customerId);
  }

  return result;
}

async function auditRowsForRequest(requestId) {
  const [rows] = await pool.execute(
    `SELECT
       CAST(audit_log_id AS CHAR) AS auditLogId,
       CAST(user_id AS CHAR) AS userId,
       CAST(employee_id AS CHAR) AS employeeId,
       CAST(branch_id AS CHAR) AS branchId,
       action_type AS actionType,
       entity_type AS entityType,
       entity_record_id AS entityRecordId,
       before_values AS beforeValues,
       after_values AS afterValues
     FROM audit_logs
     WHERE request_id = ?
     ORDER BY audit_log_id`,
    [requestId],
  );
  return rows;
}

async function tableCounts(tableNames) {
  const snapshot = {};

  for (const table of tableNames) {
    const [rows] = await pool.query(`SELECT COUNT(*) AS count FROM ${table}`);
    snapshot[table] = rows[0].count;
  }

  return snapshot;
}

test(
  'Phase 10 global customer-master integration',
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const fixture = fixtureDefinition();
    let server;

    try {
      await createFixture(fixture);
      server = await startServer();
      const address = server.address();
      const baseUrl = `http://127.0.0.1:${address.port}`;

      await t.test('exposes exactly four safe global customer routes', async () => {
        const routeSource = await readFile(
          new URL('../src/routes/admin/customer.routes.js', import.meta.url),
          'utf8',
        );
        const adminSource = await readFile(
          new URL('../src/routes/admin/index.js', import.meta.url),
          'utf8',
        );
        const routeDefinitions = [
          ...routeSource.matchAll(/router\.(get|post|patch|put|delete)\s*\(\s*['"]([^'"]+)['"]/g),
        ].map((match) => `${match[1].toUpperCase()} ${match[2]}`);

        assert.deepEqual(routeDefinitions, [
          'GET /',
          'POST /',
          'GET /:customerId',
          'PATCH /:customerId',
        ]);
        assert.equal(new Set(routeDefinitions).size, 4);
        assert.match(adminSource, /router\.use\(['"]\/customers['"], customerRouter\)/);
        assert.doesNotMatch(routeSource, /router\.delete|account|balance|credit|points|sales/i);

        for (const path of [
          '/api/admin/customers/1/account',
          '/api/admin/customers/1/balance',
          `/api/admin/branches/${fixture.branchId}/customers`,
          '/api/admin/pos-registers',
        ]) {
          const result = await send(fixture, baseUrl, path, {
            label: 'ABSENT_ROUTE',
          });
          assertStatus(result, 404);
        }
      });

      await t.test('enforces the complete global authorization matrix', async () => {
        const validBody = customerBody(fixture, 'AUTH');
        const routes = [
          ['GET', '/api/admin/customers', undefined],
          ['POST', '/api/admin/customers', validBody],
          ['GET', `/api/admin/customers/${MAX_UNSIGNED_BIGINT}`, undefined],
          ['PATCH', `/api/admin/customers/${MAX_UNSIGNED_BIGINT}`, { status: 'ACTIVE' }],
        ];

        for (const [name, token, status] of [
          ['unauthenticated', null, 401],
          ['must-change', fixture.tokens.must, 403],
          ['no-permission', fixture.tokens.none, 403],
          ['unrelated', fixture.tokens.unrelated, 403],
          ['branch-scoped', fixture.tokens.scoped, 403],
        ]) {
          for (const [method, path, body] of routes) {
            const result = await send(fixture, baseUrl, path, {
              method,
              body,
              token,
              label: `AUTH_${name}`,
            });
            assertSafeError(result, status);
          }
        }

        const readList = await send(fixture, baseUrl, '/api/admin/customers', {
          token: fixture.tokens.read,
          label: 'READ_LIST',
        });
        assertStatus(readList, 200);
        const readDetail = await send(
          fixture,
          baseUrl,
          `/api/admin/customers/${MAX_UNSIGNED_BIGINT}`,
          { token: fixture.tokens.read, label: 'READ_DETAIL' },
        );
        assertSafeError(readDetail, 404);

        for (const [method, path, body] of routes.filter(([method]) => method !== 'GET')) {
          const result = await send(fixture, baseUrl, path, {
            method,
            body,
            token: fixture.tokens.read,
            label: 'READ_WRITE_DENIED',
          });
          assertSafeError(result, 403);
        }

        for (const path of [
          '/api/admin/customers',
          `/api/admin/customers/${MAX_UNSIGNED_BIGINT}`,
        ]) {
          const result = await send(fixture, baseUrl, path, {
            token: fixture.tokens.manage,
            label: 'MANAGE_READ_DENIED',
          });
          assertSafeError(result, 403);
        }

        const managed = await createCustomer(
          fixture,
          baseUrl,
          'MANAGE_ALLOWED',
          {},
          { token: fixture.tokens.manage },
        );
        assertStatus(managed, 201);
        const managedId = managed.json.data.customer.customerId;
        const managedPatch = await send(
          fixture,
          baseUrl,
          `/api/admin/customers/${managedId}`,
          {
            method: 'PATCH',
            token: fixture.tokens.manage,
            label: 'MANAGE_PATCH_ALLOWED',
            body: { status: 'INACTIVE' },
          },
        );
        assertStatus(managedPatch, 200);

        for (const [name, token] of [
          ['both', fixture.tokens.both],
          ['unlinked-system-admin', fixture.tokens.admin],
        ]) {
          const created = await createCustomer(
            fixture,
            baseUrl,
            `AUTH_${name}`,
            {},
            { token },
          );
          assertStatus(created, 201);
          const id = created.json.data.customer.customerId;
          assertStatus(
            await send(fixture, baseUrl, '/api/admin/customers', {
              token,
              label: `AUTH_${name}_LIST`,
            }),
            200,
          );
          assertStatus(
            await send(fixture, baseUrl, `/api/admin/customers/${id}`, {
              token,
              label: `AUTH_${name}_DETAIL`,
            }),
            200,
          );
          assertStatus(
            await send(fixture, baseUrl, `/api/admin/customers/${id}`, {
              method: 'PATCH',
              token,
              label: `AUTH_${name}_PATCH`,
              body: { status: 'BLOCKED' },
            }),
            200,
          );
        }
      });

      await t.test('creates normalized individual and business profiles with audits', async () => {
        const individual = await createCustomer(fixture, baseUrl, 'INDIVIDUAL', {
          firstName: `  ${fixture.prefix}_Ada  `,
          lastName: `  ${fixture.prefix}_Okafor  `,
          businessName: `${fixture.prefix} Side Business`,
          email: `  ${fixture.prefix}.UPPER@EXAMPLE.INVALID  `,
          phone: `  ${fixture.prefix}_PHONE  `.slice(0, 30),
          loyaltyNumber: `00${fixture.prefix}_LOYALTY`.slice(0, 50),
          dateOfBirth: '2099-12-31',
          status: 'ACTIVE',
        });
        assertStatus(individual, 201);
        const individualCustomer = individual.json.data.customer;
        assert.equal(individualCustomer.firstName, `${fixture.prefix}_Ada`);
        assert.equal(individualCustomer.lastName, `${fixture.prefix}_Okafor`);
        assert.equal(individualCustomer.email, `${fixture.prefix}.upper@example.invalid`.toLowerCase());
        assert.equal(individualCustomer.dateOfBirth, '2099-12-31');
        assert.equal(individualCustomer.customerNumber.length, 32);
        assert.match(individualCustomer.customerNumber, /^CUS_[0-9A-F]{28}$/);
        assert.equal(Object.hasOwn(individualCustomer, 'balance'), false);

        const business = await createCustomer(fixture, baseUrl, 'BUSINESS', {
          customerType: 'BUSINESS',
          firstName: `${fixture.prefix}_Contact`,
          lastName: `${fixture.prefix}_Person`,
          businessName: `  ${fixture.prefix} Stores Ltd  `,
          email: null,
          phone: null,
          loyaltyNumber: null,
          dateOfBirth: null,
          status: 'INACTIVE',
        });
        assertStatus(business, 201);
        const businessCustomer = business.json.data.customer;
        assert.equal(businessCustomer.businessName, `${fixture.prefix} Stores Ltd`);
        assert.equal(businessCustomer.firstName, `${fixture.prefix}_Contact`);
        assert.equal(businessCustomer.email, null);
        assert.equal(businessCustomer.status, 'INACTIVE');
        assert.notEqual(businessCustomer.customerNumber, individualCustomer.customerNumber);

        for (const result of [individual, business]) {
          const audits = await auditRowsForRequest(result.requestId);
          assert.equal(audits.length, 1);
          assert.equal(audits[0].actionType, 'CUSTOMER_CREATED');
          assert.equal(audits[0].entityType, 'customers');
          assert.equal(audits[0].userId, fixture.userIds[0]);
          assert.equal(audits[0].employeeId, null);
          assert.equal(audits[0].branchId, null);
          assert.equal(audits[0].beforeValues, null);
          assert.equal(audits[0].afterValues.customerId, audits[0].entityRecordId);
          assert.equal(Object.hasOwn(audits[0].afterValues, 'password'), false);
        }
      });

      await t.test('rejects invalid shapes, fields, enums, lengths, and dates', async () => {
        const invalidBodies = [
          {},
          { firstName: 'Ada', lastName: 'Okafor' },
          { customerType: 'INDIVIDUAL', lastName: 'Okafor' },
          { customerType: 'INDIVIDUAL', firstName: 'Ada' },
          { customerType: 'BUSINESS' },
          { customerType: 'PERSON', firstName: 'Ada', lastName: 'Okafor' },
          customerBody(fixture, 'BAD_STATUS', { status: 'SUSPENDED' }),
          customerBody(fixture, 'BLANK_FIRST', { firstName: '   ' }),
          customerBody(fixture, 'BLANK_OPTIONAL_EMAIL', { email: '   ' }),
          customerBody(fixture, 'BLANK_OPTIONAL_PHONE', { phone: '   ' }),
          customerBody(fixture, 'BLANK_OPTIONAL_LOYALTY', { loyaltyNumber: '   ' }),
          customerBody(fixture, 'BAD_EMAIL', { email: 'not-an-email' }),
          customerBody(fixture, 'BAD_DATE_FORMAT', { dateOfBirth: '01/02/2000' }),
          customerBody(fixture, 'BAD_DATE_CALENDAR', { dateOfBirth: '2025-02-29' }),
          customerBody(fixture, 'LONG_FIRST', { firstName: 'A'.repeat(101) }),
          customerBody(fixture, 'LONG_LAST', { lastName: 'B'.repeat(101) }),
          customerBody(fixture, 'LONG_BUSINESS', {
            customerType: 'BUSINESS',
            businessName: 'C'.repeat(181),
          }),
          customerBody(fixture, 'LONG_EMAIL', {
            email: `${'a'.repeat(250)}@test.invalid`,
          }),
          customerBody(fixture, 'LONG_PHONE', { phone: '1'.repeat(31) }),
          customerBody(fixture, 'LONG_LOYALTY', { loyaltyNumber: '0'.repeat(51) }),
        ];

        for (const body of invalidBodies) {
          const result = await send(fixture, baseUrl, '/api/admin/customers', {
            method: 'POST',
            body,
            label: 'INVALID_CREATE',
          });
          assertSafeError(result, 400);
          assert.equal((await auditRowsForRequest(result.requestId)).length, 0);
        }

        const forbiddenFields = [
          'customerId', 'customer_id', 'customerNumber', 'customer_number',
          'createdAt', 'created_at', 'updatedAt', 'updated_at', 'balance',
          'creditLimit', 'storeCredit', 'loyaltyPoints', 'points',
          'accountNumber', 'branchId', 'createdByEmployeeId', 'updatedByEmployeeId',
        ];

        for (const field of forbiddenFields) {
          const result = await send(fixture, baseUrl, '/api/admin/customers', {
            method: 'POST',
            label: `FORBIDDEN_${field}`,
            body: { ...customerBody(fixture, `FIELD_${field}`), [field]: '1' },
          });
          assertSafeError(result, 400);
        }
      });

      await t.test('enforces loyalty uniqueness but not email or phone uniqueness', async () => {
        const sharedEmail = `${fixture.prefix}.shared@example.invalid`.toLowerCase();
        const sharedPhone = `${fixture.prefix}_SHARED`.slice(0, 30);
        const first = await createCustomer(fixture, baseUrl, 'SHARED_1', {
          email: sharedEmail,
          phone: sharedPhone,
          loyaltyNumber: null,
        });
        const second = await createCustomer(fixture, baseUrl, 'SHARED_2', {
          email: sharedEmail,
          phone: sharedPhone,
          loyaltyNumber: null,
        });
        assertStatus(first, 201);
        assertStatus(second, 201);

        const loyalty = `${fixture.prefix}_CaseLoyalty`.slice(0, 50);
        assertStatus(
          await createCustomer(fixture, baseUrl, 'LOYALTY_1', {
            loyaltyNumber: loyalty,
          }),
          201,
        );
        const duplicate = await createCustomer(fixture, baseUrl, 'LOYALTY_2', {
          loyaltyNumber: loyalty.toLowerCase(),
        });
        assertSafeError(duplicate, 409);
        assert.equal((await auditRowsForRequest(duplicate.requestId)).length, 0);

        const [rows] = await pool.execute(
          'SELECT COUNT(*) AS count FROM customers WHERE loyalty_number = ?',
          [loyalty],
        );
        assert.equal(rows[0].count, '1');
      });

      await t.test('validates BIGINT IDs, PATCH final state, status, and no-op behavior', async () => {
        assertSafeError(
          await send(fixture, baseUrl, '/api/admin/customers/not-an-id', {
            label: 'MALFORMED_ID',
          }),
          400,
        );
        assertSafeError(
          await send(
            fixture,
            baseUrl,
            `/api/admin/customers/${MAX_UNSIGNED_BIGINT}`,
            { label: 'MAX_ID' },
          ),
          404,
        );

        const individual = await createCustomer(fixture, baseUrl, 'PATCH_INDIVIDUAL', {
          businessName: null,
        });
        const individualId = individual.json.data.customer.customerId;
        assertSafeError(
          await send(fixture, baseUrl, `/api/admin/customers/${individualId}`, {
            method: 'PATCH',
            label: 'EMPTY_PATCH',
            body: {},
          }),
          400,
        );
        assertSafeError(
          await send(fixture, baseUrl, `/api/admin/customers/${individualId}`, {
            method: 'PATCH',
            label: 'UNKNOWN_PATCH',
            body: { balance: '10.00' },
          }),
          400,
        );
        assertSafeError(
          await send(fixture, baseUrl, `/api/admin/customers/${individualId}`, {
            method: 'PATCH',
            label: 'INVALID_TRANSITION',
            body: { customerType: 'BUSINESS' },
          }),
          400,
        );
        const toBusiness = await send(
          fixture,
          baseUrl,
          `/api/admin/customers/${individualId}`,
          {
            method: 'PATCH',
            label: 'TO_BUSINESS',
            body: {
              customerType: 'BUSINESS',
              businessName: `${fixture.prefix} Converted Ltd`,
            },
          },
        );
        assertStatus(toBusiness, 200);
        assert.equal(toBusiness.json.data.customer.customerType, 'BUSINESS');
        assert.equal(
          toBusiness.json.data.customer.firstName,
          individual.json.data.customer.firstName,
        );

        const business = await createCustomer(fixture, baseUrl, 'PATCH_BUSINESS', {
          customerType: 'BUSINESS',
          firstName: null,
          lastName: null,
          businessName: `${fixture.prefix} Business Only`,
        });
        const businessId = business.json.data.customer.customerId;
        assertSafeError(
          await send(fixture, baseUrl, `/api/admin/customers/${businessId}`, {
            method: 'PATCH',
            label: 'INVALID_TO_INDIVIDUAL',
            body: { customerType: 'INDIVIDUAL' },
          }),
          400,
        );
        const toIndividual = await send(
          fixture,
          baseUrl,
          `/api/admin/customers/${businessId}`,
          {
            method: 'PATCH',
            label: 'TO_INDIVIDUAL',
            body: {
              customerType: 'INDIVIDUAL',
              firstName: `${fixture.prefix}_Converted`,
              lastName: `${fixture.prefix}_Person`,
            },
          },
        );
        assertStatus(toIndividual, 200);
        assert.equal(
          toIndividual.json.data.customer.businessName,
          business.json.data.customer.businessName,
        );

        for (const status of ['ACTIVE', 'INACTIVE', 'BLOCKED']) {
          const result = await send(
            fixture,
            baseUrl,
            `/api/admin/customers/${businessId}`,
            {
              method: 'PATCH',
              label: `STATUS_${status}`,
              body: { status },
            },
          );
          assertStatus(result, 200);
          assert.equal(result.json.data.customer.status, status);
        }

        const beforeNoOp = await send(
          fixture,
          baseUrl,
          `/api/admin/customers/${businessId}`,
          { label: 'BEFORE_NOOP' },
        );
        const noOp = await send(
          fixture,
          baseUrl,
          `/api/admin/customers/${businessId}`,
          {
            method: 'PATCH',
            label: 'NOOP',
            body: { status: 'BLOCKED' },
          },
        );
        assertStatus(noOp, 200);
        assert.equal(
          noOp.json.data.customer.updatedAt,
          beforeNoOp.json.data.customer.updatedAt,
        );
        assert.equal((await auditRowsForRequest(noOp.requestId)).length, 0);
      });

      await t.test('supports bounded deterministic lists, search, and exact filters', async () => {
        const individual = await createCustomer(fixture, baseUrl, 'LIST_UNIQUE', {
          firstName: `${fixture.prefix}_SearchGiven`,
          lastName: `${fixture.prefix}_SearchFamily`,
          email: `${fixture.prefix}.search@example.invalid`.toLowerCase(),
          phone: `${fixture.prefix}_SEARCHPHONE`.slice(0, 30),
          loyaltyNumber: `${fixture.prefix}_SEARCHLOYALTY`.slice(0, 50),
          status: 'BLOCKED',
        });
        const business = await createCustomer(fixture, baseUrl, 'LIST_BUSINESS', {
          customerType: 'BUSINESS',
          businessName: `${fixture.prefix} Search Enterprise`,
          status: 'INACTIVE',
        });
        const individualCustomer = individual.json.data.customer;
        const businessCustomer = business.json.data.customer;

        const defaultList = await send(fixture, baseUrl, '/api/admin/customers', {
          label: 'LIST_DEFAULT',
        });
        assertStatus(defaultList, 200);
        assert.equal(defaultList.json.data.pagination.page, 1);
        assert.equal(defaultList.json.data.pagination.limit, 20);
        assert.ok(defaultList.json.data.pagination.totalItems >= 2);

        const firstPage = await send(
          fixture,
          baseUrl,
          '/api/admin/customers?page=1&limit=1',
          { label: 'LIST_PAGE_1' },
        );
        const secondPage = await send(
          fixture,
          baseUrl,
          '/api/admin/customers?page=2&limit=1',
          { label: 'LIST_PAGE_2' },
        );
        assertStatus(firstPage, 200);
        assertStatus(secondPage, 200);
        assert.notEqual(
          firstPage.json.data.items[0].customerId,
          secondPage.json.data.items[0].customerId,
        );
        const repeated = await send(
          fixture,
          baseUrl,
          '/api/admin/customers?page=1&limit=1',
          { label: 'LIST_REPEAT' },
        );
        assert.equal(
          repeated.json.data.items[0].customerId,
          firstPage.json.data.items[0].customerId,
        );

        const searches = [
          individualCustomer.customerNumber,
          'SearchGiven',
          'SearchFamily',
          'Search Enterprise',
          individualCustomer.email,
          individualCustomer.phone,
          individualCustomer.loyaltyNumber,
        ];

        for (const search of searches) {
          const result = await send(
            fixture,
            baseUrl,
            `/api/admin/customers?search=${encodeURIComponent(search)}`,
            { label: 'LIST_SEARCH' },
          );
          assertStatus(result, 200);
          assert.ok(
            result.json.data.items.some(({ customerId }) =>
              [individualCustomer.customerId, businessCustomer.customerId].includes(
                customerId,
              )),
          );
        }

        const exactFilters = [
          ['customerType', 'INDIVIDUAL', individualCustomer.customerId],
          ['status', 'BLOCKED', individualCustomer.customerId],
          ['loyaltyNumber', individualCustomer.loyaltyNumber, individualCustomer.customerId],
          ['email', individualCustomer.email, individualCustomer.customerId],
          ['phone', individualCustomer.phone, individualCustomer.customerId],
        ];

        for (const [key, value, expectedId] of exactFilters) {
          const result = await send(
            fixture,
            baseUrl,
            `/api/admin/customers?${key}=${encodeURIComponent(value)}`,
            { label: `FILTER_${key}` },
          );
          assertStatus(result, 200);
          assert.ok(result.json.data.items.some(({ customerId }) => customerId === expectedId));
        }

        const empty = await send(
          fixture,
          baseUrl,
          `/api/admin/customers?email=${fixture.prefix}.missing@example.invalid`,
          { label: 'LIST_EMPTY' },
        );
        assertStatus(empty, 200);
        assert.equal(empty.json.data.items.length, 0);
        assert.equal(empty.json.data.pagination.totalItems, 0);
        assertSafeError(
          await send(fixture, baseUrl, '/api/admin/customers?limit=101', {
            label: 'LIST_LIMIT',
          }),
          400,
        );
        assertSafeError(
          await send(fixture, baseUrl, '/api/admin/customers?sort=customerId', {
            label: 'LIST_UNKNOWN',
          }),
          400,
        );
      });

      await t.test('serializes disjoint same-customer patches without lost updates', async () => {
        const created = await createCustomer(fixture, baseUrl, 'PATCH_RACE');
        const id = created.json.data.customer.customerId;
        const email = `${fixture.prefix}.race@example.invalid`.toLowerCase();
        const phone = `${fixture.prefix}_RACE_PHONE`.slice(0, 30);
        const [emailResult, phoneResult] = await Promise.all([
          send(fixture, baseUrl, `/api/admin/customers/${id}`, {
            method: 'PATCH',
            label: 'RACE_EMAIL',
            body: { email },
          }),
          send(fixture, baseUrl, `/api/admin/customers/${id}`, {
            method: 'PATCH',
            label: 'RACE_PHONE',
            body: { phone },
          }),
        ]);
        assertStatus(emailResult, 200);
        assertStatus(phoneResult, 200);
        const detail = await send(fixture, baseUrl, `/api/admin/customers/${id}`, {
          label: 'RACE_DETAIL',
        });
        assert.equal(detail.json.data.customer.email, email);
        assert.equal(detail.json.data.customer.phone, phone);

        const requestIds = [emailResult.requestId, phoneResult.requestId];
        const [rows] = await pool.execute(
          `SELECT before_values AS beforeValues, after_values AS afterValues
           FROM audit_logs
           WHERE request_id IN (${placeholders(requestIds)})
           ORDER BY audit_log_id`,
          requestIds,
        );
        assert.equal(rows.length, 2);
        assert.deepEqual(rows[1].beforeValues, rows[0].afterValues);
        assert.equal(rows[1].afterValues.email, email);
        assert.equal(rows[1].afterValues.phone, phone);
      });

      await t.test('makes duplicate-loyalty and type-transition races safe', async () => {
        const loyalty = `${fixture.prefix}_RACE_LOYALTY`.slice(0, 50);
        const raceResults = await Promise.all([
          createCustomer(fixture, baseUrl, 'LOY_RACE_1', { loyaltyNumber: loyalty }),
          createCustomer(fixture, baseUrl, 'LOY_RACE_2', { loyaltyNumber: loyalty }),
        ]);
        assert.deepEqual(
          raceResults.map(({ response }) => response.status).sort(),
          [201, 409],
        );
        const auditCounts = await Promise.all(
          raceResults.map(async ({ requestId }) => (await auditRowsForRequest(requestId)).length),
        );
        assert.deepEqual(auditCounts.sort(), [0, 1]);

        const created = await createCustomer(fixture, baseUrl, 'TYPE_RACE', {
          customerType: 'BUSINESS',
          businessName: `${fixture.prefix} Initial Business`,
          firstName: `${fixture.prefix}_Initial`,
          lastName: `${fixture.prefix}_Person`,
        });
        const id = created.json.data.customer.customerId;
        const typeResults = await Promise.all([
          send(fixture, baseUrl, `/api/admin/customers/${id}`, {
            method: 'PATCH',
            label: 'TYPE_RACE_BUSINESS',
            body: {
              customerType: 'BUSINESS',
              businessName: `${fixture.prefix} Final Business`,
            },
          }),
          send(fixture, baseUrl, `/api/admin/customers/${id}`, {
            method: 'PATCH',
            label: 'TYPE_RACE_INDIVIDUAL',
            body: {
              customerType: 'INDIVIDUAL',
              firstName: `${fixture.prefix}_Final`,
              lastName: `${fixture.prefix}_Customer`,
            },
          }),
        ]);
        assert.deepEqual(typeResults.map(({ response }) => response.status), [200, 200]);
        const detail = await send(fixture, baseUrl, `/api/admin/customers/${id}`, {
          label: 'TYPE_RACE_DETAIL',
        });
        const finalCustomer = detail.json.data.customer;
        assert.ok(
          finalCustomer.customerType === 'INDIVIDUAL'
            ? finalCustomer.firstName && finalCustomer.lastName
            : finalCustomer.businessName,
        );
      });

      await t.test('preserves historical sale references and exposes no delete', async () => {
        const created = await createCustomer(fixture, baseUrl, 'HISTORY');
        const customerId = created.json.data.customer.customerId;
        const saleNumber = `${fixture.prefix}_SALE`;
        fixture.saleNumbers.push(saleNumber);
        await pool.execute(
          `INSERT INTO sales (
             sale_number, branch_id, customer_id, cashier_employee_id,
             status, currency_code
           ) VALUES (?, ?, ?, ?, 'OPEN', 'NGN')`,
          [saleNumber, fixture.branchId, customerId, fixture.employeeId],
        );
        const [beforeRows] = await pool.execute(
          `SELECT CAST(sale_id AS CHAR) AS saleId,
                  sale_number AS saleNumber,
                  CAST(customer_id AS CHAR) AS customerId,
                  status, subtotal_amount AS subtotalAmount,
                  total_amount AS totalAmount
           FROM sales WHERE sale_number = ?`,
          [saleNumber],
        );
        const patch = await send(
          fixture,
          baseUrl,
          `/api/admin/customers/${customerId}`,
          { method: 'PATCH', label: 'HISTORY_PATCH', body: { status: 'INACTIVE' } },
        );
        assertStatus(patch, 200);
        const [afterRows] = await pool.execute(
          `SELECT CAST(sale_id AS CHAR) AS saleId,
                  sale_number AS saleNumber,
                  CAST(customer_id AS CHAR) AS customerId,
                  status, subtotal_amount AS subtotalAmount,
                  total_amount AS totalAmount
           FROM sales WHERE sale_number = ?`,
          [saleNumber],
        );
        assert.deepEqual(afterRows, beforeRows);
        assertStatus(
          await send(fixture, baseUrl, `/api/admin/customers/${customerId}`, {
            label: 'HISTORY_READ',
          }),
          200,
        );
        assertStatus(
          await send(fixture, baseUrl, `/api/admin/customers/${customerId}`, {
            method: 'DELETE',
            label: 'DELETE_ABSENT',
          }),
          404,
        );
      });

      await t.test('does not mutate unrelated domains and suppresses GET audits', async () => {
        const tables = [
          'branches', 'products', 'product_variants', 'product_packages',
          'product_barcodes', 'branch_variant_prices', 'branch_package_prices',
          'suppliers', 'purchase_orders', 'goods_receipts', 'branch_inventory',
          'inventory_lots', 'inventory_transactions', 'inventory_adjustments',
          'stock_counts', 'stock_transfers', 'sales',
        ];
        const before = await tableCounts(tables);
        const created = await createCustomer(fixture, baseUrl, 'NONMUTATION', {
          status: 'ACTIVE',
        });
        const id = created.json.data.customer.customerId;
        const updated = await send(fixture, baseUrl, `/api/admin/customers/${id}`, {
          method: 'PATCH',
          label: 'NONMUTATION_PATCH',
          body: { phone: `${fixture.prefix}_NM`.slice(0, 30) },
        });
        assertStatus(updated, 200);
        const getResult = await send(fixture, baseUrl, `/api/admin/customers/${id}`, {
          label: 'GET_NO_AUDIT',
        });
        assertStatus(getResult, 200);
        assert.equal((await auditRowsForRequest(getResult.requestId)).length, 0);
        assert.deepEqual(await tableCounts(tables), before);
      });
    } finally {
      const cleanupErrors = [];

      try {
        await stopServer(server);
      } catch (error) {
        cleanupErrors.push(error);
      }

      try {
        await cleanupFixture(fixture);
      } catch (error) {
        cleanupErrors.push(error);
      }

      try {
        await pool.end();
      } catch (error) {
        cleanupErrors.push(error);
      }

      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'Phase 10 cleanup failed');
      }
    }
  },
);
