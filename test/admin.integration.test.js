import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import net from 'node:net';
import test from 'node:test';

import bcrypt from 'bcrypt';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

requireIntegrationEnvironment();

const [
  { default: app },
  { pool },
  { ACCESS_CONTROL_PERMISSIONS, SYSTEM_ADMIN_ROLE },
  { signAccessToken },
] = await Promise.all([
  import('../src/app.js'),
  import('../src/config/database.js'),
  import('../src/config/accessControl.js'),
  import('../src/utils/jwt.js'),
]);

const TEST_TIMEOUT_MS = 300_000;
const CHILD_TIMEOUT_MS = 20_000;
const MAX_UNSIGNED_BIGINT = '18446744073709551615';
const TEST_USER_AGENT = 'TEST_PHASE4_ADMIN_INTEGRATION/1.0';

function requireIntegrationEnvironment() {
  const requiredVariables = [
    'DB_HOST',
    'DB_PORT',
    'DB_USER',
    'DB_PASSWORD',
    'DB_NAME',
    'JWT_SECRET',
    'JWT_EXPIRES_IN',
    'JWT_ISSUER',
    'JWT_AUDIENCE',
    'BCRYPT_ROUNDS',
  ];
  const missingVariables = requiredVariables.filter((variableName) => {
    if (variableName === 'DB_PASSWORD') {
      return !Object.hasOwn(process.env, variableName);
    }

    return !process.env[variableName]?.trim();
  });

  assert.deepEqual(
    missingVariables,
    [],
    'Phase 4 live integration tests require the documented environment variables.',
  );
  assert.ok(
    Buffer.byteLength(process.env.JWT_SECRET, 'utf8') >= 48,
    'JWT_SECRET must be at least 48 UTF-8 bytes.',
  );

  const rounds = Number(process.env.BCRYPT_ROUNDS);
  assert.ok(
    Number.isInteger(rounds) && rounds >= 10 && rounds <= 14,
    'BCRYPT_ROUNDS must be an integer between 10 and 14.',
  );
}

function assertIdString(value) {
  assert.equal(typeof value, 'string');
  assert.match(value, /^[1-9]\d*$/);
}

async function getLastInsertId(connection) {
  const [rows] = await connection.execute(
    'SELECT CAST(LAST_INSERT_ID() AS CHAR) AS insertedId',
  );

  return rows[0].insertedId;
}

function createFixtureDefinition() {
  const token = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
  const lowerToken = token.toLowerCase();
  const fixture = {
    token,
    lowerToken,
    auditPrefix: `TEST_P4_${token}`,
    requestCounter: 0,
    requestIds: new Set(),
    failedRequestIds: new Set(),
    known: {
      branchCodes: new Set([`T4S_${token}`]),
      employeeNumbers: new Set([`T4ADM_${token}`]),
      roleCodes: new Set([`T4_ADMIN_${token}`]),
      usernames: new Set([
        `t4.admin.${lowerToken}`,
        `t4.must.${lowerToken}`,
        `t4.denied.${lowerToken}`,
        `t4.scoped.${lowerToken}`,
        `t4.subject.${lowerToken}`,
      ]),
    },
    ids: {
      branches: new Set(),
      employees: new Set(),
      roles: new Set(),
      users: new Set(),
      assignments: new Set(),
      userRoles: new Set(),
    },
    scopeBranchCode: `T4S_${token}`,
    adminEmployeeNumber: `T4ADM_${token}`,
    adminRoleCode: `T4_ADMIN_${token}`,
    adminUsername: `t4.admin.${lowerToken}`,
    mustChangeUsername: `t4.must.${lowerToken}`,
    deniedUsername: `t4.denied.${lowerToken}`,
    scopedUsername: `t4.scoped.${lowerToken}`,
    subjectUsername: `t4.subject.${lowerToken}`,
    adminPassword: `Admin-P4-${token}!`,
    temporaryPassword: `Temporary-P4-${token}!`,
    resetPassword: `Reset-P4-${token}!`,
    termPassword: `Terminate-P4-${token}!`,
    setupCommitted: false,
  };

  fixture.branchPayloads = ['A', 'B', 'C'].map((suffix, index) => {
    const branchCode = `T4${suffix}_${token}`;
    fixture.known.branchCodes.add(branchCode);
    return {
      branchCode: branchCode.toLowerCase(),
      branchName: `PAGED_${token} Branch ${suffix}`,
      phone: `+23480000000${index}`,
      email: `phase4-branch-${suffix.toLowerCase()}-${lowerToken}@example.invalid`,
      addressLine1: `${index + 1} Phase Four Avenue`,
      addressLine2: null,
      city: 'Lagos',
      stateRegion: 'Lagos',
      postalCode: `10000${index}`,
      countryCode: 'ng',
      currencyCode: 'ngn',
      timezone: 'Africa/Lagos',
      openedOn: '2020-01-01',
      status: 'ACTIVE',
    };
  });

  fixture.employeePayloads = ['ONE', 'TERM', 'THREE'].map((suffix, index) => {
    const employeeNumber = `T4${suffix}_${token}`;
    fixture.known.employeeNumbers.add(employeeNumber);
    return {
      employeeNumber: employeeNumber.toLowerCase(),
      firstName: `PAGED_${token}`,
      lastName: `Employee ${index + 1}`,
      email: `phase4-employee-${index + 1}-${lowerToken}@example.invalid`,
      phone: `+23481100000${index}`,
      hireDate: '2020-01-01',
      employmentStatus: 'ACTIVE',
    };
  });

  fixture.rolePayloads = ['ONE', 'TWO', 'THREE'].map((suffix, index) => {
    const roleCode = `T4_${suffix}_${token}`;
    fixture.known.roleCodes.add(roleCode);
    return {
      roleCode: roleCode.toLowerCase(),
      roleName: `PAGED_${token} Role ${index + 1}`,
      description: `Temporary Phase 4 role ${index + 1}`,
      isActive: true,
    };
  });

  return fixture;
}

function nextRequestId(fixture, label) {
  fixture.requestCounter += 1;
  const requestId = `${fixture.auditPrefix}_${String(
    fixture.requestCounter,
  ).padStart(3, '0')}_${label}`.slice(0, 100);
  fixture.requestIds.add(requestId);
  return requestId;
}

