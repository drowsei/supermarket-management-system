import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
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

const TEST_TIMEOUT_MS = 600_000;
const CHILD_TIMEOUT_MS = 30_000;
const MAX_UNSIGNED_BIGINT = '18446744073709551615';
const TEST_USER_AGENT = 'TEST_PHASE5A_CATALOG_REFERENCE/1.0';
const NEW_PERMISSION_METADATA = Object.freeze([
  {
    code: 'catalog.read',
    name: 'Read Catalog',
    description: 'View shared reference catalog configuration.',
  },
  {
    code: 'catalog.manage',
    name: 'Manage Catalog',
    description: 'Create and update shared reference catalog configuration.',
  },
  {
    code: 'products.read',
    name: 'Read Products',
    description: 'View products, variants, packages, and barcodes.',
  },
  {
    code: 'products.manage',
    name: 'Manage Products',
    description: 'Create and update products, variants, packages, and barcodes.',
  },
  {
    code: 'pricing.read',
    name: 'Read Pricing',
    description: 'View branch pricing configuration.',
  },
  {
    code: 'pricing.manage',
    name: 'Manage Pricing',
    description: 'Create and update branch pricing configuration.',
  },
  {
    code: 'suppliers.read',
    name: 'Read Suppliers',
    description: 'View suppliers and supplier catalog configuration.',
  },
  {
    code: 'suppliers.manage',
    name: 'Manage Suppliers',
    description: 'Create and update suppliers and supplier catalog configuration.',
  },
]);

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
    'Phase 5A live integration tests require the documented environment variables.',
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

function createFixtureDefinition() {
  const token = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
  const lowerToken = token.toLowerCase();

  return {
    token,
    lowerToken,
    auditPrefix: `TEST_P5A_${token}`,
    requestCounter: 0,
    requestIds: new Set(),
    failedRequestIds: new Set(),
    setupCommitted: false,
    known: {
      branchCodes: new Set([`T5AS_${token}`]),
      employeeNumbers: new Set([`T5AADM_${token}`]),
      roleCodes: new Set([
        `T5A_ADMIN_${token}`,
        `T5A_READ_${token}`,
        `T5A_MANAGE_${token}`,
      ]),
      usernames: new Set([
        `t5a.admin.${lowerToken}`,
        `t5a.must.${lowerToken}`,
        `t5a.denied.${lowerToken}`,
        `t5a.scoped.${lowerToken}`,
        `t5a.reader.${lowerToken}`,
        `t5a.manager.${lowerToken}`,
      ]),
      permissionCodes: new Set([`test.phase5a.${lowerToken}`]),
      unitCodes: new Set(),
      categoryCodes: new Set(),
      brandCodes: new Set(),
      taxCodes: new Set(),
      productCodes: new Set(),
      variantSkus: new Set(),
    },
    ids: {
      branches: new Set(),
      employees: new Set(),
      roles: new Set(),
      users: new Set(),
      userRoles: new Set(),
      permissions: new Set(),
      units: new Set(),
      categories: new Set(),
      brands: new Set(),
      taxRates: new Set(),
      products: new Set(),
      variants: new Set(),
    },
    branchCode: `T5AS_${token}`,
    employeeNumber: `T5AADM_${token}`,
    roleCodes: {
      admin: `T5A_ADMIN_${token}`,
      reader: `T5A_READ_${token}`,
      manager: `T5A_MANAGE_${token}`,
    },
    usernames: {
      admin: `t5a.admin.${lowerToken}`,
      mustChange: `t5a.must.${lowerToken}`,
      denied: `t5a.denied.${lowerToken}`,
      scoped: `t5a.scoped.${lowerToken}`,
      reader: `t5a.reader.${lowerToken}`,
      manager: `t5a.manager.${lowerToken}`,
    },
    customPermissionCode: `test.phase5a.${lowerToken}`,
    password: `Phase5A-${token}-Password!`,
  };
}

function nextRequestId(fixture, label) {
  fixture.requestCounter += 1;
  const requestId = `${fixture.auditPrefix}_${String(
    fixture.requestCounter,
  ).padStart(3, '0')}_${label}`.slice(0, 100);
  fixture.requestIds.add(requestId);
  return requestId;
}

function placeholders(values) {
  return values.map(() => '?').join(', ');
}

function assertIdString(value) {
  assert.equal(typeof value, 'string');
  assert.match(value, /^[1-9]\d*$/);
}

function rememberId(fixture, collection, value) {
  assertIdString(value);
  fixture.ids[collection].add(value);
  return value;
}

function parseJsonColumn(value) {
  if (value === null || value === undefined || typeof value === 'object') {
    return value ?? null;
  }

  return JSON.parse(value);
}

async function getLastInsertId(connection) {
  const [rows] = await connection.execute(
    'SELECT CAST(LAST_INSERT_ID() AS CHAR) AS insertedId',
  );

  return rows[0].insertedId;
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
      assert.fail(
        `Expected JSON, received: ${responseText.slice(0, 200)}`,
      );
    }
  }

  return { response, json, responseText };
}

