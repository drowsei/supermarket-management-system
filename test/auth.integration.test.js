import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import net from 'node:net';
import test from 'node:test';

import bcrypt from 'bcrypt';
import dotenv from 'dotenv';
import express from 'express';
import jwt from 'jsonwebtoken';

dotenv.config({ quiet: true });

requireIntegrationEnvironment();

const [
  { default: app },
  { pool },
  { authenticate },
  {
    requireBranchPermission,
    requirePasswordChangeCompleted,
    requirePermission,
  },
  { loginUser },
  { errorHandler },
  { createLoginRateLimiter, LOGIN_ATTEMPT_LIMIT },
  { signAccessToken },
] = await Promise.all([
  import('../src/app.js'),
  import('../src/config/database.js'),
  import('../src/middleware/auth.middleware.js'),
  import('../src/middleware/authorization.middleware.js'),
  import('../src/controllers/auth.controller.js'),
  import('../src/middleware/errorHandler.js'),
  import('../src/middleware/loginRateLimiter.js'),
  import('../src/utils/jwt.js'),
]);

const TEST_TIMEOUT_MS = 120_000;
const CHILD_STARTUP_TIMEOUT_MS = 15_000;
const CHILD_SHUTDOWN_TIMEOUT_MS = 15_000;

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
    'Live integration tests require all documented database and authentication environment variables.',
  );

  const jwtSecret = process.env.JWT_SECRET;
  assert.ok(
    Buffer.byteLength(jwtSecret, 'utf8') >= 48 &&
      !/^replace[_-]?with/i.test(jwtSecret),
    'JWT_SECRET must be a private random value of at least 48 UTF-8 bytes before live tests run.',
  );

  const lifetimeMatch = /^([1-9]\d*)(s|m|h)$/.exec(
    process.env.JWT_EXPIRES_IN,
  );
  const unitSeconds = { s: 1, m: 60, h: 3_600 };
  const lifetimeSeconds = lifetimeMatch
    ? Number(lifetimeMatch[1]) * unitSeconds[lifetimeMatch[2]]
    : Number.NaN;
  assert.ok(
    Number.isSafeInteger(lifetimeSeconds) &&
      lifetimeSeconds >= 60 &&
      lifetimeSeconds <= 3_600,
    'JWT_EXPIRES_IN must use an explicit s, m, or h unit and be between 60 seconds and 1 hour.',
  );

  const bcryptRounds = Number(process.env.BCRYPT_ROUNDS);
  assert.ok(
    Number.isInteger(bcryptRounds) && bcryptRounds >= 10 && bcryptRounds <= 14,
    'BCRYPT_ROUNDS must be an integer between 10 and 14 before live tests run.',
  );
}