async function runNodeScript(scriptPath) {
  const child = spawn(process.execPath, [scriptPath], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'test' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout = `${stdout}${chunk}`.slice(-30_000);
  });
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-30_000);
  });
  child.stdin.end();

  let timeout;
  try {
    const [code, signal] = await Promise.race([
      once(child, 'exit'),
      new Promise((resolve, reject) => {
        timeout = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`${scriptPath} timed out.`));
        }, CHILD_TIMEOUT_MS);
      }),
    ]);
    return { code, signal, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

async function canonicalSeedSnapshot() {
  const permissionCodes = ACCESS_CONTROL_PERMISSIONS.map(({ code }) => code);
  const placeholders = permissionCodes.map(() => '?').join(', ');
  const [permissionRows] = await pool.execute(
    `SELECT
       CAST(permission_id AS CHAR) AS permissionId,
       permission_code AS permissionCode,
       permission_name AS permissionName,
       description
     FROM permissions
     WHERE permission_code IN (${placeholders})
     ORDER BY permission_code`,
    permissionCodes,
  );
  const [roleRows] = await pool.execute(
    `SELECT
       CAST(role_id AS CHAR) AS roleId,
       role_code AS roleCode,
       role_name AS roleName,
       description,
       is_active AS isActive
     FROM roles
     WHERE role_code = ?
     ORDER BY role_id`,
    [SYSTEM_ADMIN_ROLE.code],
  );
  const roleId = roleRows[0]?.roleId ?? '0';
  const [mappingRows] = await pool.execute(
    `SELECT
       CAST(rp.role_id AS CHAR) AS roleId,
       CAST(rp.permission_id AS CHAR) AS permissionId,
       p.permission_code AS permissionCode
     FROM role_permissions rp
     INNER JOIN permissions p ON p.permission_id = rp.permission_id
     WHERE rp.role_id = ?
       AND p.permission_code IN (${placeholders})
     ORDER BY p.permission_code`,
    [roleId, ...permissionCodes],
  );

  return { permissions: permissionRows, roles: roleRows, mappings: mappingRows };
}

async function createFixtures(fixture) {
  const rounds = Number(process.env.BCRYPT_ROUNDS);
  const passwordHash = await bcrypt.hash(fixture.adminPassword, rounds);
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    const [dateRows] = await connection.execute(
      "SELECT DATE_FORMAT(CURRENT_DATE(), '%Y-%m-%d') AS currentDate",
    );
    fixture.currentDate = dateRows[0].currentDate;

    await connection.execute(
      `INSERT INTO branches (
         branch_code, branch_name, address_line_1, city,
         country_code, currency_code, timezone, status
       ) VALUES (?, ?, ?, ?, 'NG', 'NGN', 'Africa/Lagos', 'ACTIVE')`,
      [
        fixture.scopeBranchCode,
        `TEST_P4 Scope ${fixture.token}`,
        '1 Fixture Setup Street',
        'Lagos',
      ],
    );
    fixture.scopeBranchId = await getLastInsertId(connection);
    fixture.ids.branches.add(fixture.scopeBranchId);

    await connection.execute(
      `INSERT INTO employees (
         employee_number, first_name, last_name, email,
         hire_date, employment_status
       ) VALUES (?, 'Phase4', 'Administrator', ?, '2020-01-01', 'ACTIVE')`,
      [
        fixture.adminEmployeeNumber,
        `phase4-admin-employee-${fixture.lowerToken}@example.invalid`,
      ],
    );
    fixture.adminEmployeeId = await getLastInsertId(connection);
    fixture.ids.employees.add(fixture.adminEmployeeId);

    await connection.execute(
      `INSERT INTO roles (role_code, role_name, description, is_active)
       VALUES (?, ?, 'Temporary Phase 4 integration administrator role', 1)`,
      [fixture.adminRoleCode, `TEST_P4 Administrator ${fixture.token}`],
    );
    fixture.adminRoleId = await getLastInsertId(connection);
    fixture.ids.roles.add(fixture.adminRoleId);

    const permissionCodes = ACCESS_CONTROL_PERMISSIONS.map(({ code }) => code);
    const placeholders = permissionCodes.map(() => '?').join(', ');
    const [permissionRows] = await connection.execute(
      `SELECT CAST(permission_id AS CHAR) AS permissionId, permission_code AS permissionCode
       FROM permissions
       WHERE permission_code IN (${placeholders})
       ORDER BY permission_code`,
      permissionCodes,
    );
    assert.equal(permissionRows.length, ACCESS_CONTROL_PERMISSIONS.length);
    fixture.permissionIdByCode = Object.fromEntries(
      permissionRows.map((row) => [row.permissionCode, row.permissionId]),
    );

    for (const permission of permissionRows) {
      await connection.execute(
        'INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
        [fixture.adminRoleId, permission.permissionId],
      );
    }

    const users = [
      {
        key: 'admin',
        employeeId: fixture.adminEmployeeId,
        username: fixture.adminUsername,
        mustChange: 0,
      },
      {
        key: 'mustChange',
        employeeId: null,
        username: fixture.mustChangeUsername,
        mustChange: 1,
      },
      {
        key: 'denied',
        employeeId: null,
        username: fixture.deniedUsername,
        mustChange: 0,
      },
      {
        key: 'scoped',
        employeeId: null,
        username: fixture.scopedUsername,
        mustChange: 0,
      },
      {
        key: 'subject',
        employeeId: null,
        username: fixture.subjectUsername,
        mustChange: 0,
      },
    ];

    for (const user of users) {
      await connection.execute(
        `INSERT INTO users (
           employee_id, username, email, password_hash,
           is_active, must_change_password
         ) VALUES (?, ?, ?, ?, 1, ?)`,
        [
          user.employeeId,
          user.username,
          `${user.username}@example.invalid`,
          passwordHash,
          user.mustChange,
        ],
      );
      const userId = await getLastInsertId(connection);
      fixture[`${user.key}UserId`] = userId;
      fixture.ids.users.add(userId);
    }

    await connection.execute(
      `INSERT INTO user_roles (user_id, role_id, branch_id, assigned_by_user_id)
       VALUES (?, ?, NULL, ?)`,
      [fixture.adminUserId, fixture.adminRoleId, fixture.adminUserId],
    );
    fixture.adminUserRoleId = await getLastInsertId(connection);
    fixture.ids.userRoles.add(fixture.adminUserRoleId);

    await connection.execute(
      `INSERT INTO user_roles (user_id, role_id, branch_id, assigned_by_user_id)
       VALUES (?, ?, NULL, ?)`,
      [fixture.mustChangeUserId, fixture.adminRoleId, fixture.adminUserId],
    );
    fixture.ids.userRoles.add(await getLastInsertId(connection));

    await connection.execute(
      `INSERT INTO user_roles (user_id, role_id, branch_id, assigned_by_user_id)
       VALUES (?, ?, ?, ?)`,
      [
        fixture.scopedUserId,
        fixture.adminRoleId,
        fixture.scopeBranchId,
        fixture.adminUserId,
      ],
    );
    fixture.ids.userRoles.add(await getLastInsertId(connection));

    await connection.commit();
    fixture.setupCommitted = true;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  fixture.adminToken = signAccessToken(fixture.adminUserId).accessToken;
  fixture.mustChangeToken = signAccessToken(
    fixture.mustChangeUserId,
  ).accessToken;
  fixture.deniedToken = signAccessToken(fixture.deniedUserId).accessToken;
  fixture.scopedToken = signAccessToken(fixture.scopedUserId).accessToken;
  fixture.subjectToken = signAccessToken(fixture.subjectUserId).accessToken;
}

function startHttpServer(expressApp) {
  return new Promise((resolve, reject) => {
    const server = expressApp.listen(0, '127.0.0.1');
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

async function stopHttpServer(server) {
  if (!server?.listening) {
    return;
  }

  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function baseUrlFor(server) {
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

async function sendRequest(baseUrl, path, options = {}) {
  const headers = new Headers(options.headers);

  if (options.token) {
    headers.set('authorization', `Bearer ${options.token}`);
  }
  if (!headers.has('user-agent')) {
    headers.set('user-agent', TEST_USER_AGENT);
  }

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
  let json = null;

  if (responseText) {
    try {
      json = JSON.parse(responseText);
    } catch {
      assert.fail(`Expected a JSON response, received: ${responseText.slice(0, 200)}`);
    }
  }

  return { response, json, responseText };
}

async function sendMutation(fixture, baseUrl, label, path, options = {}) {
  const requestId = nextRequestId(fixture, label);
  const result = await sendRequest(baseUrl, path, {
    ...options,
    token: options.token ?? fixture.adminToken,
    headers: {
      ...options.headers,
      'x-request-id': requestId,
    },
  });

  return { ...result, requestId };
}

function assertSafeError(result, statusCode) {
  assert.equal(result.response.status, statusCode);
  assert.equal(result.json?.success, false);
  assert.equal(typeof result.json?.message, 'string');

  const serialized = JSON.stringify(result.json);
  for (const forbidden of [
    'password_hash',
    'passwordHash',
    'sqlMessage',
    'sqlState',
    'ER_DUP_ENTRY',
    'stack',
    'INSERT INTO',
    'UPDATE users',
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
}

function assertPagination(data, expected = {}) {
  assert.ok(Array.isArray(data?.items));
  assert.ok(data?.pagination);
  for (const key of ['page', 'limit', 'totalItems', 'totalPages']) {
    assert.equal(Number.isInteger(data.pagination[key]), true, `${key} must be an integer`);
    assert.ok(data.pagination[key] >= (key === 'page' || key === 'limit' ? 1 : 0));
  }
  assert.ok(data.items.length <= data.pagination.limit);
  assert.equal(
    data.pagination.totalPages,
    data.pagination.totalItems === 0
      ? 0
      : Math.ceil(data.pagination.totalItems / data.pagination.limit),
  );

  for (const [key, value] of Object.entries(expected)) {
    assert.equal(data.pagination[key], value);
  }
}

function assertNoSecretMaterial(value, fixture) {
  const serialized = JSON.stringify(value);
  for (const secret of [
    fixture.adminPassword,
    fixture.temporaryPassword,
    fixture.resetPassword,
    fixture.termPassword,
    fixture.adminToken,
    process.env.JWT_SECRET,
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal(serialized.includes('password_hash'), false);
  assert.equal(serialized.includes('passwordHash'), false);
  assert.equal(/\$2[aby]\$\d{2}\$/.test(serialized), false);
}

function placeholders(values) {
  return values.map(() => '?').join(', ');
}

async function discoverFixtureIds(connection, fixture) {
  const branchCodes = [...fixture.known.branchCodes];
  const employeeNumbers = [...fixture.known.employeeNumbers];
  const roleCodes = [...fixture.known.roleCodes];
  const usernames = [...fixture.known.usernames];

  const [branchRows] = await connection.execute(
    `SELECT CAST(branch_id AS CHAR) AS id FROM branches
     WHERE branch_code IN (${placeholders(branchCodes)})`,
    branchCodes,
  );
  const [employeeRows] = await connection.execute(
    `SELECT CAST(employee_id AS CHAR) AS id FROM employees
     WHERE employee_number IN (${placeholders(employeeNumbers)})`,
    employeeNumbers,
  );
  const [roleRows] = await connection.execute(
    `SELECT CAST(role_id AS CHAR) AS id FROM roles
     WHERE role_code IN (${placeholders(roleCodes)})`,
    roleCodes,
  );
  const [userRows] = await connection.execute(
    `SELECT CAST(user_id AS CHAR) AS id FROM users
     WHERE username IN (${placeholders(usernames)})`,
    usernames,
  );

  for (const row of branchRows) fixture.ids.branches.add(row.id);
  for (const row of employeeRows) fixture.ids.employees.add(row.id);
  for (const row of roleRows) fixture.ids.roles.add(row.id);
  for (const row of userRows) fixture.ids.users.add(row.id);
}

async function cleanupFixtures(fixture) {
  if (!fixture.setupCommitted) {
    return;
  }

  const connection = await pool.getConnection();
  try {
    await discoverFixtureIds(connection, fixture);
    const branchIds = [...fixture.ids.branches];
    const employeeIds = [...fixture.ids.employees];
    const roleIds = [...fixture.ids.roles];
    const userIds = [...fixture.ids.users];
    const requestIds = [...fixture.requestIds];
    const requestAuditPredicate =
      requestIds.length > 0
        ? ` OR request_id IN (${placeholders(requestIds)})`
        : '';

    await connection.beginTransaction();
    await connection.execute(
      `DELETE FROM audit_logs
       WHERE user_id IN (${placeholders(userIds)})
          OR employee_id IN (${placeholders(employeeIds)})
          OR branch_id IN (${placeholders(branchIds)})
          ${requestAuditPredicate}`,
      [...userIds, ...employeeIds, ...branchIds, ...requestIds],
    );
    await connection.execute(
      `DELETE FROM user_roles
       WHERE user_id IN (${placeholders(userIds)})
          OR role_id IN (${placeholders(roleIds)})
          OR branch_id IN (${placeholders(branchIds)})
          OR assigned_by_user_id IN (${placeholders(userIds)})`,
      [...userIds, ...roleIds, ...branchIds, ...userIds],
    );
    await connection.execute(
      `DELETE FROM role_permissions WHERE role_id IN (${placeholders(roleIds)})`,
      roleIds,
    );
    await connection.execute(
      `DELETE FROM users WHERE user_id IN (${placeholders(userIds)})`,
      userIds,
    );
    await connection.execute(
      `DELETE FROM employee_branch_assignments
       WHERE employee_id IN (${placeholders(employeeIds)})`,
      employeeIds,
    );
    await connection.execute(
      `DELETE FROM employees WHERE employee_id IN (${placeholders(employeeIds)})`,
      employeeIds,
    );
    await connection.execute(
      `DELETE FROM roles WHERE role_id IN (${placeholders(roleIds)})`,
      roleIds,
    );
    await connection.execute(
      `DELETE FROM branches WHERE branch_id IN (${placeholders(branchIds)})`,
      branchIds,
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  const connectionForVerification = await pool.getConnection();
  try {
    const branchCodes = [...fixture.known.branchCodes];
    const employeeNumbers = [...fixture.known.employeeNumbers];
    const roleCodes = [...fixture.known.roleCodes];
    const usernames = [...fixture.known.usernames];
    const requestIds = [...fixture.requestIds];
    const branchIds = [...fixture.ids.branches];
    const employeeIds = [...fixture.ids.employees];
    const roleIds = [...fixture.ids.roles];
    const userIds = [...fixture.ids.users];
    const requestAuditPredicate =
      requestIds.length > 0
        ? ` OR request_id IN (${placeholders(requestIds)})`
        : '';
    const [rows] = await connectionForVerification.execute(
      `SELECT
         (SELECT COUNT(*) FROM branches WHERE branch_code IN (${placeholders(branchCodes)})) AS branchCount,
         (SELECT COUNT(*) FROM employees WHERE employee_number IN (${placeholders(employeeNumbers)})) AS employeeCount,
         (SELECT COUNT(*) FROM roles WHERE role_code IN (${placeholders(roleCodes)})) AS roleCount,
         (SELECT COUNT(*) FROM users WHERE username IN (${placeholders(usernames)})) AS userCount,
         (SELECT COUNT(*) FROM employee_branch_assignments WHERE employee_id IN (${placeholders(employeeIds)})) AS assignmentCount,
         (SELECT COUNT(*) FROM role_permissions WHERE role_id IN (${placeholders(roleIds)})) AS rolePermissionCount,
         (SELECT COUNT(*) FROM user_roles
          WHERE user_id IN (${placeholders(userIds)})
             OR role_id IN (${placeholders(roleIds)})
             OR branch_id IN (${placeholders(branchIds)})
             OR assigned_by_user_id IN (${placeholders(userIds)})) AS userRoleCount,
         (SELECT COUNT(*) FROM audit_logs
          WHERE user_id IN (${placeholders(userIds)})
             OR employee_id IN (${placeholders(employeeIds)})
             OR branch_id IN (${placeholders(branchIds)})
             ${requestAuditPredicate}) AS auditCount`,
      [
        ...branchCodes,
        ...employeeNumbers,
        ...roleCodes,
        ...usernames,
        ...employeeIds,
        ...roleIds,
        ...userIds,
        ...roleIds,
        ...branchIds,
        ...userIds,
        ...userIds,
        ...employeeIds,
        ...branchIds,
        ...requestIds,
      ],
    );

    for (const [label, count] of Object.entries(rows[0])) {
      assert.equal(Number(count), 0, `Phase 4 cleanup left ${label} behind.`);
    }

    const seed = await canonicalSeedSnapshot();
    assert.equal(seed.permissions.length, ACCESS_CONTROL_PERMISSIONS.length);
    assert.equal(seed.roles.length, 1);
    assert.equal(seed.mappings.length, ACCESS_CONTROL_PERMISSIONS.length);
  } finally {
    connectionForVerification.release();
  }
}

async function getAvailablePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function verifyGracefulShutdown(signal) {
  const port = await getAvailablePort();
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'test', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout = `${stdout}${chunk}`.slice(-30_000);
  });
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-30_000);
  });

  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Child server startup timed out.')),
      CHILD_TIMEOUT_MS,
    );
    const inspect = () => {
      if (stdout.includes(`Server running on port ${port}`)) {
        clearTimeout(timeout);
        child.stdout.off('data', inspect);
        resolve();
      }
    };
    child.stdout.on('data', inspect);
    child.once('exit', (code, childSignal) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Child exited before startup (code ${code}, signal ${childSignal}).`,
        ),
      );
    });
    inspect();
  });

  try {
    await ready;
    const health = await sendRequest(
      `http://127.0.0.1:${port}`,
      '/api/health',
    );
    assert.equal(health.response.status, 200);

    let timeout;
    const exitPromise = Promise.race([
      once(child, 'exit'),
      new Promise((resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Child server shutdown timed out.')),
          CHILD_TIMEOUT_MS,
        );
      }),
    ]);
    assert.equal(child.kill(signal), true);
    const [code, childSignal] = await exitPromise.finally(() =>
      clearTimeout(timeout),
    );

    assert.equal(code, 0);
    assert.equal(childSignal, null);
    assert.match(stdout, /Shutting down gracefully/);
    assert.match(stdout, /HTTP server and MySQL pool closed/);
    assert.equal(stderr, '');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }
}

function rememberEntity(fixture, kind, id) {
  assertIdString(id);
  fixture.ids[kind].add(id);
  return id;
}

test(
  'Phase 4 organization and access administration API integration',
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const fixture = createFixtureDefinition();
    let apiServer;

    try {
      await t.test('seeds canonical access control idempotently', async () => {
        const firstRun = await runNodeScript('scripts/seed-access-control.js');
        assert.equal(firstRun.code, 0, firstRun.stderr);
        assert.equal(firstRun.signal, null);
        assert.match(
          firstRun.stdout,
          new RegExp(`${ACCESS_CONTROL_PERMISSIONS.length} canonical permissions`),
        );
        assertNoSecretMaterial(firstRun, fixture);
        const firstSnapshot = await canonicalSeedSnapshot();

        assert.equal(
          firstSnapshot.permissions.length,
          ACCESS_CONTROL_PERMISSIONS.length,
        );
        assert.equal(firstSnapshot.roles.length, 1);
        assert.equal(firstSnapshot.roles[0].roleCode, SYSTEM_ADMIN_ROLE.code);
        assert.equal(firstSnapshot.roles[0].roleName, SYSTEM_ADMIN_ROLE.name);
        assert.equal(
          firstSnapshot.mappings.length,
          ACCESS_CONTROL_PERMISSIONS.length,
        );

        const secondRun = await runNodeScript('scripts/seed-access-control.js');
        assert.equal(secondRun.code, 0, secondRun.stderr);
        assert.equal(secondRun.signal, null);
        const secondSnapshot = await canonicalSeedSnapshot();
        assert.deepEqual(secondSnapshot, firstSnapshot);
      });

      await t.test('refuses non-interactive administrator bootstrap safely', async () => {
        const result = await runNodeScript('scripts/bootstrap-admin.js');
        assert.equal(result.code, 1);
        assert.equal(result.signal, null);
        assert.match(result.stderr, /requires an interactive terminal/i);
        assertNoSecretMaterial(result, fixture);
      });

      await createFixtures(fixture);
      apiServer = await startHttpServer(app);
      const baseUrl = baseUrlFor(apiServer);

      await t.test('preserves Phase 2 and Phase 3 HTTP behavior', async () => {
        const health = await sendRequest(baseUrl, '/api/health');
        assert.equal(health.response.status, 200);
        assert.equal(health.json.success, true);

        const databaseHealth = await sendRequest(
          baseUrl,
          '/api/health/database',
        );
        assert.equal(databaseHealth.response.status, 200);
        assert.deepEqual(databaseHealth.json, {
          success: true,
          database: 'connected',
        });

        const missingRoute = await sendRequest(baseUrl, '/not-a-real-route');
        assertSafeError(missingRoute, 404);

        const invalidToken = await sendRequest(baseUrl, '/api/auth/me', {
          token: 'not.a.valid.token',
        });
        assertSafeError(invalidToken, 401);

        const currentUser = await sendRequest(baseUrl, '/api/auth/me', {
          token: fixture.adminToken,
        });
        assert.equal(currentUser.response.status, 200);
        assert.equal(currentUser.json.data.user.userId, fixture.adminUserId);

        const login = await sendRequest(baseUrl, '/api/auth/login', {
          method: 'POST',
          body: {
            identifier: fixture.adminUsername,
            password: fixture.adminPassword,
          },
        });
        assert.equal(login.response.status, 200);
        assert.equal(typeof login.json.data.accessToken, 'string');
        const { accessToken, ...safeLoginData } = login.json.data;
        assertNoSecretMaterial(
          { ...login.json, data: safeLoginData },
          fixture,
        );
      });

      await t.test('protects every admin endpoint and enforces global scope', async () => {
        const endpoints = [
          ['GET', '/api/admin/branches'],
          ['GET', `/api/admin/branches/${fixture.scopeBranchId}`],
          ['POST', '/api/admin/branches'],
          ['PATCH', `/api/admin/branches/${fixture.scopeBranchId}`],
          ['GET', '/api/admin/employees'],
          ['GET', `/api/admin/employees/${fixture.adminEmployeeId}`],
          ['POST', '/api/admin/employees'],
          ['PATCH', `/api/admin/employees/${fixture.adminEmployeeId}`],
          ['POST', `/api/admin/employees/${fixture.adminEmployeeId}/terminate`],
          ['POST', `/api/admin/employees/${fixture.adminEmployeeId}/assignments`],
          [
            'POST',
            `/api/admin/employees/${fixture.adminEmployeeId}/assignments/1/end`,
          ],
          [
            'POST',
            `/api/admin/employees/${fixture.adminEmployeeId}/assignments/1/make-primary`,
          ],
          ['GET', '/api/admin/users'],
          ['GET', `/api/admin/users/${fixture.adminUserId}`],
          ['POST', '/api/admin/users'],
          ['PATCH', `/api/admin/users/${fixture.adminUserId}`],
          ['POST', `/api/admin/users/${fixture.adminUserId}/reset-password`],
          ['POST', `/api/admin/users/${fixture.adminUserId}/roles`],
          [
            'DELETE',
            `/api/admin/users/${fixture.adminUserId}/roles/${fixture.adminUserRoleId}`,
          ],
          ['GET', '/api/admin/roles'],
          ['GET', `/api/admin/roles/${fixture.adminRoleId}`],
          ['POST', '/api/admin/roles'],
          ['PATCH', `/api/admin/roles/${fixture.adminRoleId}`],
          ['PUT', `/api/admin/roles/${fixture.adminRoleId}/permissions`],
          ['GET', '/api/admin/permissions'],
        ];

        for (const [method, path] of endpoints) {
          const result = await sendRequest(baseUrl, path, {
            method,
            body: method === 'GET' || method === 'DELETE' ? undefined : {},
          });
          assertSafeError(result, 401);
        }

        const passwordBlocked = await sendRequest(
          baseUrl,
          '/api/admin/branches',
          { token: fixture.mustChangeToken },
        );
        assertSafeError(passwordBlocked, 403);
        assert.match(passwordBlocked.json.message, /Password change required/i);

        const permissionBlocked = await sendRequest(
          baseUrl,
          '/api/admin/branches',
          { token: fixture.deniedToken },
        );
        assertSafeError(permissionBlocked, 403);

        const branchScopeIsNotGlobal = await sendRequest(
          baseUrl,
          '/api/admin/branches',
          { token: fixture.scopedToken },
        );
        assertSafeError(branchScopeIsNotGlobal, 403);

        const globallyAllowed = await sendRequest(
          baseUrl,
          '/api/admin/branches',
          { token: fixture.adminToken },
        );
        assert.equal(globallyAllowed.response.status, 200);
      });

      await t.test('creates, reads, updates, filters, and paginates branches', async () => {
        fixture.branchIds = [];
        for (const [index, payload] of fixture.branchPayloads.entries()) {
          const result = await sendMutation(
            fixture,
            baseUrl,
            `BRANCH_CREATE_${index}`,
            '/api/admin/branches',
            { method: 'POST', body: payload },
          );
          assert.equal(result.response.status, 201);
          const branch = result.json.data.branch;
          const branchId = rememberEntity(
            fixture,
            'branches',
            branch.branchId,
          );
          fixture.branchIds.push(branchId);
          assert.equal(branch.branchCode, payload.branchCode.toUpperCase());
          assert.equal(branch.countryCode, 'NG');
          assert.equal(branch.currencyCode, 'NGN');
        }

        const [branchAId] = fixture.branchIds;
        const detail = await sendRequest(
          baseUrl,
          `/api/admin/branches/${branchAId}`,
          { token: fixture.adminToken },
        );
        assert.equal(detail.response.status, 200);
        assert.equal(detail.json.data.branch.branchId, branchAId);

        const duplicate = await sendMutation(
          fixture,
          baseUrl,
          'BRANCH_DUPLICATE',
          '/api/admin/branches',
          { method: 'POST', body: fixture.branchPayloads[0] },
        );
        fixture.failedRequestIds.add(duplicate.requestId);
        assertSafeError(duplicate, 409);

        const updated = await sendMutation(
          fixture,
          baseUrl,
          'BRANCH_UPDATE',
          `/api/admin/branches/${branchAId}`,
          { method: 'PATCH', body: { phone: '+2348999999999', status: 'INACTIVE' } },
        );
        assert.equal(updated.response.status, 200);
        assert.equal(updated.json.data.branch.status, 'INACTIVE');
        assert.equal(updated.json.data.branch.phone, '+2348999999999');

        const pageOne = await sendRequest(
          baseUrl,
          `/api/admin/branches?search=${encodeURIComponent(`PAGED_${fixture.token}`)}&page=1&limit=2`,
          { token: fixture.adminToken },
        );
        assert.equal(pageOne.response.status, 200);
        assertPagination(pageOne.json.data, {
          page: 1,
          limit: 2,
          totalItems: 3,
          totalPages: 2,
        });
        assert.equal(pageOne.json.data.items.length, 2);

        const pageTwo = await sendRequest(
          baseUrl,
          `/api/admin/branches?search=${encodeURIComponent(`PAGED_${fixture.token}`)}&page=2&limit=2`,
          { token: fixture.adminToken },
        );
        assert.equal(pageTwo.response.status, 200);
        assertPagination(pageTwo.json.data, {
          page: 2,
          limit: 2,
          totalItems: 3,
          totalPages: 2,
        });
        assert.equal(pageTwo.json.data.items.length, 1);
        assert.equal(
          new Set([
            ...pageOne.json.data.items.map((item) => item.branchId),
            ...pageTwo.json.data.items.map((item) => item.branchId),
          ]).size,
          3,
        );

        const inactive = await sendRequest(
          baseUrl,
          `/api/admin/branches?status=INACTIVE&search=${encodeURIComponent(`PAGED_${fixture.token}`)}`,
          { token: fixture.adminToken },
        );
        assert.equal(inactive.response.status, 200);
        assertPagination(inactive.json.data, { totalItems: 1 });

        for (const query of [
          'page=0',
          'page=1.5',
          'page=abc',
          'limit=0',
          'limit=101',
          'limit=-1',
          'sort=branchCode',
          'status=DELETED',
        ]) {
          const invalid = await sendRequest(
            baseUrl,
            `/api/admin/branches?${query}`,
            { token: fixture.adminToken },
          );
          assertSafeError(invalid, 400);
        }

        const invalidId = await sendRequest(baseUrl, '/api/admin/branches/0', {
          token: fixture.adminToken,
        });
        assertSafeError(invalidId, 400);
        const notFound = await sendRequest(
          baseUrl,
          `/api/admin/branches/${MAX_UNSIGNED_BIGINT}`,
          { token: fixture.adminToken },
        );
        assertSafeError(notFound, 404);
      });

      await t.test('administers employees and branch assignment history', async () => {
        fixture.employeeIds = [];
        for (const [index, payload] of fixture.employeePayloads.entries()) {
          const result = await sendMutation(
            fixture,
            baseUrl,
            `EMPLOYEE_CREATE_${index}`,
            '/api/admin/employees',
            { method: 'POST', body: payload },
          );
          assert.equal(result.response.status, 201);
          const employee = result.json.data.employee;
          const employeeId = rememberEntity(
            fixture,
            'employees',
            employee.employeeId,
          );
          fixture.employeeIds.push(employeeId);
          assert.equal(employee.employeeNumber, payload.employeeNumber.toUpperCase());
          assert.equal(employee.employmentStatus, 'ACTIVE');
        }

        const [employeeId] = fixture.employeeIds;
        const duplicate = await sendMutation(
          fixture,
          baseUrl,
          'EMPLOYEE_DUPLICATE',
          '/api/admin/employees',
          { method: 'POST', body: fixture.employeePayloads[0] },
        );
        fixture.failedRequestIds.add(duplicate.requestId);
        assertSafeError(duplicate, 409);

        const updated = await sendMutation(
          fixture,
          baseUrl,
          'EMPLOYEE_UPDATE',
          `/api/admin/employees/${employeeId}`,
          { method: 'PATCH', body: { phone: '+2348777777777' } },
        );
        assert.equal(updated.response.status, 200);
        assert.equal(updated.json.data.employee.phone, '+2348777777777');

        const genericTermination = await sendMutation(
          fixture,
          baseUrl,
          'EMPLOYEE_BAD_PATCH_TERMINATION',
          `/api/admin/employees/${employeeId}`,
          { method: 'PATCH', body: { employmentStatus: 'TERMINATED' } },
        );
        fixture.failedRequestIds.add(genericTermination.requestId);
        assertSafeError(genericTermination, 400);

        const activeBranchOne = fixture.branchIds[1];
        const activeBranchTwo = fixture.branchIds[2];
        const firstAssignment = await sendMutation(
          fixture,
          baseUrl,
          'ASSIGNMENT_CREATE_PRIMARY',
          `/api/admin/employees/${employeeId}/assignments`,
          {
            method: 'POST',
            body: {
              branchId: activeBranchOne,
              jobTitle: 'Cashier',
              startedOn: '2021-01-01',
              isPrimary: true,
            },
          },
        );
        assert.equal(firstAssignment.response.status, 201);
        fixture.firstAssignmentId = rememberEntity(
          fixture,
          'assignments',
          firstAssignment.json.data.assignment.assignmentId,
        );

        const secondAssignment = await sendMutation(
          fixture,
          baseUrl,
          'ASSIGNMENT_CREATE_SECONDARY',
          `/api/admin/employees/${employeeId}/assignments`,
          {
            method: 'POST',
            body: {
              branchId: activeBranchTwo,
              jobTitle: 'Relief Cashier',
              startedOn: '2021-02-01',
              isPrimary: false,
            },
          },
        );
        assert.equal(secondAssignment.response.status, 201);
        fixture.secondAssignmentId = rememberEntity(
          fixture,
          'assignments',
          secondAssignment.json.data.assignment.assignmentId,
        );

        const overlapping = await sendMutation(
          fixture,
          baseUrl,
          'ASSIGNMENT_OVERLAP',
          `/api/admin/employees/${employeeId}/assignments`,
          {
            method: 'POST',
            body: {
              branchId: activeBranchOne,
              jobTitle: 'Duplicate',
              startedOn: '2022-01-01',
              isPrimary: false,
            },
          },
        );
        fixture.failedRequestIds.add(overlapping.requestId);
        assertSafeError(overlapping, 409);

        const inactiveBranchAssignment = await sendMutation(
          fixture,
          baseUrl,
          'ASSIGNMENT_INACTIVE_BRANCH',
          `/api/admin/employees/${employeeId}/assignments`,
          {
            method: 'POST',
            body: {
              branchId: fixture.branchIds[0],
              jobTitle: 'Invalid',
              startedOn: '2021-01-01',
              isPrimary: false,
            },
          },
        );
        fixture.failedRequestIds.add(inactiveBranchAssignment.requestId);
        assertSafeError(inactiveBranchAssignment, 409);

        const madePrimary = await sendMutation(
          fixture,
          baseUrl,
          'ASSIGNMENT_MAKE_PRIMARY',
          `/api/admin/employees/${employeeId}/assignments/${fixture.secondAssignmentId}/make-primary`,
          { method: 'POST', body: {} },
        );
        assert.equal(madePrimary.response.status, 200);
        assert.equal(madePrimary.json.data.assignment.isPrimary, true);

        const [primaryRows] = await pool.execute(
          `SELECT CAST(assignment_id AS CHAR) AS assignmentId
           FROM employee_branch_assignments
           WHERE employee_id = ? AND ended_on IS NULL AND is_primary = 1`,
          [employeeId],
        );
        assert.deepEqual(primaryRows, [{ assignmentId: fixture.secondAssignmentId }]);

        const ended = await sendMutation(
          fixture,
          baseUrl,
          'ASSIGNMENT_END',
          `/api/admin/employees/${employeeId}/assignments/${fixture.secondAssignmentId}/end`,
          { method: 'POST', body: { endedOn: fixture.currentDate } },
        );
        assert.equal(ended.response.status, 200);
        assert.equal(ended.json.data.assignment.endedOn, fixture.currentDate);
        assert.equal(ended.json.data.assignment.isPrimary, false);

        const idempotentEnd = await sendMutation(
          fixture,
          baseUrl,
          'ASSIGNMENT_END_REPEAT',
          `/api/admin/employees/${employeeId}/assignments/${fixture.secondAssignmentId}/end`,
          { method: 'POST', body: { endedOn: fixture.currentDate } },
        );
        assert.equal(idempotentEnd.response.status, 200);
        assert.equal(idempotentEnd.json.data.alreadyEnded, true);

        const endedPrimary = await sendMutation(
          fixture,
          baseUrl,
          'ASSIGNMENT_ENDED_PRIMARY',
          `/api/admin/employees/${employeeId}/assignments/${fixture.secondAssignmentId}/make-primary`,
          { method: 'POST', body: {} },
        );
        fixture.failedRequestIds.add(endedPrimary.requestId);
        assertSafeError(endedPrimary, 409);

        const wrongOwner = await sendMutation(
          fixture,
          baseUrl,
          'ASSIGNMENT_WRONG_OWNER',
          `/api/admin/employees/${fixture.employeeIds[1]}/assignments/${fixture.firstAssignmentId}/make-primary`,
          { method: 'POST', body: {} },
        );
        fixture.failedRequestIds.add(wrongOwner.requestId);
        assertSafeError(wrongOwner, 404);

        const detail = await sendRequest(
          baseUrl,
          `/api/admin/employees/${employeeId}`,
          { token: fixture.adminToken },
        );
        assert.equal(detail.response.status, 200);
        assert.equal(detail.json.data.employee.assignments.length, 2);

        const filtered = await sendRequest(
          baseUrl,
          `/api/admin/employees?branchId=${activeBranchOne}&search=${encodeURIComponent(`PAGED_${fixture.token}`)}`,
          { token: fixture.adminToken },
        );
        assert.equal(filtered.response.status, 200);
        assertPagination(filtered.json.data, { totalItems: 1 });

        const paged = await sendRequest(
          baseUrl,
          `/api/admin/employees?search=${encodeURIComponent(`PAGED_${fixture.token}`)}&page=1&limit=2`,
          { token: fixture.adminToken },
        );
        assert.equal(paged.response.status, 200);
        assertPagination(paged.json.data, { page: 1, limit: 2, totalItems: 3 });

        for (const query of [
          'page=0',
          'limit=101',
          'employmentStatus=DELETED',
          'branchId=0',
          'unexpected=true',
        ]) {
          const invalid = await sendRequest(
            baseUrl,
            `/api/admin/employees?${query}`,
            { token: fixture.adminToken },
          );
          assertSafeError(invalid, 400);
        }
      });

      await t.test('provisions and administers internal user accounts safely', async () => {
        const usernames = [
          `paged.${fixture.lowerToken}.one`,
          `paged.${fixture.lowerToken}.term`,
          `paged.${fixture.lowerToken}.three`,
        ];
        for (const username of usernames) {
          fixture.known.usernames.add(username);
        }
        const userPayloads = [
          {
            employeeId: fixture.employeeIds[0],
            username: usernames[0],
            email: `paged-user-one-${fixture.lowerToken}@example.invalid`,
            temporaryPassword: fixture.temporaryPassword,
          },
          {
            employeeId: fixture.employeeIds[1],
            username: usernames[1],
            email: `paged-user-term-${fixture.lowerToken}@example.invalid`,
            temporaryPassword: fixture.termPassword,
          },
          {
            employeeId: fixture.employeeIds[2],
            username: usernames[2],
            email: `paged-user-three-${fixture.lowerToken}@example.invalid`,
            temporaryPassword: fixture.temporaryPassword,
          },
        ];
        fixture.userIds = [];

        for (const [index, payload] of userPayloads.entries()) {
          const result = await sendMutation(
            fixture,
            baseUrl,
            `USER_CREATE_${index}`,
            '/api/admin/users',
            { method: 'POST', body: payload },
          );
          assert.equal(result.response.status, 201);
          const user = result.json.data.user;
          const userId = rememberEntity(fixture, 'users', user.userId);
          fixture.userIds.push(userId);
          assert.equal(user.employeeId, payload.employeeId);
          assert.equal(user.username, payload.username);
          assert.equal(user.isActive, true);
          assert.equal(user.mustChangePassword, true);
          assertNoSecretMaterial(result.json, fixture);
        }

        [fixture.staffUserId, fixture.terminationUserId, fixture.thirdUserId] =
          fixture.userIds;
        fixture.terminationUserToken = signAccessToken(
          fixture.terminationUserId,
        ).accessToken;

        const [credentialRows] = await pool.execute(
          `SELECT password_hash AS passwordHash, must_change_password AS mustChangePassword
           FROM users WHERE user_id = ?`,
          [fixture.staffUserId],
        );
        assert.match(credentialRows[0].passwordHash, /^\$2[aby]\$/);
        assert.equal(
          bcrypt.getRounds(credentialRows[0].passwordHash),
          Number(process.env.BCRYPT_ROUNDS),
        );
        assert.notEqual(
          credentialRows[0].passwordHash,
          fixture.temporaryPassword,
        );
        assert.equal(
          await bcrypt.compare(
            fixture.temporaryPassword,
            credentialRows[0].passwordHash,
          ),
          true,
        );
        assert.equal(credentialRows[0].mustChangePassword, 1);

        const detail = await sendRequest(
          baseUrl,
          `/api/admin/users/${fixture.staffUserId}`,
          { token: fixture.adminToken },
        );
        assert.equal(detail.response.status, 200);
        assert.equal(detail.json.data.user.userId, fixture.staffUserId);
        assert.ok(Array.isArray(detail.json.data.user.roleGrants));
        assertNoSecretMaterial(detail.json, fixture);

        const duplicateUsername = await sendMutation(
          fixture,
          baseUrl,
          'USER_DUPLICATE_USERNAME',
          '/api/admin/users',
          {
            method: 'POST',
            body: {
              employeeId: null,
              username: usernames[0],
              email: `unique-${fixture.lowerToken}@example.invalid`,
              temporaryPassword: fixture.temporaryPassword,
            },
          },
        );
        fixture.failedRequestIds.add(duplicateUsername.requestId);
        assertSafeError(duplicateUsername, 409);

        const duplicateEmail = await sendMutation(
          fixture,
          baseUrl,
          'USER_DUPLICATE_EMAIL',
          '/api/admin/users',
          {
            method: 'POST',
            body: {
              employeeId: null,
              username: `unique.${fixture.lowerToken}`,
              email: userPayloads[0].email,
              temporaryPassword: fixture.temporaryPassword,
            },
          },
        );
        fixture.failedRequestIds.add(duplicateEmail.requestId);
        assertSafeError(duplicateEmail, 409);

        const duplicateEmployee = await sendMutation(
          fixture,
          baseUrl,
          'USER_DUPLICATE_EMPLOYEE',
          '/api/admin/users',
          {
            method: 'POST',
            body: {
              employeeId: fixture.employeeIds[0],
              username: `second.${fixture.lowerToken}`,
              email: `second-${fixture.lowerToken}@example.invalid`,
              temporaryPassword: fixture.temporaryPassword,
            },
          },
        );
        fixture.failedRequestIds.add(duplicateEmployee.requestId);
        assertSafeError(duplicateEmployee, 409);

        const updatedUsername = `paged.${fixture.lowerToken}.updated`;
        fixture.known.usernames.add(updatedUsername);
        const updated = await sendMutation(
          fixture,
          baseUrl,
          'USER_UPDATE',
          `/api/admin/users/${fixture.staffUserId}`,
          {
            method: 'PATCH',
            body: {
              username: updatedUsername,
              email: `updated-${fixture.lowerToken}@example.invalid`,
            },
          },
        );
        assert.equal(updated.response.status, 200);
        assert.equal(updated.json.data.user.username, updatedUsername);
        assertNoSecretMaterial(updated.json, fixture);

        const selfDeactivation = await sendMutation(
          fixture,
          baseUrl,
          'USER_SELF_DEACTIVATE',
          `/api/admin/users/${fixture.adminUserId}`,
          { method: 'PATCH', body: { isActive: false } },
        );
        fixture.failedRequestIds.add(selfDeactivation.requestId);
        assertSafeError(selfDeactivation, 409);
        const [adminState] = await pool.execute(
          'SELECT is_active AS isActive FROM users WHERE user_id = ?',
          [fixture.adminUserId],
        );
        assert.equal(adminState[0].isActive, 1);

        for (const forbiddenBody of [
          { passwordHash: 'forbidden' },
          { password_hash: 'forbidden' },
          { mustChangePassword: false },
          { temporaryPassword: fixture.resetPassword },
        ]) {
          const forbidden = await sendMutation(
            fixture,
            baseUrl,
            'USER_FORBIDDEN_PATCH',
            `/api/admin/users/${fixture.staffUserId}`,
            { method: 'PATCH', body: forbiddenBody },
          );
          fixture.failedRequestIds.add(forbidden.requestId);
          assertSafeError(forbidden, 400);
        }

        const beforeResetHash = credentialRows[0].passwordHash;
        const reset = await sendMutation(
          fixture,
          baseUrl,
          'USER_PASSWORD_RESET',
          `/api/admin/users/${fixture.staffUserId}/reset-password`,
          {
            method: 'POST',
            body: { temporaryPassword: fixture.resetPassword },
          },
        );
        assert.equal(reset.response.status, 200);
        assertNoSecretMaterial(reset.json, fixture);
        const [resetRows] = await pool.execute(
          `SELECT password_hash AS passwordHash, must_change_password AS mustChangePassword
           FROM users WHERE user_id = ?`,
          [fixture.staffUserId],
        );
        assert.notEqual(resetRows[0].passwordHash, beforeResetHash);
        assert.equal(
          await bcrypt.compare(fixture.resetPassword, resetRows[0].passwordHash),
          true,
        );
        assert.equal(resetRows[0].mustChangePassword, 1);

        const deactivateThird = await sendMutation(
          fixture,
          baseUrl,
          'USER_DEACTIVATE',
          `/api/admin/users/${fixture.thirdUserId}`,
          { method: 'PATCH', body: { isActive: false } },
        );
        assert.equal(deactivateThird.response.status, 200);
        assert.equal(deactivateThird.json.data.user.isActive, false);

        const paged = await sendRequest(
          baseUrl,
          `/api/admin/users?search=${encodeURIComponent(`paged.${fixture.lowerToken}`)}&page=1&limit=2`,
          { token: fixture.adminToken },
        );
        assert.equal(paged.response.status, 200);
        assertPagination(paged.json.data, {
          page: 1,
          limit: 2,
          totalItems: 3,
          totalPages: 2,
        });

        const employeeFilter = await sendRequest(
          baseUrl,
          `/api/admin/users?employeeId=${fixture.employeeIds[0]}`,
          { token: fixture.adminToken },
        );
        assert.equal(employeeFilter.response.status, 200);
        assertPagination(employeeFilter.json.data, { totalItems: 1 });
        assert.equal(employeeFilter.json.data.items[0].userId, fixture.staffUserId);

        const inactiveFilter = await sendRequest(
          baseUrl,
          `/api/admin/users?isActive=false&search=${encodeURIComponent(`paged.${fixture.lowerToken}`)}`,
          { token: fixture.adminToken },
        );
        assert.equal(inactiveFilter.response.status, 200);
        assertPagination(inactiveFilter.json.data, { totalItems: 1 });

        for (const query of [
          'page=0',
          'limit=101',
          'isActive=1',
          'employeeId=0',
          'role=admin',
        ]) {
          const invalid = await sendRequest(
            baseUrl,
            `/api/admin/users?${query}`,
            { token: fixture.adminToken },
          );
          assertSafeError(invalid, 400);
        }
      });

      await t.test('administers roles and the read-only permission catalog', async () => {
        const catalog = await sendRequest(
          baseUrl,
          '/api/admin/permissions?limit=100',
          { token: fixture.adminToken },
        );
        assert.equal(catalog.response.status, 200);
        assertPagination(catalog.json.data, { page: 1, limit: 100 });
        const permissionCodes = new Set(
          catalog.json.data.items.map((permission) => {
            assertIdString(permission.permissionId);
            return permission.permissionCode;
          }),
        );
        for (const permission of ACCESS_CONTROL_PERMISSIONS) {
          assert.equal(permissionCodes.has(permission.code), true);
        }

        const branchPermissions = await sendRequest(
          baseUrl,
          '/api/admin/permissions?search=branches.&limit=100',
          { token: fixture.adminToken },
        );
        assert.equal(branchPermissions.response.status, 200);
        assertPagination(branchPermissions.json.data, { totalItems: 2 });

        fixture.roleIds = [];
        for (const [index, payload] of fixture.rolePayloads.entries()) {
          const result = await sendMutation(
            fixture,
            baseUrl,
            `ROLE_CREATE_${index}`,
            '/api/admin/roles',
            { method: 'POST', body: payload },
          );
          assert.equal(result.response.status, 201);
          const role = result.json.data.role;
          const roleId = rememberEntity(fixture, 'roles', role.roleId);
          fixture.roleIds.push(roleId);
          assert.equal(role.roleCode, payload.roleCode.toUpperCase());
          assert.equal(role.isActive, true);
          assert.deepEqual(role.permissions, []);
        }
        [fixture.operationalRoleId] = fixture.roleIds;

        const duplicateCode = await sendMutation(
          fixture,
          baseUrl,
          'ROLE_DUPLICATE_CODE',
          '/api/admin/roles',
          {
            method: 'POST',
            body: {
              ...fixture.rolePayloads[0],
              roleName: `Unique role name ${fixture.token}`,
            },
          },
        );
        fixture.failedRequestIds.add(duplicateCode.requestId);
        assertSafeError(duplicateCode, 409);

        const duplicateName = await sendMutation(
          fixture,
          baseUrl,
          'ROLE_DUPLICATE_NAME',
          '/api/admin/roles',
          {
            method: 'POST',
            body: {
              ...fixture.rolePayloads[0],
              roleCode: `UNIQUE_${fixture.token}`,
              roleName: fixture.rolePayloads[1].roleName,
            },
          },
        );
        fixture.failedRequestIds.add(duplicateName.requestId);
        assertSafeError(duplicateName, 409);

        const updated = await sendMutation(
          fixture,
          baseUrl,
          'ROLE_UPDATE',
          `/api/admin/roles/${fixture.operationalRoleId}`,
          {
            method: 'PATCH',
            body: {
              roleName: `PAGED_${fixture.token} Operational Role`,
              description: 'Updated temporary role',
            },
          },
        );
        assert.equal(updated.response.status, 200);
        assert.equal(updated.json.data.role.description, 'Updated temporary role');

        const branchesReadId = fixture.permissionIdByCode['branches.read'];
        const usersReadId = fixture.permissionIdByCode['users.read'];
        const replaced = await sendMutation(
          fixture,
          baseUrl,
          'ROLE_PERMISSIONS_REPLACE',
          `/api/admin/roles/${fixture.operationalRoleId}/permissions`,
          {
            method: 'PUT',
            body: { permissionIds: [branchesReadId, usersReadId] },
          },
        );
        assert.equal(replaced.response.status, 200);
        assert.deepEqual(
          replaced.json.data.role.permissions.map((item) => item.permissionCode),
          ['branches.read', 'users.read'],
        );

        const duplicateIds = await sendMutation(
          fixture,
          baseUrl,
          'ROLE_PERMISSIONS_DUPLICATE',
          `/api/admin/roles/${fixture.operationalRoleId}/permissions`,
          {
            method: 'PUT',
            body: { permissionIds: [branchesReadId, branchesReadId] },
          },
        );
        fixture.failedRequestIds.add(duplicateIds.requestId);
        assertSafeError(duplicateIds, 400);

        const missingPermission = await sendMutation(
          fixture,
          baseUrl,
          'ROLE_PERMISSIONS_MISSING',
          `/api/admin/roles/${fixture.operationalRoleId}/permissions`,
          {
            method: 'PUT',
            body: { permissionIds: [branchesReadId, MAX_UNSIGNED_BIGINT] },
          },
        );
        fixture.failedRequestIds.add(missingPermission.requestId);
        assertSafeError(missingPermission, 404);

        const detail = await sendRequest(
          baseUrl,
          `/api/admin/roles/${fixture.operationalRoleId}`,
          { token: fixture.adminToken },
        );
        assert.equal(detail.response.status, 200);
        assert.deepEqual(
          detail.json.data.role.permissions.map((item) => item.permissionCode),
          ['branches.read', 'users.read'],
        );

        const rolesPage = await sendRequest(
          baseUrl,
          `/api/admin/roles?search=${encodeURIComponent(`PAGED_${fixture.token}`)}&page=1&limit=2`,
          { token: fixture.adminToken },
        );
        assert.equal(rolesPage.response.status, 200);
        assertPagination(rolesPage.json.data, {
          page: 1,
          limit: 2,
          totalItems: 3,
          totalPages: 2,
        });

        for (const path of [
          '/api/admin/roles?page=0',
          '/api/admin/roles?limit=101',
          '/api/admin/roles?isActive=1',
          '/api/admin/roles?sort=roleCode',
          '/api/admin/permissions?page=0',
          '/api/admin/permissions?limit=101',
          '/api/admin/permissions?sort=permissionCode',
        ]) {
          const invalid = await sendRequest(baseUrl, path, {
            token: fixture.adminToken,
          });
          assertSafeError(invalid, 400);
        }

        const systemRole = (await canonicalSeedSnapshot()).roles[0];
        const protectRole = await sendMutation(
          fixture,
          baseUrl,
          'SYSTEM_ROLE_DEACTIVATE',
          `/api/admin/roles/${systemRole.roleId}`,
          { method: 'PATCH', body: { isActive: false } },
        );
        fixture.failedRequestIds.add(protectRole.requestId);
        assertSafeError(protectRole, 409);

        const protectPermissions = await sendMutation(
          fixture,
          baseUrl,
          'SYSTEM_ROLE_CLEAR_PERMISSIONS',
          `/api/admin/roles/${systemRole.roleId}/permissions`,
          { method: 'PUT', body: { permissionIds: [] } },
        );
        fixture.failedRequestIds.add(protectPermissions.requestId);
        assertSafeError(protectPermissions, 409);
      });

      await t.test('assigns and revokes global and branch-scoped user roles', async () => {
        const globalGrant = await sendMutation(
          fixture,
          baseUrl,
          'USER_ROLE_GLOBAL_ASSIGN',
          `/api/admin/users/${fixture.subjectUserId}/roles`,
          {
            method: 'POST',
            body: { roleId: fixture.operationalRoleId, branchId: null },
          },
        );
        assert.equal(globalGrant.response.status, 201);
        fixture.subjectGlobalUserRoleId = rememberEntity(
          fixture,
          'userRoles',
          globalGrant.json.data.userRole.userRoleId,
        );
        assert.equal(globalGrant.json.data.userRole.branchId, null);
        assert.equal(
          globalGrant.json.data.userRole.assignedByUserId,
          fixture.adminUserId,
        );

        const subjectAllowed = await sendRequest(baseUrl, '/api/admin/branches', {
          token: fixture.subjectToken,
        });
        assert.equal(subjectAllowed.response.status, 200);

        const duplicate = await sendMutation(
          fixture,
          baseUrl,
          'USER_ROLE_DUPLICATE',
          `/api/admin/users/${fixture.subjectUserId}/roles`,
          {
            method: 'POST',
            body: { roleId: fixture.operationalRoleId, branchId: null },
          },
        );
        fixture.failedRequestIds.add(duplicate.requestId);
        assertSafeError(duplicate, 409);

        const linkedBranchGrant = await sendMutation(
          fixture,
          baseUrl,
          'USER_ROLE_BRANCH_ASSIGN',
          `/api/admin/users/${fixture.staffUserId}/roles`,
          {
            method: 'POST',
            body: {
              roleId: fixture.operationalRoleId,
              branchId: fixture.branchIds[1],
            },
          },
        );
        assert.equal(linkedBranchGrant.response.status, 201);
        fixture.staffBranchUserRoleId = rememberEntity(
          fixture,
          'userRoles',
          linkedBranchGrant.json.data.userRole.userRoleId,
        );
        assert.equal(
          linkedBranchGrant.json.data.userRole.assignedByUserId,
          fixture.adminUserId,
        );

        const missingAssignment = await sendMutation(
          fixture,
          baseUrl,
          'USER_ROLE_MISSING_ASSIGNMENT',
          `/api/admin/users/${fixture.staffUserId}/roles`,
          {
            method: 'POST',
            body: {
              roleId: fixture.operationalRoleId,
              branchId: fixture.scopeBranchId,
            },
          },
        );
        fixture.failedRequestIds.add(missingAssignment.requestId);
        assertSafeError(missingAssignment, 409);

        const unlinkedBranchGrant = await sendMutation(
          fixture,
          baseUrl,
          'USER_ROLE_UNLINKED_BRANCH_ASSIGN',
          `/api/admin/users/${fixture.deniedUserId}/roles`,
          {
            method: 'POST',
            body: {
              roleId: fixture.operationalRoleId,
              branchId: fixture.scopeBranchId,
            },
          },
        );
        assert.equal(unlinkedBranchGrant.response.status, 201);
        fixture.unlinkedBranchUserRoleId = rememberEntity(
          fixture,
          'userRoles',
          unlinkedBranchGrant.json.data.userRole.userRoleId,
        );

        const spoofedActor = await sendMutation(
          fixture,
          baseUrl,
          'USER_ROLE_SPOOFED_ACTOR',
          `/api/admin/users/${fixture.deniedUserId}/roles`,
          {
            method: 'POST',
            body: {
              roleId: fixture.operationalRoleId,
              branchId: null,
              assignedByUserId: fixture.deniedUserId,
            },
          },
        );
        fixture.failedRequestIds.add(spoofedActor.requestId);
        assertSafeError(spoofedActor, 400);

        const selfRevoke = await sendMutation(
          fixture,
          baseUrl,
          'USER_ROLE_SELF_REVOKE',
          `/api/admin/users/${fixture.adminUserId}/roles/${fixture.adminUserRoleId}`,
          { method: 'DELETE' },
        );
        fixture.failedRequestIds.add(selfRevoke.requestId);
        assertSafeError(selfRevoke, 409);

        const deactivateRole = await sendMutation(
          fixture,
          baseUrl,
          'ROLE_DEACTIVATE',
          `/api/admin/roles/${fixture.operationalRoleId}`,
          { method: 'PATCH', body: { isActive: false } },
        );
        assert.equal(deactivateRole.response.status, 200);
        assert.equal(deactivateRole.json.data.role.isActive, false);

        const staleGrantDenied = await sendRequest(
          baseUrl,
          '/api/admin/branches',
          { token: fixture.subjectToken },
        );
        assertSafeError(staleGrantDenied, 403);

        const inactiveAssignment = await sendMutation(
          fixture,
          baseUrl,
          'USER_ROLE_INACTIVE_ROLE',
          `/api/admin/users/${fixture.thirdUserId}/roles`,
          {
            method: 'POST',
            body: { roleId: fixture.operationalRoleId, branchId: null },
          },
        );
        fixture.failedRequestIds.add(inactiveAssignment.requestId);
        assertSafeError(inactiveAssignment, 409);

        for (const [label, userId, userRoleId] of [
          [
            'USER_ROLE_GLOBAL_REVOKE',
            fixture.subjectUserId,
            fixture.subjectGlobalUserRoleId,
          ],
          [
            'USER_ROLE_BRANCH_REVOKE',
            fixture.staffUserId,
            fixture.staffBranchUserRoleId,
          ],
          [
            'USER_ROLE_UNLINKED_REVOKE',
            fixture.deniedUserId,
            fixture.unlinkedBranchUserRoleId,
          ],
        ]) {
          const revoked = await sendMutation(
            fixture,
            baseUrl,
            label,
            `/api/admin/users/${userId}/roles/${userRoleId}`,
            { method: 'DELETE' },
          );
          assert.equal(revoked.response.status, 200);
          assert.equal(revoked.json.data.userRole.userRoleId, userRoleId);
        }

        const [assignedByRows] = await pool.execute(
          `SELECT COUNT(*) AS count
           FROM user_roles
           WHERE assigned_by_user_id = ?
             AND user_id IN (?, ?, ?)`,
          [
            fixture.adminUserId,
            fixture.subjectUserId,
            fixture.staffUserId,
            fixture.deniedUserId,
          ],
        );
        assert.equal(Number(assignedByRows[0].count), 0);
      });

      await t.test('terminates employment, assignments, and linked login atomically', async () => {
        const terminationEmployeeId = fixture.employeeIds[1];
        const assignment = await sendMutation(
          fixture,
          baseUrl,
          'TERMINATION_ASSIGNMENT_CREATE',
          `/api/admin/employees/${terminationEmployeeId}/assignments`,
          {
            method: 'POST',
            body: {
              branchId: fixture.branchIds[1],
              jobTitle: 'Supervisor',
              startedOn: '2021-01-01',
              isPrimary: true,
            },
          },
        );
        assert.equal(assignment.response.status, 201);
        fixture.terminationAssignmentId = rememberEntity(
          fixture,
          'assignments',
          assignment.json.data.assignment.assignmentId,
        );

        const beforeTermination = await sendRequest(baseUrl, '/api/auth/me', {
          token: fixture.terminationUserToken,
        });
        assert.equal(beforeTermination.response.status, 200);

        const terminated = await sendMutation(
          fixture,
          baseUrl,
          'EMPLOYEE_TERMINATE',
          `/api/admin/employees/${terminationEmployeeId}/terminate`,
          {
            method: 'POST',
            body: { terminationDate: fixture.currentDate },
          },
        );
        assert.equal(terminated.response.status, 200);
        assert.equal(
          terminated.json.data.employee.employmentStatus,
          'TERMINATED',
        );
        assert.equal(
          terminated.json.data.employee.terminationDate,
          fixture.currentDate,
        );
        assert.equal(terminated.json.data.linkedUserDeactivated, true);
        assert.deepEqual(terminated.json.data.endedAssignmentIds, [
          fixture.terminationAssignmentId,
        ]);

        const afterTermination = await sendRequest(baseUrl, '/api/auth/me', {
          token: fixture.terminationUserToken,
        });
        assertSafeError(afterTermination, 401);

        const [stateRows] = await pool.execute(
          `SELECT
             e.employment_status AS employmentStatus,
             e.termination_date AS terminationDate,
             u.is_active AS userIsActive,
             eba.ended_on AS assignmentEndedOn,
             eba.is_primary AS assignmentIsPrimary
           FROM employees e
           INNER JOIN users u ON u.employee_id = e.employee_id
           INNER JOIN employee_branch_assignments eba
             ON eba.employee_id = e.employee_id
           WHERE e.employee_id = ? AND eba.assignment_id = ?`,
          [terminationEmployeeId, fixture.terminationAssignmentId],
        );
        assert.equal(stateRows[0].employmentStatus, 'TERMINATED');
        assert.equal(stateRows[0].userIsActive, 0);
        assert.equal(stateRows[0].assignmentIsPrimary, 0);

        const unsafeReactivation = await sendMutation(
          fixture,
          baseUrl,
          'TERMINATED_USER_REACTIVATE',
          `/api/admin/users/${fixture.terminationUserId}`,
          { method: 'PATCH', body: { isActive: true } },
        );
        fixture.failedRequestIds.add(unsafeReactivation.requestId);
        assertSafeError(unsafeReactivation, 409);

        const [reactivationRows] = await pool.execute(
          'SELECT is_active AS isActive FROM users WHERE user_id = ?',
          [fixture.terminationUserId],
        );
        assert.equal(reactivationRows[0].isActive, 0);

        const repeated = await sendMutation(
          fixture,
          baseUrl,
          'EMPLOYEE_TERMINATE_REPEAT',
          `/api/admin/employees/${terminationEmployeeId}/terminate`,
          {
            method: 'POST',
            body: { terminationDate: fixture.currentDate },
          },
        );
        assert.equal(repeated.response.status, 200);
        assert.equal(repeated.json.data.alreadyTerminated, true);

        const terminatedList = await sendRequest(
          baseUrl,
          `/api/admin/employees?employmentStatus=TERMINATED&search=${encodeURIComponent(`PAGED_${fixture.token}`)}`,
          { token: fixture.adminToken },
        );
        assert.equal(terminatedList.response.status, 200);
        assertPagination(terminatedList.json.data, { totalItems: 1 });
      });

      await t.test('keeps master data and permission definitions off DELETE APIs', async () => {
        const paths = [
          `/api/admin/branches/${fixture.branchIds[0]}`,
          `/api/admin/employees/${fixture.employeeIds[0]}`,
          `/api/admin/users/${fixture.staffUserId}`,
          `/api/admin/roles/${fixture.operationalRoleId}`,
          `/api/admin/permissions/${fixture.permissionIdByCode['branches.read']}`,
        ];
        for (const path of paths) {
          const result = await sendRequest(baseUrl, path, {
            method: 'DELETE',
            token: fixture.adminToken,
          });
          assertSafeError(result, 404);
        }

        for (const method of ['POST', 'PATCH', 'DELETE']) {
          const result = await sendRequest(baseUrl, '/api/admin/permissions', {
            method,
            token: fixture.adminToken,
            body: method === 'DELETE' ? undefined : {},
          });
          assertSafeError(result, 404);
        }
      });

      await t.test('writes complete secret-free administrative audit events', async () => {
        const [auditRows] = await pool.execute(
          `SELECT
             CAST(audit_log_id AS CHAR) AS auditLogId,
             CAST(user_id AS CHAR) AS userId,
             CAST(employee_id AS CHAR) AS employeeId,
             CAST(branch_id AS CHAR) AS branchId,
             action_type AS actionType,
             entity_type AS entityType,
             entity_record_id AS entityRecordId,
             before_values AS beforeValues,
             after_values AS afterValues,
             ip_address AS ipAddress,
             user_agent AS userAgent,
             request_id AS requestId,
             notes
           FROM audit_logs
           WHERE user_id = ? AND request_id LIKE ?
           ORDER BY audit_log_id`,
          [fixture.adminUserId, `${fixture.auditPrefix}%`],
        );
        assert.ok(auditRows.length > 0);

        const actionTypes = new Set(auditRows.map((row) => row.actionType));
        for (const expectedAction of [
          'BRANCH_CREATED',
          'BRANCH_UPDATED',
          'EMPLOYEE_CREATED',
          'EMPLOYEE_UPDATED',
          'EMPLOYEE_TERMINATED',
          'EMPLOYEE_BRANCH_ASSIGNED',
          'EMPLOYEE_BRANCH_ASSIGNMENT_ENDED',
          'EMPLOYEE_PRIMARY_BRANCH_CHANGED',
          'USER_CREATED',
          'USER_UPDATED',
          'USER_PASSWORD_RESET',
          'ROLE_CREATED',
          'ROLE_UPDATED',
          'ROLE_PERMISSIONS_CHANGED',
          'USER_ROLE_ASSIGNED',
          'USER_ROLE_REVOKED',
        ]) {
          assert.equal(
            actionTypes.has(expectedAction),
            true,
            `Missing audit action ${expectedAction}`,
          );
        }

        for (const row of auditRows) {
          assertIdString(row.auditLogId);
          assert.equal(row.userId, fixture.adminUserId);
          assert.equal(row.employeeId, fixture.adminEmployeeId);
          assert.equal(row.userAgent, TEST_USER_AGENT);
          assert.equal(fixture.requestIds.has(row.requestId), true);
          assert.ok(row.ipAddress);
        }
        assertNoSecretMaterial(auditRows, fixture);

        const failedIds = [...fixture.failedRequestIds];
        const [failedAuditRows] = await pool.execute(
          `SELECT COUNT(*) AS count FROM audit_logs
           WHERE request_id IN (${placeholders(failedIds)})`,
          failedIds,
        );
        assert.equal(Number(failedAuditRows[0].count), 0);

        const [permissionAuditRows] = await pool.execute(
          `SELECT before_values AS beforeValues, after_values AS afterValues
           FROM audit_logs
           WHERE user_id = ?
             AND action_type = 'ROLE_PERMISSIONS_CHANGED'
             AND entity_record_id = ?`,
          [fixture.adminUserId, fixture.operationalRoleId],
        );
        assert.equal(permissionAuditRows.length, 1);
        const beforeValues =
          typeof permissionAuditRows[0].beforeValues === 'string'
            ? JSON.parse(permissionAuditRows[0].beforeValues)
            : permissionAuditRows[0].beforeValues;
        const afterValues =
          typeof permissionAuditRows[0].afterValues === 'string'
            ? JSON.parse(permissionAuditRows[0].afterValues)
            : permissionAuditRows[0].afterValues;
        assert.deepEqual(beforeValues.permissionCodes, []);
        assert.deepEqual(afterValues.permissionCodes, [
          'branches.read',
          'users.read',
        ]);

        const [terminationAuditRows] = await pool.execute(
          `SELECT COUNT(*) AS count
           FROM audit_logs
           WHERE user_id = ?
             AND action_type = 'EMPLOYEE_TERMINATED'
             AND entity_record_id = ?`,
          [fixture.adminUserId, fixture.employeeIds[1]],
        );
        assert.equal(Number(terminationAuditRows[0].count), 1);
      });

      await t.test('handles SIGTERM and SIGINT gracefully', async () => {
        await verifyGracefulShutdown('SIGTERM');
        await verifyGracefulShutdown('SIGINT');
      });
    } finally {
      const errors = [];
      try {
        await stopHttpServer(apiServer);
      } catch (error) {
        errors.push(error);
      }
      try {
        await cleanupFixtures(fixture);
      } catch (error) {
        errors.push(error);
      }
      try {
        await pool.end();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) {
        for (const error of errors) {
          console.error('Phase 4 teardown diagnostic', {
            code: error.code,
            message: error.message,
            stack: error.stack,
          });
        }
        throw new AggregateError(errors, 'Phase 4 integration teardown failed.');
      }
    }
  },
);