async function sendMutation(
  fixture,
  baseUrl,
  label,
  path,
  options = {},
) {
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

function markFailedMutation(fixture, result) {
  fixture.failedRequestIds.add(result.requestId);
  return result;
}

function assertSafeError(result, statusCode) {
  assert.equal(result.response.status, statusCode);
  assert.equal(result.json?.success, false);
  assert.equal(typeof result.json?.message, 'string');

  const serialized = JSON.stringify(result.json);
  for (const forbidden of [
    'ER_DUP_ENTRY',
    'ER_CHECK_CONSTRAINT_VIOLATED',
    'sqlMessage',
    'sqlState',
    'constraint',
    'stack',
    'SELECT ',
    'INSERT ',
    'UPDATE ',
    'DELETE ',
    'passwordHash',
    'password_hash',
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
}

function assertPagination(data, expected = {}) {
  assert.ok(Array.isArray(data?.items));
  assert.ok(data?.pagination);

  for (const key of ['page', 'limit', 'totalItems', 'totalPages']) {
    assert.equal(Number.isInteger(data.pagination[key]), true);
    assert.ok(
      data.pagination[key] >= (key === 'page' || key === 'limit' ? 1 : 0),
    );
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
    fixture.password,
    fixture.adminToken,
    fixture.mustChangeToken,
    process.env.JWT_SECRET,
    process.env.DB_PASSWORD,
  ]) {
    if (secret) {
      assert.equal(serialized.includes(secret), false);
    }
  }
  assert.equal(serialized.includes('password_hash'), false);
  assert.equal(serialized.includes('passwordHash'), false);
  assert.equal(/\$2[aby]\$\d{2}\$/.test(serialized), false);
}

async function canonicalSeedSnapshot() {
  const permissionCodes = ACCESS_CONTROL_PERMISSIONS.map(({ code }) => code);
  const placeholdersForCodes = placeholders(permissionCodes);
  const [permissionRows] = await pool.execute(
    `SELECT
       CAST(permission_id AS CHAR) AS permissionId,
       permission_code AS permissionCode,
       permission_name AS permissionName,
       description
     FROM permissions
     WHERE permission_code IN (${placeholdersForCodes})
     ORDER BY permission_code`,
    permissionCodes,
  );
  const [roleRows] = await pool.execute(
    `SELECT
       CAST(role_id AS CHAR) AS roleId,
       role_code AS roleCode,
       role_name AS roleName,
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
       AND p.permission_code IN (${placeholdersForCodes})
     ORDER BY p.permission_code`,
    [roleId, ...permissionCodes],
  );

  return { permissions: permissionRows, roles: roleRows, mappings: mappingRows };
}

async function insertCustomPermission(fixture) {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    await connection.execute(
      `INSERT INTO permissions (
         permission_code,
         permission_name,
         description
       ) VALUES (?, ?, ?)`,
      [
        fixture.customPermissionCode,
        `TEST Phase 5A ${fixture.token}`,
        'Temporary unrelated permission used to verify non-destructive seeding.',
      ],
    );
    fixture.ids.permissions.add(await getLastInsertId(connection));
    await connection.commit();
    fixture.setupCommitted = true;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function createAccessFixtures(fixture) {
  const passwordHash = await bcrypt.hash(
    fixture.password,
    Number(process.env.BCRYPT_ROUNDS),
  );
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    await connection.execute(
      `INSERT INTO branches (
         branch_code, branch_name, address_line_1, city,
         country_code, currency_code, timezone, status
       ) VALUES (?, ?, ?, ?, 'NG', 'NGN', 'Africa/Lagos', 'ACTIVE')`,
      [
        fixture.branchCode,
        `TEST Phase 5A Scope ${fixture.token}`,
        '1 Phase 5A Fixture Street',
        'Lagos',
      ],
    );
    fixture.branchId = rememberId(
      fixture,
      'branches',
      await getLastInsertId(connection),
    );

    await connection.execute(
      `INSERT INTO employees (
         employee_number, first_name, last_name, email,
         hire_date, employment_status
       ) VALUES (?, 'Phase5A', 'Administrator', ?, '2020-01-01', 'ACTIVE')`,
      [
        fixture.employeeNumber,
        `phase5a-actor-${fixture.lowerToken}@example.invalid`,
      ],
    );
    fixture.adminEmployeeId = rememberId(
      fixture,
      'employees',
      await getLastInsertId(connection),
    );

    const roleDefinitions = [
      {
        key: 'admin',
        code: fixture.roleCodes.admin,
        name: `TEST Phase 5A Administrator ${fixture.token}`,
        permissions: ['catalog.read', 'catalog.manage', 'branches.read'],
      },
      {
        key: 'reader',
        code: fixture.roleCodes.reader,
        name: `TEST Phase 5A Reader ${fixture.token}`,
        permissions: ['catalog.read'],
      },
      {
        key: 'manager',
        code: fixture.roleCodes.manager,
        name: `TEST Phase 5A Manager ${fixture.token}`,
        permissions: ['catalog.manage'],
      },
    ];
    const requiredPermissionCodes = [
      'catalog.read',
      'catalog.manage',
      'branches.read',
    ];
    const [permissionRows] = await connection.execute(
      `SELECT
         CAST(permission_id AS CHAR) AS permissionId,
         permission_code AS permissionCode
       FROM permissions
       WHERE permission_code IN (${placeholders(requiredPermissionCodes)})`,
      requiredPermissionCodes,
    );
    assert.equal(permissionRows.length, requiredPermissionCodes.length);
    const permissionIdByCode = Object.fromEntries(
      permissionRows.map((row) => [row.permissionCode, row.permissionId]),
    );

    for (const roleDefinition of roleDefinitions) {
      await connection.execute(
        `INSERT INTO roles (role_code, role_name, description, is_active)
         VALUES (?, ?, 'Temporary Phase 5A integration role', 1)`,
        [roleDefinition.code, roleDefinition.name],
      );
      const roleId = rememberId(
        fixture,
        'roles',
        await getLastInsertId(connection),
      );
      fixture[`${roleDefinition.key}RoleId`] = roleId;

      for (const permissionCode of roleDefinition.permissions) {
        await connection.execute(
          `INSERT INTO role_permissions (role_id, permission_id)
           VALUES (?, ?)`,
          [roleId, permissionIdByCode[permissionCode]],
        );
      }
    }

    const userDefinitions = [
      {
        key: 'admin',
        username: fixture.usernames.admin,
        employeeId: fixture.adminEmployeeId,
        mustChange: 0,
      },
      {
        key: 'mustChange',
        username: fixture.usernames.mustChange,
        employeeId: null,
        mustChange: 1,
      },
      {
        key: 'denied',
        username: fixture.usernames.denied,
        employeeId: null,
        mustChange: 0,
      },
      {
        key: 'scoped',
        username: fixture.usernames.scoped,
        employeeId: null,
        mustChange: 0,
      },
      {
        key: 'reader',
        username: fixture.usernames.reader,
        employeeId: null,
        mustChange: 0,
      },
      {
        key: 'manager',
        username: fixture.usernames.manager,
        employeeId: null,
        mustChange: 0,
      },
    ];

    for (const userDefinition of userDefinitions) {
      await connection.execute(
        `INSERT INTO users (
           employee_id, username, email, password_hash,
           is_active, must_change_password
         ) VALUES (?, ?, ?, ?, 1, ?)`,
        [
          userDefinition.employeeId,
          userDefinition.username,
          `${userDefinition.username}@example.invalid`,
          passwordHash,
          userDefinition.mustChange,
        ],
      );
      fixture[`${userDefinition.key}UserId`] = rememberId(
        fixture,
        'users',
        await getLastInsertId(connection),
      );
    }

    const grantDefinitions = [
      [fixture.adminUserId, fixture.adminRoleId, null],
      [fixture.mustChangeUserId, fixture.adminRoleId, null],
      [fixture.scopedUserId, fixture.adminRoleId, fixture.branchId],
      [fixture.readerUserId, fixture.readerRoleId, null],
      [fixture.managerUserId, fixture.managerRoleId, null],
    ];

    for (const [userId, roleId, branchId] of grantDefinitions) {
      await connection.execute(
        `INSERT INTO user_roles (
           user_id, role_id, branch_id, assigned_by_user_id
         ) VALUES (?, ?, ?, ?)`,
        [userId, roleId, branchId, fixture.adminUserId],
      );
      fixture.ids.userRoles.add(await getLastInsertId(connection));
    }

    await connection.commit();
    fixture.setupCommitted = true;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  for (const key of [
    'admin',
    'mustChange',
    'denied',
    'scoped',
    'reader',
    'manager',
  ]) {
    fixture[`${key}Token`] = signAccessToken(
      fixture[`${key}UserId`],
    ).accessToken;
  }
}

async function createProductFixture(
  fixture,
  {
    label,
    categoryId,
    brandId = null,
    taxRateId = null,
    status = 'ACTIVE',
  },
) {
  const productCode = `T5AP_${fixture.token}_${label}`;
  fixture.known.productCodes.add(productCode);
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    await connection.execute(
      `INSERT INTO products (
         category_id, brand_id, tax_rate_id,
         product_code, product_name, description, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        categoryId,
        brandId,
        taxRateId,
        productCode,
        `TEST Phase 5A dependency ${fixture.token} ${label}`,
        'Temporary direct SQL dependency fixture; no product API is involved.',
        status,
      ],
    );
    const productId = rememberId(
      fixture,
      'products',
      await getLastInsertId(connection),
    );
    await connection.commit();
    return productId;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function createFractionalVariantFixture(
  fixture,
  { productId, unitOfMeasureId, label },
) {
  const sku = `T5AV_${fixture.token}_${label}`;
  fixture.known.variantSkus.add(sku);
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    await connection.execute(
      `INSERT INTO product_variants (
         product_id, unit_of_measure_id, sku, variant_name,
         is_fractional, default_selling_price, status
       ) VALUES (?, ?, ?, ?, 1, 0.0000, 'DISCONTINUED')`,
      [
        productId,
        unitOfMeasureId,
        sku,
        `TEST fractional dependency ${fixture.token} ${label}`,
      ],
    );
    const variantId = rememberId(
      fixture,
      'variants',
      await getLastInsertId(connection),
    );
    await connection.commit();
    return variantId;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function discoverIdsByValues(
  connection,
  { table, idColumn, valueColumn, values },
) {
  if (values.length === 0) {
    return [];
  }

  const [rows] = await connection.execute(
    `SELECT CAST(${idColumn} AS CHAR) AS id
     FROM ${table}
     WHERE ${valueColumn} IN (${placeholders(values)})`,
    values,
  );

  return rows.map((row) => row.id);
}

async function discoverFixtureIds(connection, fixture) {
  const definitions = [
    ['branches', 'branches', 'branch_id', 'branch_code', 'branchCodes'],
    ['employees', 'employees', 'employee_id', 'employee_number', 'employeeNumbers'],
    ['roles', 'roles', 'role_id', 'role_code', 'roleCodes'],
    ['users', 'users', 'user_id', 'username', 'usernames'],
    ['permissions', 'permissions', 'permission_id', 'permission_code', 'permissionCodes'],
    ['units', 'units_of_measure', 'unit_of_measure_id', 'unit_code', 'unitCodes'],
    ['categories', 'categories', 'category_id', 'category_code', 'categoryCodes'],
    ['brands', 'brands', 'brand_id', 'brand_code', 'brandCodes'],
    ['taxRates', 'tax_rates', 'tax_rate_id', 'tax_code', 'taxCodes'],
    ['products', 'products', 'product_id', 'product_code', 'productCodes'],
    ['variants', 'product_variants', 'product_variant_id', 'sku', 'variantSkus'],
  ];

  for (const [collection, table, idColumn, valueColumn, knownCollection] of definitions) {
    const discovered = await discoverIdsByValues(connection, {
      table,
      idColumn,
      valueColumn,
      values: [...fixture.known[knownCollection]],
    });
    for (const id of discovered) {
      fixture.ids[collection].add(id);
    }
  }
}

async function deleteByIds(connection, table, idColumn, values) {
  if (values.length === 0) {
    return;
  }

  await connection.execute(
    `DELETE FROM ${table}
     WHERE ${idColumn} IN (${placeholders(values)})`,
    values,
  );
}

async function deleteFixtureAudits(connection, fixture) {
  const predicates = ['request_id LIKE ?'];
  const parameters = [`${fixture.auditPrefix}%`];
  const userIds = [...fixture.ids.users];
  const employeeIds = [...fixture.ids.employees];
  const branchIds = [...fixture.ids.branches];

  if (userIds.length > 0) {
    predicates.push(`user_id IN (${placeholders(userIds)})`);
    parameters.push(...userIds);
  }
  if (employeeIds.length > 0) {
    predicates.push(`employee_id IN (${placeholders(employeeIds)})`);
    parameters.push(...employeeIds);
  }
  if (branchIds.length > 0) {
    predicates.push(`branch_id IN (${placeholders(branchIds)})`);
    parameters.push(...branchIds);
  }

  await connection.execute(
    `DELETE FROM audit_logs WHERE ${predicates.join(' OR ')}`,
    parameters,
  );
}

async function deleteFixtureUserRoles(connection, fixture) {
  const predicates = [];
  const parameters = [];
  const userIds = [...fixture.ids.users];
  const roleIds = [...fixture.ids.roles];
  const branchIds = [...fixture.ids.branches];

  for (const [column, values] of [
    ['user_id', userIds],
    ['role_id', roleIds],
    ['branch_id', branchIds],
    ['assigned_by_user_id', userIds],
  ]) {
    if (values.length > 0) {
      predicates.push(`${column} IN (${placeholders(values)})`);
      parameters.push(...values);
    }
  }

  if (predicates.length > 0) {
    await connection.execute(
      `DELETE FROM user_roles WHERE ${predicates.join(' OR ')}`,
      parameters,
    );
  }
}

async function deleteFixtureCategories(connection, fixture) {
  const pending = new Set(fixture.ids.categories);

  while (pending.size > 0) {
    const pendingIds = [...pending];
    const [leafRows] = await connection.execute(
      `SELECT CAST(c.category_id AS CHAR) AS categoryId
       FROM categories c
       WHERE c.category_id IN (${placeholders(pendingIds)})
         AND NOT EXISTS (
           SELECT 1
           FROM categories child
           WHERE child.parent_category_id = c.category_id
         )
       ORDER BY c.category_id DESC`,
      pendingIds,
    );

    if (leafRows.length === 0) {
      throw new Error(
        'Phase 5A category cleanup found a cycle or a non-fixture child dependency.',
      );
    }

    const leafIds = leafRows.map((row) => row.categoryId);
    await deleteByIds(connection, 'categories', 'category_id', leafIds);
    for (const leafId of leafIds) {
      pending.delete(leafId);
    }
  }
}

async function countByKnownValues(
  connection,
  { table, column, values },
) {
  if (values.length === 0) {
    return 0;
  }

  const [rows] = await connection.execute(
    `SELECT COUNT(*) AS count
     FROM ${table}
     WHERE ${column} IN (${placeholders(values)})`,
    values,
  );

  return Number(rows[0].count);
}

async function verifyFixtureCleanup(fixture) {
  const connection = await pool.getConnection();

  try {
    const definitions = [
      ['branchCount', 'branches', 'branch_code', 'branchCodes'],
      ['employeeCount', 'employees', 'employee_number', 'employeeNumbers'],
      ['roleCount', 'roles', 'role_code', 'roleCodes'],
      ['userCount', 'users', 'username', 'usernames'],
      ['permissionCount', 'permissions', 'permission_code', 'permissionCodes'],
      ['unitCount', 'units_of_measure', 'unit_code', 'unitCodes'],
      ['categoryCount', 'categories', 'category_code', 'categoryCodes'],
      ['brandCount', 'brands', 'brand_code', 'brandCodes'],
      ['taxRateCount', 'tax_rates', 'tax_code', 'taxCodes'],
      ['productCount', 'products', 'product_code', 'productCodes'],
      ['variantCount', 'product_variants', 'sku', 'variantSkus'],
    ];

    for (const [label, table, column, knownCollection] of definitions) {
      const count = await countByKnownValues(connection, {
        table,
        column,
        values: [...fixture.known[knownCollection]],
      });
      assert.equal(count, 0, `Phase 5A cleanup left ${label} behind.`);
    }

    const [auditRows] = await connection.execute(
      'SELECT COUNT(*) AS count FROM audit_logs WHERE request_id LIKE ?',
      [`${fixture.auditPrefix}%`],
    );
    assert.equal(Number(auditRows[0].count), 0);

    const seed = await canonicalSeedSnapshot();
    assert.equal(seed.permissions.length, 22);
    assert.equal(seed.roles.length, 1);
    assert.equal(seed.mappings.length, 22);
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
    await discoverFixtureIds(connection, fixture);
    await connection.beginTransaction();

    await deleteFixtureAudits(connection, fixture);
    await deleteByIds(
      connection,
      'product_variants',
      'product_variant_id',
      [...fixture.ids.variants],
    );
    await deleteByIds(
      connection,
      'products',
      'product_id',
      [...fixture.ids.products],
    );
    await deleteFixtureUserRoles(connection, fixture);
    await deleteByIds(
      connection,
      'role_permissions',
      'role_id',
      [...fixture.ids.roles],
    );
    await deleteByIds(
      connection,
      'users',
      'user_id',
      [...fixture.ids.users],
    );
    await deleteByIds(
      connection,
      'employee_branch_assignments',
      'employee_id',
      [...fixture.ids.employees],
    );
    await deleteByIds(
      connection,
      'employees',
      'employee_id',
      [...fixture.ids.employees],
    );
    await deleteByIds(
      connection,
      'roles',
      'role_id',
      [...fixture.ids.roles],
    );
    await deleteByIds(
      connection,
      'branches',
      'branch_id',
      [...fixture.ids.branches],
    );
    await deleteFixtureCategories(connection, fixture);
    await deleteByIds(
      connection,
      'tax_rates',
      'tax_rate_id',
      [...fixture.ids.taxRates],
    );
    await deleteByIds(
      connection,
      'brands',
      'brand_id',
      [...fixture.ids.brands],
    );
    await deleteByIds(
      connection,
      'units_of_measure',
      'unit_of_measure_id',
      [...fixture.ids.units],
    );
    await deleteByIds(
      connection,
      'permissions',
      'permission_id',
      [...fixture.ids.permissions],
    );

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  await verifyFixtureCleanup(fixture);
}

function rememberCode(fixture, collection, value) {
  const normalized = value.trim().toUpperCase();
  fixture.known[collection].add(normalized);
  return value;
}

async function expectMutationError(
  fixture,
  baseUrl,
  label,
  path,
  options,
  expectedStatus,
) {
  const result = markFailedMutation(
    fixture,
    await sendMutation(fixture, baseUrl, label, path, options),
  );
  assertSafeError(result, expectedStatus);
  return result;
}

async function queryCount(sql, parameters = []) {
  const [rows] = await pool.execute(sql, parameters);
  return Number(rows[0].count);
}

test(
  'Phase 5A reference catalog and access-control integration',
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const fixture = createFixtureDefinition();
    let apiServer;

    try {
      await t.test(
        'expands and seeds the canonical permission catalog idempotently',
        async () => {
          assert.equal(ACCESS_CONTROL_PERMISSIONS.length, 22);
          assert.equal(
            new Set(
              ACCESS_CONTROL_PERMISSIONS.map((permission) => permission.code),
            ).size,
            22,
          );

          for (const expectedPermission of NEW_PERMISSION_METADATA) {
            assert.deepEqual(
              ACCESS_CONTROL_PERMISSIONS.find(
                (permission) => permission.code === expectedPermission.code,
              ),
              expectedPermission,
            );
          }

          await insertCustomPermission(fixture);
          const firstRun = await runNodeScript(
            'scripts/seed-access-control.js',
          );
          assert.equal(firstRun.code, 0, firstRun.stderr);
          assert.equal(firstRun.signal, null);
          assert.match(firstRun.stdout, /22 canonical permissions/);
          const firstSnapshot = await canonicalSeedSnapshot();
          assert.equal(firstSnapshot.permissions.length, 22);
          assert.equal(firstSnapshot.roles.length, 1);
          assert.equal(
            firstSnapshot.roles[0].roleCode,
            SYSTEM_ADMIN_ROLE.code,
          );
          assert.equal(firstSnapshot.mappings.length, 22);

          const [customRows] = await pool.execute(
            `SELECT CAST(permission_id AS CHAR) AS permissionId
             FROM permissions
             WHERE permission_code = ?`,
            [fixture.customPermissionCode],
          );
          assert.equal(customRows.length, 1);
          fixture.ids.permissions.add(customRows[0].permissionId);

          const secondRun = await runNodeScript(
            'scripts/seed-access-control.js',
          );
          assert.equal(secondRun.code, 0, secondRun.stderr);
          assert.equal(secondRun.signal, null);
          assert.deepEqual(await canonicalSeedSnapshot(), firstSnapshot);
          assert.equal(
            await queryCount(
              'SELECT COUNT(*) AS count FROM permissions WHERE permission_code = ?',
              [fixture.customPermissionCode],
            ),
            1,
          );
          assertNoSecretMaterial({ firstRun, secondRun }, fixture);
        },
      );

      await createAccessFixtures(fixture);
      apiServer = await startHttpServer(app);
      const baseUrl = baseUrlFor(apiServer);

      await t.test(
        'protects all catalog routes with current global permissions',
        async () => {
          const protectedRoutes = [
            ['GET', '/api/admin/catalog/units'],
            ['GET', `/api/admin/catalog/units/${MAX_UNSIGNED_BIGINT}`],
            ['POST', '/api/admin/catalog/units'],
            ['PATCH', `/api/admin/catalog/units/${MAX_UNSIGNED_BIGINT}`],
            ['GET', '/api/admin/catalog/categories'],
            ['GET', `/api/admin/catalog/categories/${MAX_UNSIGNED_BIGINT}`],
            ['POST', '/api/admin/catalog/categories'],
            ['PATCH', `/api/admin/catalog/categories/${MAX_UNSIGNED_BIGINT}`],
            ['GET', '/api/admin/catalog/brands'],
            ['GET', `/api/admin/catalog/brands/${MAX_UNSIGNED_BIGINT}`],
            ['POST', '/api/admin/catalog/brands'],
            ['PATCH', `/api/admin/catalog/brands/${MAX_UNSIGNED_BIGINT}`],
            ['GET', '/api/admin/catalog/tax-rates'],
            ['GET', `/api/admin/catalog/tax-rates/${MAX_UNSIGNED_BIGINT}`],
            ['POST', '/api/admin/catalog/tax-rates'],
            ['PATCH', `/api/admin/catalog/tax-rates/${MAX_UNSIGNED_BIGINT}`],
          ];

          for (const [method, path] of protectedRoutes) {
            const result = await sendRequest(baseUrl, path, {
              method,
              ...(method === 'POST' || method === 'PATCH'
                ? { body: {} }
                : {}),
            });
            assertSafeError(result, 401);
          }

          for (const [token, method, path, expectedStatus] of [
            [fixture.mustChangeToken, 'GET', '/api/admin/catalog/units', 403],
            [fixture.mustChangeToken, 'POST', '/api/admin/catalog/units', 403],
            [fixture.deniedToken, 'GET', '/api/admin/catalog/units', 403],
            [fixture.deniedToken, 'POST', '/api/admin/catalog/units', 403],
            [fixture.readerToken, 'POST', '/api/admin/catalog/units', 403],
            [fixture.managerToken, 'GET', '/api/admin/catalog/units', 403],
            [fixture.scopedToken, 'GET', '/api/admin/catalog/units', 403],
            [fixture.scopedToken, 'POST', '/api/admin/catalog/units', 403],
          ]) {
            const result = await sendRequest(baseUrl, path, {
              token,
              method,
              ...(method === 'POST' ? { body: {} } : {}),
            });
            assertSafeError(result, expectedStatus);
          }

          const readerResult = await sendRequest(
            baseUrl,
            '/api/admin/catalog/units',
            { token: fixture.readerToken },
          );
          assert.equal(readerResult.response.status, 200);
          assertPagination(readerResult.json.data);

          const phaseFourAllowed = await sendRequest(
            baseUrl,
            '/api/admin/branches',
            { token: fixture.adminToken },
          );
          assert.equal(phaseFourAllowed.response.status, 200);

          const phaseFourDenied = await sendRequest(
            baseUrl,
            '/api/admin/branches',
            { token: fixture.managerToken },
          );
          assertSafeError(phaseFourDenied, 403);

          const authUnitCode = rememberCode(
            fixture,
            'unitCodes',
            `T5AU${fixture.token}`,
          );
          const managerWrite = await sendMutation(
            fixture,
            baseUrl,
            'GLOBAL_MANAGER_UNIT_CREATE',
            '/api/admin/catalog/units',
            {
              token: fixture.managerToken,
              method: 'POST',
              body: {
                unitCode: authUnitCode.toLowerCase(),
                unitName: `TEST ${fixture.token} manager unit`,
                symbol: `m${fixture.token.slice(0, 4)}`,
              },
            },
          );
          assert.equal(managerWrite.response.status, 201);
          fixture.authUnitId = rememberId(
            fixture,
            'units',
            managerWrite.json.data.unit.unitOfMeasureId,
          );
          assert.equal(managerWrite.json.data.unit.unitCode, authUnitCode);
          assert.equal(managerWrite.json.data.unit.allowsFraction, false);
        },
      );

      await t.test(
        'administers units of measure with strict fractional safety',
        async () => {
          const mainCode = rememberCode(
            fixture,
            'unitCodes',
            `T5UM${fixture.token}`,
          );
          const mainCreate = await sendMutation(
            fixture,
            baseUrl,
            'UNIT_MAIN_CREATE',
            '/api/admin/catalog/units',
            {
              method: 'POST',
              body: {
                unitCode: mainCode.toLowerCase(),
                unitName: `TEST ${fixture.token} Main Unit`,
                symbol: `u${fixture.token.slice(0, 5)}`,
              },
            },
          );
          assert.equal(mainCreate.response.status, 201);
          fixture.mainUnitId = rememberId(
            fixture,
            'units',
            mainCreate.json.data.unit.unitOfMeasureId,
          );
          assert.equal(mainCreate.json.data.unit.unitCode, mainCode);
          assert.equal(mainCreate.json.data.unit.allowsFraction, false);
          assert.equal(typeof mainCreate.json.data.unit.createdAt, 'string');

          const fractionalCode = rememberCode(
            fixture,
            'unitCodes',
            `T5UF${fixture.token}`,
          );
          const fractionalCreate = await sendMutation(
            fixture,
            baseUrl,
            'UNIT_FRACTIONAL_CREATE',
            '/api/admin/catalog/units',
            {
              method: 'POST',
              body: {
                unitCode: fractionalCode,
                unitName: `TEST ${fixture.token} Fractional Unit`,
                symbol: `f${fixture.token.slice(0, 5)}`,
                allowsFraction: true,
              },
            },
          );
          assert.equal(fractionalCreate.response.status, 201);
          fixture.fractionalUnitId = rememberId(
            fixture,
            'units',
            fractionalCreate.json.data.unit.unitOfMeasureId,
          );
          assert.equal(
            fractionalCreate.json.data.unit.allowsFraction,
            true,
          );

          const dependencyCode = rememberCode(
            fixture,
            'unitCodes',
            `T5UD${fixture.token}`,
          );
          const dependencyCreate = await sendMutation(
            fixture,
            baseUrl,
            'UNIT_DEPENDENCY_CREATE',
            '/api/admin/catalog/units',
            {
              method: 'POST',
              body: {
                unitCode: dependencyCode,
                unitName: `TEST ${fixture.token} Dependency Unit`,
                symbol: `d${fixture.token.slice(0, 5)}`,
                allowsFraction: true,
              },
            },
          );
          assert.equal(dependencyCreate.response.status, 201);
          fixture.dependencyUnitId = rememberId(
            fixture,
            'units',
            dependencyCreate.json.data.unit.unitOfMeasureId,
          );

          const getResult = await sendRequest(
            baseUrl,
            `/api/admin/catalog/units/${fixture.mainUnitId}`,
            { token: fixture.adminToken },
          );
          assert.equal(getResult.response.status, 200);
          assert.equal(
            getResult.json.data.unit.unitOfMeasureId,
            fixture.mainUnitId,
          );

          for (const search of [
            mainCode,
            `${fixture.token} Main Unit`,
            `u${fixture.token.slice(0, 5)}`,
          ]) {
            const list = await sendRequest(
              baseUrl,
              `/api/admin/catalog/units?search=${encodeURIComponent(search)}`,
              { token: fixture.adminToken },
            );
            assert.equal(list.response.status, 200);
            assert.ok(
              list.json.data.items.some(
                (unit) => unit.unitOfMeasureId === fixture.mainUnitId,
              ),
            );
          }

          for (const expectedValue of [true, false]) {
            const filtered = await sendRequest(
              baseUrl,
              `/api/admin/catalog/units?allowsFraction=${expectedValue}&limit=100`,
              { token: fixture.adminToken },
            );
            assert.equal(filtered.response.status, 200);
            assert.ok(
              filtered.json.data.items.every(
                (unit) => unit.allowsFraction === expectedValue,
              ),
            );
          }

          const updatedCode = rememberCode(
            fixture,
            'unitCodes',
            `T5UX${fixture.token}`,
          );
          const updateCode = await sendMutation(
            fixture,
            baseUrl,
            'UNIT_CODE_UPDATE',
            `/api/admin/catalog/units/${fixture.mainUnitId}`,
            { method: 'PATCH', body: { unitCode: updatedCode.toLowerCase() } },
          );
          assert.equal(updateCode.response.status, 200);
          assert.equal(updateCode.json.data.unit.unitCode, updatedCode);

          const updatedName = `TEST ${fixture.token} Renamed Unit`;
          const updateName = await sendMutation(
            fixture,
            baseUrl,
            'UNIT_NAME_UPDATE',
            `/api/admin/catalog/units/${fixture.mainUnitId}`,
            { method: 'PATCH', body: { unitName: updatedName } },
          );
          assert.equal(updateName.response.status, 200);
          assert.equal(updateName.json.data.unit.unitName, updatedName);

          const updatedSymbol = `z${fixture.token.slice(0, 5)}`;
          const updateSymbol = await sendMutation(
            fixture,
            baseUrl,
            'UNIT_SYMBOL_UPDATE',
            `/api/admin/catalog/units/${fixture.mainUnitId}`,
            { method: 'PATCH', body: { symbol: updatedSymbol } },
          );
          assert.equal(updateSymbol.response.status, 200);
          assert.equal(updateSymbol.json.data.unit.symbol, updatedSymbol);

          const enableFraction = await sendMutation(
            fixture,
            baseUrl,
            'UNIT_FRACTION_ENABLE',
            `/api/admin/catalog/units/${fixture.mainUnitId}`,
            { method: 'PATCH', body: { allowsFraction: true } },
          );
          assert.equal(enableFraction.response.status, 200);
          assert.equal(enableFraction.json.data.unit.allowsFraction, true);

          const disableUnusedFraction = await sendMutation(
            fixture,
            baseUrl,
            'UNIT_FRACTION_DISABLE_UNUSED',
            `/api/admin/catalog/units/${fixture.mainUnitId}`,
            { method: 'PATCH', body: { allowsFraction: false } },
          );
          assert.equal(disableUnusedFraction.response.status, 200);
          assert.equal(
            disableUnusedFraction.json.data.unit.allowsFraction,
            false,
          );

          await expectMutationError(
            fixture,
            baseUrl,
            'UNIT_DUPLICATE_CODE',
            '/api/admin/catalog/units',
            {
              method: 'POST',
              body: {
                unitCode: updatedCode,
                unitName: `TEST ${fixture.token} Unique Duplicate Code Name`,
                symbol: 'dup-code',
              },
            },
            409,
          );

          const duplicateNameCode = rememberCode(
            fixture,
            'unitCodes',
            `T5UN${fixture.token}`,
          );
          await expectMutationError(
            fixture,
            baseUrl,
            'UNIT_DUPLICATE_NAME',
            '/api/admin/catalog/units',
            {
              method: 'POST',
              body: {
                unitCode: duplicateNameCode,
                unitName: updatedName,
                symbol: 'dup-name',
              },
            },
            409,
          );

          for (const [index, field] of [
            'unitCode',
            'unitName',
            'symbol',
          ].entries()) {
            const invalidCode = rememberCode(
              fixture,
              'unitCodes',
              `T5UB${index}${fixture.token}`,
            );
            const body = {
              unitCode: invalidCode,
              unitName: `TEST ${fixture.token} Blank ${index}`,
              symbol: `b${index}`,
            };
            body[field] = '   ';
            await expectMutationError(
              fixture,
              baseUrl,
              `UNIT_BLANK_${field}`,
              '/api/admin/catalog/units',
              { method: 'POST', body },
              400,
            );
          }

          await expectMutationError(
            fixture,
            baseUrl,
            'UNIT_UNKNOWN_FIELD',
            `/api/admin/catalog/units/${fixture.mainUnitId}`,
            { method: 'PATCH', body: { createdAt: '2020-01-01' } },
            400,
          );
          await expectMutationError(
            fixture,
            baseUrl,
            'UNIT_INVALID_BOOLEAN',
            `/api/admin/catalog/units/${fixture.mainUnitId}`,
            { method: 'PATCH', body: { allowsFraction: 1 } },
            400,
          );

          for (const invalidId of ['0', '-1', '1.5', 'abc']) {
            const invalid = await sendRequest(
              baseUrl,
              `/api/admin/catalog/units/${invalidId}`,
              { token: fixture.adminToken },
            );
            assertSafeError(invalid, 400);
          }
          const missing = await sendRequest(
            baseUrl,
            `/api/admin/catalog/units/${MAX_UNSIGNED_BIGINT}`,
            { token: fixture.adminToken },
          );
          assertSafeError(missing, 404);
        },
      );

      await t.test(
        'maintains an acyclic, dependency-safe category hierarchy',
        async () => {
          const createCategory = async (
            label,
            { parentCategoryId = null, isActive = true, categoryName } = {},
          ) => {
            const categoryCode = rememberCode(
              fixture,
              'categoryCodes',
              `T5A${label}${fixture.token}`,
            );
            const result = await sendMutation(
              fixture,
              baseUrl,
              `CATEGORY_${label}_CREATE`,
              '/api/admin/catalog/categories',
              {
                method: 'POST',
                body: {
                  parentCategoryId,
                  categoryCode: categoryCode.toLowerCase(),
                  categoryName:
                    categoryName ?? `TEST ${fixture.token} Category ${label}`,
                  description: `TEST ${fixture.token} ${label} description`,
                  isActive,
                },
              },
            );
            assert.equal(result.response.status, 201);
            const category = result.json.data.category;
            rememberId(fixture, 'categories', category.categoryId);
            assert.equal(category.categoryCode, categoryCode);
            assert.equal(
              Object.hasOwn(category, 'parentScopeId'),
              false,
            );
            return category;
          };

          const rootA = await createCategory('RA');
          const rootB = await createCategory('RB');
          const child = await createCategory('CH', {
            parentCategoryId: rootA.categoryId,
          });
          const grandchild = await createCategory('GC', {
            parentCategoryId: child.categoryId,
          });
          fixture.rootCategoryId = rootA.categoryId;

          const getResult = await sendRequest(
            baseUrl,
            `/api/admin/catalog/categories/${child.categoryId}`,
            { token: fixture.adminToken },
          );
          assert.equal(getResult.response.status, 200);
          assert.equal(
            getResult.json.data.category.parentCategoryId,
            rootA.categoryId,
          );

          for (const searchValue of [
            grandchild.categoryCode,
            'Category GC',
            `${fixture.token} GC description`,
          ]) {
            const search = await sendRequest(
              baseUrl,
              `/api/admin/catalog/categories?search=${encodeURIComponent(
                searchValue,
              )}`,
              { token: fixture.adminToken },
            );
            assert.equal(search.response.status, 200);
            assert.ok(
              search.json.data.items.some(
                (category) => category.categoryId === grandchild.categoryId,
              ),
            );
          }

          const childrenOfRoot = await sendRequest(
            baseUrl,
            `/api/admin/catalog/categories?parentCategoryId=${rootA.categoryId}&limit=100`,
            { token: fixture.adminToken },
          );
          assert.equal(childrenOfRoot.response.status, 200);
          assert.ok(
            childrenOfRoot.json.data.items.every(
              (category) => category.parentCategoryId === rootA.categoryId,
            ),
          );

          const roots = await sendRequest(
            baseUrl,
            '/api/admin/catalog/categories?parentCategoryId=null&limit=100',
            { token: fixture.adminToken },
          );
          assert.equal(roots.response.status, 200);
          assert.ok(
            roots.json.data.items.every(
              (category) => category.parentCategoryId === null,
            ),
          );

          const updatedName = `TEST ${fixture.token} Renamed Child`;
          const rename = await sendMutation(
            fixture,
            baseUrl,
            'CATEGORY_NAME_UPDATE',
            `/api/admin/catalog/categories/${child.categoryId}`,
            { method: 'PATCH', body: { categoryName: updatedName } },
          );
          assert.equal(rename.response.status, 200);
          assert.equal(rename.json.data.category.categoryName, updatedName);

          const updatedDescription = `TEST ${fixture.token} updated child description`;
          const descriptionUpdate = await sendMutation(
            fixture,
            baseUrl,
            'CATEGORY_DESCRIPTION_UPDATE',
            `/api/admin/catalog/categories/${child.categoryId}`,
            { method: 'PATCH', body: { description: updatedDescription } },
          );
          assert.equal(descriptionUpdate.response.status, 200);
          assert.equal(
            descriptionUpdate.json.data.category.description,
            updatedDescription,
          );

          const reparent = await sendMutation(
            fixture,
            baseUrl,
            'CATEGORY_SAFE_REPARENT',
            `/api/admin/catalog/categories/${child.categoryId}`,
            { method: 'PATCH', body: { parentCategoryId: rootB.categoryId } },
          );
          assert.equal(reparent.response.status, 200);
          assert.equal(
            reparent.json.data.category.parentCategoryId,
            rootB.categoryId,
          );

          await expectMutationError(
            fixture,
            baseUrl,
            'CATEGORY_DUPLICATE_CODE',
            '/api/admin/catalog/categories',
            {
              method: 'POST',
              body: {
                categoryCode: rootA.categoryCode,
                categoryName: `TEST ${fixture.token} duplicate code`,
              },
            },
            409,
          );

          const duplicateNameCode = rememberCode(
            fixture,
            'categoryCodes',
            `T5ADN${fixture.token}`,
          );
          await expectMutationError(
            fixture,
            baseUrl,
            'CATEGORY_DUPLICATE_ROOT_NAME',
            '/api/admin/catalog/categories',
            {
              method: 'POST',
              body: {
                categoryCode: duplicateNameCode,
                categoryName: rootA.categoryName,
              },
            },
            409,
          );

          const sharedName = `TEST ${fixture.token} Shared Sibling Name`;
          const sharedA = await createCategory('SA', {
            parentCategoryId: rootA.categoryId,
            categoryName: sharedName,
          });
          const sharedB = await createCategory('SB', {
            parentCategoryId: rootB.categoryId,
            categoryName: sharedName,
          });
          assert.notEqual(sharedA.categoryId, sharedB.categoryId);

          const duplicateSiblingCode = rememberCode(
            fixture,
            'categoryCodes',
            `T5ADS${fixture.token}`,
          );
          await expectMutationError(
            fixture,
            baseUrl,
            'CATEGORY_DUPLICATE_SIBLING_NAME',
            '/api/admin/catalog/categories',
            {
              method: 'POST',
              body: {
                parentCategoryId: rootA.categoryId,
                categoryCode: duplicateSiblingCode,
                categoryName: sharedName,
              },
            },
            409,
          );

          const missingParentCode = rememberCode(
            fixture,
            'categoryCodes',
            `T5AMP${fixture.token}`,
          );
          await expectMutationError(
            fixture,
            baseUrl,
            'CATEGORY_MISSING_PARENT',
            '/api/admin/catalog/categories',
            {
              method: 'POST',
              body: {
                parentCategoryId: MAX_UNSIGNED_BIGINT,
                categoryCode: missingParentCode,
                categoryName: `TEST ${fixture.token} Missing Parent`,
              },
            },
            404,
          );

          await expectMutationError(
            fixture,
            baseUrl,
            'CATEGORY_DIRECT_SELF_CYCLE',
            `/api/admin/catalog/categories/${rootA.categoryId}`,
            {
              method: 'PATCH',
              body: { parentCategoryId: rootA.categoryId },
            },
            409,
          );
          await expectMutationError(
            fixture,
            baseUrl,
            'CATEGORY_DEEP_CYCLE',
            `/api/admin/catalog/categories/${rootB.categoryId}`,
            {
              method: 'PATCH',
              body: { parentCategoryId: grandchild.categoryId },
            },
            409,
          );

          const cycleOne = await createCategory('C1');
          const cycleTwo = await createCategory('C2');
          const firstCycleEdge = await sendMutation(
            fixture,
            baseUrl,
            'CATEGORY_TWO_NODE_EDGE',
            `/api/admin/catalog/categories/${cycleOne.categoryId}`,
            {
              method: 'PATCH',
              body: { parentCategoryId: cycleTwo.categoryId },
            },
          );
          assert.equal(firstCycleEdge.response.status, 200);
          await expectMutationError(
            fixture,
            baseUrl,
            'CATEGORY_TWO_NODE_CYCLE',
            `/api/admin/catalog/categories/${cycleTwo.categoryId}`,
            {
              method: 'PATCH',
              body: { parentCategoryId: cycleOne.categoryId },
            },
            409,
          );

          const inactiveParent = await createCategory('IP', {
            isActive: false,
          });
          const blockedChildCode = rememberCode(
            fixture,
            'categoryCodes',
            `T5ABC${fixture.token}`,
          );
          await expectMutationError(
            fixture,
            baseUrl,
            'CATEGORY_ACTIVE_UNDER_INACTIVE',
            '/api/admin/catalog/categories',
            {
              method: 'POST',
              body: {
                parentCategoryId: inactiveParent.categoryId,
                categoryCode: blockedChildCode,
                categoryName: `TEST ${fixture.token} Blocked Active Child`,
              },
            },
            409,
          );

          const inactiveChild = await createCategory('IC', {
            parentCategoryId: inactiveParent.categoryId,
            isActive: false,
          });
          await expectMutationError(
            fixture,
            baseUrl,
            'CATEGORY_ACTIVATE_UNDER_INACTIVE',
            `/api/admin/catalog/categories/${inactiveChild.categoryId}`,
            { method: 'PATCH', body: { isActive: true } },
            409,
          );

          const safeLeaf = await createCategory('SL');
          const safeDeactivate = await sendMutation(
            fixture,
            baseUrl,
            'CATEGORY_SAFE_DEACTIVATE',
            `/api/admin/catalog/categories/${safeLeaf.categoryId}`,
            { method: 'PATCH', body: { isActive: false } },
          );
          assert.equal(safeDeactivate.response.status, 200);
          assert.equal(safeDeactivate.json.data.category.isActive, false);

          const activeDependencyRoot = await createCategory('AD');
          const activeDependencyChild = await createCategory('AC', {
            parentCategoryId: activeDependencyRoot.categoryId,
          });
          await expectMutationError(
            fixture,
            baseUrl,
            'CATEGORY_ACTIVE_DESCENDANT_BLOCK',
            `/api/admin/catalog/categories/${activeDependencyRoot.categoryId}`,
            { method: 'PATCH', body: { isActive: false } },
            409,
          );
          const activeChildAfterFailure = await sendRequest(
            baseUrl,
            `/api/admin/catalog/categories/${activeDependencyChild.categoryId}`,
            { token: fixture.adminToken },
          );
          assert.equal(
            activeChildAfterFailure.json.data.category.isActive,
            true,
          );

          const productDependencyRoot = await createCategory('PD');
          const productDependencyLeaf = await createCategory('PL', {
            parentCategoryId: productDependencyRoot.categoryId,
            isActive: false,
          });
          fixture.productDependencyCategoryRootId =
            productDependencyRoot.categoryId;
          fixture.productDependencyCategoryLeafId =
            productDependencyLeaf.categoryId;

          const concurrentA = await createCategory('XA');
          const concurrentB = await createCategory('XB');
          const concurrentResults = await Promise.all([
            sendMutation(
              fixture,
              baseUrl,
              'CATEGORY_CONCURRENT_A_TO_B',
              `/api/admin/catalog/categories/${concurrentA.categoryId}`,
              {
                method: 'PATCH',
                body: { parentCategoryId: concurrentB.categoryId },
              },
            ),
            sendMutation(
              fixture,
              baseUrl,
              'CATEGORY_CONCURRENT_B_TO_A',
              `/api/admin/catalog/categories/${concurrentB.categoryId}`,
              {
                method: 'PATCH',
                body: { parentCategoryId: concurrentA.categoryId },
              },
            ),
          ]);
          assert.deepEqual(
            concurrentResults
              .map((result) => result.response.status)
              .sort((left, right) => left - right),
            [200, 409],
          );
          for (const result of concurrentResults) {
            if (result.response.status === 409) {
              fixture.failedRequestIds.add(result.requestId);
              assertSafeError(result, 409);
            }
          }

          const [concurrentRows] = await pool.execute(
            `SELECT
               CAST(category_id AS CHAR) AS categoryId,
               CAST(parent_category_id AS CHAR) AS parentCategoryId
             FROM categories
             WHERE category_id IN (?, ?)
             ORDER BY category_id`,
            [concurrentA.categoryId, concurrentB.categoryId],
          );
          assert.equal(concurrentRows.length, 2);
          assert.equal(
            concurrentRows.every(
              (row) => row.parentCategoryId !== row.categoryId,
            ),
            true,
          );
          assert.equal(
            concurrentRows[0].parentCategoryId === concurrentRows[1].categoryId &&
              concurrentRows[1].parentCategoryId === concurrentRows[0].categoryId,
            false,
          );

          const inactiveFilter = await sendRequest(
            baseUrl,
            '/api/admin/catalog/categories?isActive=false&limit=100',
            { token: fixture.adminToken },
          );
          assert.equal(inactiveFilter.response.status, 200);
          assert.ok(
            inactiveFilter.json.data.items.every(
              (category) => category.isActive === false,
            ),
          );
        },
      );

      await t.test(
        'administers brand lifecycle without changing dependent products',
        async () => {
          const createBrand = async (label, { isActive = true } = {}) => {
            const brandCode = rememberCode(
              fixture,
              'brandCodes',
              `T5AB${label}${fixture.token}`,
            );
            const result = await sendMutation(
              fixture,
              baseUrl,
              `BRAND_${label}_CREATE`,
              '/api/admin/catalog/brands',
              {
                method: 'POST',
                body: {
                  brandCode: brandCode.toLowerCase(),
                  brandName: `TEST ${fixture.token} Brand ${label}`,
                  description: `TEST ${fixture.token} ${label} brand description`,
                  isActive,
                },
              },
            );
            assert.equal(result.response.status, 201);
            const brand = result.json.data.brand;
            rememberId(fixture, 'brands', brand.brandId);
            assert.equal(brand.brandCode, brandCode);
            return brand;
          };

          const mainBrand = await createBrand('MAIN');
          const dependencyBrand = await createBrand('DEP');
          const unusedBrand = await createBrand('UNUSED');
          fixture.dependencyBrandId = dependencyBrand.brandId;

          const getResult = await sendRequest(
            baseUrl,
            `/api/admin/catalog/brands/${mainBrand.brandId}`,
            { token: fixture.adminToken },
          );
          assert.equal(getResult.response.status, 200);
          assert.equal(getResult.json.data.brand.brandId, mainBrand.brandId);

          for (const searchValue of [
            mainBrand.brandCode,
            'Brand MAIN',
            `${fixture.token} MAIN brand description`,
          ]) {
            const search = await sendRequest(
              baseUrl,
              `/api/admin/catalog/brands?search=${encodeURIComponent(
                searchValue,
              )}`,
              { token: fixture.adminToken },
            );
            assert.equal(search.response.status, 200);
            assert.ok(
              search.json.data.items.some(
                (brand) => brand.brandId === mainBrand.brandId,
              ),
            );
          }

          const updatedCode = rememberCode(
            fixture,
            'brandCodes',
            `T5ABNEW${fixture.token}`,
          );
          const updatedName = `TEST ${fixture.token} Renamed Brand`;
          const updatedDescription = `TEST ${fixture.token} updated brand description`;
          const update = await sendMutation(
            fixture,
            baseUrl,
            'BRAND_UPDATE',
            `/api/admin/catalog/brands/${mainBrand.brandId}`,
            {
              method: 'PATCH',
              body: {
                brandCode: updatedCode.toLowerCase(),
                brandName: updatedName,
                description: updatedDescription,
              },
            },
          );
          assert.equal(update.response.status, 200);
          assert.equal(update.json.data.brand.brandCode, updatedCode);
          assert.equal(update.json.data.brand.brandName, updatedName);
          assert.equal(
            update.json.data.brand.description,
            updatedDescription,
          );

          const deactivate = await sendMutation(
            fixture,
            baseUrl,
            'BRAND_UNUSED_DEACTIVATE',
            `/api/admin/catalog/brands/${unusedBrand.brandId}`,
            { method: 'PATCH', body: { isActive: false } },
          );
          assert.equal(deactivate.response.status, 200);
          assert.equal(deactivate.json.data.brand.isActive, false);

          const inactiveFilter = await sendRequest(
            baseUrl,
            '/api/admin/catalog/brands?isActive=false&limit=100',
            { token: fixture.adminToken },
          );
          assert.equal(inactiveFilter.response.status, 200);
          assert.ok(
            inactiveFilter.json.data.items.every(
              (brand) => brand.isActive === false,
            ),
          );
          assert.ok(
            inactiveFilter.json.data.items.some(
              (brand) => brand.brandId === unusedBrand.brandId,
            ),
          );

          const reactivate = await sendMutation(
            fixture,
            baseUrl,
            'BRAND_UNUSED_REACTIVATE',
            `/api/admin/catalog/brands/${unusedBrand.brandId}`,
            { method: 'PATCH', body: { isActive: true } },
          );
          assert.equal(reactivate.response.status, 200);
          assert.equal(reactivate.json.data.brand.isActive, true);

          await expectMutationError(
            fixture,
            baseUrl,
            'BRAND_DUPLICATE_CODE',
            '/api/admin/catalog/brands',
            {
              method: 'POST',
              body: {
                brandCode: updatedCode,
                brandName: `TEST ${fixture.token} Duplicate Brand Code`,
              },
            },
            409,
          );

          const duplicateNameCode = rememberCode(
            fixture,
            'brandCodes',
            `T5ABDN${fixture.token}`,
          );
          await expectMutationError(
            fixture,
            baseUrl,
            'BRAND_DUPLICATE_NAME',
            '/api/admin/catalog/brands',
            {
              method: 'POST',
              body: {
                brandCode: duplicateNameCode,
                brandName: updatedName,
              },
            },
            409,
          );

          await expectMutationError(
            fixture,
            baseUrl,
            'BRAND_UNKNOWN_FIELD',
            `/api/admin/catalog/brands/${mainBrand.brandId}`,
            { method: 'PATCH', body: { brandId: mainBrand.brandId } },
            400,
          );
          await expectMutationError(
            fixture,
            baseUrl,
            'BRAND_INVALID_BOOLEAN',
            `/api/admin/catalog/brands/${mainBrand.brandId}`,
            { method: 'PATCH', body: { isActive: 'false' } },
            400,
          );
          const blankBrandCode = rememberCode(
            fixture,
            'brandCodes',
            `T5ABBL${fixture.token}`,
          );
          await expectMutationError(
            fixture,
            baseUrl,
            'BRAND_BLANK_NAME',
            '/api/admin/catalog/brands',
            {
              method: 'POST',
              body: { brandCode: blankBrandCode, brandName: '   ' },
            },
            400,
          );
        },
      );

      await t.test(
        'administers tax rates with exact decimal-string behavior',
        async () => {
          const createTaxRate = async (
            label,
            { ratePercent, isInclusive, isActive = true, taxName } = {},
          ) => {
            const taxCode = rememberCode(
              fixture,
              'taxCodes',
              `T5AT${label}${fixture.token}`,
            );
            const body = {
              taxCode: taxCode.toLowerCase(),
              taxName: taxName ?? `TEST ${fixture.token} Tax ${label}`,
              isActive,
            };
            if (ratePercent !== undefined) body.ratePercent = ratePercent;
            if (isInclusive !== undefined) body.isInclusive = isInclusive;

            const result = await sendMutation(
              fixture,
              baseUrl,
              `TAX_${label}_CREATE`,
              '/api/admin/catalog/tax-rates',
              { method: 'POST', body },
            );
            assert.equal(result.response.status, 201);
            const taxRate = result.json.data.taxRate;
            rememberId(fixture, 'taxRates', taxRate.taxRateId);
            assert.equal(taxRate.taxCode, taxCode);
            assert.equal(typeof taxRate.ratePercent, 'string');
            return taxRate;
          };

          const defaultTax = await createTaxRate('ZERO');
          assert.equal(defaultTax.ratePercent, '0.0000');
          assert.equal(defaultTax.isInclusive, false);
          assert.equal(defaultTax.isActive, true);

          const configuredTax = await createTaxRate('MAIN', {
            ratePercent: '7.5',
            isInclusive: true,
          });
          assert.equal(configuredTax.ratePercent, '7.5000');
          assert.equal(configuredTax.isInclusive, true);

          const dependencyTax = await createTaxRate('DEP', {
            ratePercent: '5.0000',
          });
          fixture.dependencyTaxRateId = dependencyTax.taxRateId;
          const unusedTax = await createTaxRate('UNUSED', {
            ratePercent: '2.5000',
          });
          await createTaxRate('INACTIVE', {
            ratePercent: '0',
            isActive: false,
          });

          const getResult = await sendRequest(
            baseUrl,
            `/api/admin/catalog/tax-rates/${configuredTax.taxRateId}`,
            { token: fixture.adminToken },
          );
          assert.equal(getResult.response.status, 200);
          assert.equal(
            getResult.json.data.taxRate.taxRateId,
            configuredTax.taxRateId,
          );

          for (const searchValue of [
            configuredTax.taxCode,
            `Tax MAIN`,
          ]) {
            const search = await sendRequest(
              baseUrl,
              `/api/admin/catalog/tax-rates?search=${encodeURIComponent(
                searchValue,
              )}`,
              { token: fixture.adminToken },
            );
            assert.equal(search.response.status, 200);
            assert.ok(
              search.json.data.items.some(
                (taxRate) => taxRate.taxRateId === configuredTax.taxRateId,
              ),
            );
          }

          for (const [filterName, filterValue] of [
            ['isActive', true],
            ['isActive', false],
            ['isInclusive', true],
            ['isInclusive', false],
          ]) {
            const filtered = await sendRequest(
              baseUrl,
              `/api/admin/catalog/tax-rates?${filterName}=${filterValue}&limit=100`,
              { token: fixture.adminToken },
            );
            assert.equal(filtered.response.status, 200);
            assert.ok(filtered.json.data.items.length > 0);
            assert.ok(
              filtered.json.data.items.every(
                (taxRate) => taxRate[filterName] === filterValue,
              ),
            );
          }

          const renamedTax = `TEST ${fixture.token} Renamed Tax`;
          const rename = await sendMutation(
            fixture,
            baseUrl,
            'TAX_NAME_UPDATE',
            `/api/admin/catalog/tax-rates/${defaultTax.taxRateId}`,
            { method: 'PATCH', body: { taxName: renamedTax } },
          );
          assert.equal(rename.response.status, 200);
          assert.equal(rename.json.data.taxRate.taxName, renamedTax);

          for (const [label, input, expected] of [
            ['FOUR_DECIMAL', '7.1234', '7.1234'],
            ['ZERO', '0', '0.0000'],
            ['HUNDRED', '100.0000', '100.0000'],
          ]) {
            const update = await sendMutation(
              fixture,
              baseUrl,
              `TAX_RATE_${label}`,
              `/api/admin/catalog/tax-rates/${defaultTax.taxRateId}`,
              { method: 'PATCH', body: { ratePercent: input } },
            );
            assert.equal(update.response.status, 200);
            assert.equal(update.json.data.taxRate.ratePercent, expected);
          }

          const inclusiveUpdate = await sendMutation(
            fixture,
            baseUrl,
            'TAX_INCLUSIVE_UPDATE',
            `/api/admin/catalog/tax-rates/${defaultTax.taxRateId}`,
            { method: 'PATCH', body: { isInclusive: true } },
          );
          assert.equal(inclusiveUpdate.response.status, 200);
          assert.equal(inclusiveUpdate.json.data.taxRate.isInclusive, true);

          const invalidRates = [
            ['NEGATIVE', '-0.0001'],
            ['OVER_100', '100.0001'],
            ['MALFORMED', 'NaN'],
            ['INFINITY', 'Infinity'],
            ['SCIENTIFIC', '1e2'],
            ['PRECISION', '1.23456'],
            ['NUMBER', 7.5],
          ];
          for (const [label, ratePercent] of invalidRates) {
            await expectMutationError(
              fixture,
              baseUrl,
              `TAX_INVALID_${label}`,
              `/api/admin/catalog/tax-rates/${defaultTax.taxRateId}`,
              { method: 'PATCH', body: { ratePercent } },
              400,
            );
          }

          for (const [label, field, value] of [
            ['INCLUSIVE', 'isInclusive', 1],
            ['ACTIVE', 'isActive', 'false'],
          ]) {
            await expectMutationError(
              fixture,
              baseUrl,
              `TAX_INVALID_BOOLEAN_${label}`,
              `/api/admin/catalog/tax-rates/${defaultTax.taxRateId}`,
              { method: 'PATCH', body: { [field]: value } },
              400,
            );
          }

          await expectMutationError(
            fixture,
            baseUrl,
            'TAX_DUPLICATE_CODE',
            '/api/admin/catalog/tax-rates',
            {
              method: 'POST',
              body: {
                taxCode: configuredTax.taxCode,
                taxName: `TEST ${fixture.token} Duplicate Tax Code`,
              },
            },
            409,
          );

          const duplicateNameCode = rememberCode(
            fixture,
            'taxCodes',
            `T5ATDN${fixture.token}`,
          );
          const duplicateName = await sendMutation(
            fixture,
            baseUrl,
            'TAX_DUPLICATE_NAME_ALLOWED',
            '/api/admin/catalog/tax-rates',
            {
              method: 'POST',
              body: {
                taxCode: duplicateNameCode,
                taxName: configuredTax.taxName,
              },
            },
          );
          assert.equal(duplicateName.response.status, 201);
          rememberId(
            fixture,
            'taxRates',
            duplicateName.json.data.taxRate.taxRateId,
          );

          const deactivate = await sendMutation(
            fixture,
            baseUrl,
            'TAX_UNUSED_DEACTIVATE',
            `/api/admin/catalog/tax-rates/${unusedTax.taxRateId}`,
            { method: 'PATCH', body: { isActive: false } },
          );
          assert.equal(deactivate.response.status, 200);
          assert.equal(deactivate.json.data.taxRate.isActive, false);
          const reactivate = await sendMutation(
            fixture,
            baseUrl,
            'TAX_UNUSED_REACTIVATE',
            `/api/admin/catalog/tax-rates/${unusedTax.taxRateId}`,
            { method: 'PATCH', body: { isActive: true } },
          );
          assert.equal(reactivate.response.status, 200);
          assert.equal(reactivate.json.data.taxRate.isActive, true);

          const blankTaxCode = rememberCode(
            fixture,
            'taxCodes',
            `T5ATBL${fixture.token}`,
          );
          await expectMutationError(
            fixture,
            baseUrl,
            'TAX_BLANK_NAME',
            '/api/admin/catalog/tax-rates',
            {
              method: 'POST',
              body: { taxCode: blankTaxCode, taxName: '   ' },
            },
            400,
          );
          await expectMutationError(
            fixture,
            baseUrl,
            'TAX_UNKNOWN_FIELD',
            `/api/admin/catalog/tax-rates/${defaultTax.taxRateId}`,
            { method: 'PATCH', body: { updatedAt: '2020-01-01' } },
            400,
          );
        },
      );

      await t.test(
        'blocks reference deactivation when active catalog dependencies exist',
        async () => {
          const productId = await createProductFixture(fixture, {
            label: 'DEPENDENCY',
            categoryId: fixture.productDependencyCategoryLeafId,
            brandId: fixture.dependencyBrandId,
            taxRateId: fixture.dependencyTaxRateId,
            status: 'ACTIVE',
          });
          const variantId = await createFractionalVariantFixture(fixture, {
            productId,
            unitOfMeasureId: fixture.dependencyUnitId,
            label: 'DEPENDENCY',
          });

          const [beforeProductRows] = await pool.execute(
            `SELECT
               CAST(product_id AS CHAR) AS productId,
               CAST(category_id AS CHAR) AS categoryId,
               CAST(brand_id AS CHAR) AS brandId,
               CAST(tax_rate_id AS CHAR) AS taxRateId,
               status
             FROM products
             WHERE product_id = ?`,
            [productId],
          );
          const beforeProduct = beforeProductRows[0];

          await expectMutationError(
            fixture,
            baseUrl,
            'UNIT_FRACTIONAL_DEPENDENCY_BLOCK',
            `/api/admin/catalog/units/${fixture.dependencyUnitId}`,
            { method: 'PATCH', body: { allowsFraction: false } },
            409,
          );
          await expectMutationError(
            fixture,
            baseUrl,
            'BRAND_ACTIVE_PRODUCT_BLOCK',
            `/api/admin/catalog/brands/${fixture.dependencyBrandId}`,
            { method: 'PATCH', body: { isActive: false } },
            409,
          );
          await expectMutationError(
            fixture,
            baseUrl,
            'TAX_ACTIVE_PRODUCT_BLOCK',
            `/api/admin/catalog/tax-rates/${fixture.dependencyTaxRateId}`,
            { method: 'PATCH', body: { isActive: false } },
            409,
          );
          await expectMutationError(
            fixture,
            baseUrl,
            'CATEGORY_SUBTREE_PRODUCT_BLOCK',
            `/api/admin/catalog/categories/${fixture.productDependencyCategoryRootId}`,
            { method: 'PATCH', body: { isActive: false } },
            409,
          );

          const [unitRows] = await pool.execute(
            `SELECT allows_fraction AS allowsFraction
             FROM units_of_measure
             WHERE unit_of_measure_id = ?`,
            [fixture.dependencyUnitId],
          );
          assert.equal(Number(unitRows[0].allowsFraction), 1);

          const [brandRows] = await pool.execute(
            'SELECT is_active AS isActive FROM brands WHERE brand_id = ?',
            [fixture.dependencyBrandId],
          );
          assert.equal(Number(brandRows[0].isActive), 1);

          const [taxRows] = await pool.execute(
            'SELECT is_active AS isActive FROM tax_rates WHERE tax_rate_id = ?',
            [fixture.dependencyTaxRateId],
          );
          assert.equal(Number(taxRows[0].isActive), 1);

          const [categoryRows] = await pool.execute(
            'SELECT is_active AS isActive FROM categories WHERE category_id = ?',
            [fixture.productDependencyCategoryRootId],
          );
          assert.equal(Number(categoryRows[0].isActive), 1);

          const [afterProductRows] = await pool.execute(
            `SELECT
               CAST(product_id AS CHAR) AS productId,
               CAST(category_id AS CHAR) AS categoryId,
               CAST(brand_id AS CHAR) AS brandId,
               CAST(tax_rate_id AS CHAR) AS taxRateId,
               status
             FROM products
             WHERE product_id = ?`,
            [productId],
          );
          assert.deepEqual(afterProductRows[0], beforeProduct);

          const [variantRows] = await pool.execute(
            `SELECT
               CAST(product_variant_id AS CHAR) AS productVariantId,
               is_fractional AS isFractional,
               status
             FROM product_variants
             WHERE product_variant_id = ?`,
            [variantId],
          );
          assert.equal(variantRows[0].productVariantId, variantId);
          assert.equal(Number(variantRows[0].isFractional), 1);
          assert.equal(variantRows[0].status, 'DISCONTINUED');
        },
      );

      await t.test(
        'uses bounded pagination, strict validation, and no DELETE routes',
        async () => {
          const collections = [
            {
              path: '/api/admin/catalog/units',
              id: fixture.mainUnitId,
              missingLabel: 'UNIT',
              idField: 'unitOfMeasureId',
              countSql: `SELECT COUNT(*) AS count
                         FROM units_of_measure
                         WHERE LOCATE(?, CONCAT_WS(' ', unit_code, unit_name, symbol)) > 0`,
            },
            {
              path: '/api/admin/catalog/categories',
              id: fixture.rootCategoryId,
              missingLabel: 'CATEGORY',
              idField: 'categoryId',
              countSql: `SELECT COUNT(*) AS count
                         FROM categories
                         WHERE LOCATE(?, CONCAT_WS(' ', category_code, category_name, description)) > 0`,
            },
            {
              path: '/api/admin/catalog/brands',
              id: fixture.dependencyBrandId,
              missingLabel: 'BRAND',
              idField: 'brandId',
              countSql: `SELECT COUNT(*) AS count
                         FROM brands
                         WHERE LOCATE(?, CONCAT_WS(' ', brand_code, brand_name, description)) > 0`,
            },
            {
              path: '/api/admin/catalog/tax-rates',
              id: fixture.dependencyTaxRateId,
              missingLabel: 'TAX_RATE',
              idField: 'taxRateId',
              countSql: `SELECT COUNT(*) AS count
                         FROM tax_rates
                         WHERE LOCATE(?, CONCAT_WS(' ', tax_code, tax_name)) > 0`,
            },
          ];

          for (const collection of collections) {
            const defaultList = await sendRequest(baseUrl, collection.path, {
              token: fixture.adminToken,
            });
            assert.equal(defaultList.response.status, 200);
            assertPagination(defaultList.json.data, { page: 1, limit: 20 });
            const repeatedDefaultList = await sendRequest(
              baseUrl,
              collection.path,
              { token: fixture.adminToken },
            );
            assert.equal(repeatedDefaultList.response.status, 200);
            assert.deepEqual(
              repeatedDefaultList.json.data,
              defaultList.json.data,
              'An unchanged collection query must have deterministic ordering.',
            );

            const matchingCount = await queryCount(collection.countSql, [
              fixture.token,
            ]);
            const firstPage = await sendRequest(
              baseUrl,
              `${collection.path}?search=${fixture.token}&page=1&limit=2`,
              { token: fixture.adminToken },
            );
            assert.equal(firstPage.response.status, 200);
            assertPagination(firstPage.json.data, {
              page: 1,
              limit: 2,
              totalItems: matchingCount,
            });
            const secondPage = await sendRequest(
              baseUrl,
              `${collection.path}?search=${fixture.token}&page=2&limit=2`,
              { token: fixture.adminToken },
            );
            assert.equal(secondPage.response.status, 200);
            assertPagination(secondPage.json.data, {
              page: 2,
              limit: 2,
              totalItems: matchingCount,
            });
            const firstPageIds = new Set(
              firstPage.json.data.items.map(
                (item) => item[collection.idField],
              ),
            );
            assert.equal(
              secondPage.json.data.items.some((item) =>
                firstPageIds.has(item[collection.idField]),
              ),
              false,
            );

            const maximumLimit = await sendRequest(
              baseUrl,
              `${collection.path}?search=${fixture.token}&limit=100`,
              { token: fixture.adminToken },
            );
            assert.equal(maximumLimit.response.status, 200);
            assertPagination(maximumLimit.json.data, {
              page: 1,
              limit: 100,
              totalItems: matchingCount,
            });
            assert.equal(maximumLimit.json.data.items.length, matchingCount);

            for (const [field, value] of [
              ['page', '0'],
              ['page', '1.5'],
              ['page', 'abc'],
              ['limit', '0'],
              ['limit', '101'],
            ]) {
              const invalidPagination = await sendRequest(
                baseUrl,
                `${collection.path}?${field}=${value}`,
                { token: fixture.adminToken },
              );
              assertSafeError(invalidPagination, 400);
            }

            const unknownQuery = await sendRequest(
              baseUrl,
              `${collection.path}?unsupported=true`,
              { token: fixture.adminToken },
            );
            assertSafeError(unknownQuery, 400);

            for (const invalidId of ['0', '-1', '1.5', 'abc']) {
              const invalid = await sendRequest(
                baseUrl,
                `${collection.path}/${invalidId}`,
                { token: fixture.adminToken },
              );
              assertSafeError(invalid, 400);
            }

            const missing = await sendRequest(
              baseUrl,
              `${collection.path}/${MAX_UNSIGNED_BIGINT}`,
              { token: fixture.adminToken },
            );
            assertSafeError(missing, 404);

            await expectMutationError(
              fixture,
              baseUrl,
              `${collection.missingLabel}_EMPTY_PATCH`,
              `${collection.path}/${collection.id}`,
              { method: 'PATCH', body: {} },
              400,
            );

            const deleteResult = await sendRequest(
              baseUrl,
              `${collection.path}/${collection.id}`,
              { token: fixture.adminToken, method: 'DELETE' },
            );
            assertSafeError(deleteResult, 404);
            assert.equal(deleteResult.json.message, 'Route not found');
          }

          const invalidParentFilter = await sendRequest(
            baseUrl,
            '/api/admin/catalog/categories?parentCategoryId=1.5',
            { token: fixture.adminToken },
          );
          assertSafeError(invalidParentFilter, 400);

          await expectMutationError(
            fixture,
            baseUrl,
            'CATEGORY_UNKNOWN_FIELD',
            `/api/admin/catalog/categories/${fixture.rootCategoryId}`,
            { method: 'PATCH', body: { updatedAt: '2020-01-01' } },
            400,
          );
          await expectMutationError(
            fixture,
            baseUrl,
            'CATEGORY_INVALID_BOOLEAN',
            `/api/admin/catalog/categories/${fixture.rootCategoryId}`,
            { method: 'PATCH', body: { isActive: 1 } },
            400,
          );
          await expectMutationError(
            fixture,
            baseUrl,
            'CATEGORY_BLANK_DESCRIPTION',
            `/api/admin/catalog/categories/${fixture.rootCategoryId}`,
            { method: 'PATCH', body: { description: '   ' } },
            400,
          );
          await expectMutationError(
            fixture,
            baseUrl,
            'BRAND_BLANK_DESCRIPTION',
            `/api/admin/catalog/brands/${fixture.dependencyBrandId}`,
            { method: 'PATCH', body: { description: '   ' } },
            400,
          );
        },
      );

      await t.test(
        'writes safe, actor-aware audit snapshots in the mutation transaction',
        async () => {
          const [rows] = await pool.execute(
            `SELECT
               CAST(audit_log_id AS CHAR) AS auditLogId,
               CAST(user_id AS CHAR) AS userId,
               CAST(employee_id AS CHAR) AS employeeId,
               CAST(branch_id AS CHAR) AS branchId,
               action_type AS actionType,
               entity_type AS entityType,
               entity_record_id AS entityRecordId,
               occurred_at AS occurredAt,
               before_values AS beforeValues,
               after_values AS afterValues,
               ip_address AS ipAddress,
               user_agent AS userAgent,
               request_id AS requestId,
               notes
             FROM audit_logs
             WHERE request_id LIKE ?
             ORDER BY audit_log_id`,
            [`${fixture.auditPrefix}%`],
          );
          const auditRows = rows.map((row) => ({
            ...row,
            beforeValues: parseJsonColumn(row.beforeValues),
            afterValues: parseJsonColumn(row.afterValues),
          }));
          const successfulRequestIds = [...fixture.requestIds].filter(
            (requestId) => !fixture.failedRequestIds.has(requestId),
          );

          assert.equal(auditRows.length, successfulRequestIds.length);
          assert.deepEqual(
            [...new Set(auditRows.map((row) => row.requestId))].sort(),
            successfulRequestIds.sort(),
          );

          const expectedActionTypes = [
            'UNIT_OF_MEASURE_CREATED',
            'UNIT_OF_MEASURE_UPDATED',
            'CATEGORY_CREATED',
            'CATEGORY_UPDATED',
            'BRAND_CREATED',
            'BRAND_UPDATED',
            'TAX_RATE_CREATED',
            'TAX_RATE_UPDATED',
          ];
          assert.deepEqual(
            [...new Set(auditRows.map((row) => row.actionType))].sort(),
            expectedActionTypes.sort(),
          );

          for (const row of auditRows) {
            assertIdString(row.auditLogId);
            assertIdString(row.userId);
            assertIdString(row.entityRecordId);
            assert.equal(row.branchId, null);
            assert.equal(typeof row.occurredAt?.toISOString, 'function');
            assert.equal(typeof row.ipAddress, 'string');
            assert.ok(row.ipAddress.length > 0);
            assert.equal(row.userAgent, TEST_USER_AGENT);
            assert.equal(typeof row.notes, 'string');
            assert.ok(row.notes.length > 0);
            assert.equal(typeof row.afterValues, 'object');

            if (row.actionType.endsWith('_CREATED')) {
              assert.equal(row.beforeValues, null);
            } else {
              assert.equal(typeof row.beforeValues, 'object');
              assert.notDeepEqual(row.beforeValues, row.afterValues);
            }
          }

          const managerCreateAudit = auditRows.find((row) =>
            row.requestId.endsWith('_GLOBAL_MANAGER_UNIT_CREATE'),
          );
          assert.ok(managerCreateAudit);
          assert.equal(managerCreateAudit.userId, fixture.managerUserId);
          assert.equal(managerCreateAudit.employeeId, null);

          for (const row of auditRows.filter(
            (candidate) => candidate.requestId !== managerCreateAudit.requestId,
          )) {
            assert.equal(row.userId, fixture.adminUserId);
            assert.equal(row.employeeId, fixture.adminEmployeeId);
          }

          for (const requestId of fixture.failedRequestIds) {
            assert.equal(
              auditRows.some((row) => row.requestId === requestId),
              false,
              `Failed mutation ${requestId} must not leave an audit row.`,
            );
          }

          assertNoSecretMaterial(auditRows, fixture);
        },
      );
    } finally {
      const cleanupErrors = [];

      try {
        await stopHttpServer(apiServer);
      } catch (error) {
        cleanupErrors.push(error);
      }

      try {
        await cleanupFixtures(fixture);
      } catch (error) {
        cleanupErrors.push(error);
      }

      try {
        await pool.end();
      } catch (error) {
        cleanupErrors.push(error);
      }

      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          cleanupErrors,
          'Phase 5A integration cleanup failed.',
        );
      }
    }
  },
);