function createFixtureDefinition() {
  const uniqueToken = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`;

  return {
    uniqueToken,
    branchACode: `TEST_A_${uniqueToken}`,
    branchBCode: `TEST_B_${uniqueToken}`,
    employeeNumber: `TEST_E_${uniqueToken}`,
    username: `TEST_AUTH_${uniqueToken}`,
    email: `TEST_AUTH_${uniqueToken}@example.invalid`,
    inactiveUsername: `TEST_INACTIVE_${uniqueToken}`,
    inactiveEmail: `TEST_INACTIVE_${uniqueToken}@example.invalid`,
    globalRoleCode: `TEST_GLOBAL_${uniqueToken}`,
    branchRoleCode: `TEST_BRANCH_${uniqueToken}`,
    inactiveRoleCode: `TEST_INACTIVE_${uniqueToken}`,
    globalPermissionCode: `TEST.GLOBAL.${uniqueToken}`,
    branchPermissionCode: `TEST.BRANCH.${uniqueToken}`,
    inactivePermissionCode: `TEST.INACTIVE.${uniqueToken}`,
    missingPermissionCode: `TEST.MISSING.${uniqueToken}`,
    requestId: `TEST_AUTH_PASSWORD_${uniqueToken}`,
    currentPassword: `CurrentAuth3-${uniqueToken}`,
    inactivePassword: `InactiveAuth3-${uniqueToken}`,
    newPassword: `ChangedAuth3-${uniqueToken}`,
    setupCommitted: false,
  };
}

function asId(value) {
  return String(value);
}

async function createFixtures(fixture) {
  const rounds = Number.parseInt(process.env.BCRYPT_ROUNDS, 10);
  const [activePasswordHash, inactivePasswordHash] = await Promise.all([
    bcrypt.hash(fixture.currentPassword, rounds),
    bcrypt.hash(fixture.inactivePassword, rounds),
  ]);
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [branchAResult] = await connection.execute(
      `INSERT INTO branches (
        branch_code,
        branch_name,
        address_line_1,
        city,
        country_code,
        currency_code,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE')`,
      [
        fixture.branchACode,
        `TEST_AUTH Branch A ${fixture.uniqueToken}`,
        'TEST_AUTH fixture address',
        'Lagos',
        'NG',
        'NGN',
      ],
    );
    fixture.branchAId = asId(branchAResult.insertId);

    const [branchBResult] = await connection.execute(
      `INSERT INTO branches (
        branch_code,
        branch_name,
        address_line_1,
        city,
        country_code,
        currency_code,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE')`,
      [
        fixture.branchBCode,
        `TEST_AUTH Branch B ${fixture.uniqueToken}`,
        'TEST_AUTH fixture address',
        'Lagos',
        'NG',
        'NGN',
      ],
    );
    fixture.branchBId = asId(branchBResult.insertId);

    const roleDefinitions = [
      [fixture.globalRoleCode, `TEST_AUTH Global ${fixture.uniqueToken}`, 1],
      [fixture.branchRoleCode, `TEST_AUTH Branch ${fixture.uniqueToken}`, 1],
      [fixture.inactiveRoleCode, `TEST_AUTH Inactive ${fixture.uniqueToken}`, 0],
    ];

    for (const [roleCode, roleName, isActive] of roleDefinitions) {
      const [roleResult] = await connection.execute(
        `INSERT INTO roles (role_code, role_name, description, is_active)
         VALUES (?, ?, ?, ?)`,
        [roleCode, roleName, 'Temporary Phase 3 integration-test role', isActive],
      );

      if (roleCode === fixture.globalRoleCode) {
        fixture.globalRoleId = asId(roleResult.insertId);
      } else if (roleCode === fixture.branchRoleCode) {
        fixture.branchRoleId = asId(roleResult.insertId);
      } else {
        fixture.inactiveRoleId = asId(roleResult.insertId);
      }
    }

    const permissionDefinitions = [
      [
        fixture.globalPermissionCode,
        `TEST_AUTH global permission ${fixture.uniqueToken}`,
      ],
      [
        fixture.branchPermissionCode,
        `TEST_AUTH branch permission ${fixture.uniqueToken}`,
      ],
      [
        fixture.inactivePermissionCode,
        `TEST_AUTH inactive-role permission ${fixture.uniqueToken}`,
      ],
    ];

    for (const [permissionCode, permissionName] of permissionDefinitions) {
      const [permissionResult] = await connection.execute(
        `INSERT INTO permissions (
          permission_code,
          permission_name,
          description
        ) VALUES (?, ?, ?)`,
        [
          permissionCode,
          permissionName,
          'Temporary Phase 3 integration-test permission',
        ],
      );

      if (permissionCode === fixture.globalPermissionCode) {
        fixture.globalPermissionId = asId(permissionResult.insertId);
      } else if (permissionCode === fixture.branchPermissionCode) {
        fixture.branchPermissionId = asId(permissionResult.insertId);
      } else {
        fixture.inactivePermissionId = asId(permissionResult.insertId);
      }
    }

    const [employeeResult] = await connection.execute(
      `INSERT INTO employees (
        employee_number,
        first_name,
        last_name,
        email,
        hire_date,
        employment_status
      ) VALUES (?, ?, ?, ?, ?, 'ACTIVE')`,
      [
        fixture.employeeNumber,
        'TEST_AUTH',
        fixture.uniqueToken,
        `test-employee-${fixture.uniqueToken}@example.invalid`,
        '2000-01-01',
      ],
    );
    fixture.employeeId = asId(employeeResult.insertId);

    const [assignmentResult] = await connection.execute(
      `INSERT INTO employee_branch_assignments (
        employee_id,
        branch_id,
        job_title,
        started_on,
        is_primary
      ) VALUES (?, ?, ?, ?, 1)`,
      [
        fixture.employeeId,
        fixture.branchAId,
        'TEST_AUTH Cashier',
        '2000-01-01',
      ],
    );
    fixture.branchAAssignmentId = asId(assignmentResult.insertId);

    const [activeUserResult] = await connection.execute(
      `INSERT INTO users (
        employee_id,
        username,
        email,
        password_hash,
        is_active,
        must_change_password
      ) VALUES (?, ?, ?, ?, 1, 1)`,
      [
        fixture.employeeId,
        fixture.username,
        fixture.email,
        activePasswordHash,
      ],
    );
    fixture.activeUserId = asId(activeUserResult.insertId);

    const [inactiveUserResult] = await connection.execute(
      `INSERT INTO users (
        employee_id,
        username,
        email,
        password_hash,
        is_active,
        must_change_password
      ) VALUES (NULL, ?, ?, ?, 0, 0)`,
      [
        fixture.inactiveUsername,
        fixture.inactiveEmail,
        inactivePasswordHash,
      ],
    );
    fixture.inactiveUserId = asId(inactiveUserResult.insertId);

    await connection.execute(
      `INSERT INTO role_permissions (role_id, permission_id)
       VALUES (?, ?), (?, ?), (?, ?)`,
      [
        fixture.globalRoleId,
        fixture.globalPermissionId,
        fixture.branchRoleId,
        fixture.branchPermissionId,
        fixture.inactiveRoleId,
        fixture.inactivePermissionId,
      ],
    );

    await connection.execute(
      `INSERT INTO user_roles (user_id, role_id, branch_id)
       VALUES (?, ?, NULL), (?, ?, ?), (?, ?, NULL)`,
      [
        fixture.activeUserId,
        fixture.globalRoleId,
        fixture.activeUserId,
        fixture.branchRoleId,
        fixture.branchAId,
        fixture.activeUserId,
        fixture.inactiveRoleId,
      ],
    );

    await connection.commit();
    fixture.setupCommitted = true;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function cleanupFixtures(fixture) {
  if (!fixture.setupCommitted) {
    return;
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    await connection.execute(
      'DELETE FROM audit_logs WHERE user_id IN (?, ?)',
      [fixture.activeUserId, fixture.inactiveUserId],
    );
    await connection.execute(
      'DELETE FROM user_roles WHERE user_id IN (?, ?)',
      [fixture.activeUserId, fixture.inactiveUserId],
    );
    await connection.execute(
      'DELETE FROM role_permissions WHERE role_id IN (?, ?, ?)',
      [
        fixture.globalRoleId,
        fixture.branchRoleId,
        fixture.inactiveRoleId,
      ],
    );
    await connection.execute(
      'DELETE FROM users WHERE user_id IN (?, ?)',
      [fixture.activeUserId, fixture.inactiveUserId],
    );
    await connection.execute(
      'DELETE FROM employee_branch_assignments WHERE employee_id = ?',
      [fixture.employeeId],
    );
    await connection.execute(
      'DELETE FROM employees WHERE employee_id = ?',
      [fixture.employeeId],
    );
    await connection.execute(
      'DELETE FROM roles WHERE role_id IN (?, ?, ?)',
      [
        fixture.globalRoleId,
        fixture.branchRoleId,
        fixture.inactiveRoleId,
      ],
    );
    await connection.execute(
      'DELETE FROM permissions WHERE permission_id IN (?, ?, ?)',
      [
        fixture.globalPermissionId,
        fixture.branchPermissionId,
        fixture.inactivePermissionId,
      ],
    );
    await connection.execute(
      'DELETE FROM branches WHERE branch_id IN (?, ?)',
      [fixture.branchAId, fixture.branchBId],
    );

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  const [remainingRows] = await pool.execute(
    `SELECT
      (SELECT COUNT(*) FROM audit_logs
        WHERE request_id = ?
          OR (entity_type = 'users' AND entity_record_id IN (?, ?)))
        AS audit_count,
      (SELECT COUNT(*) FROM user_roles
        WHERE user_id IN (?, ?)) AS user_role_count,
      (SELECT COUNT(*) FROM role_permissions
        WHERE role_id IN (?, ?, ?)) AS role_permission_count,
      (SELECT COUNT(*) FROM users
        WHERE username IN (?, ?)) AS user_count,
      (SELECT COUNT(*) FROM employee_branch_assignments
        WHERE employee_id = ?) AS assignment_count,
      (SELECT COUNT(*) FROM employees
        WHERE employee_number = ?) AS employee_count,
      (SELECT COUNT(*) FROM roles
        WHERE role_code IN (?, ?, ?)) AS role_count,
      (SELECT COUNT(*) FROM permissions
        WHERE permission_code IN (?, ?, ?)) AS permission_count,
      (SELECT COUNT(*) FROM branches
        WHERE branch_code IN (?, ?)) AS branch_count`,
    [
      fixture.requestId,
      fixture.activeUserId,
      fixture.inactiveUserId,
      fixture.activeUserId,
      fixture.inactiveUserId,
      fixture.globalRoleId,
      fixture.branchRoleId,
      fixture.inactiveRoleId,
      fixture.username,
      fixture.inactiveUsername,
      fixture.employeeId,
      fixture.employeeNumber,
      fixture.globalRoleCode,
      fixture.branchRoleCode,
      fixture.inactiveRoleCode,
      fixture.globalPermissionCode,
      fixture.branchPermissionCode,
      fixture.inactivePermissionCode,
      fixture.branchACode,
      fixture.branchBCode,
    ],
  );
  const remaining = remainingRows[0];

  for (const [recordType, count] of Object.entries(remaining)) {
    assert.equal(
      Number(count),
      0,
      `Temporary authentication fixture cleanup left ${recordType} rows behind.`,
    );
  }
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
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function getBaseUrl(server) {
  const address = server.address();

  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

async function sendRequest(baseUrl, path, options = {}) {
  const headers = new Headers(options.headers);

  if (options.token) {
    headers.set('authorization', `Bearer ${options.token}`);
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
  const json = responseText ? JSON.parse(responseText) : null;

  return { response, json };
}

function assertSafeError(result, expectedStatus) {
  assert.equal(result.response.status, expectedStatus);
  assert.equal(result.json?.success, false);
  assert.equal(typeof result.json?.message, 'string');

  const serializedResponse = JSON.stringify(result.json);
  for (const forbiddenField of [
    'password_hash',
    'passwordHash',
    'sqlMessage',
    'sqlState',
    'stack',
  ]) {
    assert.equal(serializedResponse.includes(forbiddenField), false);
  }
}

function assertNoSecretMaterial(json, fixture) {
  const serializedResponse = JSON.stringify(json);

  for (const sensitiveValue of [
    fixture.currentPassword,
    fixture.inactivePassword,
    fixture.newPassword,
    process.env.JWT_SECRET,
  ]) {
    assert.equal(
      serializedResponse.includes(sensitiveValue),
      false,
      'An API response contained sensitive authentication material.',
    );
  }

  assert.equal(serializedResponse.includes('password_hash'), false);
  assert.equal(serializedResponse.includes('passwordHash'), false);
  assert.equal(/\$2[aby]\$\d{2}\$/.test(serializedResponse), false);
}

function createAuthorizationTestApp(fixture) {
  const authorizationApp = express();
  const sendSuccess = (request, response) => {
    response.status(200).json({ success: true });
  };

  authorizationApp.get(
    '/test/global',
    authenticate,
    requirePermission(fixture.globalPermissionCode),
    sendSuccess,
  );
  authorizationApp.get(
    '/test/branch-only-as-global',
    authenticate,
    requirePermission(fixture.branchPermissionCode),
    sendSuccess,
  );
  authorizationApp.get(
    '/test/inactive-role',
    authenticate,
    requirePermission(fixture.inactivePermissionCode),
    sendSuccess,
  );
  authorizationApp.get(
    '/test/missing',
    authenticate,
    requirePermission(fixture.missingPermissionCode),
    sendSuccess,
  );
  authorizationApp.get(
    '/test/branch/:branchId',
    authenticate,
    requireBranchPermission(fixture.branchPermissionCode),
    sendSuccess,
  );
  authorizationApp.get(
    '/test/global-at-branch/:branchId',
    authenticate,
    requireBranchPermission(fixture.globalPermissionCode),
    sendSuccess,
  );
  authorizationApp.get(
    '/test/password-ready',
    authenticate,
    requirePasswordChangeCompleted,
    sendSuccess,
  );
  authorizationApp.use(errorHandler);

  return authorizationApp;
}

function createRateLimitTestApp() {
  const rateLimitApp = express();

  rateLimitApp.use(express.json());
  rateLimitApp.post(
    '/api/auth/login',
    createLoginRateLimiter({ limit: 2, windowMs: 60_000 }),
    loginUser,
  );
  rateLimitApp.get('/api/health', (request, response) => {
    response.status(200).json({ success: true });
  });
  rateLimitApp.use(errorHandler);

  return rateLimitApp;
}

function signCustomToken(subject, overrides = {}) {
  return jwt.sign({}, process.env.JWT_SECRET, {
    algorithm: overrides.algorithm ?? 'HS256',
    audience: overrides.audience ?? process.env.JWT_AUDIENCE,
    issuer: overrides.issuer ?? process.env.JWT_ISSUER,
    subject,
    expiresIn: overrides.expiresIn ?? '5m',
  });
}

async function getAvailablePort() {
  const portServer = net.createServer();

  portServer.listen(0, '127.0.0.1');
  await once(portServer, 'listening');

  const address = portServer.address();
  assert.ok(address && typeof address === 'object');

  await new Promise((resolve, reject) => {
    portServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  return address.port;
}

function waitForChildOutput(child, capturedOutput, expectedText, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Child server did not become ready before the timeout.'));
    }, timeoutMs);

    const inspectOutput = () => {
      if (capturedOutput.stdout.includes(expectedText)) {
        cleanup();
        resolve();
      }
    };
    const handleExit = (code, signal) => {
      cleanup();
      reject(
        new Error(
          `Child server exited before readiness (code ${code}, signal ${signal}).`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off('data', inspectOutput);
      child.off('exit', handleExit);
    };

    child.stdout.on('data', inspectOutput);
    child.once('exit', handleExit);
    inspectOutput();
  });
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }

  let timeout;

  try {
    return await Promise.race([
      once(child, 'exit').then(([code, signal]) => ({ code, signal })),
      new Promise((resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Child server did not exit before the timeout.')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function verifyGracefulShutdown(signal) {
  const port = await getAvailablePort();
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const capturedOutput = { stdout: '', stderr: '' };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    capturedOutput.stdout = `${capturedOutput.stdout}${chunk}`.slice(-20_000);
  });
  child.stderr.on('data', (chunk) => {
    capturedOutput.stderr = `${capturedOutput.stderr}${chunk}`.slice(-20_000);
  });

  try {
    await waitForChildOutput(
      child,
      capturedOutput,
      `Server running on port ${port}`,
      CHILD_STARTUP_TIMEOUT_MS,
    );

    const healthResult = await sendRequest(
      `http://127.0.0.1:${port}`,
      '/api/health',
    );
    assert.equal(healthResult.response.status, 200);

    assert.equal(child.kill(signal), true);
    const exit = await waitForChildExit(child, CHILD_SHUTDOWN_TIMEOUT_MS);

    assert.equal(exit.code, 0);
    assert.equal(exit.signal, null);
    assert.match(capturedOutput.stdout, /Shutting down gracefully/);
    assert.match(capturedOutput.stdout, /HTTP server and MySQL pool closed/);
    assert.ok(
      capturedOutput.stderr.length === 0,
      'The child server wrote unexpected diagnostics to stderr.',
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  }
}

test(
  'Phase 2 regressions and Phase 3 authentication/authorization integration',
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const fixture = createFixtureDefinition();
    let apiServer;
    let authorizationServer;
    let rateLimitServer;

    try {
      await createFixtures(fixture);
      apiServer = await startHttpServer(app);
      authorizationServer = await startHttpServer(
        createAuthorizationTestApp(fixture),
      );
      rateLimitServer = await startHttpServer(createRateLimitTestApp());

      const apiBaseUrl = getBaseUrl(apiServer);
      const authorizationBaseUrl = getBaseUrl(authorizationServer);
      const rateLimitBaseUrl = getBaseUrl(rateLimitServer);
      let accessToken;

      await t.test('preserves the Phase 2 health and 404 behavior', async () => {
        const apiHealth = await sendRequest(apiBaseUrl, '/api/health');
        assert.equal(apiHealth.response.status, 200);
        assert.deepEqual(apiHealth.json, {
          success: true,
          message: 'Supermarket Management System API is running',
        });
        assert.equal(
          apiHealth.response.headers.get('x-content-type-options'),
          'nosniff',
        );
        assert.equal(apiHealth.response.headers.get('x-powered-by'), null);

        const databaseHealth = await sendRequest(
          apiBaseUrl,
          '/api/health/database',
        );
        assert.equal(databaseHealth.response.status, 200);
        assert.deepEqual(databaseHealth.json, {
          success: true,
          database: 'connected',
        });

        const notFound = await sendRequest(apiBaseUrl, '/does-not-exist');
        assertSafeError(notFound, 404);
        assert.equal(notFound.json.message, 'Route not found');

        const noPublicRegistration = await sendRequest(
          apiBaseUrl,
          '/api/auth/register',
          { method: 'POST', body: {} },
        );
        assertSafeError(noPublicRegistration, 404);
      });

      await t.test('validates both required login fields', async () => {
        const missingIdentifier = await sendRequest(
          apiBaseUrl,
          '/api/auth/login',
          {
            method: 'POST',
            body: { password: fixture.currentPassword },
          },
        );
        assertSafeError(missingIdentifier, 400);

        const missingPassword = await sendRequest(
          apiBaseUrl,
          '/api/auth/login',
          {
            method: 'POST',
            body: { identifier: fixture.username },
          },
        );
        assertSafeError(missingPassword, 400);
      });

      await t.test('uses the same generic response for unknown and wrong credentials', async () => {
        const unknownUser = await sendRequest(apiBaseUrl, '/api/auth/login', {
          method: 'POST',
          body: {
            identifier: `unknown_${fixture.uniqueToken}`,
            password: fixture.currentPassword,
          },
        });
        const wrongPassword = await sendRequest(apiBaseUrl, '/api/auth/login', {
          method: 'POST',
          body: {
            identifier: fixture.username,
            password: `Wrong-${fixture.uniqueToken}`,
          },
        });

        assertSafeError(unknownUser, 401);
        assertSafeError(wrongPassword, 401);
        assert.deepEqual(unknownUser.json, wrongPassword.json);
        assert.deepEqual(unknownUser.json, {
          success: false,
          message: 'Invalid credentials',
        });
      });

      await t.test('rejects an inactive account without revealing its state', async () => {
        const inactiveLogin = await sendRequest(apiBaseUrl, '/api/auth/login', {
          method: 'POST',
          body: {
            identifier: fixture.inactiveUsername,
            password: fixture.inactivePassword,
          },
        });

        assertSafeError(inactiveLogin, 401);
        assert.deepEqual(inactiveLogin.json, {
          success: false,
          message: 'Invalid credentials',
        });

        const { accessToken: inactiveToken } = signAccessToken(
          fixture.inactiveUserId,
        );
        const inactiveProtectedRequest = await sendRequest(
          apiBaseUrl,
          '/api/auth/me',
          { token: inactiveToken },
        );
        assertSafeError(inactiveProtectedRequest, 401);
      });

      await t.test('rejects an ambiguous cross-column login identifier', async () => {
        await pool.execute(
          'UPDATE users SET email = ? WHERE user_id = ?',
          [fixture.username, fixture.inactiveUserId],
        );

        try {
          const ambiguousLogin = await sendRequest(
            apiBaseUrl,
            '/api/auth/login',
            {
              method: 'POST',
              body: {
                identifier: fixture.username,
                password: fixture.currentPassword,
              },
            },
          );
          assertSafeError(ambiguousLogin, 401);
          assert.deepEqual(ambiguousLogin.json, {
            success: false,
            message: 'Invalid credentials',
          });
        } finally {
          await pool.execute(
            'UPDATE users SET email = ? WHERE user_id = ?',
            [fixture.inactiveEmail, fixture.inactiveUserId],
          );
        }
      });

      await t.test('logs in with safe data, a minimal JWT, and a bigint string ID', async () => {
        const [beforeRows] = await pool.execute(
          'SELECT last_login_at FROM users WHERE user_id = ?',
          [fixture.activeUserId],
        );
        assert.equal(beforeRows[0].last_login_at, null);

        const login = await sendRequest(apiBaseUrl, '/api/auth/login', {
          method: 'POST',
          body: {
            identifier: fixture.username,
            password: fixture.currentPassword,
          },
        });
        accessToken = login.json?.data?.accessToken;

        assert.equal(login.response.status, 200);
        assert.equal(login.json.success, true);
        assert.equal(login.json.data.tokenType, 'Bearer');
        assert.equal(login.json.data.expiresIn, process.env.JWT_EXPIRES_IN);
        assert.equal(typeof accessToken, 'string');
        assert.equal(login.json.data.user.userId, fixture.activeUserId);
        assert.equal(typeof login.json.data.user.userId, 'string');
        assert.equal(login.json.data.user.username, fixture.username);
        assert.equal(login.json.data.user.email, fixture.email);
        assert.equal(login.json.data.user.employeeId, fixture.employeeId);
        assert.equal(login.json.data.user.mustChangePassword, true);
        assert.equal('password_hash' in login.json.data.user, false);
        assert.equal('passwordHash' in login.json.data.user, false);
        assertNoSecretMaterial(login.json, fixture);

        const tokenPayload = jwt.decode(accessToken);
        assert.deepEqual(Object.keys(tokenPayload).sort(), [
          'aud',
          'exp',
          'iat',
          'iss',
          'sub',
        ]);
        assert.equal(tokenPayload.sub, fixture.activeUserId);
        assert.equal(tokenPayload.iss, process.env.JWT_ISSUER);
        assert.equal(tokenPayload.aud, process.env.JWT_AUDIENCE);
        assert.ok(tokenPayload.exp > tokenPayload.iat);
        assert.ok(tokenPayload.exp - tokenPayload.iat <= 3_600);
        for (const forbiddenClaim of [
          'username',
          'email',
          'employeeId',
          'roles',
          'permissions',
          'password_hash',
          'passwordHash',
        ]) {
          assert.equal(forbiddenClaim in tokenPayload, false);
        }

        const [afterRows] = await pool.execute(
          'SELECT last_login_at FROM users WHERE user_id = ?',
          [fixture.activeUserId],
        );
        assert.notEqual(afterRows[0].last_login_at, null);
      });

      await t.test('rejects missing, malformed, invalid, and expired tokens', async () => {
        const noToken = await sendRequest(apiBaseUrl, '/api/auth/me');
        assertSafeError(noToken, 401);

        const malformed = await sendRequest(apiBaseUrl, '/api/auth/me', {
          headers: { authorization: 'Basic credentials' },
        });
        assertSafeError(malformed, 401);

        const invalid = await sendRequest(apiBaseUrl, '/api/auth/me', {
          token: 'invalid.token.value',
        });
        assertSafeError(invalid, 401);

        const expired = await sendRequest(apiBaseUrl, '/api/auth/me', {
          token: signCustomToken(fixture.activeUserId, { expiresIn: -1 }),
        });
        assertSafeError(expired, 401);

        const nonexistentUser = await sendRequest(apiBaseUrl, '/api/auth/me', {
          token: signCustomToken('18446744073709551615'),
        });
        assertSafeError(nonexistentUser, 401);
      });

      await t.test('enforces JWT issuer, audience, and HS256 algorithm', async () => {
        const wrongIssuer = await sendRequest(apiBaseUrl, '/api/auth/me', {
          token: signCustomToken(fixture.activeUserId, {
            issuer: 'TEST_AUTH_WRONG_ISSUER',
          }),
        });
        assertSafeError(wrongIssuer, 401);

        const wrongAudience = await sendRequest(apiBaseUrl, '/api/auth/me', {
          token: signCustomToken(fixture.activeUserId, {
            audience: 'TEST_AUTH_WRONG_AUDIENCE',
          }),
        });
        assertSafeError(wrongAudience, 401);

        const wrongAlgorithm = await sendRequest(apiBaseUrl, '/api/auth/me', {
          token: signCustomToken(fixture.activeUserId, {
            algorithm: 'HS384',
          }),
        });
        assertSafeError(wrongAlgorithm, 401);
      });

      await t.test('returns current safe account and authorization data from /me', async () => {
        const currentUser = await sendRequest(apiBaseUrl, '/api/auth/me', {
          token: accessToken,
        });

        assert.equal(currentUser.response.status, 200);
        assert.equal(currentUser.json.success, true);
        assert.equal(currentUser.json.data.user.userId, fixture.activeUserId);
        assert.equal(currentUser.json.data.user.employeeId, fixture.employeeId);
        assert.equal(currentUser.json.data.user.isActive, true);
        assert.equal(currentUser.json.data.user.mustChangePassword, true);
        assert.ok(currentUser.json.data.user.lastLoginAt);
        assert.equal('password_hash' in currentUser.json.data.user, false);
        assert.equal('passwordHash' in currentUser.json.data.user, false);
        assertNoSecretMaterial(currentUser.json, fixture);

        const authorization = currentUser.json.data.authorization;
        assert.ok(
          authorization.globalRoles.some(
            (role) => role.roleCode === fixture.globalRoleCode,
          ),
        );
        assert.ok(
          authorization.branchRoles.some(
            (role) =>
              role.branchId === fixture.branchAId &&
              role.roleCode === fixture.branchRoleCode,
          ),
        );
        assert.ok(
          authorization.permissions.global.includes(
            fixture.globalPermissionCode,
          ),
        );
        assert.ok(
          authorization.permissions.byBranch[fixture.branchAId].includes(
            fixture.branchPermissionCode,
          ),
        );
        assert.equal(
          JSON.stringify(authorization).includes(fixture.inactiveRoleCode),
          false,
        );
        assert.equal(
          JSON.stringify(authorization).includes(
            fixture.inactivePermissionCode,
          ),
          false,
        );
      });

      await t.test('enforces global, branch-scoped, missing, and inactive-role permissions', async () => {
        const globalPermission = await sendRequest(
          authorizationBaseUrl,
          '/test/global',
          { token: accessToken },
        );
        assert.equal(globalPermission.response.status, 200);

        const branchRoleIsNotGlobal = await sendRequest(
          authorizationBaseUrl,
          '/test/branch-only-as-global',
          { token: accessToken },
        );
        assertSafeError(branchRoleIsNotGlobal, 403);

        const matchingBranch = await sendRequest(
          authorizationBaseUrl,
          `/test/branch/${fixture.branchAId}`,
          { token: accessToken },
        );
        assert.equal(matchingBranch.response.status, 200);

        const otherBranch = await sendRequest(
          authorizationBaseUrl,
          `/test/branch/${fixture.branchBId}`,
          { token: accessToken },
        );
        assertSafeError(otherBranch, 403);

        const missingPermission = await sendRequest(
          authorizationBaseUrl,
          '/test/missing',
          { token: accessToken },
        );
        assertSafeError(missingPermission, 403);

        const inactiveRole = await sendRequest(
          authorizationBaseUrl,
          '/test/inactive-role',
          { token: accessToken },
        );
        assertSafeError(inactiveRole, 403);
      });

      await t.test('requires an active employee assignment for branch access', async () => {
        await pool.execute(
          `INSERT INTO user_roles (user_id, role_id, branch_id)
           VALUES (?, ?, ?)`,
          [
            fixture.activeUserId,
            fixture.branchRoleId,
            fixture.branchBId,
          ],
        );

        const withoutAssignment = await sendRequest(
          authorizationBaseUrl,
          `/test/branch/${fixture.branchBId}`,
          { token: accessToken },
        );
        assertSafeError(withoutAssignment, 403);

        const [assignmentResult] = await pool.execute(
          `INSERT INTO employee_branch_assignments (
            employee_id,
            branch_id,
            job_title,
            started_on,
            is_primary
          ) VALUES (?, ?, ?, ?, 0)`,
          [
            fixture.employeeId,
            fixture.branchBId,
            'TEST_AUTH Temporary Assignment',
            '2000-01-01',
          ],
        );
        const branchBAssignmentId = asId(assignmentResult.insertId);

        try {
          const withAssignment = await sendRequest(
            authorizationBaseUrl,
            `/test/branch/${fixture.branchBId}`,
            { token: accessToken },
          );
          assert.equal(withAssignment.response.status, 200);

          const globalAtAssignedBranch = await sendRequest(
            authorizationBaseUrl,
            `/test/global-at-branch/${fixture.branchBId}`,
            { token: accessToken },
          );
          assert.equal(globalAtAssignedBranch.response.status, 200);
        } finally {
          await pool.execute(
            'DELETE FROM employee_branch_assignments WHERE assignment_id = ?',
            [branchBAssignmentId],
          );
        }

        const afterAssignmentEnds = await sendRequest(
          authorizationBaseUrl,
          `/test/global-at-branch/${fixture.branchBId}`,
          { token: accessToken },
        );
        assertSafeError(afterAssignmentEnds, 403);
      });

      await t.test('uses current database grants instead of stale JWT claims', async () => {
        await pool.execute(
          `DELETE FROM role_permissions
           WHERE role_id = ? AND permission_id = ?`,
          [fixture.globalRoleId, fixture.globalPermissionId],
        );

        try {
          const revoked = await sendRequest(
            authorizationBaseUrl,
            '/test/global',
            { token: accessToken },
          );
          assertSafeError(revoked, 403);
        } finally {
          await pool.execute(
            `INSERT INTO role_permissions (role_id, permission_id)
             VALUES (?, ?)`,
            [fixture.globalRoleId, fixture.globalPermissionId],
          );
        }

        const restored = await sendRequest(
          authorizationBaseUrl,
          '/test/global',
          { token: accessToken },
        );
        assert.equal(restored.response.status, 200);
      });

      await t.test('blocks password-gated routes while allowing /me', async () => {
        const passwordGated = await sendRequest(
          authorizationBaseUrl,
          '/test/password-ready',
          { token: accessToken },
        );
        assertSafeError(passwordGated, 403);

        const currentUser = await sendRequest(apiBaseUrl, '/api/auth/me', {
          token: accessToken,
        });
        assert.equal(currentUser.response.status, 200);
        assert.equal(currentUser.json.data.user.mustChangePassword, true);
      });

      await t.test('validates and safely changes the authenticated password', async () => {
        const noToken = await sendRequest(
          apiBaseUrl,
          '/api/auth/change-password',
          {
            method: 'POST',
            body: {
              currentPassword: fixture.currentPassword,
              newPassword: fixture.newPassword,
            },
          },
        );
        assertSafeError(noToken, 401);

        const wrongCurrentPassword = await sendRequest(
          apiBaseUrl,
          '/api/auth/change-password',
          {
            method: 'POST',
            token: accessToken,
            body: {
              currentPassword: `Wrong-${fixture.uniqueToken}`,
              newPassword: fixture.newPassword,
            },
          },
        );
        assertSafeError(wrongCurrentPassword, 401);

        const weakPassword = await sendRequest(
          apiBaseUrl,
          '/api/auth/change-password',
          {
            method: 'POST',
            token: accessToken,
            body: {
              currentPassword: fixture.currentPassword,
              newPassword: 'short',
            },
          },
        );
        assertSafeError(weakPassword, 400);

        const unchangedPassword = await sendRequest(
          apiBaseUrl,
          '/api/auth/change-password',
          {
            method: 'POST',
            token: accessToken,
            body: {
              currentPassword: fixture.currentPassword,
              newPassword: fixture.currentPassword,
            },
          },
        );
        assertSafeError(unchangedPassword, 400);

        const overlongPassword = await sendRequest(
          apiBaseUrl,
          '/api/auth/change-password',
          {
            method: 'POST',
            token: accessToken,
            body: {
              currentPassword: fixture.currentPassword,
              newPassword: 'x'.repeat(73),
            },
          },
        );
        assertSafeError(overlongPassword, 400);

        const passwordChange = await sendRequest(
          apiBaseUrl,
          '/api/auth/change-password',
          {
            method: 'POST',
            token: accessToken,
            headers: { 'x-request-id': fixture.requestId },
            body: {
              currentPassword: fixture.currentPassword,
              newPassword: fixture.newPassword,
            },
          },
        );
        assert.equal(passwordChange.response.status, 200);
        assert.deepEqual(passwordChange.json, {
          success: true,
          message: 'Password changed successfully',
        });

        const [storedRows] = await pool.execute(
          `SELECT password_hash, must_change_password
           FROM users
           WHERE user_id = ?`,
          [fixture.activeUserId],
        );
        assert.match(storedRows[0].password_hash, /^\$2[aby]\$/);
        assert.equal(
          bcrypt.getRounds(storedRows[0].password_hash),
          Number(process.env.BCRYPT_ROUNDS),
        );
        assert.notEqual(storedRows[0].password_hash, fixture.newPassword);
        assert.equal(
          await bcrypt.compare(
            fixture.newPassword,
            storedRows[0].password_hash,
          ),
          true,
        );
        assert.equal(storedRows[0].must_change_password, 0);

        const [auditRows] = await pool.execute(
          `SELECT action_type, before_values, after_values, request_id
           FROM audit_logs
           WHERE user_id = ? AND action_type = 'PASSWORD_CHANGED'`,
          [fixture.activeUserId],
        );
        assert.equal(auditRows.length, 1);
        assert.equal(auditRows[0].request_id, fixture.requestId);

        const serializedAudit = JSON.stringify(auditRows[0]);
        assert.equal(serializedAudit.includes(fixture.currentPassword), false);
        assert.equal(serializedAudit.includes(fixture.newPassword), false);
        assert.equal(serializedAudit.includes(accessToken), false);
        assert.equal(/\$2[aby]\$\d{2}\$/.test(serializedAudit), false);
      });

      await t.test('uses current must-change state with an already-issued token', async () => {
        const passwordGated = await sendRequest(
          authorizationBaseUrl,
          '/test/password-ready',
          { token: accessToken },
        );
        assert.equal(passwordGated.response.status, 200);

        const currentUser = await sendRequest(apiBaseUrl, '/api/auth/me', {
          token: accessToken,
        });
        assert.equal(currentUser.response.status, 200);
        assert.equal(currentUser.json.data.user.mustChangePassword, false);
      });

      await t.test('rejects the old password and accepts the new one by email', async () => {
        const oldPassword = await sendRequest(apiBaseUrl, '/api/auth/login', {
          method: 'POST',
          body: {
            identifier: fixture.username,
            password: fixture.currentPassword,
          },
        });
        assertSafeError(oldPassword, 401);

        const newPassword = await sendRequest(apiBaseUrl, '/api/auth/login', {
          method: 'POST',
          body: {
            identifier: fixture.email,
            password: fixture.newPassword,
          },
        });
        assert.equal(newPassword.response.status, 200);
        assert.equal(newPassword.json.success, true);
        assert.equal(typeof newPassword.json.data.accessToken, 'string');
        assert.equal(newPassword.json.data.user.mustChangePassword, false);
      });

      await t.test('returns a clean 429 response after repeated login attempts', async () => {
        assert.equal(LOGIN_ATTEMPT_LIMIT, 10);

        for (let attempt = 0; attempt < 2; attempt += 1) {
          const result = await sendRequest(rateLimitBaseUrl, '/api/auth/login', {
            method: 'POST',
            body: {
              identifier: `rate_limit_${fixture.uniqueToken}`,
              password: `RateLimit-${fixture.uniqueToken}`,
            },
          });
          assertSafeError(result, 401);
        }

        const rateLimitedResult = await sendRequest(
          rateLimitBaseUrl,
          '/api/auth/login',
          {
            method: 'POST',
            body: {
              identifier: `rate_limit_${fixture.uniqueToken}`,
              password: `RateLimit-${fixture.uniqueToken}`,
            },
          },
        );
        assertSafeError(rateLimitedResult, 429);

        const unaffectedHealthRoute = await sendRequest(
          rateLimitBaseUrl,
          '/api/health',
        );
        assert.equal(unaffectedHealthRoute.response.status, 200);
      });

      await t.test('handles SIGTERM and SIGINT with a clean shutdown', async () => {
        await verifyGracefulShutdown('SIGTERM');
        await verifyGracefulShutdown('SIGINT');
      });
    } finally {
      const teardownErrors = [];

      for (const server of [rateLimitServer, authorizationServer, apiServer]) {
        try {
          await stopHttpServer(server);
        } catch (error) {
          teardownErrors.push(error);
        }
      }

      try {
        await cleanupFixtures(fixture);
      } catch (error) {
        teardownErrors.push(error);
      }

      try {
        await pool.end();
      } catch (error) {
        teardownErrors.push(error);
      }

      if (teardownErrors.length > 0) {
        throw new AggregateError(teardownErrors, 'Integration-test teardown failed.');
      }
    }
  },
);
