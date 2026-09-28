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
const TEST_USER_AGENT = 'TEST_PHASE11_POS/1.0';
const MAX_UNSIGNED_BIGINT = '18446744073709551615';

function fixtureDefinition() {
  const token = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();

  return {
    token,
    lower: token.toLowerCase(),
    prefix: `TEST_P11_${token}`,
    requestCounter: 0,
    branchIds: [],
    employeeIds: [],
    assignmentIds: [],
    roleIds: [],
    userIds: [],
    registerIds: [],
    tillIds: [],
    movementIds: [],
    saleIds: [],
    paymentIds: [],
    paymentMethodIds: [],
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
  const requestId = `${fixture.prefix}_${fixture.requestCounter}_${options.label ?? 'REQUEST'}`.slice(0, 100);
  const token = Object.hasOwn(options, 'token')
    ? options.token
    : fixture.tokens.admin;
  const headers = new Headers(options.headers);

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
    'ER_', 'sqlMessage', 'sqlState', 'constraint', 'stack',
    'DB_PASSWORD', 'uq_pos_', 'uq_till_',
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
      [45, 45, 45, 45],
    );
    assert.equal(ACCESS_CONTROL_PERMISSIONS.length, 45);
    assert.equal(new Set(ACCESS_CONTROL_PERMISSIONS.map(({ code }) => code)).size, 45);

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

    const branchDefinitions = [
      ['A', 'ACTIVE', 'NGN'],
      ['B', 'ACTIVE', 'NGN'],
      ['C', 'INACTIVE', 'NGN'],
    ];
    fixture.branchByName = {};

    for (const [name, status, currency] of branchDefinitions) {
      await connection.execute(
        `INSERT INTO branches (
           branch_code, branch_name, address_line_1, city,
           country_code, currency_code, timezone, status
         ) VALUES (?, ?, '11 POS Test Street', 'Lagos',
                   'NG', ?, 'Africa/Lagos', ?)`,
        [`T11${name}_${fixture.token}`, `${fixture.prefix} Branch ${name}`, currency, status],
      );
      const id = await lastInsertId(connection);
      fixture.branchIds.push(id);
      fixture.branchByName[name] = id;
    }
    fixture.branchAId = fixture.branchByName.A;
    fixture.branchBId = fixture.branchByName.B;
    fixture.inactiveBranchId = fixture.branchByName.C;

    const employees = [
      ['operator', 'ACTIVE', null],
      ['operator2', 'ACTIVE', null],
      ['cashier1', 'ACTIVE', null],
      ['cashier2', 'ACTIVE', null],
      ['cashierBoth', 'ACTIVE', null],
      ['cashierB', 'ACTIVE', null],
      ['onLeave', 'ON_LEAVE', null],
      ['terminated', 'TERMINATED', '2025-01-01'],
      ['unassigned', 'ACTIVE', null],
      ['regGlobal', 'ACTIVE', null],
      ['regNoAssign', 'ACTIVE', null],
    ];
    fixture.employeeByName = {};

    for (const [name, status, terminationDate] of employees) {
      await connection.execute(
        `INSERT INTO employees (
           employee_number, first_name, last_name, email,
           hire_date, termination_date, employment_status
         ) VALUES (?, 'Phase11', ?, ?, '2020-01-01', ?, ?)`,
        [
          `T11E_${name}_${fixture.token}`,
          name,
          `t11.${name}.${fixture.lower}@example.invalid`,
          terminationDate,
          status,
        ],
      );
      const id = await lastInsertId(connection);
      fixture.employeeIds.push(id);
      fixture.employeeByName[name] = id;
    }

    const assignments = [
      ['operator', 'A'], ['operator', 'B'], ['operator2', 'A'],
      ['cashier1', 'A'], ['cashier2', 'A'],
      ['cashierBoth', 'A'], ['cashierBoth', 'B'], ['cashierB', 'B'],
      ['onLeave', 'A'], ['terminated', 'A'],
      ['regGlobal', 'A'],
    ];

    for (const [employeeName, branchName] of assignments) {
      await connection.execute(
        `INSERT INTO employee_branch_assignments (
           employee_id, branch_id, job_title, started_on, is_primary
         ) VALUES (?, ?, 'Phase 11 Test', '2020-01-01', 0)`,
        [fixture.employeeByName[employeeName], fixture.branchByName[branchName]],
      );
      fixture.assignmentIds.push(await lastInsertId(connection));
    }

    const roles = {
      none: [],
      unrelated: permissionCodes.filter(
        (code) => !code.startsWith('pos_registers.') && !code.startsWith('till_sessions.'),
      ),
      registerRead: ['pos_registers.read'],
      registerManage: ['pos_registers.manage'],
      registerBoth: ['pos_registers.read', 'pos_registers.manage'],
      registerWrong: ['pos_registers.read', 'pos_registers.manage'],
      tillRead: ['till_sessions.read'],
      tillManage: ['till_sessions.manage'],
      tillBoth: ['till_sessions.read', 'till_sessions.manage'],
      tillWrong: ['till_sessions.read', 'till_sessions.manage'],
    };
    fixture.roleByName = {};

    for (const [name, codes] of Object.entries(roles)) {
      await connection.execute(
        `INSERT INTO roles (role_code, role_name, description, is_active)
         VALUES (?, ?, 'Temporary Phase 11 role', 1)`,
        [`T11_${name.toUpperCase()}_${fixture.token}`, `${fixture.prefix} ${name}`],
      );
      const id = await lastInsertId(connection);
      fixture.roleIds.push(id);
      fixture.roleByName[name] = id;

      for (const code of codes) {
        await connection.execute(
          'INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
          [id, permissionIds[code]],
        );
      }
    }

    const [systemRows] = await connection.execute(
      `SELECT CAST(role_id AS CHAR) AS roleId, is_active AS isActive
       FROM roles WHERE role_code = ?`,
      [SYSTEM_ADMIN_ROLE.code],
    );
    assert.equal(systemRows.length, 1);
    assert.equal(systemRows[0].isActive, 1);
    fixture.systemRoleId = systemRows[0].roleId;

    const [mappingRows] = await connection.execute(
      `SELECT COUNT(*) AS count
       FROM role_permissions rp
       INNER JOIN permissions p ON p.permission_id = rp.permission_id
       WHERE rp.role_id = ?
         AND p.permission_code IN (${placeholders(permissionCodes)})`,
      [fixture.systemRoleId, ...permissionCodes],
    );
    assert.equal(mappingRows[0].count, '45');

    const passwordHash = await bcrypt.hash(
      `Phase11-${fixture.token}-Password!`,
      Number(process.env.BCRYPT_ROUNDS),
    );
    const users = [
      ['admin', null, fixture.systemRoleId, null, 0],
      ['must', null, fixture.systemRoleId, null, 1],
      ['none', null, fixture.roleByName.none, null, 0],
      ['unrelated', null, fixture.roleByName.unrelated, null, 0],
      ['registerRead', null, fixture.roleByName.registerRead, null, 0],
      ['registerManage', null, fixture.roleByName.registerManage, null, 0],
      ['registerBoth', null, fixture.roleByName.registerBoth, fixture.branchAId, 0],
      ['registerWrong', null, fixture.roleByName.registerWrong, fixture.branchBId, 0],
      ['regGlobal', fixture.employeeByName.regGlobal, fixture.roleByName.registerBoth, null, 0],
      [
        'regNoAssign',
        fixture.employeeByName.regNoAssign,
        fixture.roleByName.registerBoth,
        null,
        0,
      ],
      ['tillRead', null, fixture.roleByName.tillRead, null, 0],
      ['tillManage', fixture.employeeByName.operator, fixture.roleByName.tillManage, null, 0],
      ['tillBoth', fixture.employeeByName.operator2, fixture.roleByName.tillBoth, fixture.branchAId, 0],
      ['tillWrong', null, fixture.roleByName.tillWrong, fixture.branchBId, 0],
      ['onLeave', fixture.employeeByName.onLeave, fixture.roleByName.tillManage, null, 0],
      ['terminated', fixture.employeeByName.terminated, fixture.roleByName.tillManage, null, 0],
      ['unassigned', fixture.employeeByName.unassigned, fixture.roleByName.tillManage, null, 0],
    ];
    fixture.tokens = {};
    fixture.userByName = {};

    for (const [name, employeeId, roleId, branchId, mustChange] of users) {
      await connection.execute(
        `INSERT INTO users (
           employee_id, username, email, password_hash,
           is_active, must_change_password
         ) VALUES (?, ?, ?, ?, 1, ?)`,
        [
          employeeId,
          `t11.${name}.${fixture.lower}`,
          `t11.${name}.${fixture.lower}@example.invalid`,
          passwordHash,
          mustChange,
        ],
      );
      const id = await lastInsertId(connection);
      fixture.userIds.push(id);
      fixture.userByName[name] = id;
      await connection.execute(
        `INSERT INTO user_roles (user_id, role_id, branch_id, assigned_by_user_id)
         VALUES (?, ?, ?, NULL)`,
        [id, roleId, branchId],
      );
      fixture.tokens[name] = signAccessToken(id).accessToken;
    }

    for (const [kind, type] of [['cash', 'CASH'], ['card', 'CARD'], ['bank', 'BANK_TRANSFER']]) {
      await connection.execute(
        `INSERT INTO payment_methods (
           method_code, method_name, method_type, requires_reference, is_active
         ) VALUES (?, ?, ?, 0, 1)`,
        [`T11${kind.toUpperCase()}_${fixture.token}`, `${fixture.prefix} ${kind}`, type],
      );
      const id = await lastInsertId(connection);
      fixture.paymentMethodIds.push(id);
      fixture[`${kind}PaymentMethodId`] = id;
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
      `DELETE sp FROM sale_payments sp
       INNER JOIN sales s ON s.sale_id = sp.sale_id
       WHERE s.branch_id IN (${placeholders(fixture.branchIds)})
         AND (s.sale_number LIKE ? OR sp.payment_number LIKE ?)`,
      [...fixture.branchIds, marker, marker],
    );
    await connection.execute(
      `DELETE si FROM sale_items si
       INNER JOIN sales s ON s.sale_id = si.sale_id
       WHERE s.branch_id IN (${placeholders(fixture.branchIds)})
         AND s.sale_number LIKE ?`,
      [...fixture.branchIds, marker],
    );
    await connection.execute(
      `DELETE sr FROM sales_returns sr
       INNER JOIN sales s ON s.sale_id = sr.original_sale_id
       WHERE s.branch_id IN (${placeholders(fixture.branchIds)})
         AND s.sale_number LIKE ?`,
      [...fixture.branchIds, marker],
    );
    await connection.execute(
      `DELETE FROM sales
       WHERE branch_id IN (${placeholders(fixture.branchIds)})
         AND sale_number LIKE ?`,
      [...fixture.branchIds, marker],
    );
    await connection.execute(
      `DELETE tcm FROM till_cash_movements tcm
       INNER JOIN till_sessions ts ON ts.till_session_id = tcm.till_session_id
       WHERE ts.branch_id IN (${placeholders(fixture.branchIds)})`,
      fixture.branchIds,
    );
    await connection.execute(
      `DELETE FROM audit_logs
       WHERE request_id LIKE ?
          OR user_id IN (${placeholders(fixture.userIds)})
          OR branch_id IN (${placeholders(fixture.branchIds)})`,
      [marker, ...fixture.userIds, ...fixture.branchIds],
    );
    await connection.execute(
      `DELETE FROM till_sessions
       WHERE branch_id IN (${placeholders(fixture.branchIds)})`,
      fixture.branchIds,
    );
    await connection.execute(
      `DELETE FROM pos_registers
       WHERE branch_id IN (${placeholders(fixture.branchIds)})`,
      fixture.branchIds,
    );
    await connection.execute(
      `DELETE FROM payment_methods
       WHERE payment_method_id IN (${placeholders(fixture.paymentMethodIds)})`,
      fixture.paymentMethodIds,
    );
    await connection.execute(
      `DELETE FROM users WHERE user_id IN (${placeholders(fixture.userIds)})`,
      fixture.userIds,
    );
    await connection.execute(
      `DELETE FROM roles WHERE role_id IN (${placeholders(fixture.roleIds)})`,
      fixture.roleIds,
    );
    await connection.execute(
      `DELETE FROM employee_branch_assignments
       WHERE assignment_id IN (${placeholders(fixture.assignmentIds)})`,
      fixture.assignmentIds,
    );
    await connection.execute(
      `DELETE FROM employees
       WHERE employee_id IN (${placeholders(fixture.employeeIds)})`,
      fixture.employeeIds,
    );
    await connection.execute(
      `DELETE FROM branches
       WHERE branch_id IN (${placeholders(fixture.branchIds)})`,
      fixture.branchIds,
    );
    await connection.commit();

    const checks = [
      ['audit_logs', 'request_id', marker],
      ['sales', 'sale_number', marker],
      ['sale_payments', 'payment_number', marker],
      ['payment_methods', 'method_name', marker],
      ['pos_registers', 'register_code', 'T11%'],
      ['employees', 'employee_number', 'T11E%'],
      ['users', 'username', `t11.%.${fixture.lower}`],
      ['roles', 'role_name', marker],
      ['branches', 'branch_name', marker],
    ];

    for (const [table, column, value] of checks) {
      const [rows] = await connection.execute(
        `SELECT COUNT(*) AS count FROM ${table} WHERE ${column} LIKE ?`,
        [value],
      );
      assert.equal(rows[0].count, '0', `${table} cleanup left TEST_P11 rows`);
    }

    if (fixture.tillIds.length > 0) {
      const [rows] = await connection.execute(
        `SELECT
           (SELECT COUNT(*) FROM till_sessions
            WHERE till_session_id IN (${placeholders(fixture.tillIds)})) +
           (SELECT COUNT(*) FROM till_cash_movements
            WHERE till_session_id IN (${placeholders(fixture.tillIds)})) AS count`,
        [...fixture.tillIds, ...fixture.tillIds],
      );
      assert.equal(rows[0].count, '0');
    }

    fixture.cleaned = true;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

function branchRoot(fixture, branchId = fixture.branchAId) {
  return `/api/admin/branches/${branchId}`;
}

function registerBody(fixture, suffix, overrides = {}) {
  return {
    registerCode: `P11_${suffix}_${fixture.token}`.slice(0, 30),
    registerName: `${fixture.prefix} Register ${suffix}`.slice(0, 100),
    terminalIdentifier: `${fixture.prefix}_TERM_${suffix}`.slice(0, 150),
    ...overrides,
  };
}

async function createRegister(
  fixture,
  baseUrl,
  suffix,
  { branchId = fixture.branchAId, token = fixture.tokens.admin, overrides = {} } = {},
) {
  const result = await send(
    fixture,
    baseUrl,
    `${branchRoot(fixture, branchId)}/pos-registers`,
    {
      method: 'POST',
      token,
      label: `REGISTER_${suffix}`,
      body: registerBody(fixture, suffix, overrides),
    },
  );

  if (result.response.status === 201) {
    const record = result.json.data.posRegister;
    assertId(record.posRegisterId);
    fixture.registerIds.push(record.posRegisterId);
  }

  return result;
}

async function openTill(
  fixture,
  baseUrl,
  registerId,
  suffix,
  {
    branchId = fixture.branchAId,
    cashierEmployeeId = fixture.employeeByName.cashier1,
    openingCashAmount = '100.00',
    token = fixture.tokens.tillManage,
    bodyOverrides = {},
  } = {},
) {
  const result = await send(
    fixture,
    baseUrl,
    `${branchRoot(fixture, branchId)}/pos-registers/${registerId}/till-sessions`,
    {
      method: 'POST',
      token,
      label: `OPEN_${suffix}`,
      body: {
        cashierEmployeeId,
        openingCashAmount,
        notes: `${fixture.prefix} ${suffix}`,
        ...bodyOverrides,
      },
    },
  );

  if (result.response.status === 201) {
    const record = result.json.data.tillSession;
    assertId(record.tillSessionId);
    fixture.tillIds.push(record.tillSessionId);
  }

  return result;
}

async function createMovement(
  fixture,
  baseUrl,
  tillSessionId,
  suffix,
  {
    branchId = fixture.branchAId,
    token = fixture.tokens.tillManage,
    movementType = 'CASH_IN',
    amount = '10.00',
    referenceNumber = `${fixture.prefix}_${suffix}`.slice(0, 100),
    bodyOverrides = {},
  } = {},
) {
  const result = await send(
    fixture,
    baseUrl,
    `${branchRoot(fixture, branchId)}/till-sessions/${tillSessionId}/cash-movements`,
    {
      method: 'POST',
      token,
      label: `MOVEMENT_${suffix}`,
      body: {
        movementType,
        amount,
        reason: `${fixture.prefix} ${suffix}`,
        referenceNumber,
        ...bodyOverrides,
      },
    },
  );

  if (result.response.status === 201) {
    const record = result.json.data.cashMovement;
    assertId(record.tillCashMovementId);
    fixture.movementIds.push(record.tillCashMovementId);
  }

  return result;
}

async function insertSale(fixture, tillSession, suffix) {
  const connection = await pool.getConnection();

  try {
    await connection.execute(
      `INSERT INTO sales (
         sale_number, branch_id, pos_register_id, till_session_id,
         cashier_employee_id, status, currency_code,
         subtotal_amount, discount_amount, tax_amount, total_amount, notes
       ) VALUES (?, ?, ?, ?, ?, 'OPEN', ?, '0.00', '0.00', '0.00', '0.00', ?)`,
      [
        `${fixture.prefix}_SALE_${suffix}`.slice(0, 50),
        tillSession.branchId,
        tillSession.posRegisterId,
        tillSession.tillSessionId,
        tillSession.cashierEmployeeId,
        tillSession.currencyCode,
        `${fixture.prefix} direct SQL reconciliation prerequisite`,
      ],
    );
    const id = await lastInsertId(connection);
    fixture.saleIds.push(id);
    return id;
  } finally {
    connection.release();
  }
}

async function insertPayment(
  fixture,
  saleId,
  suffix,
  {
    methodId = fixture.cashPaymentMethodId,
    paymentType = 'PAYMENT',
    status = 'COMPLETED',
    amount = '1.00',
    currencyCode = 'NGN',
  } = {},
) {
  const connection = await pool.getConnection();

  try {
    await connection.execute(
      `INSERT INTO sale_payments (
         payment_number, sale_id, payment_method_id,
         processed_by_employee_id, payment_type, status,
         amount, currency_code, paid_at, notes
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?,
                 CASE WHEN ? = 'COMPLETED' THEN UTC_TIMESTAMP(6) ELSE NULL END, ?)`,
      [
        `${fixture.prefix}_PAY_${suffix}`.slice(0, 50),
        saleId,
        methodId,
        fixture.employeeByName.operator,
        paymentType,
        status,
        amount,
        currencyCode,
        status,
        `${fixture.prefix} direct SQL payment prerequisite`,
      ],
    );
    const id = await lastInsertId(connection);
    fixture.paymentIds.push(id);
    return id;
  } finally {
    connection.release();
  }
}

async function auditRows(requestIds) {
  if (requestIds.length === 0) return [];
  const [rows] = await pool.execute(
    `SELECT CAST(audit_log_id AS CHAR) AS auditLogId,
            CAST(user_id AS CHAR) AS userId,
            CAST(employee_id AS CHAR) AS employeeId,
            CAST(branch_id AS CHAR) AS branchId,
            action_type AS actionType, entity_type AS entityType,
            entity_record_id AS entityRecordId,
            before_values AS beforeValues, after_values AS afterValues,
            request_id AS requestId
     FROM audit_logs
     WHERE request_id IN (${placeholders(requestIds)})
     ORDER BY audit_log_id`,
    requestIds,
  );
  return rows;
}

async function tableFingerprint(table, timestampColumn = 'updated_at') {
  const [rows] = await pool.query(
    `SELECT CAST(COUNT(*) AS CHAR) AS rowCount,
            COALESCE(DATE_FORMAT(MAX(${timestampColumn}), '%Y-%m-%d %H:%i:%s.%f'), '') AS latest
     FROM ${table}`,
  );
  return rows[0];
}

test(
  'Phase 11 POS registers and till sessions integration',
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const fixture = fixtureDefinition();
    let server;

    try {
      await createFixture(fixture);
      server = await startServer();
      const address = server.address();
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const rootA = branchRoot(fixture);
      const rootB = branchRoot(fixture, fixture.branchBId);

      await t.test('exposes exactly 13 branch-scoped routes and no aliases', async () => {
        const [registerSource, tillSource, indexSource, branchSource] = await Promise.all([
          readFile(new URL('../src/routes/admin/pos/register.routes.js', import.meta.url), 'utf8'),
          readFile(new URL('../src/routes/admin/pos/till.routes.js', import.meta.url), 'utf8'),
          readFile(new URL('../src/routes/admin/pos/index.js', import.meta.url), 'utf8'),
          readFile(new URL('../src/routes/admin/branch.routes.js', import.meta.url), 'utf8'),
        ]);
        const extract = (source) => [
          ...source.matchAll(/router\.(get|post|patch|put|delete)\s*\(\s*['"]([^'"]+)['"]/g),
        ].map((match) => `${match[1].toUpperCase()} ${match[2]}`);
        const registerRoutes = extract(registerSource);
        const tillRoutes = extract(tillSource);
        assert.equal(registerRoutes.length, 5);
        assert.equal(tillRoutes.length, 8);
        const effectiveRoutes = [
          ...registerRoutes.map((route) => route.replace(' /', ' /pos-registers/')),
          ...tillRoutes.map((route) => route.replace(' /', ' /till-sessions/')),
        ];
        assert.equal(new Set(effectiveRoutes).size, 13);
        assert.deepEqual(registerRoutes, [
          'GET /', 'POST /', 'GET /:posRegisterId', 'PATCH /:posRegisterId',
          'POST /:posRegisterId/till-sessions',
        ]);
        assert.deepEqual(tillRoutes, [
          'GET /', 'GET /:tillSessionId',
          'POST /:tillSessionId/suspend', 'POST /:tillSessionId/resume',
          'POST /:tillSessionId/close', 'POST /:tillSessionId/cancel',
          'GET /:tillSessionId/cash-movements',
          'POST /:tillSessionId/cash-movements',
        ]);
        assert.match(indexSource, /pos-registers/);
        assert.match(indexSource, /till-sessions/);
        assert.match(branchSource, /pos/);
        assert.doesNotMatch(`${registerSource}\n${tillSource}`, /router\.(delete|put)\s*\(/);

        for (const path of [
          '/api/admin/pos-registers', '/api/admin/till-sessions',
          `${rootA}/checkout`, `${rootA}/payments`,
        ]) {
          assertStatus(await send(fixture, baseUrl, path, { label: 'ABSENT_GLOBAL' }), 404);
        }
      });

      await t.test('enforces the complete register authorization matrix', async () => {
        const seed = await createRegister(fixture, baseUrl, 'AUTH_SEED');
        assertStatus(seed, 201);
        fixture.authRegister = seed.json.data.posRegister;
        const detailPath = `${rootA}/pos-registers/${fixture.authRegister.posRegisterId}`;
        const routes = [
          ['GET', `${rootA}/pos-registers`, undefined],
          ['POST', `${rootA}/pos-registers`, registerBody(fixture, 'AUTH_DENIED')],
          ['GET', detailPath, undefined],
          ['PATCH', detailPath, { registerName: `${fixture.prefix} denied` }],
        ];

        for (const [method, path, body] of routes) {
          assertSafeError(
            await send(fixture, baseUrl, path, { method, body, token: null, label: 'REG_UNAUTH' }),
            401,
          );
          for (const name of [
            'must', 'none', 'unrelated', 'registerWrong', 'regNoAssign',
          ]) {
            assertSafeError(
              await send(fixture, baseUrl, path, {
                method, body, token: fixture.tokens[name], label: `REG_${name}`,
              }),
              403,
            );
          }
        }

        assertStatus(await send(fixture, baseUrl, `${rootA}/pos-registers`, {
          token: fixture.tokens.registerRead, label: 'REG_READ_LIST',
        }), 200);
        assertStatus(await send(fixture, baseUrl, detailPath, {
          token: fixture.tokens.registerRead, label: 'REG_READ_DETAIL',
        }), 200);
        for (const [method, path, body] of routes.filter(([method]) => method !== 'GET')) {
          assertSafeError(await send(fixture, baseUrl, path, {
            method, body, token: fixture.tokens.registerRead, label: 'REG_READ_WRITE',
          }), 403);
        }

        for (const path of [`${rootA}/pos-registers`, detailPath]) {
          assertSafeError(await send(fixture, baseUrl, path, {
            token: fixture.tokens.registerManage, label: 'REG_MANAGE_READ',
          }), 403);
        }
        const managed = await createRegister(fixture, baseUrl, 'AUTH_MANAGE', {
          token: fixture.tokens.registerManage,
        });
        assertStatus(managed, 201);
        assertStatus(await send(fixture, baseUrl, detailPath, {
          method: 'PATCH', token: fixture.tokens.registerManage,
          label: 'REG_MANAGE_PATCH', body: { registerName: `${fixture.prefix} managed` },
        }), 200);

        assertStatus(await send(fixture, baseUrl, `${rootA}/pos-registers`, {
          token: fixture.tokens.registerBoth, label: 'REG_SCOPED_READ',
        }), 200);
        const scoped = await createRegister(fixture, baseUrl, 'AUTH_SCOPED', {
          token: fixture.tokens.registerBoth,
        });
        assertStatus(scoped, 201);
        assertSafeError(await send(fixture, baseUrl, `${rootB}/pos-registers`, {
          token: fixture.tokens.registerBoth, label: 'REG_SCOPED_OTHER',
        }), 403);

        assertStatus(await send(fixture, baseUrl, `${rootA}/pos-registers`, {
          token: fixture.tokens.regGlobal, label: 'REG_LINKED_GLOBAL_ASSIGNED',
        }), 200);
        assertStatus(await createRegister(fixture, baseUrl, 'AUTH_LINKED_GLOBAL', {
          token: fixture.tokens.regGlobal,
        }), 201);
        assertSafeError(await send(fixture, baseUrl, `${rootB}/pos-registers`, {
          token: fixture.tokens.regGlobal, label: 'REG_LINKED_GLOBAL_UNASSIGNED_BRANCH',
        }), 403);

        assertStatus(await send(fixture, baseUrl, `${rootB}/pos-registers`, {
          token: fixture.tokens.admin, label: 'REG_ADMIN_READ',
        }), 200);
        const adminB = await createRegister(fixture, baseUrl, 'AUTH_ADMIN_B', {
          branchId: fixture.branchBId,
        });
        assertStatus(adminB, 201);
        fixture.branchBRegister = adminB.json.data.posRegister;
        assertStatus(await send(
          fixture,
          baseUrl,
          `${rootB}/pos-registers/${fixture.branchBRegister.posRegisterId}`,
          { method: 'PATCH', label: 'REG_ADMIN_PATCH', body: { status: 'MAINTENANCE' } },
        ), 200);
      });

      await t.test('enforces till permissions, branch scope, and operational actors', async () => {
        const register = await createRegister(fixture, baseUrl, 'TILL_AUTH');
        assertStatus(register, 201);
        const registerId = register.json.data.posRegister.posRegisterId;
        const opened = await openTill(fixture, baseUrl, registerId, 'TILL_AUTH');
        assertStatus(opened, 201);
        const till = opened.json.data.tillSession;
        fixture.authTill = till;
        const paths = {
          list: `${rootA}/till-sessions`,
          open: `${rootA}/pos-registers/${registerId}/till-sessions`,
          detail: `${rootA}/till-sessions/${till.tillSessionId}`,
          suspend: `${rootA}/till-sessions/${till.tillSessionId}/suspend`,
          resume: `${rootA}/till-sessions/${till.tillSessionId}/resume`,
          close: `${rootA}/till-sessions/${till.tillSessionId}/close`,
          cancel: `${rootA}/till-sessions/${till.tillSessionId}/cancel`,
          movementList: `${rootA}/till-sessions/${till.tillSessionId}/cash-movements`,
          movementCreate: `${rootA}/till-sessions/${till.tillSessionId}/cash-movements`,
        };
        const routes = [
          ['GET', paths.list],
          ['POST', paths.open, { cashierEmployeeId: fixture.employeeByName.cashier2, openingCashAmount: '0.00' }],
          ['GET', paths.detail], ['POST', paths.suspend, {}], ['POST', paths.resume, {}],
          ['POST', paths.close, { actualClosingCashAmount: '100.00' }],
          ['POST', paths.cancel, {}], ['GET', paths.movementList],
          ['POST', paths.movementCreate, { movementType: 'CASH_IN', amount: '1.00', reason: 'test' }],
        ];

        for (const [method, path, body] of routes) {
          assertSafeError(await send(fixture, baseUrl, path, {
            method, body, token: null, label: 'TILL_UNAUTH',
          }), 401);
          for (const name of ['must', 'none', 'unrelated', 'tillWrong']) {
            assertSafeError(await send(fixture, baseUrl, path, {
              method, body, token: fixture.tokens[name], label: `TILL_${name}`,
            }), 403);
          }
        }

        for (const path of [paths.list, paths.detail, paths.movementList]) {
          assertStatus(await send(fixture, baseUrl, path, {
            token: fixture.tokens.tillRead, label: 'TILL_READ_GET',
          }), 200);
          assertSafeError(await send(fixture, baseUrl, path, {
            token: fixture.tokens.tillManage, label: 'TILL_MANAGE_GET',
          }), 403);
          assertStatus(await send(fixture, baseUrl, path, {
            token: fixture.tokens.admin, label: 'TILL_ADMIN_GET',
          }), 200);
        }
        for (const [method, path, body] of routes.filter(([method]) => method === 'POST')) {
          assertSafeError(await send(fixture, baseUrl, path, {
            method, body, token: fixture.tokens.tillRead, label: 'TILL_READ_WRITE',
          }), 403);
          assertSafeError(await send(fixture, baseUrl, path, {
            method, body, token: fixture.tokens.admin, label: 'TILL_UNLINKED_ADMIN_WRITE',
          }), 403);
        }

        for (const name of ['onLeave', 'terminated', 'unassigned']) {
          const actorRegister = await createRegister(fixture, baseUrl, `ACTOR_${name}`);
          assertStatus(actorRegister, 201);
          assertSafeError(await openTill(
            fixture,
            baseUrl,
            actorRegister.json.data.posRegister.posRegisterId,
            `ACTOR_${name}`,
            { token: fixture.tokens[name] },
          ), 403);
        }

        assertStatus(await send(fixture, baseUrl, paths.suspend, {
          method: 'POST', token: fixture.tokens.tillManage, label: 'TILL_MANAGE_SUSPEND', body: {},
        }), 200);
        assertStatus(await send(fixture, baseUrl, paths.resume, {
          method: 'POST', token: fixture.tokens.tillManage, label: 'TILL_MANAGE_RESUME', body: {},
        }), 200);
        assertStatus(await createMovement(fixture, baseUrl, till.tillSessionId, 'AUTH'), 201);
        assertStatus(await send(fixture, baseUrl, paths.close, {
          method: 'POST', token: fixture.tokens.tillManage,
          label: 'TILL_MANAGE_CLOSE', body: { actualClosingCashAmount: '110.00' },
        }), 200);

        const cancelRegister = await createRegister(fixture, baseUrl, 'AUTH_CANCEL');
        assertStatus(cancelRegister, 201);
        const cancelOpen = await openTill(
          fixture,
          baseUrl,
          cancelRegister.json.data.posRegister.posRegisterId,
          'AUTH_CANCEL',
          { cashierEmployeeId: fixture.employeeByName.cashier2, token: fixture.tokens.tillBoth },
        );
        assertStatus(cancelOpen, 201);
        assertStatus(await send(
          fixture,
          baseUrl,
          `${rootA}/till-sessions/${cancelOpen.json.data.tillSession.tillSessionId}/cancel`,
          { method: 'POST', token: fixture.tokens.tillBoth, label: 'TILL_SCOPED_CANCEL', body: {} },
        ), 200);
      });

      await t.test('validates, lists, updates, and scopes register configuration', async () => {
        const created = await createRegister(fixture, baseUrl, 'CORE', {
          token: fixture.tokens.registerManage,
          overrides: {
            registerCode: `  CORE_${fixture.token}  `,
            registerName: `  ${fixture.prefix} Core Register  `,
            terminalIdentifier: `  ${fixture.prefix}_CORE_TERM  `,
          },
        });
        assertStatus(created, 201);
        const record = created.json.data.posRegister;
        fixture.coreRegister = record;
        assert.deepEqual(Object.keys(record).sort(), [
          'branchId', 'createdAt', 'posRegisterId', 'registerCode',
          'registerName', 'status', 'terminalIdentifier', 'updatedAt',
        ]);
        assert.equal(record.branchId, fixture.branchAId);
        assert.equal(record.registerCode, `CORE_${fixture.token}`);
        assert.equal(record.registerName, `${fixture.prefix} Core Register`);
        assert.equal(record.terminalIdentifier, `${fixture.prefix}_CORE_TERM`);
        assert.equal(record.status, 'ACTIVE');

        const detailPath = `${rootA}/pos-registers/${record.posRegisterId}`;
        const detail = await send(fixture, baseUrl, detailPath, {
          token: fixture.tokens.registerRead, label: 'REG_CORE_DETAIL',
        });
        assertStatus(detail, 200);
        assert.deepEqual(detail.json.data.posRegister, record);

        const update = await send(fixture, baseUrl, detailPath, {
          method: 'PATCH', token: fixture.tokens.registerManage,
          label: 'REG_CORE_UPDATE', body: {
            registerName: `${fixture.prefix} Core Updated`,
            terminalIdentifier: null,
            status: 'MAINTENANCE',
          },
        });
        assertStatus(update, 200);
        assert.equal(update.json.data.posRegister.status, 'MAINTENANCE');
        assert.equal(update.json.data.posRegister.terminalIdentifier, null);
        const noOp = await send(fixture, baseUrl, detailPath, {
          method: 'PATCH', token: fixture.tokens.registerManage,
          label: 'REG_CORE_NOOP', body: {
            registerName: `${fixture.prefix} Core Updated`,
            terminalIdentifier: null,
            status: 'MAINTENANCE',
          },
        });
        assertStatus(noOp, 200);
        assert.equal(noOp.json.data.posRegister.updatedAt, update.json.data.posRegister.updatedAt);
        assert.deepEqual(await auditRows([noOp.requestId]), []);

        const sameCode = await createRegister(fixture, baseUrl, 'DUP_CODE', {
          overrides: { registerCode: `core_${fixture.token}` },
        });
        assertSafeError(sameCode, 409);
        const otherBranch = await createRegister(fixture, baseUrl, 'DUP_OTHER_BRANCH', {
          branchId: fixture.branchBId,
          overrides: { registerCode: `CORE_${fixture.token}`, terminalIdentifier: null },
        });
        assertStatus(otherBranch, 201);
        const terminalA = await createRegister(fixture, baseUrl, 'TERM_A');
        assertStatus(terminalA, 201);
        const duplicateTerminal = await createRegister(fixture, baseUrl, 'TERM_B', {
          branchId: fixture.branchBId,
          overrides: { terminalIdentifier: terminalA.json.data.posRegister.terminalIdentifier },
        });
        assertSafeError(duplicateTerminal, 409);
        assertStatus(await createRegister(fixture, baseUrl, 'NULL_TERM_A', {
          overrides: { terminalIdentifier: null },
        }), 201);
        assertStatus(await createRegister(fixture, baseUrl, 'NULL_TERM_B', {
          overrides: { terminalIdentifier: null },
        }), 201);

        const defaultList = await send(fixture, baseUrl, `${rootA}/pos-registers`, {
          token: fixture.tokens.registerRead, label: 'REG_LIST_DEFAULT',
        });
        assertStatus(defaultList, 200);
        assert.equal(defaultList.json.data.pagination.page, 1);
        assert.equal(defaultList.json.data.pagination.limit, 20);
        const filtered = await send(
          fixture,
          baseUrl,
          `${rootA}/pos-registers?search=${fixture.token}&status=ACTIVE&page=1&limit=2`,
          { token: fixture.tokens.registerRead, label: 'REG_LIST_FILTER' },
        );
        assertStatus(filtered, 200);
        assert.ok(filtered.json.data.items.length <= 2);
        assert.ok(filtered.json.data.items.every(({ branchId, status }) =>
          branchId === fixture.branchAId && status === 'ACTIVE'));
        const repeat = await send(
          fixture,
          baseUrl,
          `${rootA}/pos-registers?search=${fixture.token}&status=ACTIVE&page=1&limit=2`,
          { token: fixture.tokens.registerRead, label: 'REG_LIST_REPEAT' },
        );
        assert.deepEqual(
          repeat.json.data.items.map(({ posRegisterId }) => posRegisterId),
          filtered.json.data.items.map(({ posRegisterId }) => posRegisterId),
        );

        for (const path of [
          `${rootA}/pos-registers?unknown=1`,
          `${rootA}/pos-registers?limit=101`,
          `${rootA}/pos-registers?status=BROKEN`,
        ]) assertSafeError(await send(fixture, baseUrl, path, { label: 'REG_BAD_QUERY' }), 400);

        const invalidBodies = [
          {},
          { registerCode: 'X', registerName: 'X', unknown: true },
          { registerCode: ' ', registerName: 'Valid' },
          { registerCode: 'X'.repeat(31), registerName: 'Valid' },
          { registerCode: 'VALID', registerName: ' ' },
          { registerCode: 'VALID', registerName: 'X'.repeat(101) },
          { registerCode: 'VALID', registerName: 'Valid', terminalIdentifier: ' ' },
          { registerCode: 'VALID', registerName: 'Valid', terminalIdentifier: 'X'.repeat(151) },
          { registerCode: 'VALID', registerName: 'Valid', status: 'BROKEN' },
          { registerCode: 'VALID', registerName: 'Valid', branchId: fixture.branchAId },
          { registerCode: 'VALID', registerName: 'Valid', posRegisterId: '1' },
          { registerCode: 'VALID', registerName: 'Valid', createdAt: '2020-01-01' },
        ];
        for (const body of invalidBodies) {
          assertSafeError(await send(fixture, baseUrl, `${rootA}/pos-registers`, {
            method: 'POST', label: 'REG_INVALID_CREATE', body,
          }), 400);
        }
        for (const body of [{}, { branchId: fixture.branchAId }, { status: 'BROKEN' }]) {
          assertSafeError(await send(fixture, baseUrl, detailPath, {
            method: 'PATCH', label: 'REG_INVALID_PATCH', body,
          }), 400);
        }
        assertSafeError(await send(fixture, baseUrl, `${rootA}/pos-registers/not-an-id`, {
          label: 'REG_MALFORMED',
        }), 400);
        assertSafeError(await send(
          fixture,
          baseUrl,
          `${rootA}/pos-registers/${MAX_UNSIGNED_BIGINT}`,
          { label: 'REG_MAX' },
        ), 404);
        assertSafeError(await send(
          fixture,
          baseUrl,
          `${rootB}/pos-registers/${fixture.authRegister.posRegisterId}`,
          { label: 'REG_CROSS_BRANCH' },
        ), 404);
        assertStatus(await send(fixture, baseUrl, detailPath, {
          method: 'DELETE', label: 'REG_DELETE_ABSENT',
        }), 404);
      });

      await t.test('opens and lists tills with strict identity and exact-money validation', async () => {
        const registerResult = await createRegister(fixture, baseUrl, 'OPEN_CORE');
        assertStatus(registerResult, 201);
        const register = registerResult.json.data.posRegister;
        const open = await openTill(fixture, baseUrl, register.posRegisterId, 'OPEN_CORE', {
          openingCashAmount: '000100.5',
          bodyOverrides: { notes: `  ${fixture.prefix} open notes  ` },
        });
        assertStatus(open, 201);
        const session = open.json.data.tillSession;
        fixture.openCoreTill = session;
        assert.deepEqual(Object.keys(session).sort(), [
          'actualClosingCashAmount', 'branchId', 'cashDifferenceAmount',
          'cashierEmployeeId', 'closedAt', 'closedByEmployeeId', 'createdAt',
          'currencyCode', 'expectedClosingCashAmount', 'notes', 'openedAt',
          'openedByEmployeeId', 'openingCashAmount', 'posRegisterId',
          'sessionNumber', 'status', 'tillSessionId', 'updatedAt',
        ]);
        assert.equal(session.branchId, fixture.branchAId);
        assert.equal(session.posRegisterId, register.posRegisterId);
        assert.equal(session.cashierEmployeeId, fixture.employeeByName.cashier1);
        assert.equal(session.openedByEmployeeId, fixture.employeeByName.operator);
        assert.equal(session.currencyCode, 'NGN');
        assert.equal(session.openingCashAmount, '100.50');
        assert.equal(session.status, 'OPEN');
        assert.equal(session.notes, `${fixture.prefix} open notes`);
        for (const field of [
          'closedByEmployeeId', 'closedAt', 'expectedClosingCashAmount',
          'actualClosingCashAmount', 'cashDifferenceAmount',
        ]) assert.equal(session[field], null);
        assertId(session.tillSessionId);
        assert.ok(session.sessionNumber.length <= 50);

        const detailPath = `${rootA}/till-sessions/${session.tillSessionId}`;
        const detail = await send(fixture, baseUrl, detailPath, {
          token: fixture.tokens.tillRead, label: 'TILL_CORE_DETAIL',
        });
        assertStatus(detail, 200);
        assert.equal(detail.json.data.tillSession.tillSessionId, session.tillSessionId);

        const list = await send(
          fixture,
          baseUrl,
          `${rootA}/till-sessions?status=OPEN&posRegisterId=${register.posRegisterId}` +
            `&cashierEmployeeId=${session.cashierEmployeeId}` +
            `&openedByEmployeeId=${session.openedByEmployeeId}` +
            '&from=2000-01-01&to=9999-12-31&page=1&limit=20',
          { token: fixture.tokens.tillRead, label: 'TILL_LIST_FILTER' },
        );
        assertStatus(list, 200);
        assert.ok(list.json.data.items.some(
          ({ tillSessionId }) => tillSessionId === session.tillSessionId,
        ));
        assert.equal(list.json.data.pagination.page, 1);
        assert.equal(list.json.data.pagination.limit, 20);
        const listAgain = await send(
          fixture,
          baseUrl,
          `${rootA}/till-sessions?status=OPEN&page=1&limit=20`,
          { token: fixture.tokens.tillRead, label: 'TILL_LIST_REPEAT' },
        );
        assertStatus(listAgain, 200);
        const listRepeat2 = await send(
          fixture,
          baseUrl,
          `${rootA}/till-sessions?status=OPEN&page=1&limit=20`,
          { token: fixture.tokens.tillRead, label: 'TILL_LIST_REPEAT2' },
        );
        assert.deepEqual(
          listAgain.json.data.items.map(({ tillSessionId }) => tillSessionId),
          listRepeat2.json.data.items.map(({ tillSessionId }) => tillSessionId),
        );
        for (const query of [
          'unknown=1', 'limit=101', 'status=INVALID',
          'posRegisterId=bad', `cashierEmployeeId=${MAX_UNSIGNED_BIGINT}&from=bad`,
          'from=2030-01-01&to=2020-01-01',
        ]) assertSafeError(await send(fixture, baseUrl, `${rootA}/till-sessions?${query}`, {
          token: fixture.tokens.tillRead, label: 'TILL_BAD_QUERY',
        }), 400);

        const validationRegister = await createRegister(fixture, baseUrl, 'OPEN_VALIDATION');
        assertStatus(validationRegister, 201);
        const validationPath = `${rootA}/pos-registers/${validationRegister.json.data.posRegister.posRegisterId}/till-sessions`;
        const validCashier = fixture.employeeByName.cashier2;
        const invalidOpenBodies = [
          {},
          { cashierEmployeeId: validCashier, openingCashAmount: 10 },
          { cashierEmployeeId: validCashier, openingCashAmount: '1e2' },
          { cashierEmployeeId: validCashier, openingCashAmount: '-1.00' },
          { cashierEmployeeId: validCashier, openingCashAmount: '1.001' },
          { cashierEmployeeId: validCashier, openingCashAmount: '100000000000000000.00' },
          { cashierEmployeeId: validCashier, openingCashAmount: '1.00', notes: ' ' },
          { cashierEmployeeId: validCashier, openingCashAmount: '1.00', notes: 'X'.repeat(1001) },
          { cashierEmployeeId: validCashier, openingCashAmount: '1.00', sessionNumber: 'CLIENT' },
          { cashierEmployeeId: validCashier, openingCashAmount: '1.00', branchId: fixture.branchAId },
          { cashierEmployeeId: validCashier, openingCashAmount: '1.00', openedByEmployeeId: validCashier },
          { cashierEmployeeId: validCashier, openingCashAmount: '1.00', status: 'OPEN' },
          { cashierEmployeeId: validCashier, openingCashAmount: '1.00', expectedClosingCashAmount: '1.00' },
        ];
        for (const body of invalidOpenBodies) {
          assertSafeError(await send(fixture, baseUrl, validationPath, {
            method: 'POST', token: fixture.tokens.tillManage,
            label: 'TILL_INVALID_OPEN', body,
          }), 400);
        }
        assertSafeError(await send(
          fixture,
          baseUrl,
          `${rootA}/pos-registers/not-an-id/till-sessions`,
          {
            method: 'POST', token: fixture.tokens.tillManage,
            label: 'OPEN_BAD_REGISTER_ID',
            body: { cashierEmployeeId: validCashier, openingCashAmount: '1.00' },
          },
        ), 400);
        assertSafeError(await send(
          fixture,
          baseUrl,
          `${rootA}/pos-registers/${MAX_UNSIGNED_BIGINT}/till-sessions`,
          {
            method: 'POST', token: fixture.tokens.tillManage,
            label: 'OPEN_MAX_REGISTER_ID',
            body: { cashierEmployeeId: validCashier, openingCashAmount: '1.00' },
          },
        ), 404);
        assertSafeError(await send(fixture, baseUrl, validationPath, {
          method: 'POST', token: fixture.tokens.tillManage,
          label: 'OPEN_BAD_CASHIER_ID',
          body: { cashierEmployeeId: 'bad', openingCashAmount: '1.00' },
        }), 400);
        assertSafeError(await send(fixture, baseUrl, validationPath, {
          method: 'POST', token: fixture.tokens.tillManage,
          label: 'OPEN_MAX_CASHIER_ID',
          body: { cashierEmployeeId: MAX_UNSIGNED_BIGINT, openingCashAmount: '1.00' },
        }), 404);
        for (const cashier of ['onLeave', 'terminated', 'unassigned', 'cashierB']) {
          assertSafeError(await send(fixture, baseUrl, validationPath, {
            method: 'POST', token: fixture.tokens.tillManage,
            label: `OPEN_CASHIER_${cashier}`,
            body: {
              cashierEmployeeId: fixture.employeeByName[cashier],
              openingCashAmount: '1.00',
            },
          }), 409);
        }

        const inactiveRegister = await createRegister(fixture, baseUrl, 'INACTIVE_OPEN', {
          overrides: { status: 'INACTIVE' },
        });
        assertStatus(inactiveRegister, 201);
        assertSafeError(await openTill(
          fixture,
          baseUrl,
          inactiveRegister.json.data.posRegister.posRegisterId,
          'INACTIVE_OPEN',
          { cashierEmployeeId: validCashier },
        ), 409);
        assertSafeError(await send(
          fixture,
          baseUrl,
          `${rootB}/pos-registers/${validationRegister.json.data.posRegister.posRegisterId}/till-sessions`,
          {
            method: 'POST', token: fixture.tokens.tillManage,
            label: 'OPEN_CROSS_BRANCH_REGISTER',
            body: { cashierEmployeeId: fixture.employeeByName.cashierBoth, openingCashAmount: '1.00' },
          },
        ), 404);
        assertSafeError(await send(
          fixture,
          baseUrl,
          `${rootB}/till-sessions/${session.tillSessionId}`,
          { token: fixture.tokens.admin, label: 'TILL_CROSS_BRANCH' },
        ), 404);
      });

      await t.test('enforces lifecycle and append-only cash-movement rules', async () => {
        const session = fixture.openCoreTill;
        const sessionRoot = `${rootA}/till-sessions/${session.tillSessionId}`;
        const suspend = await send(fixture, baseUrl, `${sessionRoot}/suspend`, {
          method: 'POST', token: fixture.tokens.tillManage,
          label: 'CORE_SUSPEND', body: {},
        });
        assertStatus(suspend, 200);
        assert.equal(suspend.json.data.tillSession.status, 'SUSPENDED');
        for (const field of [
          'closedAt', 'closedByEmployeeId', 'expectedClosingCashAmount',
          'actualClosingCashAmount', 'cashDifferenceAmount',
        ]) assert.equal(suspend.json.data.tillSession[field], null);
        assertSafeError(await createMovement(
          fixture, baseUrl, session.tillSessionId, 'SUSPENDED',
        ), 409);
        assertSafeError(await send(fixture, baseUrl, `${sessionRoot}/suspend`, {
          method: 'POST', token: fixture.tokens.tillManage,
          label: 'DOUBLE_SUSPEND', body: {},
        }), 409);
        const resume = await send(fixture, baseUrl, `${sessionRoot}/resume`, {
          method: 'POST', token: fixture.tokens.tillManage,
          label: 'CORE_RESUME', body: {},
        });
        assertStatus(resume, 200);
        assert.equal(resume.json.data.tillSession.status, 'OPEN');
        assertSafeError(await send(fixture, baseUrl, `${sessionRoot}/resume`, {
          method: 'POST', token: fixture.tokens.tillManage,
          label: 'DOUBLE_RESUME', body: {},
        }), 409);

        const movements = [];
        for (const [type, amount] of [
          ['CASH_IN', '10.00'], ['CASH_OUT', '1.50'],
          ['CASH_DROP', '2.00'], ['PAYOUT', '0.50'],
        ]) {
          const movement = await createMovement(
            fixture,
            baseUrl,
            session.tillSessionId,
            `CORE_${type}`,
            { movementType: type, amount },
          );
          assertStatus(movement, 201);
          assert.equal(movement.json.data.cashMovement.amount, amount);
          assert.equal(movement.json.data.cashMovement.movementType, type);
          assert.equal(
            movement.json.data.cashMovement.recordedByEmployeeId,
            fixture.employeeByName.operator,
          );
          movements.push(movement.json.data.cashMovement);
        }
        const movementRoot = `${sessionRoot}/cash-movements`;
        const list = await send(
          fixture,
          baseUrl,
          `${movementRoot}?movementType=CASH_IN&recordedByEmployeeId=${fixture.employeeByName.operator}` +
            '&from=2000-01-01&to=9999-12-31&page=1&limit=20',
          { token: fixture.tokens.tillRead, label: 'MOVEMENT_LIST' },
        );
        assertStatus(list, 200);
        assert.ok(list.json.data.items.some(
          ({ tillCashMovementId }) => tillCashMovementId === movements[0].tillCashMovementId,
        ));
        const duplicate = await createMovement(
          fixture,
          baseUrl,
          session.tillSessionId,
          'DUPLICATE_REF',
          { referenceNumber: movements[0].referenceNumber },
        );
        assertSafeError(duplicate, 409);
        assertStatus(await createMovement(
          fixture, baseUrl, session.tillSessionId, 'NULL_REF_1', { referenceNumber: null },
        ), 201);
        assertStatus(await createMovement(
          fixture, baseUrl, session.tillSessionId, 'NULL_REF_2', { referenceNumber: null },
        ), 201);

        const invalidMovements = [
          {},
          { movementType: 'BAD', amount: '1.00', reason: 'x' },
          { movementType: 'CASH_IN', amount: 1, reason: 'x' },
          { movementType: 'CASH_IN', amount: '1e2', reason: 'x' },
          { movementType: 'CASH_IN', amount: '-1.00', reason: 'x' },
          { movementType: 'CASH_IN', amount: '0.00', reason: 'x' },
          { movementType: 'CASH_IN', amount: '1.001', reason: 'x' },
          { movementType: 'CASH_IN', amount: '100000000000000000.00', reason: 'x' },
          { movementType: 'CASH_IN', amount: '1.00', reason: ' ' },
          { movementType: 'CASH_IN', amount: '1.00', reason: 'X'.repeat(501) },
          { movementType: 'CASH_IN', amount: '1.00', reason: 'x', referenceNumber: ' ' },
          { movementType: 'CASH_IN', amount: '1.00', reason: 'x', referenceNumber: 'X'.repeat(101) },
          { movementType: 'CASH_IN', amount: '1.00', reason: 'x', recordedByEmployeeId: '1' },
        ];
        for (const body of invalidMovements) {
          assertSafeError(await send(fixture, baseUrl, movementRoot, {
            method: 'POST', token: fixture.tokens.tillManage,
            label: 'MOVEMENT_INVALID', body,
          }), 400);
        }
        for (const query of ['unknown=1', 'limit=101', 'movementType=BAD', 'from=bad']) {
          assertSafeError(await send(fixture, baseUrl, `${movementRoot}?${query}`, {
            token: fixture.tokens.tillRead, label: 'MOVEMENT_BAD_QUERY',
          }), 400);
        }
        for (const [method, path] of [
          ['PATCH', movementRoot], ['DELETE', movementRoot],
          ['PATCH', sessionRoot], ['DELETE', sessionRoot],
          ['POST', `${sessionRoot}/reopen`], ['GET', `${sessionRoot}/balance`],
          ['POST', `${sessionRoot}/reconcile`], ['GET', `${sessionRoot}/sales`],
          ['GET', `${sessionRoot}/payments`],
        ]) assertStatus(await send(fixture, baseUrl, path, {
          method, label: 'TILL_ROUTE_ABSENT', body: method === 'POST' ? {} : undefined,
        }), 404);
      });

      await t.test('protects active registers and makes CLOSED/CANCELLED terminal', async () => {
        const session = fixture.openCoreTill;
        const sessionRoot = `${rootA}/till-sessions/${session.tillSessionId}`;
        const registerPath = `${rootA}/pos-registers/${session.posRegisterId}`;
        assertSafeError(await send(fixture, baseUrl, registerPath, {
          method: 'PATCH', label: 'DISABLE_ACTIVE_REGISTER', body: { status: 'INACTIVE' },
        }), 409);

        assertSafeError(await send(fixture, baseUrl, `${sessionRoot}/close`, {
          method: 'POST', token: fixture.tokens.tillManage,
          label: 'CLOSE_NUMERIC', body: { actualClosingCashAmount: 126.5 },
        }), 400);
        for (const amount of ['-1.00', '1e2', '1.001', '100000000000000000.00']) {
          assertSafeError(await send(fixture, baseUrl, `${sessionRoot}/close`, {
            method: 'POST', token: fixture.tokens.tillManage,
            label: 'CLOSE_INVALID_MONEY', body: { actualClosingCashAmount: amount },
          }), 400);
        }
        assertSafeError(await send(fixture, baseUrl, `${sessionRoot}/close`, {
          method: 'POST', token: fixture.tokens.tillManage,
          label: 'CLOSE_SERVER_FIELD', body: {
            actualClosingCashAmount: '126.50', expectedClosingCashAmount: '126.50',
          },
        }), 400);
        for (const action of ['suspend', 'resume', 'cancel']) {
          assertSafeError(await send(fixture, baseUrl, `${sessionRoot}/${action}`, {
            method: 'POST', token: fixture.tokens.tillManage,
            label: 'ACTION_NONEMPTY', body: { notes: 'not accepted' },
          }), 400);
        }

        assertStatus(await send(fixture, baseUrl, `${sessionRoot}/suspend`, {
          method: 'POST', token: fixture.tokens.tillManage,
          label: 'CLOSE_FROM_SUSPENDED_PREP', body: {},
        }), 200);
        const closed = await send(fixture, baseUrl, `${sessionRoot}/close`, {
          method: 'POST', token: fixture.tokens.tillManage,
          label: 'CLOSE_FROM_SUSPENDED', body: { actualClosingCashAmount: '125.00' },
        });
        assertStatus(closed, 200);
        assert.equal(closed.json.data.tillSession.status, 'CLOSED');
        assert.equal(closed.json.data.tillSession.expectedClosingCashAmount, '126.50');
        assert.equal(closed.json.data.tillSession.actualClosingCashAmount, '125.00');
        assert.equal(closed.json.data.tillSession.cashDifferenceAmount, '-1.50');
        assert.equal(
          closed.json.data.tillSession.closedByEmployeeId,
          fixture.employeeByName.operator,
        );
        for (const action of ['suspend', 'resume', 'close', 'cancel']) {
          assertSafeError(await send(fixture, baseUrl, `${sessionRoot}/${action}`, {
            method: 'POST', token: fixture.tokens.tillManage,
            label: 'CLOSED_TERMINAL',
            body: action === 'close' ? { actualClosingCashAmount: '1.00' } : {},
          }), 409);
        }
        assertSafeError(await createMovement(
          fixture, baseUrl, session.tillSessionId, 'CLOSED_TERMINAL',
        ), 409);
        assertStatus(await send(fixture, baseUrl, registerPath, {
          method: 'PATCH', label: 'DISABLE_RELEASED_REGISTER', body: { status: 'INACTIVE' },
        }), 200);

        const cancelRegister = await createRegister(fixture, baseUrl, 'TERMINAL_CANCEL');
        assertStatus(cancelRegister, 201);
        const opened = await openTill(
          fixture,
          baseUrl,
          cancelRegister.json.data.posRegister.posRegisterId,
          'TERMINAL_CANCEL',
          { cashierEmployeeId: fixture.employeeByName.cashier2 },
        );
        assertStatus(opened, 201);
        const cancelRoot = `${rootA}/till-sessions/${opened.json.data.tillSession.tillSessionId}`;
        const cancelled = await send(fixture, baseUrl, `${cancelRoot}/cancel`, {
          method: 'POST', token: fixture.tokens.tillManage,
          label: 'TERMINAL_CANCEL', body: {},
        });
        assertStatus(cancelled, 200);
        assert.equal(cancelled.json.data.tillSession.status, 'CANCELLED');
        assert.equal(cancelled.json.data.tillSession.expectedClosingCashAmount, null);
        assert.equal(cancelled.json.data.tillSession.actualClosingCashAmount, null);
        assert.equal(cancelled.json.data.tillSession.cashDifferenceAmount, null);
        for (const action of ['suspend', 'resume', 'close', 'cancel']) {
          assertSafeError(await send(fixture, baseUrl, `${cancelRoot}/${action}`, {
            method: 'POST', token: fixture.tokens.tillManage,
            label: 'CANCELLED_TERMINAL',
            body: action === 'close' ? { actualClosingCashAmount: '1.00' } : {},
          }), 409);
        }
        assertSafeError(await createMovement(
          fixture,
          baseUrl,
          opened.json.data.tillSession.tillSessionId,
          'CANCELLED_TERMINAL',
        ), 409);
      });

      await t.test('serializes register uniqueness and active-session races', async () => {
        const duplicateCode = `RACE_${fixture.token}`.slice(0, 30);
        const codeRace = await Promise.all([
          createRegister(fixture, baseUrl, 'CODE_RACE_A', {
            overrides: { registerCode: duplicateCode },
          }),
          createRegister(fixture, baseUrl, 'CODE_RACE_B', {
            overrides: { registerCode: duplicateCode.toLowerCase() },
          }),
        ]);
        assert.deepEqual(codeRace.map(({ response }) => response.status).sort(), [201, 409]);
        codeRace.filter(({ response }) => response.status === 409)
          .forEach((result) => assertSafeError(result, 409));
        const [codeRows] = await pool.execute(
          `SELECT COUNT(*) AS count FROM pos_registers
           WHERE branch_id = ? AND register_code = ?`,
          [fixture.branchAId, duplicateCode],
        );
        assert.equal(codeRows[0].count, '1');

        const sharedTerminal = `${fixture.prefix}_RACE_TERMINAL`;
        const terminalRace = await Promise.all([
          createRegister(fixture, baseUrl, 'TERM_RACE_A', {
            overrides: { terminalIdentifier: sharedTerminal },
          }),
          createRegister(fixture, baseUrl, 'TERM_RACE_B', {
            branchId: fixture.branchBId,
            overrides: { terminalIdentifier: sharedTerminal.toLowerCase() },
          }),
        ]);
        assert.deepEqual(
          terminalRace.map(({ response }) => response.status).sort(),
          [201, 409],
        );

        const sharedRegister = await createRegister(fixture, baseUrl, 'OPEN_RACE_REGISTER');
        assertStatus(sharedRegister, 201);
        const sameRegisterRace = await Promise.all([
          openTill(
            fixture, baseUrl, sharedRegister.json.data.posRegister.posRegisterId,
            'SAME_REGISTER_A', { cashierEmployeeId: fixture.employeeByName.cashier1 },
          ),
          openTill(
            fixture, baseUrl, sharedRegister.json.data.posRegister.posRegisterId,
            'SAME_REGISTER_B', { cashierEmployeeId: fixture.employeeByName.cashier2 },
          ),
        ]);
        assert.deepEqual(
          sameRegisterRace.map(({ response }) => response.status).sort(),
          [201, 409],
        );
        const winningRegisterSession = sameRegisterRace.find(
          ({ response }) => response.status === 201,
        ).json.data.tillSession;
        const [activeRegisterRows] = await pool.execute(
          `SELECT COUNT(*) AS count FROM till_sessions
           WHERE pos_register_id = ? AND status IN ('OPEN', 'SUSPENDED')`,
          [winningRegisterSession.posRegisterId],
        );
        assert.equal(activeRegisterRows[0].count, '1');
        assertStatus(await send(
          fixture,
          baseUrl,
          `${rootA}/till-sessions/${winningRegisterSession.tillSessionId}/cancel`,
          { method: 'POST', token: fixture.tokens.tillManage, label: 'RACE_REGISTER_RELEASE', body: {} },
        ), 200);

        const cashierRaceRegisters = await Promise.all([
          createRegister(fixture, baseUrl, 'CASHIER_RACE_A'),
          createRegister(fixture, baseUrl, 'CASHIER_RACE_B'),
        ]);
        cashierRaceRegisters.forEach((result) => assertStatus(result, 201));
        const sameCashierRace = await Promise.all(
          cashierRaceRegisters.map((result, index) => openTill(
            fixture,
            baseUrl,
            result.json.data.posRegister.posRegisterId,
            `SAME_CASHIER_${index}`,
            { cashierEmployeeId: fixture.employeeByName.cashierBoth },
          )),
        );
        assert.deepEqual(
          sameCashierRace.map(({ response }) => response.status).sort(),
          [201, 409],
        );
        const winningCashierSession = sameCashierRace.find(
          ({ response }) => response.status === 201,
        ).json.data.tillSession;
        const [activeCashierRows] = await pool.execute(
          `SELECT COUNT(*) AS count FROM till_sessions
           WHERE cashier_employee_id = ? AND status IN ('OPEN', 'SUSPENDED')`,
          [fixture.employeeByName.cashierBoth],
        );
        assert.equal(activeCashierRows[0].count, '1');
        assertStatus(await send(
          fixture,
          baseUrl,
          `${rootA}/till-sessions/${winningCashierSession.tillSessionId}/cancel`,
          { method: 'POST', token: fixture.tokens.tillManage, label: 'RACE_CASHIER_RELEASE', body: {} },
        ), 200);

        const statusRegister = await createRegister(fixture, baseUrl, 'STATUS_OPEN_RACE');
        assertStatus(statusRegister, 201);
        const statusRegisterId = statusRegister.json.data.posRegister.posRegisterId;
        const [statusPatch, statusOpen] = await Promise.all([
          send(fixture, baseUrl, `${rootA}/pos-registers/${statusRegisterId}`, {
            method: 'PATCH', label: 'STATUS_OPEN_RACE_PATCH', body: { status: 'INACTIVE' },
          }),
          openTill(fixture, baseUrl, statusRegisterId, 'STATUS_OPEN_RACE', {
            cashierEmployeeId: fixture.employeeByName.cashier1,
          }),
        ]);
        assert.ok(
          (statusPatch.response.status === 200 && statusOpen.response.status === 409) ||
          (statusPatch.response.status === 409 && statusOpen.response.status === 201),
        );
        const [stateRows] = await pool.execute(
          `SELECT pr.status,
                  (SELECT COUNT(*) FROM till_sessions ts
                   WHERE ts.pos_register_id = pr.pos_register_id
                     AND ts.status IN ('OPEN', 'SUSPENDED')) AS activeCount
           FROM pos_registers pr WHERE pr.pos_register_id = ?`,
          [statusRegisterId],
        );
        assert.ok(
          (stateRows[0].status === 'INACTIVE' && stateRows[0].activeCount === '0') ||
          (stateRows[0].status === 'ACTIVE' && stateRows[0].activeCount === '1'),
        );
        if (statusOpen.response.status === 201) {
          assertStatus(await send(
            fixture,
            baseUrl,
            `${rootA}/till-sessions/${statusOpen.json.data.tillSession.tillSessionId}/cancel`,
            { method: 'POST', token: fixture.tokens.tillManage, label: 'STATUS_RACE_RELEASE', body: {} },
          ), 200);
        }
      });

      await t.test('serializes lifecycle, close, and cancellation races', async () => {
        async function openRaceSession(label, { suspended = false } = {}) {
          const register = await createRegister(fixture, baseUrl, `LIFE_${label}`);
          assertStatus(register, 201);
          const opened = await openTill(
            fixture,
            baseUrl,
            register.json.data.posRegister.posRegisterId,
            `LIFE_${label}`,
            { cashierEmployeeId: fixture.employeeByName.cashier1, openingCashAmount: '100.00' },
          );
          assertStatus(opened, 201);
          const session = opened.json.data.tillSession;
          if (suspended) {
            assertStatus(await send(
              fixture,
              baseUrl,
              `${rootA}/till-sessions/${session.tillSessionId}/suspend`,
              { method: 'POST', token: fixture.tokens.tillManage, label: `${label}_PRE_SUSPEND`, body: {} },
            ), 200);
          }
          return session;
        }

        const suspendClose = await openRaceSession('SUSPEND_CLOSE');
        const suspendCloseRoot = `${rootA}/till-sessions/${suspendClose.tillSessionId}`;
        const suspendCloseResults = await Promise.all([
          send(fixture, baseUrl, `${suspendCloseRoot}/suspend`, {
            method: 'POST', token: fixture.tokens.tillManage, label: 'RACE_SUSPEND', body: {},
          }),
          send(fixture, baseUrl, `${suspendCloseRoot}/close`, {
            method: 'POST', token: fixture.tokens.tillManage,
            label: 'RACE_SUSPEND_CLOSE', body: { actualClosingCashAmount: '100.00' },
          }),
        ]);
        assert.equal(suspendCloseResults[1].response.status, 200);
        assert.ok([200, 409].includes(suspendCloseResults[0].response.status));

        const resumeClose = await openRaceSession('RESUME_CLOSE', { suspended: true });
        const resumeCloseRoot = `${rootA}/till-sessions/${resumeClose.tillSessionId}`;
        const resumeCloseResults = await Promise.all([
          send(fixture, baseUrl, `${resumeCloseRoot}/resume`, {
            method: 'POST', token: fixture.tokens.tillManage, label: 'RACE_RESUME', body: {},
          }),
          send(fixture, baseUrl, `${resumeCloseRoot}/close`, {
            method: 'POST', token: fixture.tokens.tillManage,
            label: 'RACE_RESUME_CLOSE', body: { actualClosingCashAmount: '100.00' },
          }),
        ]);
        assert.equal(resumeCloseResults[1].response.status, 200);
        assert.ok([200, 409].includes(resumeCloseResults[0].response.status));

        const duplicateClose = await openRaceSession('DUP_CLOSE');
        const duplicateClosePath = `${rootA}/till-sessions/${duplicateClose.tillSessionId}/close`;
        const duplicateCloseResults = await Promise.all([
          send(fixture, baseUrl, duplicateClosePath, {
            method: 'POST', token: fixture.tokens.tillManage,
            label: 'DUP_CLOSE_A', body: { actualClosingCashAmount: '100.00' },
          }),
          send(fixture, baseUrl, duplicateClosePath, {
            method: 'POST', token: fixture.tokens.tillManage,
            label: 'DUP_CLOSE_B', body: { actualClosingCashAmount: '101.00' },
          }),
        ]);
        assert.deepEqual(
          duplicateCloseResults.map(({ response }) => response.status).sort(),
          [200, 409],
        );
        const closeAudits = await auditRows(
          duplicateCloseResults.map(({ requestId }) => requestId),
        );
        assert.equal(closeAudits.length, 1);
        assert.equal(closeAudits[0].actionType, 'TILL_SESSION_CLOSED');

        const closeMovement = await openRaceSession('CLOSE_MOVEMENT');
        const closeMovementRoot = `${rootA}/till-sessions/${closeMovement.tillSessionId}`;
        const [closeResult, movementResult] = await Promise.all([
          send(fixture, baseUrl, `${closeMovementRoot}/close`, {
            method: 'POST', token: fixture.tokens.tillManage,
            label: 'RACE_CLOSE_MOVEMENT_CLOSE', body: { actualClosingCashAmount: '100.00' },
          }),
          createMovement(
            fixture,
            baseUrl,
            closeMovement.tillSessionId,
            'RACE_CLOSE_MOVEMENT',
            { movementType: 'CASH_IN', amount: '5.00' },
          ),
        ]);
        assert.equal(closeResult.response.status, 200);
        assert.ok([201, 409].includes(movementResult.response.status));
        const [closeState] = await pool.execute(
          `SELECT expected_closing_cash_amount AS expectedAmount,
                  (SELECT COUNT(*) FROM till_cash_movements
                   WHERE till_session_id = ts.till_session_id) AS movementCount
           FROM till_sessions ts WHERE till_session_id = ?`,
          [closeMovement.tillSessionId],
        );
        assert.equal(
          closeState[0].expectedAmount,
          closeState[0].movementCount === '1' ? '105.00' : '100.00',
        );

        const cancelMovement = await openRaceSession('CANCEL_MOVEMENT');
        const cancelMovementRoot = `${rootA}/till-sessions/${cancelMovement.tillSessionId}`;
        const [cancelResult, cancelMovementResult] = await Promise.all([
          send(fixture, baseUrl, `${cancelMovementRoot}/cancel`, {
            method: 'POST', token: fixture.tokens.tillManage,
            label: 'RACE_CANCEL_MOVEMENT_CANCEL', body: {},
          }),
          createMovement(
            fixture,
            baseUrl,
            cancelMovement.tillSessionId,
            'RACE_CANCEL_MOVEMENT',
            { movementType: 'CASH_IN', amount: '5.00' },
          ),
        ]);
        assert.ok([200, 409].includes(cancelResult.response.status));
        assert.ok([201, 409].includes(cancelMovementResult.response.status));
        assert.notEqual(
          cancelResult.response.status === 200 && cancelMovementResult.response.status === 201,
          true,
        );
        const [cancelState] = await pool.execute(
          `SELECT status,
                  (SELECT COUNT(*) FROM till_cash_movements
                   WHERE till_session_id = ts.till_session_id) AS movementCount
           FROM till_sessions ts WHERE till_session_id = ?`,
          [cancelMovement.tillSessionId],
        );
        assert.ok(
          (cancelState[0].status === 'CANCELLED' && cancelState[0].movementCount === '0') ||
          (cancelState[0].status === 'OPEN' && cancelState[0].movementCount === '1'),
        );
        if (cancelState[0].status === 'OPEN') {
          assertStatus(await send(fixture, baseUrl, `${cancelMovementRoot}/close`, {
            method: 'POST', token: fixture.tokens.tillManage,
            label: 'CANCEL_RACE_RELEASE', body: { actualClosingCashAmount: '105.00' },
          }), 200);
        }
      });

      await t.test('writes the exact transaction-bound Phase 11 audit vocabulary', async () => {
        const created = await createRegister(fixture, baseUrl, 'AUDIT_REGISTER');
        assertStatus(created, 201);
        const register = created.json.data.posRegister;
        const updated = await send(
          fixture,
          baseUrl,
          `${rootA}/pos-registers/${register.posRegisterId}`,
          {
            method: 'PATCH',
            label: 'AUDIT_REGISTER_UPDATE',
            body: { registerName: `${fixture.prefix} Audit Register Updated` },
          },
        );
        assertStatus(updated, 200);

        const opened = await openTill(
          fixture,
          baseUrl,
          register.posRegisterId,
          'AUDIT_CLOSE',
          { cashierEmployeeId: fixture.employeeByName.cashier1, openingCashAmount: '50.00' },
        );
        assertStatus(opened, 201);
        const session = opened.json.data.tillSession;
        const sessionRoot = `${rootA}/till-sessions/${session.tillSessionId}`;
        const suspended = await send(fixture, baseUrl, `${sessionRoot}/suspend`, {
          method: 'POST', token: fixture.tokens.tillManage,
          label: 'AUDIT_SUSPEND', body: {},
        });
        assertStatus(suspended, 200);
        const resumed = await send(fixture, baseUrl, `${sessionRoot}/resume`, {
          method: 'POST', token: fixture.tokens.tillManage,
          label: 'AUDIT_RESUME', body: {},
        });
        assertStatus(resumed, 200);
        const movement = await createMovement(
          fixture,
          baseUrl,
          session.tillSessionId,
          'AUDIT_MOVEMENT',
          { amount: '2.00' },
        );
        assertStatus(movement, 201);
        const closed = await send(fixture, baseUrl, `${sessionRoot}/close`, {
          method: 'POST', token: fixture.tokens.tillManage,
          label: 'AUDIT_CLOSE', body: { actualClosingCashAmount: '52.00' },
        });
        assertStatus(closed, 200);

        const reopened = await openTill(
          fixture,
          baseUrl,
          register.posRegisterId,
          'AUDIT_CANCEL',
          { cashierEmployeeId: fixture.employeeByName.cashier2, openingCashAmount: '0.00' },
        );
        assertStatus(reopened, 201);
        const cancelled = await send(
          fixture,
          baseUrl,
          `${rootA}/till-sessions/${reopened.json.data.tillSession.tillSessionId}/cancel`,
          {
            method: 'POST', token: fixture.tokens.tillManage,
            label: 'AUDIT_CANCEL', body: {},
          },
        );
        assertStatus(cancelled, 200);

        const mutationResults = [
          created, updated, opened, suspended, resumed, movement, closed,
          reopened, cancelled,
        ];
        const audits = await auditRows(mutationResults.map(({ requestId }) => requestId));
        assert.equal(audits.length, mutationResults.length);
        assert.deepEqual(
          [...new Set(audits.map(({ actionType }) => actionType))].sort(),
          [
            'POS_REGISTER_CREATED',
            'POS_REGISTER_UPDATED',
            'TILL_CASH_MOVEMENT_CREATED',
            'TILL_SESSION_CANCELLED',
            'TILL_SESSION_CLOSED',
            'TILL_SESSION_OPENED',
            'TILL_SESSION_RESUMED',
            'TILL_SESSION_SUSPENDED',
          ],
        );
        assert.ok(audits.every(({ branchId }) => branchId === fixture.branchAId));
        assert.ok(audits.every(({ beforeValues, afterValues }) => {
          const serialized = JSON.stringify({ beforeValues, afterValues });
          return ![
            'activeRegisterGuard', 'activeCashierGuard', 'password', 'token',
            'credential', 'sqlMessage', 'DB_PASSWORD',
          ].some((secret) => serialized.includes(secret));
        }));

        const detail = await send(
          fixture,
          baseUrl,
          `${rootA}/pos-registers/${register.posRegisterId}`,
          { label: 'AUDIT_GET_SUPPRESSED' },
        );
        assertStatus(detail, 200);
        const duplicate = await createRegister(fixture, baseUrl, 'AUDIT_DUPLICATE', {
          overrides: { registerCode: register.registerCode },
        });
        assertSafeError(duplicate, 409);
        const noOp = await send(
          fixture,
          baseUrl,
          `${rootA}/pos-registers/${register.posRegisterId}`,
          {
            method: 'PATCH',
            label: 'AUDIT_NOOP_SUPPRESSED',
            body: { registerName: `${fixture.prefix} Audit Register Updated` },
          },
        );
        assertStatus(noOp, 200);
        assert.deepEqual(
          await auditRows([detail.requestId, duplicate.requestId, noOp.requestId]),
          [],
        );
      });

      await t.test('reconciles persisted cash evidence exactly without mutating it', async () => {
        const register = await createRegister(fixture, baseUrl, 'RECONCILIATION');
        assertStatus(register, 201);
        const opened = await openTill(
          fixture,
          baseUrl,
          register.json.data.posRegister.posRegisterId,
          'RECONCILIATION',
          { cashierEmployeeId: fixture.employeeByName.cashier1, openingCashAmount: '100.00' },
        );
        assertStatus(opened, 201);
        const session = opened.json.data.tillSession;
        const saleId = await insertSale(fixture, session, 'RECONCILIATION');

        await insertPayment(fixture, saleId, 'CASH_PAYMENT', {
          amount: '50.00',
        });
        await insertPayment(fixture, saleId, 'CASH_REFUND', {
          paymentType: 'REFUND', amount: '10.00',
        });
        await insertPayment(fixture, saleId, 'CARD_COMPLETED', {
          methodId: fixture.cardPaymentMethodId, amount: '500.00',
        });
        await insertPayment(fixture, saleId, 'CASH_PENDING', {
          status: 'PENDING', amount: '100.00',
        });
        await insertPayment(fixture, saleId, 'CASH_FAILED', {
          status: 'FAILED', amount: '100.00',
        });
        await insertPayment(fixture, saleId, 'CASH_CANCELLED', {
          status: 'CANCELLED', amount: '100.00',
        });

        for (const [movementType, amount] of [
          ['CASH_IN', '20.00'],
          ['CASH_OUT', '5.00'],
          ['CASH_DROP', '30.00'],
          ['PAYOUT', '2.00'],
        ]) {
          assertStatus(await createMovement(
            fixture,
            baseUrl,
            session.tillSessionId,
            `RECON_${movementType}`,
            { movementType, amount },
          ), 201);
        }

        const [saleBefore] = await pool.execute(
          `SELECT status, currency_code AS currencyCode,
                  subtotal_amount AS subtotalAmount, total_amount AS totalAmount,
                  updated_at AS updatedAt
           FROM sales WHERE sale_id = ?`,
          [saleId],
        );
        const [paymentsBefore] = await pool.execute(
          `SELECT payment_number AS paymentNumber, payment_type AS paymentType,
                  status, amount, currency_code AS currencyCode,
                  updated_at AS updatedAt
           FROM sale_payments WHERE sale_id = ? ORDER BY sale_payment_id`,
          [saleId],
        );
        const result = await send(
          fixture,
          baseUrl,
          `${rootA}/till-sessions/${session.tillSessionId}/close`,
          {
            method: 'POST', token: fixture.tokens.tillManage,
            label: 'RECONCILIATION_CLOSE',
            body: { actualClosingCashAmount: '120.00' },
          },
        );
        assertStatus(result, 200);
        assert.equal(result.json.data.tillSession.status, 'CLOSED');
        assert.equal(result.json.data.tillSession.expectedClosingCashAmount, '123.00');
        assert.equal(result.json.data.tillSession.actualClosingCashAmount, '120.00');
        assert.equal(result.json.data.tillSession.cashDifferenceAmount, '-3.00');

        const [saleAfter] = await pool.execute(
          `SELECT status, currency_code AS currencyCode,
                  subtotal_amount AS subtotalAmount, total_amount AS totalAmount,
                  updated_at AS updatedAt
           FROM sales WHERE sale_id = ?`,
          [saleId],
        );
        const [paymentsAfter] = await pool.execute(
          `SELECT payment_number AS paymentNumber, payment_type AS paymentType,
                  status, amount, currency_code AS currencyCode,
                  updated_at AS updatedAt
           FROM sale_payments WHERE sale_id = ? ORDER BY sale_payment_id`,
          [saleId],
        );
        assert.deepEqual(saleAfter, saleBefore);
        assert.deepEqual(paymentsAfter, paymentsBefore);
      });

      await t.test('rolls back currency, negative-cash, and overflow close failures', async () => {
        const register = await createRegister(fixture, baseUrl, 'RECON_FAILURES');
        assertStatus(register, 201);
        const registerId = register.json.data.posRegister.posRegisterId;
        const opened = await openTill(
          fixture,
          baseUrl,
          registerId,
          'RECON_FAILURES',
          { cashierEmployeeId: fixture.employeeByName.cashier1, openingCashAmount: '0.00' },
        );
        assertStatus(opened, 201);
        const session = opened.json.data.tillSession;
        const saleId = await insertSale(fixture, session, 'RECON_FAILURES');
        const paymentId = await insertPayment(fixture, saleId, 'WRONG_CURRENCY', {
          amount: '5.00', currencyCode: 'USD',
        });
        assertStatus(await createMovement(
          fixture,
          baseUrl,
          session.tillSessionId,
          'NEGATIVE_EXPECTED',
          { movementType: 'CASH_OUT', amount: '10.00' },
        ), 201);

        const closePath = `${rootA}/till-sessions/${session.tillSessionId}/close`;
        const currencyFailure = await send(fixture, baseUrl, closePath, {
          method: 'POST', token: fixture.tokens.tillManage,
          label: 'CURRENCY_MISMATCH', body: { actualClosingCashAmount: '0.00' },
        });
        assertSafeError(currencyFailure, 409);
        assert.deepEqual(await auditRows([currencyFailure.requestId]), []);
        const [afterCurrencyFailure] = await pool.execute(
          `SELECT status, closed_at AS closedAt,
                  expected_closing_cash_amount AS expectedAmount,
                  actual_closing_cash_amount AS actualAmount,
                  cash_difference_amount AS differenceAmount
           FROM till_sessions WHERE till_session_id = ?`,
          [session.tillSessionId],
        );
        assert.deepEqual(afterCurrencyFailure, [{
          status: 'OPEN',
          closedAt: null,
          expectedAmount: null,
          actualAmount: null,
          differenceAmount: null,
        }]);

        await pool.execute(
          `UPDATE sale_payments SET currency_code = 'NGN'
           WHERE sale_payment_id = ?`,
          [paymentId],
        );
        const negativeFailure = await send(fixture, baseUrl, closePath, {
          method: 'POST', token: fixture.tokens.tillManage,
          label: 'NEGATIVE_EXPECTED', body: { actualClosingCashAmount: '0.00' },
        });
        assertSafeError(negativeFailure, 409);
        assert.deepEqual(await auditRows([negativeFailure.requestId]), []);
        const [afterNegativeFailure] = await pool.execute(
          `SELECT status, closed_at AS closedAt,
                  expected_closing_cash_amount AS expectedAmount
           FROM till_sessions WHERE till_session_id = ?`,
          [session.tillSessionId],
        );
        assert.deepEqual(afterNegativeFailure, [{
          status: 'OPEN', closedAt: null, expectedAmount: null,
        }]);

        assertStatus(await createMovement(
          fixture,
          baseUrl,
          session.tillSessionId,
          'NEGATIVE_RECOVERY',
          { movementType: 'CASH_IN', amount: '5.00' },
        ), 201);
        assertStatus(await send(fixture, baseUrl, closePath, {
          method: 'POST', token: fixture.tokens.tillManage,
          label: 'NEGATIVE_RECOVERY_CLOSE', body: { actualClosingCashAmount: '0.00' },
        }), 200);

        const overflowOpen = await openTill(
          fixture,
          baseUrl,
          registerId,
          'RECON_OVERFLOW',
          {
            cashierEmployeeId: fixture.employeeByName.cashier1,
            openingCashAmount: '99999999999999999.99',
          },
        );
        assertStatus(overflowOpen, 201);
        const overflowId = overflowOpen.json.data.tillSession.tillSessionId;
        assertStatus(await createMovement(
          fixture,
          baseUrl,
          overflowId,
          'OVERFLOW_IN',
          { movementType: 'CASH_IN', amount: '0.01' },
        ), 201);
        const overflowFailure = await send(
          fixture,
          baseUrl,
          `${rootA}/till-sessions/${overflowId}/close`,
          {
            method: 'POST', token: fixture.tokens.tillManage,
            label: 'RECON_OVERFLOW_CLOSE',
            body: { actualClosingCashAmount: '99999999999999999.99' },
          },
        );
        assertSafeError(overflowFailure, 409);
        assert.deepEqual(await auditRows([overflowFailure.requestId]), []);
        assertStatus(await createMovement(
          fixture,
          baseUrl,
          overflowId,
          'OVERFLOW_RECOVERY',
          { movementType: 'CASH_OUT', amount: '0.01' },
        ), 201);
        assertStatus(await send(
          fixture,
          baseUrl,
          `${rootA}/till-sessions/${overflowId}/close`,
          {
            method: 'POST', token: fixture.tokens.tillManage,
            label: 'RECON_OVERFLOW_RECOVERY_CLOSE',
            body: { actualClosingCashAmount: '99999999999999999.99' },
          },
        ), 200);
      });

      await t.test('rejects cancellation with persisted movement or sale evidence', async () => {
        const register = await createRegister(fixture, baseUrl, 'CANCEL_EVIDENCE');
        assertStatus(register, 201);
        const registerId = register.json.data.posRegister.posRegisterId;
        const movementOpen = await openTill(
          fixture,
          baseUrl,
          registerId,
          'CANCEL_MOVEMENT_EVIDENCE',
          { cashierEmployeeId: fixture.employeeByName.cashier1, openingCashAmount: '10.00' },
        );
        assertStatus(movementOpen, 201);
        const movementSession = movementOpen.json.data.tillSession;
        assertStatus(await createMovement(
          fixture,
          baseUrl,
          movementSession.tillSessionId,
          'CANCEL_EVIDENCE',
          { movementType: 'CASH_IN', amount: '1.00' },
        ), 201);
        const movementCancel = await send(
          fixture,
          baseUrl,
          `${rootA}/till-sessions/${movementSession.tillSessionId}/cancel`,
          {
            method: 'POST', token: fixture.tokens.tillManage,
            label: 'CANCEL_WITH_MOVEMENT', body: {},
          },
        );
        assertSafeError(movementCancel, 409);
        assert.deepEqual(await auditRows([movementCancel.requestId]), []);
        assertStatus(await send(
          fixture,
          baseUrl,
          `${rootA}/till-sessions/${movementSession.tillSessionId}/close`,
          {
            method: 'POST', token: fixture.tokens.tillManage,
            label: 'CANCEL_MOVEMENT_RELEASE', body: { actualClosingCashAmount: '11.00' },
          },
        ), 200);

        const saleOpen = await openTill(
          fixture,
          baseUrl,
          registerId,
          'CANCEL_SALE_EVIDENCE',
          { cashierEmployeeId: fixture.employeeByName.cashier1, openingCashAmount: '10.00' },
        );
        assertStatus(saleOpen, 201);
        const saleSession = saleOpen.json.data.tillSession;
        const saleId = await insertSale(fixture, saleSession, 'CANCEL_EVIDENCE');
        const saleCancel = await send(
          fixture,
          baseUrl,
          `${rootA}/till-sessions/${saleSession.tillSessionId}/cancel`,
          {
            method: 'POST', token: fixture.tokens.tillManage,
            label: 'CANCEL_WITH_SALE', body: {},
          },
        );
        assertSafeError(saleCancel, 409);
        assert.deepEqual(await auditRows([saleCancel.requestId]), []);
        const [saleBeforeClose] = await pool.execute(
          'SELECT status, updated_at AS updatedAt FROM sales WHERE sale_id = ?',
          [saleId],
        );
        assertStatus(await send(
          fixture,
          baseUrl,
          `${rootA}/till-sessions/${saleSession.tillSessionId}/close`,
          {
            method: 'POST', token: fixture.tokens.tillManage,
            label: 'CANCEL_SALE_RELEASE', body: { actualClosingCashAmount: '10.00' },
          },
        ), 200);
        const [saleAfterClose] = await pool.execute(
          'SELECT status, updated_at AS updatedAt FROM sales WHERE sale_id = ?',
          [saleId],
        );
        assert.deepEqual(saleAfterClose, saleBeforeClose);
      });

      await t.test('does not mutate unrelated business domains', async () => {
        const tables = [
          'products', 'product_variants', 'product_packages', 'suppliers',
          'purchase_orders', 'goods_receipts', 'branch_inventory',
          'inventory_lots', 'customers', 'sales', 'sale_payments',
          'inventory_adjustments', 'stock_counts', 'stock_transfers',
        ];
        const snapshot = async () => Object.fromEntries(await Promise.all(
          tables.map(async (table) => [table, await tableFingerprint(table)]),
        ));
        const before = await snapshot();
        const register = await createRegister(fixture, baseUrl, 'NONMUTATION');
        assertStatus(register, 201);
        const opened = await openTill(
          fixture,
          baseUrl,
          register.json.data.posRegister.posRegisterId,
          'NONMUTATION',
          { cashierEmployeeId: fixture.employeeByName.cashier1, openingCashAmount: '0.00' },
        );
        assertStatus(opened, 201);
        assertStatus(await send(
          fixture,
          baseUrl,
          `${rootA}/till-sessions/${opened.json.data.tillSession.tillSessionId}/cancel`,
          {
            method: 'POST', token: fixture.tokens.tillManage,
            label: 'NONMUTATION_CANCEL', body: {},
          },
        ), 200);
        assert.deepEqual(await snapshot(), before);
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
        throw new AggregateError(cleanupErrors, 'Phase 11 cleanup failed');
      }
    }
  },
);
