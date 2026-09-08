import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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

const TEST_TIMEOUT_MS = 900_000;
const MAX_UNSIGNED_BIGINT = '18446744073709551615';
const TEST_USER_AGENT = 'TEST_PHASE5B_PRODUCT_CATALOG/1.0';

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
    'Phase 5B live integration tests require the documented environment variables.',
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
    auditPrefix: `TEST_P5B_${token}`,
    requestCounter: 0,
    requestIds: new Set(),
    expectedAuditActions: new Map(),
    noAuditRequestIds: new Set(),
    setupCommitted: false,
    known: {
      branchCodes: new Set([`T5BS_${token}`]),
      employeeNumbers: new Set([`T5BADM_${token}`]),
      roleCodes: new Set([
        `T5B_ADMIN_${token}`,
        `T5B_READ_${token}`,
        `T5B_MANAGE_${token}`,
        `T5B_CATALOG_${token}`,
      ]),
      usernames: new Set([
        `t5b.admin.${lowerToken}`,
        `t5b.must.${lowerToken}`,
        `t5b.denied.${lowerToken}`,
        `t5b.scoped.${lowerToken}`,
        `t5b.reader.${lowerToken}`,
        `t5b.manager.${lowerToken}`,
        `t5b.catalog.${lowerToken}`,
      ]),
      unitCodes: new Set(),
      categoryCodes: new Set(),
      brandCodes: new Set(),
      taxCodes: new Set(),
      productCodes: new Set(),
      variantSkus: new Set(),
      barcodes: new Set(),
      saleNumbers: new Set(),
      lotNumbers: new Set(),
    },
    ids: {
      audits: new Set(),
      branches: new Set(),
      employees: new Set(),
      roles: new Set(),
      users: new Set(),
      userRoles: new Set(),
      units: new Set(),
      categories: new Set(),
      brands: new Set(),
      taxRates: new Set(),
      products: new Set(),
      variants: new Set(),
      packages: new Set(),
      barcodes: new Set(),
      sales: new Set(),
      saleItems: new Set(),
      inventoryLots: new Set(),
    },
    branchCode: `T5BS_${token}`,
    employeeNumber: `T5BADM_${token}`,
    roleCodes: {
      admin: `T5B_ADMIN_${token}`,
      reader: `T5B_READ_${token}`,
      manager: `T5B_MANAGE_${token}`,
      catalog: `T5B_CATALOG_${token}`,
    },
    usernames: {
      admin: `t5b.admin.${lowerToken}`,
      mustChange: `t5b.must.${lowerToken}`,
      denied: `t5b.denied.${lowerToken}`,
      scoped: `t5b.scoped.${lowerToken}`,
      reader: `t5b.reader.${lowerToken}`,
      manager: `t5b.manager.${lowerToken}`,
      catalog: `t5b.catalog.${lowerToken}`,
    },
    password: `Phase5B-${token}-Password!`,
  };
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

async function getLastInsertId(connection) {
  const [rows] = await connection.execute(
    'SELECT CAST(LAST_INSERT_ID() AS CHAR) AS insertedId',
  );

  return rows[0].insertedId;
}

function nextRequestId(fixture, label) {
  fixture.requestCounter += 1;
  const requestId = `${fixture.auditPrefix}_${String(
    fixture.requestCounter,
  ).padStart(3, '0')}_${label}`.slice(0, 100);
  fixture.requestIds.add(requestId);
  return requestId;
}

function expectAudit(fixture, result, ...actionTypes) {
  assert.ok(result.requestId);
  assert.ok(actionTypes.length > 0);
  fixture.expectedAuditActions.set(result.requestId, [...actionTypes].sort());
  return result;
}

function expectNoAudit(fixture, result) {
  assert.ok(result.requestId);
  fixture.noAuditRequestIds.add(result.requestId);
  return result;
}

function parseJsonColumn(value) {
  if (value === null || value === undefined || typeof value === 'object') {
    return value ?? null;
  }

  return JSON.parse(value);
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

function packageResourcePath(productPackageId) {
  return `/api/admin/catalog/packages/${productPackageId}`;
}

function barcodeResourcePath(barcodeId) {
  return `/api/admin/catalog/barcodes/${barcodeId}`;
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
      assert.fail(`Expected JSON, received: ${responseText.slice(0, 200)}`);
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

async function expectFailedMutation(
  fixture,
  baseUrl,
  label,
  path,
  options,
  statusCode,
) {
  const result = expectNoAudit(
    fixture,
    await sendMutation(fixture, baseUrl, label, path, options),
  );
  assertSafeError(result, statusCode);
  return result;
}

function assertPagination(data, expected = {}) {
  assert.ok(Array.isArray(data?.items));
  assert.ok(data?.pagination);

  for (const key of ['page', 'limit', 'totalItems', 'totalPages']) {
    assert.equal(Number.isInteger(data.pagination[key]), true);
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

function makeGtin(payload) {
  assert.match(payload, /^\d+$/);
  let sum = 0;

  for (
    let index = payload.length - 1, position = 0;
    index >= 0;
    index -= 1, position += 1
  ) {
    sum += Number(payload[index]) * (position % 2 === 0 ? 3 : 1);
  }

  return `${payload}${(10 - (sum % 10)) % 10}`;
}

function fixtureNumericPayload(fixture, length, prefix = '') {
  const source = [...fixture.token]
    .map((character) => String(character.charCodeAt(0) % 10))
    .join('');
  const digits = `${prefix}${source.repeat(length + 1)}`;

  return digits.slice(0, length);
}

function conversionToBaseQuantity(value) {
  assert.match(value, /^\d+(?:\.\d{1,6})?$/);
  const [wholePart, fractionPart = ''] = value.split('.');
  const scaled = BigInt(`${wholePart}${fractionPart.padEnd(6, '0')}`);
  const roundedToThreePlaces = (scaled + 500n) / 1000n;
  const digits = roundedToThreePlaces.toString().padStart(4, '0');

  return `${digits.slice(0, -3)}.${digits.slice(-3)}`;
}

async function createAccessAndReferenceFixtures(fixture) {
  const passwordHash = await bcrypt.hash(
    fixture.password,
    Number(process.env.BCRYPT_ROUNDS),
  );
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const canonicalCodes = ACCESS_CONTROL_PERMISSIONS.map(
      (permission) => permission.code,
    );
    assert.equal(canonicalCodes.length, 16);
    const [permissionRows] = await connection.execute(
      `SELECT
         CAST(permission_id AS CHAR) AS permissionId,
         permission_code AS permissionCode
       FROM permissions
       WHERE permission_code IN (${placeholders(canonicalCodes)})`,
      canonicalCodes,
    );
    assert.equal(permissionRows.length, 16);
    const permissionIdByCode = Object.fromEntries(
      permissionRows.map((row) => [row.permissionCode, row.permissionId]),
    );

    await connection.execute(
      `INSERT INTO branches (
         branch_code, branch_name, address_line_1, city,
         country_code, currency_code, timezone, status
       ) VALUES (?, ?, ?, ?, 'NG', 'NGN', 'Africa/Lagos', 'ACTIVE')`,
      [
        fixture.branchCode,
        `TEST Phase 5B Branch ${fixture.token}`,
        '1 Phase 5B Fixture Street',
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
       ) VALUES (?, 'Phase5B', 'Administrator', ?, '2020-01-01', 'ACTIVE')`,
      [
        fixture.employeeNumber,
        `phase5b-actor-${fixture.lowerToken}@example.invalid`,
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
        permissions: [
          'products.read',
          'products.manage',
          'catalog.read',
          'catalog.manage',
        ],
      },
      {
        key: 'reader',
        code: fixture.roleCodes.reader,
        permissions: ['products.read'],
      },
      {
        key: 'manager',
        code: fixture.roleCodes.manager,
        permissions: ['products.manage'],
      },
      {
        key: 'catalog',
        code: fixture.roleCodes.catalog,
        permissions: ['catalog.read', 'catalog.manage'],
      },
    ];

    for (const roleDefinition of roleDefinitions) {
      await connection.execute(
        `INSERT INTO roles (role_code, role_name, description, is_active)
         VALUES (?, ?, 'Temporary Phase 5B integration role', 1)`,
        [
          roleDefinition.code,
          `TEST Phase 5B ${roleDefinition.key} ${fixture.token}`,
        ],
      );
      const roleId = rememberId(
        fixture,
        'roles',
        await getLastInsertId(connection),
      );
      fixture[`${roleDefinition.key}RoleId`] = roleId;

      for (const permissionCode of roleDefinition.permissions) {
        assert.ok(permissionIdByCode[permissionCode]);
        await connection.execute(
          `INSERT INTO role_permissions (role_id, permission_id)
           VALUES (?, ?)`,
          [roleId, permissionIdByCode[permissionCode]],
        );
      }
    }

    const userDefinitions = [
      ['admin', fixture.adminEmployeeId, 0],
      ['mustChange', null, 1],
      ['denied', null, 0],
      ['scoped', null, 0],
      ['reader', null, 0],
      ['manager', null, 0],
      ['catalog', null, 0],
    ];

    for (const [key, employeeId, mustChange] of userDefinitions) {
      const username = fixture.usernames[key];
      await connection.execute(
        `INSERT INTO users (
           employee_id, username, email, password_hash,
           is_active, must_change_password
         ) VALUES (?, ?, ?, ?, 1, ?)`,
        [
          employeeId,
          username,
          `${username}@example.invalid`,
          passwordHash,
          mustChange,
        ],
      );
      fixture[`${key}UserId`] = rememberId(
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
      [fixture.catalogUserId, fixture.catalogRoleId, null],
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

    const unitDefinitions = [
      ['each', `T5B_EACH_${fixture.token}`, false],
      ['fraction', `T5B_FRAC_${fixture.token}`, true],
      ['carton', `T5B_CTN_${fixture.token}`, false],
      ['unused', `T5B_UNU_${fixture.token}`, false],
    ];
    for (const [key, code, allowsFraction] of unitDefinitions) {
      fixture.known.unitCodes.add(code);
      await connection.execute(
        `INSERT INTO units_of_measure (
           unit_code, unit_name, symbol, allows_fraction
         ) VALUES (?, ?, ?, ?)`,
        [code, `TEST ${key} ${fixture.token}`, key, allowsFraction ? 1 : 0],
      );
      fixture[`${key}UnitId`] = rememberId(
        fixture,
        'units',
        await getLastInsertId(connection),
      );
    }

    const categoryDefinitions = [
      ['activeA', `T5B_CAT_A_${fixture.token}`, true],
      ['activeB', `T5B_CAT_B_${fixture.token}`, true],
      ['inactive', `T5B_CAT_I_${fixture.token}`, false],
      ['race', `T5B_CAT_R_${fixture.token}`, true],
    ];
    for (const [key, code, isActive] of categoryDefinitions) {
      fixture.known.categoryCodes.add(code);
      await connection.execute(
        `INSERT INTO categories (
           parent_category_id, category_code, category_name,
           description, is_active
         ) VALUES (NULL, ?, ?, ?, ?)`,
        [
          code,
          `TEST ${key} ${fixture.token}`,
          `Temporary Phase 5B ${key} category`,
          isActive ? 1 : 0,
        ],
      );
      fixture[`${key}CategoryId`] = rememberId(
        fixture,
        'categories',
        await getLastInsertId(connection),
      );
    }

    const brandDefinitions = [
      ['active', `T5B_BR_A_${fixture.token}`, true],
      ['inactive', `T5B_BR_I_${fixture.token}`, false],
    ];
    for (const [key, code, isActive] of brandDefinitions) {
      fixture.known.brandCodes.add(code);
      await connection.execute(
        `INSERT INTO brands (
           brand_code, brand_name, description, is_active
         ) VALUES (?, ?, ?, ?)`,
        [
          code,
          `TEST ${key} brand ${fixture.token}`,
          `Temporary Phase 5B ${key} brand`,
          isActive ? 1 : 0,
        ],
      );
      fixture[`${key}BrandId`] = rememberId(
        fixture,
        'brands',
        await getLastInsertId(connection),
      );
    }

    const taxDefinitions = [
      ['active', `T5B_TAX_A_${fixture.token}`, true],
      ['inactive', `T5B_TAX_I_${fixture.token}`, false],
    ];
    for (const [key, code, isActive] of taxDefinitions) {
      fixture.known.taxCodes.add(code);
      await connection.execute(
        `INSERT INTO tax_rates (
           tax_code, tax_name, rate_percent, is_inclusive, is_active
         ) VALUES (?, ?, '7.5000', 0, ?)`,
        [code, `TEST ${key} tax ${fixture.token}`, isActive ? 1 : 0],
      );
      fixture[`${key}TaxRateId`] = rememberId(
        fixture,
        'taxRates',
        await getLastInsertId(connection),
      );
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
    'catalog',
  ]) {
    fixture[`${key}Token`] = signAccessToken(
      fixture[`${key}UserId`],
    ).accessToken;
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
    [
      'employees',
      'employees',
      'employee_id',
      'employee_number',
      'employeeNumbers',
    ],
    ['roles', 'roles', 'role_id', 'role_code', 'roleCodes'],
    ['users', 'users', 'user_id', 'username', 'usernames'],
    [
      'units',
      'units_of_measure',
      'unit_of_measure_id',
      'unit_code',
      'unitCodes',
    ],
    [
      'categories',
      'categories',
      'category_id',
      'category_code',
      'categoryCodes',
    ],
    ['brands', 'brands', 'brand_id', 'brand_code', 'brandCodes'],
    ['taxRates', 'tax_rates', 'tax_rate_id', 'tax_code', 'taxCodes'],
    ['products', 'products', 'product_id', 'product_code', 'productCodes'],
    [
      'variants',
      'product_variants',
      'product_variant_id',
      'sku',
      'variantSkus',
    ],
    [
      'barcodes',
      'product_barcodes',
      'barcode_id',
      'barcode',
      'barcodes',
    ],
    ['sales', 'sales', 'sale_id', 'sale_number', 'saleNumbers'],
    [
      'inventoryLots',
      'inventory_lots',
      'inventory_lot_id',
      'lot_number',
      'lotNumbers',
    ],
  ];

  for (const [collection, table, idColumn, valueColumn, knownCollection] of
    definitions) {
    const ids = await discoverIdsByValues(connection, {
      table,
      idColumn,
      valueColumn,
      values: [...fixture.known[knownCollection]],
    });
    for (const id of ids) {
      fixture.ids[collection].add(id);
    }
  }

  if (fixture.ids.variants.size > 0) {
    const variantIds = [...fixture.ids.variants];
    const [packageRows] = await connection.execute(
      `SELECT CAST(product_package_id AS CHAR) AS id
       FROM product_packages
       WHERE product_variant_id IN (${placeholders(variantIds)})`,
      variantIds,
    );
    const [barcodeRows] = await connection.execute(
      `SELECT CAST(barcode_id AS CHAR) AS id
       FROM product_barcodes
       WHERE product_variant_id IN (${placeholders(variantIds)})`,
      variantIds,
    );
    const [lotRows] = await connection.execute(
      `SELECT CAST(inventory_lot_id AS CHAR) AS id
       FROM inventory_lots
       WHERE product_variant_id IN (${placeholders(variantIds)})`,
      variantIds,
    );

    for (const row of packageRows) fixture.ids.packages.add(row.id);
    for (const row of barcodeRows) fixture.ids.barcodes.add(row.id);
    for (const row of lotRows) fixture.ids.inventoryLots.add(row.id);
  }

  if (fixture.ids.sales.size > 0) {
    const saleIds = [...fixture.ids.sales];
    const [rows] = await connection.execute(
      `SELECT CAST(sale_item_id AS CHAR) AS id
       FROM sale_items
       WHERE sale_id IN (${placeholders(saleIds)})`,
      saleIds,
    );
    for (const row of rows) fixture.ids.saleItems.add(row.id);
  }

  if (fixture.ids.users.size > 0 || fixture.ids.roles.size > 0) {
    const predicates = [];
    const parameters = [];
    const userIds = [...fixture.ids.users];
    const roleIds = [...fixture.ids.roles];

    if (userIds.length > 0) {
      predicates.push(`user_id IN (${placeholders(userIds)})`);
      parameters.push(...userIds);
    }
    if (roleIds.length > 0) {
      predicates.push(`role_id IN (${placeholders(roleIds)})`);
      parameters.push(...roleIds);
    }

    const [rows] = await connection.execute(
      `SELECT CAST(user_role_id AS CHAR) AS id
       FROM user_roles
       WHERE ${predicates.join(' OR ')}`,
      parameters,
    );
    for (const row of rows) fixture.ids.userRoles.add(row.id);
  }

  if (fixture.requestIds.size > 0) {
    const requestIds = [...fixture.requestIds];
    const [rows] = await connection.execute(
      `SELECT CAST(audit_log_id AS CHAR) AS id
       FROM audit_logs
       WHERE request_id IN (${placeholders(requestIds)})`,
      requestIds,
    );
    for (const row of rows) fixture.ids.audits.add(row.id);
  }
}

async function deleteByIds(connection, table, idColumn, ids) {
  if (ids.length === 0) {
    return;
  }

  await connection.execute(
    `DELETE FROM ${table}
     WHERE ${idColumn} IN (${placeholders(ids)})`,
    ids,
  );
}

async function cleanupFixtures(fixture) {
  if (!fixture.setupCommitted) {
    return;
  }

  const connection = await pool.getConnection();

  try {
    await discoverFixtureIds(connection, fixture);
    await connection.beginTransaction();

    await deleteByIds(
      connection,
      'audit_logs',
      'audit_log_id',
      [...fixture.ids.audits],
    );
    await deleteByIds(
      connection,
      'sale_items',
      'sale_item_id',
      [...fixture.ids.saleItems],
    );
    await deleteByIds(
      connection,
      'sales',
      'sale_id',
      [...fixture.ids.sales],
    );

    const packageIds = [...fixture.ids.packages];
    const variantIds = [...fixture.ids.variants];
    const branchIds = [...fixture.ids.branches];

    if (packageIds.length > 0 && branchIds.length > 0) {
      await connection.execute(
        `DELETE FROM branch_package_prices
         WHERE product_package_id IN (${placeholders(packageIds)})
           AND branch_id IN (${placeholders(branchIds)})`,
        [...packageIds, ...branchIds],
      );
    }
    if (variantIds.length > 0 && branchIds.length > 0) {
      await connection.execute(
        `DELETE FROM branch_variant_prices
         WHERE product_variant_id IN (${placeholders(variantIds)})
           AND branch_id IN (${placeholders(branchIds)})`,
        [...variantIds, ...branchIds],
      );
      await connection.execute(
        `DELETE FROM branch_inventory
         WHERE product_variant_id IN (${placeholders(variantIds)})
           AND branch_id IN (${placeholders(branchIds)})`,
        [...variantIds, ...branchIds],
      );
    }

    await deleteByIds(
      connection,
      'inventory_lots',
      'inventory_lot_id',
      [...fixture.ids.inventoryLots],
    );
    await deleteByIds(
      connection,
      'product_barcodes',
      'barcode_id',
      [...fixture.ids.barcodes],
    );
    await deleteByIds(
      connection,
      'product_packages',
      'product_package_id',
      packageIds,
    );
    await deleteByIds(
      connection,
      'product_variants',
      'product_variant_id',
      variantIds,
    );
    await deleteByIds(
      connection,
      'products',
      'product_id',
      [...fixture.ids.products],
    );
    await deleteByIds(
      connection,
      'user_roles',
      'user_role_id',
      [...fixture.ids.userRoles],
    );

    const roleIds = [...fixture.ids.roles];
    if (roleIds.length > 0) {
      await connection.execute(
        `DELETE FROM role_permissions
         WHERE role_id IN (${placeholders(roleIds)})`,
        roleIds,
      );
    }

    await deleteByIds(
      connection,
      'users',
      'user_id',
      [...fixture.ids.users],
    );

    const employeeIds = [...fixture.ids.employees];
    if (employeeIds.length > 0) {
      await connection.execute(
        `DELETE FROM employee_branch_assignments
         WHERE employee_id IN (${placeholders(employeeIds)})`,
        employeeIds,
      );
    }
    await deleteByIds(
      connection,
      'employees',
      'employee_id',
      employeeIds,
    );
    await deleteByIds(connection, 'roles', 'role_id', roleIds);
    await deleteByIds(
      connection,
      'branches',
      'branch_id',
      branchIds,
    );
    await deleteByIds(
      connection,
      'categories',
      'category_id',
      [...fixture.ids.categories],
    );
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

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function countKnownValues(connection, table, column, values) {
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
      ['branches', 'branch_code', 'branchCodes'],
      ['employees', 'employee_number', 'employeeNumbers'],
      ['roles', 'role_code', 'roleCodes'],
      ['users', 'username', 'usernames'],
      ['units_of_measure', 'unit_code', 'unitCodes'],
      ['categories', 'category_code', 'categoryCodes'],
      ['brands', 'brand_code', 'brandCodes'],
      ['tax_rates', 'tax_code', 'taxCodes'],
      ['products', 'product_code', 'productCodes'],
      ['product_variants', 'sku', 'variantSkus'],
      ['product_barcodes', 'barcode', 'barcodes'],
      ['sales', 'sale_number', 'saleNumbers'],
      ['inventory_lots', 'lot_number', 'lotNumbers'],
    ];

    for (const [table, column, knownCollection] of definitions) {
      assert.equal(
        await countKnownValues(
          connection,
          table,
          column,
          [...fixture.known[knownCollection]],
        ),
        0,
        `Phase 5B cleanup left fixture rows in ${table}.`,
      );
    }

    if (fixture.requestIds.size > 0) {
      assert.equal(
        await countKnownValues(
          connection,
          'audit_logs',
          'request_id',
          [...fixture.requestIds],
        ),
        0,
      );
    }

    const canonicalCodes = ACCESS_CONTROL_PERMISSIONS.map(
      (permission) => permission.code,
    );
    const [permissionRows] = await connection.execute(
      `SELECT COUNT(*) AS count
       FROM permissions
       WHERE permission_code IN (${placeholders(canonicalCodes)})`,
      canonicalCodes,
    );
    assert.equal(Number(permissionRows[0].count), 16);

    const [mappingRows] = await connection.execute(
      `SELECT COUNT(*) AS count
       FROM role_permissions rp
       INNER JOIN roles r ON r.role_id = rp.role_id
       INNER JOIN permissions p ON p.permission_id = rp.permission_id
       WHERE r.role_code = ?
         AND p.permission_code IN (${placeholders(canonicalCodes)})`,
      [SYSTEM_ADMIN_ROLE.code, ...canonicalCodes],
    );
    assert.equal(Number(mappingRows[0].count), 16);
  } finally {
    connection.release();
  }
}

async function createProductViaApi(
  fixture,
  baseUrl,
  label,
  values,
  { token = fixture.adminToken } = {},
) {
  fixture.known.productCodes.add(values.productCode.trim().toUpperCase());
  const result = await sendMutation(
    fixture,
    baseUrl,
    label,
    '/api/admin/catalog/products',
    { method: 'POST', token, body: values },
  );
  assert.equal(result.response.status, 201, result.responseText);
  const product = result.json?.data?.product;
  rememberId(fixture, 'products', product.productId);
  expectAudit(fixture, result, 'PRODUCT_CREATED');
  return product;
}

async function createVariantViaApi(
  fixture,
  baseUrl,
  label,
  productId,
  values,
) {
  fixture.known.variantSkus.add(values.sku.trim().toUpperCase());
  const result = await sendMutation(
    fixture,
    baseUrl,
    label,
    `/api/admin/catalog/products/${productId}/variants`,
    { method: 'POST', body: values },
  );
  assert.equal(result.response.status, 201, result.responseText);
  const productVariant = result.json?.data?.productVariant;
  rememberId(fixture, 'variants', productVariant.productVariantId);
  expectAudit(
    fixture,
    result,
    'PRODUCT_VARIANT_CREATED',
    ...(values.basePackage ? ['PRODUCT_PACKAGE_CREATED'] : []),
  );

  if (values.basePackage) {
    const [rows] = await pool.execute(
      `SELECT CAST(product_package_id AS CHAR) AS productPackageId
       FROM product_packages
       WHERE product_variant_id = ?
         AND is_base_unit = 1
       ORDER BY product_package_id`,
      [productVariant.productVariantId],
    );
    assert.equal(rows.length, 1);
    rememberId(fixture, 'packages', rows[0].productPackageId);
  }

  return productVariant;
}

async function createPackageViaApi(
  fixture,
  baseUrl,
  label,
  _productId,
  productVariantId,
  values,
) {
  const result = await sendMutation(
    fixture,
    baseUrl,
    label,
    `/api/admin/catalog/variants/${productVariantId}/packages`,
    { method: 'POST', body: values },
  );
  assert.equal(result.response.status, 201, result.responseText);
  const productPackage = result.json?.data?.productPackage;
  rememberId(fixture, 'packages', productPackage.productPackageId);
  expectAudit(fixture, result, 'PRODUCT_PACKAGE_CREATED');
  return productPackage;
}

async function createBarcodeViaApi(
  fixture,
  baseUrl,
  label,
  _productId,
  productVariantId,
  values,
) {
  fixture.known.barcodes.add(values.barcode.trim());
  const result = await sendMutation(
    fixture,
    baseUrl,
    label,
    `/api/admin/catalog/variants/${productVariantId}/barcodes`,
    { method: 'POST', body: values },
  );
  assert.equal(result.response.status, 201, result.responseText);
  const productBarcode = result.json?.data?.productBarcode;
  rememberId(fixture, 'barcodes', productBarcode.barcodeId);
  expectAudit(fixture, result, 'PRODUCT_BARCODE_CREATED');
  return productBarcode;
}

async function createSaleItemFixture(
  fixture,
  {
    label,
    productVariantId,
    productPackageId = null,
    barcodeId = null,
    packageConversionFactor = '1.000000',
    lineNumber = 1,
  },
) {
  const saleNumber = `T5B_SALE_${fixture.token}_${label}`;
  fixture.known.saleNumbers.add(saleNumber);
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    await connection.execute(
      `INSERT INTO sales (
         sale_number, branch_id, cashier_employee_id,
         status, currency_code
       ) VALUES (?, ?, ?, 'OPEN', 'NGN')`,
      [saleNumber, fixture.branchId, fixture.adminEmployeeId],
    );
    const saleId = rememberId(
      fixture,
      'sales',
      await getLastInsertId(connection),
    );
    const baseQuantity = conversionToBaseQuantity(packageConversionFactor);
    await connection.execute(
      `INSERT INTO sale_items (
         sale_id, line_number, product_variant_id, product_package_id,
         barcode_id, item_description, sku_snapshot, package_name_snapshot,
         quantity, package_conversion_factor, base_quantity,
         unit_price, discount_amount, tax_rate_percent, tax_amount, line_total
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '1.000', ?, ?,
                 '1.0000', '0.00', '0.0000', '0.00', '1.00')`,
      [
        saleId,
        lineNumber,
        productVariantId,
        productPackageId,
        barcodeId,
        `TEST Phase 5B sale item ${label}`,
        `T5B-SNAPSHOT-${fixture.token}`,
        productPackageId === null ? null : `TEST package ${label}`,
        packageConversionFactor,
        baseQuantity,
      ],
    );
    rememberId(fixture, 'saleItems', await getLastInsertId(connection));
    await connection.commit();
    return saleId;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

test(
  'Phase 5B product master, variants, packages, and barcodes integration',
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const fixture = createFixtureDefinition();
    let apiServer;

    try {
      await createAccessAndReferenceFixtures(fixture);
      apiServer = await startHttpServer(app);
      const baseUrl = baseUrlFor(apiServer);

      await t.test(
        'enforces the exact global product authorization surface',
        async () => {
          const protectedRoutes = [
            ['GET', '/api/admin/catalog/products'],
            ['GET', `/api/admin/catalog/products/${MAX_UNSIGNED_BIGINT}`],
            ['POST', '/api/admin/catalog/products'],
            ['PATCH', `/api/admin/catalog/products/${MAX_UNSIGNED_BIGINT}`],
            ['GET', `/api/admin/catalog/products/${MAX_UNSIGNED_BIGINT}/variants`],
            ['POST', `/api/admin/catalog/products/${MAX_UNSIGNED_BIGINT}/variants`],
            ['GET', `/api/admin/catalog/variants/${MAX_UNSIGNED_BIGINT}`],
            ['PATCH', `/api/admin/catalog/variants/${MAX_UNSIGNED_BIGINT}`],
            [
              'GET',
              `/api/admin/catalog/variants/${MAX_UNSIGNED_BIGINT}/packages`,
            ],
            [
              'POST',
              `/api/admin/catalog/variants/${MAX_UNSIGNED_BIGINT}/packages`,
            ],
            ['GET', `/api/admin/catalog/packages/${MAX_UNSIGNED_BIGINT}`],
            [
              'PATCH',
              `/api/admin/catalog/packages/${MAX_UNSIGNED_BIGINT}`,
            ],
            [
              'GET',
              `/api/admin/catalog/variants/${MAX_UNSIGNED_BIGINT}/barcodes`,
            ],
            [
              'POST',
              `/api/admin/catalog/variants/${MAX_UNSIGNED_BIGINT}/barcodes`,
            ],
            ['GET', `/api/admin/catalog/barcodes/${MAX_UNSIGNED_BIGINT}`],
            [
              'PATCH',
              `/api/admin/catalog/barcodes/${MAX_UNSIGNED_BIGINT}`,
            ],
            [
              'GET',
              '/api/admin/catalog/barcodes/lookup?barcode=LOCKED-CONTRACT',
            ],
            ['DELETE', `/api/admin/catalog/barcodes/${MAX_UNSIGNED_BIGINT}`],
          ];

          assert.equal(protectedRoutes.length, 18);
          for (const [method, path] of protectedRoutes) {
            const result = await sendRequest(baseUrl, path, { method });
            assertSafeError(result, 401);
          }

          assertSafeError(
            await sendRequest(baseUrl, '/api/admin/catalog/products', {
              token: fixture.mustChangeToken,
            }),
            403,
          );
          assertSafeError(
            await sendRequest(baseUrl, '/api/admin/catalog/products', {
              token: fixture.deniedToken,
            }),
            403,
          );
          assertSafeError(
            await sendRequest(baseUrl, '/api/admin/catalog/products', {
              token: fixture.scopedToken,
            }),
            403,
          );
          assertSafeError(
            await sendRequest(baseUrl, '/api/admin/catalog/products', {
              token: fixture.catalogToken,
            }),
            403,
          );
          assert.equal(
            (
              await sendRequest(baseUrl, '/api/admin/catalog/products', {
                token: fixture.readerToken,
              })
            ).response.status,
            200,
          );
          assertSafeError(
            await sendRequest(baseUrl, '/api/admin/catalog/products', {
              token: fixture.managerToken,
            }),
            403,
          );
          assertSafeError(
            await sendRequest(baseUrl, '/api/admin/catalog/products', {
              method: 'POST',
              token: fixture.readerToken,
              body: {},
            }),
            403,
          );
          assertSafeError(
            await sendRequest(baseUrl, '/api/admin/catalog/products', {
              method: 'POST',
              token: fixture.scopedToken,
              body: {},
            }),
            403,
          );
          assertSafeError(
            await sendRequest(baseUrl, '/api/admin/catalog/products', {
              method: 'POST',
              token: fixture.catalogToken,
              body: {},
            }),
            403,
          );

          fixture.managerProduct = await createProductViaApi(
            fixture,
            baseUrl,
            'GLOBAL_MANAGER_PRODUCT_CREATE',
            {
              categoryId: fixture.activeACategoryId,
              productCode: `t5b_mgr_${fixture.token}`,
              productName: `PAGED_${fixture.token} A`,
              status: 'INACTIVE',
            },
            { token: fixture.managerToken },
          );
          assert.equal(fixture.managerProduct.brandId, null);
          assert.equal(fixture.managerProduct.taxRateId, null);
          assert.equal(fixture.managerProduct.description, null);

          const catalogRegression = await sendRequest(
            baseUrl,
            '/api/admin/catalog/units?limit=1',
            { token: fixture.adminToken },
          );
          assert.equal(catalogRegression.response.status, 200);

          const canonicalCodes = ACCESS_CONTROL_PERMISSIONS.map(
            (permission) => permission.code,
          );
          assert.equal(canonicalCodes.length, 16);
          assert.equal(new Set(canonicalCodes).size, 16);
          const [permissionRows] = await pool.execute(
            `SELECT COUNT(*) AS count
             FROM permissions
             WHERE permission_code IN (${placeholders(canonicalCodes)})`,
            canonicalCodes,
          );
          const [mappingRows] = await pool.execute(
            `SELECT COUNT(*) AS count
             FROM role_permissions rp
             INNER JOIN roles r ON r.role_id = rp.role_id
             INNER JOIN permissions p ON p.permission_id = rp.permission_id
             WHERE r.role_code = ?
               AND p.permission_code IN (${placeholders(canonicalCodes)})`,
            [SYSTEM_ADMIN_ROLE.code, ...canonicalCodes],
          );
          assert.equal(Number(permissionRows[0].count), 16);
          assert.equal(Number(mappingRows[0].count), 16);

          for (const [method, path] of [
            ['GET', '/api/admin/products'],
            [
              'GET',
              `/api/admin/products/${MAX_UNSIGNED_BIGINT}/variants`,
            ],
            [
              'POST',
              `/api/admin/catalog/packages/${MAX_UNSIGNED_BIGINT}/make-base`,
            ],
            [
              'POST',
              `/api/admin/catalog/barcodes/${MAX_UNSIGNED_BIGINT}/make-primary`,
            ],
          ]) {
            assertSafeError(
              await sendRequest(baseUrl, path, {
                method,
                token: fixture.adminToken,
              }),
              404,
            );
          }
        },
      );

      await t.test(
        'implements product validation, references, filters, and lifecycle rules',
        async () => {
          fixture.mainProduct = await createProductViaApi(
            fixture,
            baseUrl,
            'PRODUCT_CREATE_MAIN',
            {
              categoryId: fixture.activeACategoryId,
              brandId: fixture.activeBrandId,
              taxRateId: fixture.activeTaxRateId,
              productCode: ` t5b_main_${fixture.token} `,
              productName: `PAGED_${fixture.token} B`,
              description: '  Main fixture product  ',
              status: 'ACTIVE',
            },
          );
          assertIdString(fixture.mainProduct.productId);
          assert.equal(
            fixture.mainProduct.productCode,
            `T5B_MAIN_${fixture.token}`,
          );
          assert.equal(fixture.mainProduct.description, 'Main fixture product');
          assert.equal(fixture.mainProduct.status, 'ACTIVE');

          fixture.secondProduct = await createProductViaApi(
            fixture,
            baseUrl,
            'PRODUCT_CREATE_SECOND',
            {
              categoryId: fixture.activeBCategoryId,
              brandId: null,
              taxRateId: null,
              productCode: `T5B_SECOND_${fixture.token}`,
              productName: `PAGED_${fixture.token} C`,
              description: null,
              status: 'ACTIVE',
            },
          );
          fixture.standaloneProduct = await createProductViaApi(
            fixture,
            baseUrl,
            'PRODUCT_CREATE_STANDALONE',
            {
              categoryId: fixture.activeACategoryId,
              productCode: `T5B_STAND_${fixture.token}`,
              productName: `TEST Standalone ${fixture.token}`,
              status: 'ACTIVE',
            },
          );
          fixture.inactiveProduct = await createProductViaApi(
            fixture,
            baseUrl,
            'PRODUCT_CREATE_INACTIVE_PARENT',
            {
              categoryId: fixture.inactiveCategoryId,
              brandId: fixture.inactiveBrandId,
              taxRateId: fixture.inactiveTaxRateId,
              productCode: `T5B_INACTIVE_${fixture.token}`,
              productName: `TEST Inactive Product ${fixture.token}`,
              status: 'INACTIVE',
            },
          );
          fixture.raceProduct = await createProductViaApi(
            fixture,
            baseUrl,
            'PRODUCT_CREATE_RACE',
            {
              categoryId: fixture.activeACategoryId,
              productCode: `T5B_RACE_${fixture.token}`,
              productName: `TEST Reference Race ${fixture.token}`,
              status: 'ACTIVE',
            },
          );

          const detail = await sendRequest(
            baseUrl,
            `/api/admin/catalog/products/${fixture.mainProduct.productId}`,
            { token: fixture.adminToken },
          );
          assert.equal(detail.response.status, 200);
          assert.deepEqual(detail.json.data.product, fixture.mainProduct);

          const paged = await sendRequest(
            baseUrl,
            `/api/admin/catalog/products?search=${encodeURIComponent(
              `PAGED_${fixture.token}`,
            )}&page=1&limit=2`,
            { token: fixture.adminToken },
          );
          assert.equal(paged.response.status, 200);
          assertPagination(paged.json.data, {
            page: 1,
            limit: 2,
            totalItems: 3,
            totalPages: 2,
          });
          assert.deepEqual(
            paged.json.data.items.map((product) => product.productName),
            [`PAGED_${fixture.token} A`, `PAGED_${fixture.token} B`],
          );

          const filterCases = [
            [
              `status=INACTIVE&search=${fixture.token}`,
              fixture.managerProduct.productId,
            ],
            [
              `categoryId=${fixture.activeBCategoryId}`,
              fixture.secondProduct.productId,
            ],
            [
              `brandId=${fixture.activeBrandId}`,
              fixture.mainProduct.productId,
            ],
            ['brandId=null', fixture.managerProduct.productId],
            [
              `taxRateId=${fixture.activeTaxRateId}`,
              fixture.mainProduct.productId,
            ],
            ['taxRateId=null', fixture.managerProduct.productId],
          ];
          for (const [query, expectedProductId] of filterCases) {
            const result = await sendRequest(
              baseUrl,
              `/api/admin/catalog/products?${query}&limit=100`,
              { token: fixture.adminToken },
            );
            assert.equal(result.response.status, 200);
            assert.ok(
              result.json.data.items.some(
                (product) => product.productId === expectedProductId,
              ),
            );
          }

          for (const query of [
            'page=0',
            'limit=0',
            'limit=101',
            'status=UNKNOWN',
            'brandId=0',
            'unexpected=true',
          ]) {
            assertSafeError(
              await sendRequest(baseUrl, `/api/admin/catalog/products?${query}`, {
                token: fixture.adminToken,
              }),
              400,
            );
          }

          const update = await sendMutation(
            fixture,
            baseUrl,
            'PRODUCT_UPDATE_FIELDS',
            `/api/admin/catalog/products/${fixture.mainProduct.productId}`,
            {
              method: 'PATCH',
              body: {
                categoryId: fixture.activeBCategoryId,
                productCode: `t5b_main_new_${fixture.token}`,
                productName: `TEST Main Updated ${fixture.token}`,
                description: 'Updated product description',
              },
            },
          );
          assert.equal(update.response.status, 200, update.responseText);
          expectAudit(fixture, update, 'PRODUCT_UPDATED');
          fixture.known.productCodes.add(
            `T5B_MAIN_NEW_${fixture.token}`,
          );
          fixture.mainProduct = update.json.data.product;
          assert.equal(
            fixture.mainProduct.categoryId,
            fixture.activeBCategoryId,
          );

          const noOp = await sendMutation(
            fixture,
            baseUrl,
            'PRODUCT_UPDATE_NOOP',
            `/api/admin/catalog/products/${fixture.mainProduct.productId}`,
            {
              method: 'PATCH',
              body: { productName: fixture.mainProduct.productName },
            },
          );
          assert.equal(noOp.response.status, 200);
          expectNoAudit(fixture, noOp);

          await expectFailedMutation(
            fixture,
            baseUrl,
            'PRODUCT_DUPLICATE_CODE',
            `/api/admin/catalog/products/${fixture.secondProduct.productId}`,
            {
              method: 'PATCH',
              body: { productCode: fixture.mainProduct.productCode },
            },
            409,
          );

          const missingReferenceCases = [
            ['categoryId', MAX_UNSIGNED_BIGINT],
            ['brandId', MAX_UNSIGNED_BIGINT],
            ['taxRateId', MAX_UNSIGNED_BIGINT],
          ];
          for (const [field, value] of missingReferenceCases) {
            await expectFailedMutation(
              fixture,
              baseUrl,
              `PRODUCT_MISSING_${field}`,
              `/api/admin/catalog/products/${fixture.mainProduct.productId}`,
              { method: 'PATCH', body: { [field]: value } },
              404,
            );
          }

          const inactiveReferenceCases = [
            ['categoryId', fixture.inactiveCategoryId],
            ['brandId', fixture.inactiveBrandId],
            ['taxRateId', fixture.inactiveTaxRateId],
          ];
          for (const [field, value] of inactiveReferenceCases) {
            await expectFailedMutation(
              fixture,
              baseUrl,
              `PRODUCT_INACTIVE_${field}`,
              `/api/admin/catalog/products/${fixture.mainProduct.productId}`,
              { method: 'PATCH', body: { [field]: value } },
              409,
            );
          }

          for (const [label, body] of [
            ['UNKNOWN_FIELD', { inventoryQuantity: 1 }],
            ['BLANK_NAME', { productName: '   ' }],
            ['BAD_STATUS', { status: 'DELETED' }],
            ['BAD_BOOLEAN', { isActive: true }],
          ]) {
            await expectFailedMutation(
              fixture,
              baseUrl,
              `PRODUCT_${label}`,
              `/api/admin/catalog/products/${fixture.mainProduct.productId}`,
              { method: 'PATCH', body },
              400,
            );
          }
          assertSafeError(
            await sendRequest(baseUrl, '/api/admin/catalog/products/0', {
              token: fixture.adminToken,
            }),
            400,
          );

          const deactivate = await sendMutation(
            fixture,
            baseUrl,
            'PRODUCT_DEACTIVATE_NO_VARIANTS',
            `/api/admin/catalog/products/${fixture.standaloneProduct.productId}`,
            { method: 'PATCH', body: { status: 'INACTIVE' } },
          );
          assert.equal(deactivate.response.status, 200);
          expectAudit(fixture, deactivate, 'PRODUCT_UPDATED');
          assert.equal(deactivate.json.data.product.status, 'INACTIVE');

          const reactivate = await sendMutation(
            fixture,
            baseUrl,
            'PRODUCT_REACTIVATE',
            `/api/admin/catalog/products/${fixture.standaloneProduct.productId}`,
            { method: 'PATCH', body: { status: 'ACTIVE' } },
          );
          assert.equal(reactivate.response.status, 200);
          expectAudit(fixture, reactivate, 'PRODUCT_UPDATED');
        },
      );

      await t.test(
        'implements variant composition, exact decimals, and stability rules',
        async () => {
          fixture.mainVariant = await createVariantViaApi(
            fixture,
            baseUrl,
            'VARIANT_CREATE_ACTIVE_WITH_BASE',
            fixture.mainProduct.productId,
            {
              unitOfMeasureId: fixture.eachUnitId,
              sku: ` t5b-main-sku-${fixture.token} `,
              variantName: `PAGED_${fixture.token} Variant B`,
              sizeValue: '50.000',
              unitsPerPack: '1',
              isFractional: false,
              lotTrackingMode: 'NONE',
              requiresExpiryDate: false,
              defaultSellingPrice: '350',
              status: 'ACTIVE',
              basePackage: {
                packageCode: ' bottle ',
                packageName: 'Bottle',
                isPurchasable: true,
                isSellable: true,
                defaultSellingPrice: '350.0000',
              },
            },
          );
          assert.equal(
            fixture.mainVariant.sku,
            `T5B-MAIN-SKU-${fixture.token}`,
          );
          assert.equal(fixture.mainVariant.sizeValue, '50.000');
          assert.equal(fixture.mainVariant.unitsPerPack, '1.000');
          assert.equal(fixture.mainVariant.defaultSellingPrice, '350.0000');
          assert.equal(fixture.mainVariant.isFractional, false);
          assert.equal(fixture.mainVariant.requiresExpiryDate, false);
          assertIdString(fixture.mainVariant.productId);
          assertIdString(fixture.mainVariant.unitOfMeasureId);

          const basePackages = await sendRequest(
            baseUrl,
            `/api/admin/catalog/variants/${fixture.mainVariant.productVariantId}/packages?isBaseUnit=true`,
            { token: fixture.adminToken },
          );
          assert.equal(basePackages.response.status, 200);
          assert.equal(basePackages.json.data.items.length, 1);
          fixture.basePackage = basePackages.json.data.items[0];
          rememberId(
            fixture,
            'packages',
            fixture.basePackage.productPackageId,
          );
          assert.equal(fixture.basePackage.isBaseUnit, true);
          assert.equal(fixture.basePackage.status, 'ACTIVE');
          assert.equal(
            fixture.basePackage.packageUnitOfMeasureId,
            fixture.eachUnitId,
          );
          assert.equal(
            fixture.basePackage.conversionToBaseQuantity,
            '1.000000',
          );

          fixture.inactiveVariant = await createVariantViaApi(
            fixture,
            baseUrl,
            'VARIANT_CREATE_INACTIVE_NO_BASE',
            fixture.mainProduct.productId,
            {
              unitOfMeasureId: fixture.eachUnitId,
              sku: `T5B-INACTIVE-${fixture.token}`,
              variantName: `PAGED_${fixture.token} Variant A`,
              sizeValue: null,
              defaultSellingPrice: '0.0000',
              status: 'INACTIVE',
            },
          );
          assert.equal(fixture.inactiveVariant.sizeValue, null);
          assert.equal(fixture.inactiveVariant.unitsPerPack, '1.000');

          fixture.sameNameVariant = await createVariantViaApi(
            fixture,
            baseUrl,
            'VARIANT_CREATE_SAME_NAME_OTHER_PRODUCT',
            fixture.secondProduct.productId,
            {
              unitOfMeasureId: fixture.eachUnitId,
              sku: `T5B-SAME-NAME-${fixture.token}`,
              variantName: fixture.inactiveVariant.variantName,
              defaultSellingPrice: '10.0000',
              status: 'INACTIVE',
            },
          );

          fixture.fractionalVariant = await createVariantViaApi(
            fixture,
            baseUrl,
            'VARIANT_CREATE_FRACTIONAL',
            fixture.mainProduct.productId,
            {
              unitOfMeasureId: fixture.fractionUnitId,
              sku: `T5B-FRAC-${fixture.token}`,
              variantName: `PAGED_${fixture.token} Variant C`,
              sizeValue: '0.125',
              unitsPerPack: '2.500',
              isFractional: true,
              lotTrackingMode: 'OPTIONAL',
              requiresExpiryDate: true,
              defaultSellingPrice: '12.3456',
              status: 'INACTIVE',
            },
          );

          const detail = await sendRequest(
            baseUrl,
            `/api/admin/catalog/variants/${fixture.mainVariant.productVariantId}`,
            { token: fixture.adminToken },
          );
          assert.equal(detail.response.status, 200);
          assert.deepEqual(detail.json.data.productVariant, fixture.mainVariant);
          assertSafeError(
            await sendRequest(
              baseUrl,
              `/api/admin/catalog/variants/${MAX_UNSIGNED_BIGINT}`,
              { token: fixture.adminToken },
            ),
            404,
          );

          const paged = await sendRequest(
            baseUrl,
            `/api/admin/catalog/products/${fixture.mainProduct.productId}/variants?search=${encodeURIComponent(
              `PAGED_${fixture.token}`,
            )}&limit=2`,
            { token: fixture.adminToken },
          );
          assert.equal(paged.response.status, 200);
          assertPagination(paged.json.data, {
            page: 1,
            limit: 2,
            totalItems: 3,
            totalPages: 2,
          });
          assert.deepEqual(
            paged.json.data.items.map((variant) => variant.variantName),
            [
              `PAGED_${fixture.token} Variant A`,
              `PAGED_${fixture.token} Variant B`,
            ],
          );

          const variantFilterCases = [
            ['status=ACTIVE', fixture.mainVariant.productVariantId],
            [
              `unitOfMeasureId=${fixture.fractionUnitId}`,
              fixture.fractionalVariant.productVariantId,
            ],
            ['isFractional=true', fixture.fractionalVariant.productVariantId],
            [
              'lotTrackingMode=OPTIONAL',
              fixture.fractionalVariant.productVariantId,
            ],
            [
              'requiresExpiryDate=true',
              fixture.fractionalVariant.productVariantId,
            ],
          ];
          for (const [query, expectedVariantId] of variantFilterCases) {
            const result = await sendRequest(
              baseUrl,
              `/api/admin/catalog/products/${fixture.mainProduct.productId}/variants?${query}&limit=100`,
              { token: fixture.adminToken },
            );
            assert.equal(result.response.status, 200);
            assert.ok(
              result.json.data.items.some(
                (variant) =>
                  variant.productVariantId === expectedVariantId,
              ),
            );
          }

          for (const query of [
            'page=0',
            'limit=101',
            'isFractional=1',
            'requiresExpiryDate=falsey',
            'lotTrackingMode=SOMETIMES',
            'unknown=x',
          ]) {
            assertSafeError(
              await sendRequest(
                baseUrl,
                `/api/admin/catalog/products/${fixture.mainProduct.productId}/variants?${query}`,
                { token: fixture.adminToken },
              ),
              400,
            );
          }

          await expectFailedMutation(
            fixture,
            baseUrl,
            'VARIANT_DUPLICATE_SKU',
            `/api/admin/catalog/products/${fixture.mainProduct.productId}/variants`,
            {
              method: 'POST',
              body: {
                unitOfMeasureId: fixture.eachUnitId,
                sku: fixture.mainVariant.sku,
                variantName: `Duplicate SKU ${fixture.token}`,
                defaultSellingPrice: '1.0000',
                status: 'INACTIVE',
              },
            },
            409,
          );
          await expectFailedMutation(
            fixture,
            baseUrl,
            'VARIANT_DUPLICATE_NAME',
            `/api/admin/catalog/products/${fixture.mainProduct.productId}/variants`,
            {
              method: 'POST',
              body: {
                unitOfMeasureId: fixture.eachUnitId,
                sku: `T5B-DUP-NAME-${fixture.token}`,
                variantName: fixture.mainVariant.variantName,
                defaultSellingPrice: '1.0000',
                status: 'INACTIVE',
              },
            },
            409,
          );
          await expectFailedMutation(
            fixture,
            baseUrl,
            'VARIANT_MISSING_UOM',
            `/api/admin/catalog/products/${fixture.mainProduct.productId}/variants`,
            {
              method: 'POST',
              body: {
                unitOfMeasureId: MAX_UNSIGNED_BIGINT,
                sku: `T5B-NO-UOM-${fixture.token}`,
                variantName: `No UOM ${fixture.token}`,
                defaultSellingPrice: '1.0000',
                status: 'INACTIVE',
              },
            },
            404,
          );
          await expectFailedMutation(
            fixture,
            baseUrl,
            'VARIANT_FRACTIONAL_CONFLICT',
            `/api/admin/catalog/products/${fixture.mainProduct.productId}/variants`,
            {
              method: 'POST',
              body: {
                unitOfMeasureId: fixture.eachUnitId,
                sku: `T5B-BAD-FRAC-${fixture.token}`,
                variantName: `Bad fractional ${fixture.token}`,
                isFractional: true,
                defaultSellingPrice: '1.0000',
                status: 'INACTIVE',
              },
            },
            409,
          );
          await expectFailedMutation(
            fixture,
            baseUrl,
            'VARIANT_ACTIVE_INACTIVE_PRODUCT',
            `/api/admin/catalog/products/${fixture.inactiveProduct.productId}/variants`,
            {
              method: 'POST',
              body: {
                unitOfMeasureId: fixture.eachUnitId,
                sku: `T5B-BAD-PARENT-${fixture.token}`,
                variantName: `Bad parent ${fixture.token}`,
                defaultSellingPrice: '1.0000',
                status: 'ACTIVE',
                basePackage: {
                  packageCode: 'EACH',
                  packageName: 'Each',
                },
              },
            },
            409,
          );
          await expectFailedMutation(
            fixture,
            baseUrl,
            'VARIANT_ACTIVE_MISSING_BASE',
            `/api/admin/catalog/products/${fixture.mainProduct.productId}/variants`,
            {
              method: 'POST',
              body: {
                unitOfMeasureId: fixture.eachUnitId,
                sku: `T5B-NO-BASE-${fixture.token}`,
                variantName: `No base ${fixture.token}`,
                defaultSellingPrice: '1.0000',
                status: 'ACTIVE',
              },
            },
            400,
          );

          for (const [label, body] of [
            ['SIZE_ZERO', { sizeValue: '0' }],
            ['SIZE_NEGATIVE', { sizeValue: '-1.000' }],
            ['SIZE_PRECISION', { sizeValue: '1.0001' }],
            ['SIZE_OVERFLOW', { sizeValue: '1000000000.000' }],
            ['PACK_ZERO', { unitsPerPack: '0.000' }],
            ['PACK_NUMBER', { unitsPerPack: 1 }],
            ['PRICE_NUMBER', { defaultSellingPrice: 10 }],
            ['PRICE_NEGATIVE', { defaultSellingPrice: '-0.0001' }],
            [
              'PRICE_OVERFLOW',
              { defaultSellingPrice: '1000000000000000.0000' },
            ],
            [
              'LOT_COMBINATION',
              { lotTrackingMode: 'NONE', requiresExpiryDate: true },
            ],
            ['UNKNOWN_FIELD', { productId: fixture.mainProduct.productId }],
          ]) {
            await expectFailedMutation(
              fixture,
              baseUrl,
              `VARIANT_${label}`,
              `/api/admin/catalog/variants/${fixture.inactiveVariant.productVariantId}`,
              { method: 'PATCH', body },
              400,
            );
          }

          const update = await sendMutation(
            fixture,
            baseUrl,
            'VARIANT_UPDATE_FIELDS',
            `/api/admin/catalog/variants/${fixture.inactiveVariant.productVariantId}`,
            {
              method: 'PATCH',
              body: {
                unitOfMeasureId: fixture.unusedUnitId,
                sku: `t5b-inactive-new-${fixture.token}`,
                variantName: `TEST Inactive Updated ${fixture.token}`,
                sizeValue: '5.5',
                unitsPerPack: '2',
                defaultSellingPrice: '20.25',
              },
            },
          );
          assert.equal(update.response.status, 200, update.responseText);
          expectAudit(fixture, update, 'PRODUCT_VARIANT_UPDATED');
          fixture.known.variantSkus.add(
            `T5B-INACTIVE-NEW-${fixture.token}`,
          );
          fixture.inactiveVariant = update.json.data.productVariant;
          assert.equal(fixture.inactiveVariant.sizeValue, '5.500');
          assert.equal(fixture.inactiveVariant.unitsPerPack, '2.000');
          assert.equal(
            fixture.inactiveVariant.defaultSellingPrice,
            '20.2500',
          );

          await expectFailedMutation(
            fixture,
            baseUrl,
            'VARIANT_ACTIVATE_WITHOUT_BASE',
            `/api/admin/catalog/variants/${fixture.inactiveVariant.productVariantId}`,
            { method: 'PATCH', body: { status: 'ACTIVE' } },
            409,
          );
          await expectFailedMutation(
            fixture,
            baseUrl,
            'VARIANT_CHANGE_ESTABLISHED_UOM',
            `/api/admin/catalog/variants/${fixture.mainVariant.productVariantId}`,
            {
              method: 'PATCH',
              body: { unitOfMeasureId: fixture.unusedUnitId },
            },
            409,
          );

          fixture.historyVariant = await createVariantViaApi(
            fixture,
            baseUrl,
            'VARIANT_CREATE_HISTORY',
            fixture.mainProduct.productId,
            {
              unitOfMeasureId: fixture.eachUnitId,
              sku: `T5B-HISTORY-${fixture.token}`,
              variantName: `History Variant ${fixture.token}`,
              lotTrackingMode: 'OPTIONAL',
              defaultSellingPrice: '5.0000',
              status: 'INACTIVE',
            },
          );
          const lotNumber = `T5B_LOT_${fixture.token}`;
          fixture.known.lotNumbers.add(lotNumber);
          const historyConnection = await pool.getConnection();
          try {
            await historyConnection.beginTransaction();
            await historyConnection.execute(
              `INSERT INTO branch_inventory (
                 branch_id, product_variant_id, quantity_on_hand
               ) VALUES (?, ?, '0.000')`,
              [fixture.branchId, fixture.historyVariant.productVariantId],
            );
            await historyConnection.execute(
              `INSERT INTO inventory_lots (
                 product_variant_id, lot_number, status
               ) VALUES (?, ?, 'ACTIVE')`,
              [fixture.historyVariant.productVariantId, lotNumber],
            );
            rememberId(
              fixture,
              'inventoryLots',
              await getLastInsertId(historyConnection),
            );
            await historyConnection.commit();
          } catch (error) {
            await historyConnection.rollback();
            throw error;
          } finally {
            historyConnection.release();
          }

          await expectFailedMutation(
            fixture,
            baseUrl,
            'VARIANT_HISTORY_UOM_IMMUTABLE',
            `/api/admin/catalog/variants/${fixture.historyVariant.productVariantId}`,
            {
              method: 'PATCH',
              body: { unitOfMeasureId: fixture.unusedUnitId },
            },
            409,
          );
          await expectFailedMutation(
            fixture,
            baseUrl,
            'VARIANT_HISTORY_LOT_IMMUTABLE',
            `/api/admin/catalog/variants/${fixture.historyVariant.productVariantId}`,
            {
              method: 'PATCH',
              body: { lotTrackingMode: 'NONE' },
            },
            409,
          );

          await expectFailedMutation(
            fixture,
            baseUrl,
            'PRODUCT_DEACTIVATE_ACTIVE_VARIANT',
            `/api/admin/catalog/products/${fixture.mainProduct.productId}`,
            { method: 'PATCH', body: { status: 'INACTIVE' } },
            409,
          );
          const [variantStateRows] = await pool.execute(
            `SELECT status
             FROM product_variants
             WHERE product_variant_id = ?`,
            [fixture.mainVariant.productVariantId],
          );
          assert.equal(variantStateRows[0].status, 'ACTIVE');

          assertSafeError(
            await sendRequest(
              baseUrl,
              '/api/admin/catalog/variants/0',
              { token: fixture.adminToken },
            ),
            400,
          );
        },
      );

      await t.test(
        'implements package conversion, base selection, and history safeguards',
        async () => {
          const packagePath =
            `/api/admin/catalog/variants/${fixture.mainVariant.productVariantId}/packages`;

          fixture.cartonPackage = await createPackageViaApi(
            fixture,
            baseUrl,
            'PACKAGE_CREATE_CARTON',
            fixture.mainProduct.productId,
            fixture.mainVariant.productVariantId,
            {
              packageUnitOfMeasureId: fixture.cartonUnitId,
              packageCode: ' carton ',
              packageName: `PAGEDPKG_${fixture.token} B`,
              conversionToBaseQuantity: '24',
              isPurchasable: true,
              isSellable: true,
              defaultSellingPrice: null,
              status: 'ACTIVE',
            },
          );
          assertIdString(fixture.cartonPackage.productPackageId);
          assert.equal(fixture.cartonPackage.packageCode, 'CARTON');
          assert.equal(
            fixture.cartonPackage.conversionToBaseQuantity,
            '24.000000',
          );
          assert.equal(fixture.cartonPackage.defaultSellingPrice, null);
          assert.equal(fixture.cartonPackage.isBaseUnit, false);

          fixture.mutablePackage = await createPackageViaApi(
            fixture,
            baseUrl,
            'PACKAGE_CREATE_MUTABLE',
            fixture.mainProduct.productId,
            fixture.mainVariant.productVariantId,
            {
              packageUnitOfMeasureId: fixture.cartonUnitId,
              packageCode: `PACK6_${fixture.token}`,
              packageName: `PAGEDPKG_${fixture.token} A`,
              conversionToBaseQuantity: '6.5',
              isPurchasable: false,
              isSellable: true,
              defaultSellingPrice: '60.5',
              status: 'ACTIVE',
            },
          );
          assert.equal(
            fixture.mutablePackage.defaultSellingPrice,
            '60.5000',
          );

          fixture.baseCandidatePackage = await createPackageViaApi(
            fixture,
            baseUrl,
            'PACKAGE_CREATE_BASE_CANDIDATE',
            fixture.mainProduct.productId,
            fixture.mainVariant.productVariantId,
            {
              packageUnitOfMeasureId: fixture.eachUnitId,
              packageCode: `ALT_EACH_${fixture.token}`,
              packageName: `PAGEDPKG_${fixture.token} C`,
              conversionToBaseQuantity: '1.000000',
              isPurchasable: true,
              isSellable: false,
              defaultSellingPrice: '350.0000',
              status: 'ACTIVE',
            },
          );

          fixture.otherVariantPackage = await createPackageViaApi(
            fixture,
            baseUrl,
            'PACKAGE_SAME_CODE_OTHER_VARIANT',
            fixture.secondProduct.productId,
            fixture.sameNameVariant.productVariantId,
            {
              packageUnitOfMeasureId: fixture.cartonUnitId,
              packageCode: 'CARTON',
              packageName: `Other Carton ${fixture.token}`,
              conversionToBaseQuantity: '24.000000',
              status: 'ACTIVE',
            },
          );

          const detail = await sendRequest(
            baseUrl,
            packageResourcePath(fixture.cartonPackage.productPackageId),
            { token: fixture.adminToken },
          );
          assert.equal(detail.response.status, 200);
          assert.deepEqual(
            detail.json.data.productPackage,
            fixture.cartonPackage,
          );
          assertSafeError(
            await sendRequest(
              baseUrl,
              packageResourcePath(MAX_UNSIGNED_BIGINT),
              { token: fixture.adminToken },
            ),
            404,
          );

          const paged = await sendRequest(
            baseUrl,
            `${packagePath}?search=${encodeURIComponent(
              `PAGEDPKG_${fixture.token}`,
            )}&limit=2`,
            { token: fixture.adminToken },
          );
          assert.equal(paged.response.status, 200);
          assertPagination(paged.json.data, {
            page: 1,
            limit: 2,
            totalItems: 3,
            totalPages: 2,
          });
          assert.deepEqual(
            paged.json.data.items.map(
              (productPackage) => productPackage.packageName,
            ),
            [
              `PAGEDPKG_${fixture.token} A`,
              `PAGEDPKG_${fixture.token} B`,
            ],
          );

          const packageFilterCases = [
            ['status=ACTIVE', fixture.cartonPackage.productPackageId],
            [
              `packageUnitOfMeasureId=${fixture.cartonUnitId}`,
              fixture.cartonPackage.productPackageId,
            ],
            ['isBaseUnit=true', fixture.basePackage.productPackageId],
            ['isPurchasable=false', fixture.mutablePackage.productPackageId],
            ['isSellable=false', fixture.baseCandidatePackage.productPackageId],
          ];
          for (const [query, expectedPackageId] of packageFilterCases) {
            const result = await sendRequest(
              baseUrl,
              `${packagePath}?${query}&limit=100`,
              { token: fixture.adminToken },
            );
            assert.equal(result.response.status, 200);
            assert.ok(
              result.json.data.items.some(
                (productPackage) =>
                  productPackage.productPackageId === expectedPackageId,
              ),
            );
          }

          for (const query of [
            'page=0',
            'limit=101',
            'isBaseUnit=1',
            'isPurchasable=yes',
            'isSellable=no',
            'status=DELETED',
            'packageUnitOfMeasureId=0',
            'unknown=x',
          ]) {
            assertSafeError(
              await sendRequest(baseUrl, `${packagePath}?${query}`, {
                token: fixture.adminToken,
              }),
              400,
            );
          }

          await expectFailedMutation(
            fixture,
            baseUrl,
            'PACKAGE_DUPLICATE_CODE',
            packagePath,
            {
              method: 'POST',
              body: {
                packageUnitOfMeasureId: fixture.cartonUnitId,
                packageCode: fixture.cartonPackage.packageCode,
                packageName: `Duplicate package ${fixture.token}`,
                conversionToBaseQuantity: '48.000000',
              },
            },
            409,
          );
          await expectFailedMutation(
            fixture,
            baseUrl,
            'PACKAGE_MISSING_UOM',
            packagePath,
            {
              method: 'POST',
              body: {
                packageUnitOfMeasureId: MAX_UNSIGNED_BIGINT,
                packageCode: `NO_UOM_${fixture.token}`,
                packageName: `No UOM ${fixture.token}`,
                conversionToBaseQuantity: '2.000000',
              },
            },
            404,
          );

          const invalidPackageCases = [
            ['CONVERSION_ZERO', { conversionToBaseQuantity: '0' }],
            ['CONVERSION_PRECISION', { conversionToBaseQuantity: '1.0000001' }],
            ['CONVERSION_NUMBER', { conversionToBaseQuantity: 2 }],
            ['PRICE_NUMBER', { defaultSellingPrice: 10 }],
            ['PRICE_NEGATIVE', { defaultSellingPrice: '-0.0001' }],
            ['UNKNOWN_FIELD', { barcode: `NOPE_${fixture.token}` }],
          ];
          for (const [label, body] of invalidPackageCases) {
            await expectFailedMutation(
              fixture,
              baseUrl,
              `PACKAGE_${label}`,
              packageResourcePath(fixture.mutablePackage.productPackageId),
              { method: 'PATCH', body },
              400,
            );
          }

          await expectFailedMutation(
            fixture,
            baseUrl,
            'PACKAGE_BAD_BASE_CONVERSION_CREATE',
            packagePath,
            {
              method: 'POST',
              body: {
                packageUnitOfMeasureId: fixture.eachUnitId,
                packageCode: `BAD_BASE_CONV_${fixture.token}`,
                packageName: `Bad base conversion ${fixture.token}`,
                conversionToBaseQuantity: '2.000000',
                isBaseUnit: true,
              },
            },
            409,
          );
          await expectFailedMutation(
            fixture,
            baseUrl,
            'PACKAGE_BAD_BASE_UOM_CREATE',
            packagePath,
            {
              method: 'POST',
              body: {
                packageUnitOfMeasureId: fixture.cartonUnitId,
                packageCode: `BAD_BASE_UOM_${fixture.token}`,
                packageName: `Bad base UOM ${fixture.token}`,
                conversionToBaseQuantity: '1.000000',
                isBaseUnit: true,
              },
            },
            409,
          );
          await expectFailedMutation(
            fixture,
            baseUrl,
            'PACKAGE_SECOND_ACTIVE_BASE_CREATE',
            packagePath,
            {
              method: 'POST',
              body: {
                packageUnitOfMeasureId: fixture.eachUnitId,
                packageCode: `SECOND_BASE_${fixture.token}`,
                packageName: `Second base ${fixture.token}`,
                conversionToBaseQuantity: '1.000000',
                isBaseUnit: true,
              },
            },
            409,
          );
          await expectFailedMutation(
            fixture,
            baseUrl,
            'PACKAGE_DEACTIVATE_CURRENT_BASE',
            packageResourcePath(fixture.basePackage.productPackageId),
            { method: 'PATCH', body: { status: 'INACTIVE' } },
            409,
          );
          await expectFailedMutation(
            fixture,
            baseUrl,
            'PACKAGE_DISCONTINUE_CURRENT_BASE',
            packageResourcePath(fixture.basePackage.productPackageId),
            { method: 'PATCH', body: { status: 'DISCONTINUED' } },
            409,
          );
          await expectFailedMutation(
            fixture,
            baseUrl,
            'PACKAGE_REMOVE_CURRENT_BASE',
            packageResourcePath(fixture.basePackage.productPackageId),
            { method: 'PATCH', body: { isBaseUnit: false } },
            409,
          );
          await expectFailedMutation(
            fixture,
            baseUrl,
            'PACKAGE_SECOND_ACTIVE_BASE_PATCH',
            packageResourcePath(
              fixture.baseCandidatePackage.productPackageId,
            ),
            { method: 'PATCH', body: { isBaseUnit: true } },
            409,
          );

          const noOpBase = expectNoAudit(
            fixture,
            await sendMutation(
              fixture,
              baseUrl,
              'PACKAGE_BASE_PATCH_NOOP',
              packageResourcePath(fixture.basePackage.productPackageId),
              { method: 'PATCH', body: { isBaseUnit: true } },
            ),
          );
          assert.equal(noOpBase.response.status, 200, noOpBase.responseText);

          const mutableUpdate = await sendMutation(
            fixture,
            baseUrl,
            'PACKAGE_UPDATE_IDENTITY_BEFORE_USE',
            packageResourcePath(fixture.mutablePackage.productPackageId),
            {
              method: 'PATCH',
              body: {
                packageUnitOfMeasureId: fixture.unusedUnitId,
                packageCode: `pack6_new_${fixture.token}`,
                packageName: `Mutable Updated ${fixture.token}`,
                conversionToBaseQuantity: '6.5',
                isPurchasable: true,
                isSellable: false,
                defaultSellingPrice: '61',
              },
            },
          );
          assert.equal(mutableUpdate.response.status, 200, mutableUpdate.responseText);
          expectAudit(fixture, mutableUpdate, 'PRODUCT_PACKAGE_UPDATED');
          fixture.mutablePackage = mutableUpdate.json.data.productPackage;
          assert.equal(
            fixture.mutablePackage.conversionToBaseQuantity,
            '6.500000',
          );
          assert.equal(fixture.mutablePackage.defaultSellingPrice, '61.0000');
          assert.equal(
            fixture.mutablePackage.packageUnitOfMeasureId,
            fixture.unusedUnitId,
          );

          fixture.inactiveBaseCandidate = await createPackageViaApi(
            fixture,
            baseUrl,
            'PACKAGE_CREATE_INACTIVE_BASE_CANDIDATE',
            fixture.mainProduct.productId,
            fixture.mainVariant.productVariantId,
            {
              packageUnitOfMeasureId: fixture.eachUnitId,
              packageCode: `INACTIVE_BASE_${fixture.token}`,
              packageName: `Inactive base candidate ${fixture.token}`,
              conversionToBaseQuantity: '1.000000',
              status: 'INACTIVE',
            },
          );
          fixture.conversionBaseCandidate = await createPackageViaApi(
            fixture,
            baseUrl,
            'PACKAGE_CREATE_CONVERSION_BASE_CANDIDATE',
            fixture.mainProduct.productId,
            fixture.mainVariant.productVariantId,
            {
              packageUnitOfMeasureId: fixture.eachUnitId,
              packageCode: `CONV_BASE_${fixture.token}`,
              packageName: `Conversion base candidate ${fixture.token}`,
              conversionToBaseQuantity: '2.000000',
              status: 'INACTIVE',
            },
          );
          fixture.uomBaseCandidate = await createPackageViaApi(
            fixture,
            baseUrl,
            'PACKAGE_CREATE_UOM_BASE_CANDIDATE',
            fixture.mainProduct.productId,
            fixture.mainVariant.productVariantId,
            {
              packageUnitOfMeasureId: fixture.cartonUnitId,
              packageCode: `UOM_BASE_${fixture.token}`,
              packageName: `UOM base candidate ${fixture.token}`,
              conversionToBaseQuantity: '1.000000',
              status: 'INACTIVE',
            },
          );
          for (const [label, productPackage] of [
            ['CONVERSION', fixture.conversionBaseCandidate],
            ['UOM', fixture.uomBaseCandidate],
          ]) {
            await expectFailedMutation(
              fixture,
              baseUrl,
              `PACKAGE_BASE_PATCH_${label}`,
              packageResourcePath(productPackage.productPackageId),
              { method: 'PATCH', body: { isBaseUnit: true } },
              409,
            );
          }

          const inactiveBaseDefinition = await sendMutation(
            fixture,
            baseUrl,
            'PACKAGE_DEFINE_INACTIVE_BASE',
            packageResourcePath(
              fixture.inactiveBaseCandidate.productPackageId,
            ),
            { method: 'PATCH', body: { isBaseUnit: true } },
          );
          assert.equal(
            inactiveBaseDefinition.response.status,
            200,
            inactiveBaseDefinition.responseText,
          );
          expectAudit(
            fixture,
            inactiveBaseDefinition,
            'PRODUCT_PACKAGE_UPDATED',
          );
          fixture.inactiveBaseCandidate =
            inactiveBaseDefinition.json.data.productPackage;

          const deactivateVariantForBaseChange = await sendMutation(
            fixture,
            baseUrl,
            'PACKAGE_RECONFIGURE_DEACTIVATE_VARIANT',
            `/api/admin/catalog/variants/${fixture.mainVariant.productVariantId}`,
            { method: 'PATCH', body: { status: 'INACTIVE' } },
          );
          assert.equal(
            deactivateVariantForBaseChange.response.status,
            200,
            deactivateVariantForBaseChange.responseText,
          );
          expectAudit(
            fixture,
            deactivateVariantForBaseChange,
            'PRODUCT_VARIANT_UPDATED',
          );

          const retireOldBase = await sendMutation(
            fixture,
            baseUrl,
            'PACKAGE_RECONFIGURE_RETIRE_OLD_BASE',
            packageResourcePath(fixture.basePackage.productPackageId),
            { method: 'PATCH', body: { isBaseUnit: false } },
          );
          assert.equal(
            retireOldBase.response.status,
            200,
            retireOldBase.responseText,
          );
          expectAudit(fixture, retireOldBase, 'PRODUCT_PACKAGE_UPDATED');

          const establishNewBase = await sendMutation(
            fixture,
            baseUrl,
            'PACKAGE_RECONFIGURE_ESTABLISH_NEW_BASE',
            packageResourcePath(
              fixture.baseCandidatePackage.productPackageId,
            ),
            { method: 'PATCH', body: { isBaseUnit: true } },
          );
          assert.equal(
            establishNewBase.response.status,
            200,
            establishNewBase.responseText,
          );
          expectAudit(fixture, establishNewBase, 'PRODUCT_PACKAGE_UPDATED');
          fixture.baseCandidatePackage =
            establishNewBase.json.data.productPackage;

          const reactivateVariantAfterBaseChange = await sendMutation(
            fixture,
            baseUrl,
            'PACKAGE_RECONFIGURE_REACTIVATE_VARIANT',
            `/api/admin/catalog/variants/${fixture.mainVariant.productVariantId}`,
            { method: 'PATCH', body: { status: 'ACTIVE' } },
          );
          assert.equal(
            reactivateVariantAfterBaseChange.response.status,
            200,
            reactivateVariantAfterBaseChange.responseText,
          );
          expectAudit(
            fixture,
            reactivateVariantAfterBaseChange,
            'PRODUCT_VARIANT_UPDATED',
          );

          const [baseRows] = await pool.execute(
            `SELECT CAST(product_package_id AS CHAR) AS productPackageId
             FROM product_packages
             WHERE product_variant_id = ?
               AND status = 'ACTIVE'
               AND is_base_unit = 1`,
            [fixture.mainVariant.productVariantId],
          );
          assert.deepEqual(baseRows, [
            {
              productPackageId:
                fixture.baseCandidatePackage.productPackageId,
            },
          ]);

          await createSaleItemFixture(fixture, {
            label: 'PACKAGE_BASE_FLAG_HISTORY',
            productVariantId: fixture.mainVariant.productVariantId,
            productPackageId:
              fixture.inactiveBaseCandidate.productPackageId,
            packageConversionFactor: '1.000000',
          });
          await expectFailedMutation(
            fixture,
            baseUrl,
            'PACKAGE_HISTORY_BASE_FLAG_IMMUTABLE',
            packageResourcePath(
              fixture.inactiveBaseCandidate.productPackageId,
            ),
            { method: 'PATCH', body: { isBaseUnit: false } },
            409,
          );

          await createSaleItemFixture(fixture, {
            label: 'PACKAGE_HISTORY',
            productVariantId: fixture.mainVariant.productVariantId,
            productPackageId: fixture.mutablePackage.productPackageId,
            packageConversionFactor:
              fixture.mutablePackage.conversionToBaseQuantity,
          });
          for (const [label, body] of [
            ['CONVERSION', { conversionToBaseQuantity: '7.000000' }],
            ['UOM', { packageUnitOfMeasureId: fixture.cartonUnitId }],
          ]) {
            await expectFailedMutation(
              fixture,
              baseUrl,
              `PACKAGE_HISTORY_${label}_IMMUTABLE`,
              packageResourcePath(fixture.mutablePackage.productPackageId),
              { method: 'PATCH', body },
              409,
            );
          }
          const [historicalRows] = await pool.execute(
            `SELECT package_conversion_factor AS packageConversionFactor
             FROM sale_items
             WHERE product_package_id = ?`,
            [fixture.mutablePackage.productPackageId],
          );
          assert.equal(historicalRows.length, 1);
          assert.equal(historicalRows[0].packageConversionFactor, '6.500000');

          fixture.pricedPackage = await createPackageViaApi(
            fixture,
            baseUrl,
            'PACKAGE_CREATE_BRANCH_PRICE_HISTORY',
            fixture.mainProduct.productId,
            fixture.mainVariant.productVariantId,
            {
              packageUnitOfMeasureId: fixture.cartonUnitId,
              packageCode: `PRICE_HISTORY_${fixture.token}`,
              packageName: `Branch price history ${fixture.token}`,
              conversionToBaseQuantity: '12.000000',
              status: 'ACTIVE',
            },
          );
          await pool.execute(
            `INSERT INTO branch_package_prices (
               branch_id, product_package_id, selling_price,
               updated_by_employee_id
             ) VALUES (?, ?, '120.0000', ?)`,
            [
              fixture.branchId,
              fixture.pricedPackage.productPackageId,
              fixture.adminEmployeeId,
            ],
          );
          await expectFailedMutation(
            fixture,
            baseUrl,
            'PACKAGE_BRANCH_PRICE_IDENTITY_IMMUTABLE',
            packageResourcePath(fixture.pricedPackage.productPackageId),
            {
              method: 'PATCH',
              body: { conversionToBaseQuantity: '13.000000' },
            },
            409,
          );

          assertSafeError(
            await sendRequest(baseUrl, packageResourcePath('0'), {
              token: fixture.adminToken,
            }),
            400,
          );
          assertSafeError(
            await sendRequest(
              baseUrl,
              `/api/admin/catalog/variants/${MAX_UNSIGNED_BIGINT}/packages`,
              { token: fixture.adminToken },
            ),
            404,
          );
        },
      );

      await t.test(
        'implements barcode standards, scopes, primary switching, and history safeguards',
        async () => {
          const barcodePath =
            `/api/admin/catalog/variants/${fixture.mainVariant.productVariantId}/barcodes`;
          const invalidateCheckDigit = (barcode) =>
            `${barcode.slice(0, -1)}${(Number(barcode.at(-1)) + 1) % 10}`;
          const ean8 = makeGtin(fixtureNumericPayload(fixture, 7, '0'));
          const upcA = makeGtin(fixtureNumericPayload(fixture, 11, '1'));
          const ean13 = makeGtin(fixtureNumericPayload(fixture, 12, '2'));
          const gtin14 = makeGtin(fixtureNumericPayload(fixture, 13, '3'));
          const plu4 = fixtureNumericPayload(fixture, 4, '7');
          const plu5 = fixtureNumericPayload(fixture, 5, '8');

          fixture.variantPrimaryBarcode = await createBarcodeViaApi(
            fixture,
            baseUrl,
            'BARCODE_CREATE_EAN8_PRIMARY',
            fixture.mainProduct.productId,
            fixture.mainVariant.productVariantId,
            {
              productPackageId: null,
              barcode: ean8,
              barcodeType: 'EAN_8',
              isPrimary: true,
            },
          );
          assertIdString(fixture.variantPrimaryBarcode.barcodeId);
          assert.equal(fixture.variantPrimaryBarcode.barcode, ean8);
          assert.equal(fixture.variantPrimaryBarcode.barcode.startsWith('0'), true);
          assert.equal(fixture.variantPrimaryBarcode.productPackageId, null);
          assert.equal(fixture.variantPrimaryBarcode.isPrimary, true);

          fixture.cartonPrimaryBarcode = await createBarcodeViaApi(
            fixture,
            baseUrl,
            'BARCODE_CREATE_UPCA_PACKAGE_PRIMARY',
            fixture.mainProduct.productId,
            fixture.mainVariant.productVariantId,
            {
              productPackageId: fixture.cartonPackage.productPackageId,
              barcode: upcA,
              barcodeType: 'UPC_A',
              isPrimary: true,
            },
          );
          fixture.otherPackagePrimaryBarcode = await createBarcodeViaApi(
            fixture,
            baseUrl,
            'BARCODE_CREATE_EAN13_OTHER_SCOPE_PRIMARY',
            fixture.mainProduct.productId,
            fixture.mainVariant.productVariantId,
            {
              productPackageId:
                fixture.baseCandidatePackage.productPackageId,
              barcode: ean13,
              barcodeType: 'EAN_13',
              isPrimary: true,
            },
          );
          fixture.gtinBarcode = await createBarcodeViaApi(
            fixture,
            baseUrl,
            'BARCODE_CREATE_GTIN14',
            fixture.mainProduct.productId,
            fixture.mainVariant.productVariantId,
            {
              barcode: gtin14,
              barcodeType: 'GTIN_14',
              isPrimary: false,
            },
          );
          fixture.plu4Barcode = await createBarcodeViaApi(
            fixture,
            baseUrl,
            'BARCODE_CREATE_PLU4',
            fixture.mainProduct.productId,
            fixture.mainVariant.productVariantId,
            { barcode: plu4, barcodeType: 'PLU' },
          );
          fixture.plu5Barcode = await createBarcodeViaApi(
            fixture,
            baseUrl,
            'BARCODE_CREATE_PLU5',
            fixture.mainProduct.productId,
            fixture.mainVariant.productVariantId,
            { barcode: plu5, barcodeType: 'PLU' },
          );

          const exactCaseBarcode = `CaseSensitive-${fixture.token}`;
          const lowerCaseBarcode = `casesensitive-${fixture.token}`;
          fixture.caseBarcode = await createBarcodeViaApi(
            fixture,
            baseUrl,
            'BARCODE_CREATE_CASE_PRESERVED',
            fixture.mainProduct.productId,
            fixture.mainVariant.productVariantId,
            { barcode: exactCaseBarcode, barcodeType: 'CODE_128' },
          );
          fixture.lowerCaseBarcode = await createBarcodeViaApi(
            fixture,
            baseUrl,
            'BARCODE_CREATE_CASE_DISTINCT',
            fixture.mainProduct.productId,
            fixture.mainVariant.productVariantId,
            { barcode: lowerCaseBarcode, barcodeType: 'CODE_128' },
          );
          assert.equal(fixture.caseBarcode.barcode, exactCaseBarcode);
          assert.equal(fixture.lowerCaseBarcode.barcode, lowerCaseBarcode);

          for (const [barcode, expectedBarcodeId] of [
            [ean8, fixture.variantPrimaryBarcode.barcodeId],
            [exactCaseBarcode, fixture.caseBarcode.barcodeId],
            [lowerCaseBarcode, fixture.lowerCaseBarcode.barcodeId],
          ]) {
            const lookup = await sendRequest(
              baseUrl,
              `/api/admin/catalog/barcodes/lookup?barcode=${encodeURIComponent(
                barcode,
              )}`,
              { token: fixture.adminToken },
            );
            assert.equal(lookup.response.status, 200, lookup.responseText);
            assert.equal(
              lookup.json.data.productBarcode.barcodeId,
              expectedBarcodeId,
            );
            assert.equal(lookup.json.data.productBarcode.barcode, barcode);
          }

          for (const path of [
            '/api/admin/catalog/barcodes/lookup',
            `/api/admin/catalog/barcodes/lookup?barcode=${encodeURIComponent(
              exactCaseBarcode,
            )}&unknown=x`,
          ]) {
            assertSafeError(
              await sendRequest(baseUrl, path, {
                token: fixture.adminToken,
              }),
              400,
            );
          }

          for (const barcode of [
            exactCaseBarcode.toUpperCase(),
            `DOES-NOT-EXIST-${fixture.token}`,
          ]) {
            assertSafeError(
              await sendRequest(
                baseUrl,
                `/api/admin/catalog/barcodes/lookup?barcode=${encodeURIComponent(
                  barcode,
                )}`,
                { token: fixture.adminToken },
              ),
              404,
            );
          }

          fixture.internalBarcode = await createBarcodeViaApi(
            fixture,
            baseUrl,
            'BARCODE_CREATE_INTERNAL',
            fixture.mainProduct.productId,
            fixture.mainVariant.productVariantId,
            {
              barcode: `INTERNAL-${fixture.token}`,
              barcodeType: 'INTERNAL',
            },
          );
          fixture.otherBarcode = await createBarcodeViaApi(
            fixture,
            baseUrl,
            'BARCODE_CREATE_OTHER',
            fixture.mainProduct.productId,
            fixture.mainVariant.productVariantId,
            { barcode: `Other-${fixture.token}`, barcodeType: 'OTHER' },
          );
          fixture.cartonAlternateBarcode = await createBarcodeViaApi(
            fixture,
            baseUrl,
            'BARCODE_CREATE_CARTON_ALTERNATE',
            fixture.mainProduct.productId,
            fixture.mainVariant.productVariantId,
            {
              productPackageId: fixture.cartonPackage.productPackageId,
              barcode: `CARTON-ALT-${fixture.token}`,
              barcodeType: 'CODE_128',
              isPrimary: false,
            },
          );

          for (const suffix of ['A', 'B', 'C']) {
            await createBarcodeViaApi(
              fixture,
              baseUrl,
              `BARCODE_CREATE_PAGED_${suffix}`,
              fixture.mainProduct.productId,
              fixture.mainVariant.productVariantId,
              {
                barcode: `PAGEDBAR_${fixture.token}_${suffix}`,
                barcodeType: 'OTHER',
              },
            );
          }

          const detail = await sendRequest(
            baseUrl,
            barcodeResourcePath(fixture.variantPrimaryBarcode.barcodeId),
            { token: fixture.adminToken },
          );
          assert.equal(detail.response.status, 200);
          assert.deepEqual(
            detail.json.data.productBarcode,
            fixture.variantPrimaryBarcode,
          );
          assertSafeError(
            await sendRequest(
              baseUrl,
              barcodeResourcePath(MAX_UNSIGNED_BIGINT),
              { token: fixture.adminToken },
            ),
            404,
          );

          const paged = await sendRequest(
            baseUrl,
            `${barcodePath}?search=${encodeURIComponent(
              `PAGEDBAR_${fixture.token}`,
            )}&limit=2`,
            { token: fixture.adminToken },
          );
          assert.equal(paged.response.status, 200);
          assertPagination(paged.json.data, {
            page: 1,
            limit: 2,
            totalItems: 3,
            totalPages: 2,
          });
          assert.deepEqual(
            paged.json.data.items.map((barcode) => barcode.barcode),
            [
              `PAGEDBAR_${fixture.token}_A`,
              `PAGEDBAR_${fixture.token}_B`,
            ],
          );

          const barcodeFilterCases = [
            ['barcodeType=EAN_8', fixture.variantPrimaryBarcode.barcodeId],
            [
              `productPackageId=${fixture.cartonPackage.productPackageId}`,
              fixture.cartonPrimaryBarcode.barcodeId,
            ],
            ['productPackageId=null', fixture.variantPrimaryBarcode.barcodeId],
            ['isPrimary=true', fixture.variantPrimaryBarcode.barcodeId],
          ];
          for (const [query, expectedBarcodeId] of barcodeFilterCases) {
            const result = await sendRequest(
              baseUrl,
              `${barcodePath}?${query}&limit=100`,
              { token: fixture.adminToken },
            );
            assert.equal(result.response.status, 200);
            assert.ok(
              result.json.data.items.some(
                (barcode) => barcode.barcodeId === expectedBarcodeId,
              ),
            );
          }

          for (const query of [
            'page=0',
            'limit=0',
            'limit=101',
            'barcodeType=QR',
            'productPackageId=0',
            'isPrimary=1',
            'unknown=x',
          ]) {
            assertSafeError(
              await sendRequest(baseUrl, `${barcodePath}?${query}`, {
                token: fixture.adminToken,
              }),
              400,
            );
          }

          await expectFailedMutation(
            fixture,
            baseUrl,
            'BARCODE_GLOBAL_DUPLICATE',
            `/api/admin/catalog/variants/${fixture.sameNameVariant.productVariantId}/barcodes`,
            {
              method: 'POST',
              body: { barcode: ean8, barcodeType: 'EAN_8' },
            },
            409,
          );
          await expectFailedMutation(
            fixture,
            baseUrl,
            'BARCODE_WRONG_PACKAGE_OWNER',
            barcodePath,
            {
              method: 'POST',
              body: {
                productPackageId:
                  fixture.otherVariantPackage.productPackageId,
                barcode: `WRONG-PACKAGE-${fixture.token}`,
                barcodeType: 'CODE_128',
              },
            },
            404,
          );
          await expectFailedMutation(
            fixture,
            baseUrl,
            'BARCODE_PACKAGE_PRIMARY_CONFLICT_CREATE',
            barcodePath,
            {
              method: 'POST',
              body: {
                productPackageId: fixture.cartonPackage.productPackageId,
                barcode: `CARTON-CONFLICT-${fixture.token}`,
                barcodeType: 'CODE_128',
                isPrimary: true,
              },
            },
            409,
          );

          const invalidBarcodeCases = [
            ['EAN8_FORMAT', '1234567', 'EAN_8'],
            ['EAN8_CHECK', invalidateCheckDigit(ean8), 'EAN_8'],
            ['UPCA_FORMAT', '12345678901', 'UPC_A'],
            ['UPCA_CHECK', invalidateCheckDigit(upcA), 'UPC_A'],
            ['EAN13_FORMAT', '123456789012', 'EAN_13'],
            ['EAN13_CHECK', invalidateCheckDigit(ean13), 'EAN_13'],
            ['GTIN14_FORMAT', '1234567890123', 'GTIN_14'],
            ['GTIN14_CHECK', invalidateCheckDigit(gtin14), 'GTIN_14'],
            ['PLU_SHORT', '123', 'PLU'],
            ['PLU_ALPHA', '12A4', 'PLU'],
            ['CODE128_BLANK', '   ', 'CODE_128'],
            ['INTERNAL_BLANK', '   ', 'INTERNAL'],
            ['OTHER_BLANK', '   ', 'OTHER'],
          ];
          for (const [label, barcode, barcodeType] of invalidBarcodeCases) {
            await expectFailedMutation(
              fixture,
              baseUrl,
              `BARCODE_INVALID_${label}`,
              barcodePath,
              { method: 'POST', body: { barcode, barcodeType } },
              400,
            );
          }

          const variantPrimarySwitch = await sendMutation(
            fixture,
            baseUrl,
            'BARCODE_PATCH_PRIMARY_VARIANT_SCOPE',
            barcodeResourcePath(fixture.gtinBarcode.barcodeId),
            { method: 'PATCH', body: { isPrimary: true } },
          );
          assert.equal(
            variantPrimarySwitch.response.status,
            200,
            variantPrimarySwitch.responseText,
          );
          expectAudit(
            fixture,
            variantPrimarySwitch,
            'PRODUCT_BARCODE_UPDATED',
            'PRODUCT_BARCODE_UPDATED',
          );
          assert.equal(
            variantPrimarySwitch.json.data.productBarcode.isPrimary,
            true,
          );

          const switchPrimary = await sendMutation(
            fixture,
            baseUrl,
            'BARCODE_PATCH_PRIMARY_PACKAGE_SCOPE',
            barcodeResourcePath(
              fixture.cartonAlternateBarcode.barcodeId,
            ),
            { method: 'PATCH', body: { isPrimary: true } },
          );
          assert.equal(
            switchPrimary.response.status,
            200,
            switchPrimary.responseText,
          );
          expectAudit(
            fixture,
            switchPrimary,
            'PRODUCT_BARCODE_UPDATED',
            'PRODUCT_BARCODE_UPDATED',
          );
          assert.equal(switchPrimary.json.data.productBarcode.isPrimary, true);

          const [primaryScopeRows] = await pool.execute(
            `SELECT
               CAST(barcode_id AS CHAR) AS barcodeId,
               CAST(product_package_id AS CHAR) AS productPackageId,
               is_primary AS isPrimary
             FROM product_barcodes
             WHERE barcode_id IN (?, ?, ?)`,
            [
              fixture.cartonPrimaryBarcode.barcodeId,
              fixture.cartonAlternateBarcode.barcodeId,
              fixture.otherPackagePrimaryBarcode.barcodeId,
            ],
          );
          const primaryState = Object.fromEntries(
            primaryScopeRows.map((row) => [row.barcodeId, Boolean(row.isPrimary)]),
          );
          assert.equal(
            primaryState[fixture.cartonPrimaryBarcode.barcodeId],
            false,
          );
          assert.equal(
            primaryState[fixture.cartonAlternateBarcode.barcodeId],
            true,
          );
          assert.equal(
            primaryState[fixture.otherPackagePrimaryBarcode.barcodeId],
            true,
          );

          const noOpPrimary = expectNoAudit(
            fixture,
            await sendMutation(
              fixture,
              baseUrl,
              'BARCODE_PATCH_PRIMARY_NOOP',
              barcodeResourcePath(
                fixture.cartonAlternateBarcode.barcodeId,
              ),
              { method: 'PATCH', body: { isPrimary: true } },
            ),
          );
          assert.equal(
            noOpPrimary.response.status,
            200,
            noOpPrimary.responseText,
          );

          const primaryScopeMove = await sendMutation(
            fixture,
            baseUrl,
            'BARCODE_PATCH_PRIMARY_SCOPE_MOVE',
            barcodeResourcePath(
              fixture.cartonAlternateBarcode.barcodeId,
            ),
            {
              method: 'PATCH',
              body: {
                productPackageId:
                  fixture.baseCandidatePackage.productPackageId,
              },
            },
          );
          assert.equal(
            primaryScopeMove.response.status,
            200,
            primaryScopeMove.responseText,
          );
          expectAudit(
            fixture,
            primaryScopeMove,
            'PRODUCT_BARCODE_UPDATED',
            'PRODUCT_BARCODE_UPDATED',
          );
          fixture.cartonAlternateBarcode =
            primaryScopeMove.json.data.productBarcode;
          assert.equal(
            fixture.cartonAlternateBarcode.productPackageId,
            fixture.baseCandidatePackage.productPackageId,
          );
          assert.equal(fixture.cartonAlternateBarcode.isPrimary, true);

          const [scopeMoveRows] = await pool.execute(
            `SELECT
               CAST(barcode_id AS CHAR) AS barcodeId,
               is_primary AS isPrimary
             FROM product_barcodes
             WHERE barcode_id IN (?, ?, ?)`,
            [
              fixture.cartonAlternateBarcode.barcodeId,
              fixture.otherPackagePrimaryBarcode.barcodeId,
              fixture.gtinBarcode.barcodeId,
            ],
          );
          const scopeMoveState = Object.fromEntries(
            scopeMoveRows.map((row) => [
              row.barcodeId,
              Boolean(row.isPrimary),
            ]),
          );
          assert.equal(
            scopeMoveState[fixture.cartonAlternateBarcode.barcodeId],
            true,
          );
          assert.equal(
            scopeMoveState[fixture.otherPackagePrimaryBarcode.barcodeId],
            false,
          );
          assert.equal(scopeMoveState[fixture.gtinBarcode.barcodeId], true);

          const newOtherBarcode = `OtherUpdated-${fixture.token}`;
          fixture.known.barcodes.add(newOtherBarcode);
          const barcodeUpdate = await sendMutation(
            fixture,
            baseUrl,
            'BARCODE_UPDATE_IDENTITY_BEFORE_HISTORY',
            barcodeResourcePath(fixture.otherBarcode.barcodeId),
            {
              method: 'PATCH',
              body: {
                barcode: newOtherBarcode,
                barcodeType: 'INTERNAL',
                productPackageId: null,
              },
            },
          );
          assert.equal(barcodeUpdate.response.status, 200, barcodeUpdate.responseText);
          expectAudit(fixture, barcodeUpdate, 'PRODUCT_BARCODE_UPDATED');
          fixture.otherBarcode = barcodeUpdate.json.data.productBarcode;
          assert.equal(fixture.otherBarcode.barcode, newOtherBarcode);
          assert.equal(fixture.otherBarcode.barcodeType, 'INTERNAL');

          const legacyInvalidBarcode = `LEGACY_INVALID_${fixture.token}`;
          fixture.known.barcodes.add(legacyInvalidBarcode);
          const [legacyUpdateResult] = await pool.execute(
            `UPDATE product_barcodes
             SET barcode = ?, barcode_type = 'PLU'
             WHERE barcode_id = ?`,
            [legacyInvalidBarcode, fixture.caseBarcode.barcodeId],
          );
          assert.equal(legacyUpdateResult.affectedRows, 1);
          fixture.caseBarcode = {
            ...fixture.caseBarcode,
            barcode: legacyInvalidBarcode,
            barcodeType: 'PLU',
          };

          const historicalSaleId = await createSaleItemFixture(fixture, {
            label: 'BARCODE_HISTORY',
            productVariantId: fixture.mainVariant.productVariantId,
            barcodeId: fixture.caseBarcode.barcodeId,
          });
          for (const [label, body] of [
            ['VALUE', { barcode: `CHANGED-${fixture.token}` }],
            ['TYPE', { barcodeType: 'INTERNAL' }],
            [
              'PACKAGE',
              { productPackageId: fixture.cartonPackage.productPackageId },
            ],
          ]) {
            await expectFailedMutation(
              fixture,
              baseUrl,
              `BARCODE_HISTORY_${label}_IMMUTABLE`,
              barcodeResourcePath(fixture.caseBarcode.barcodeId),
              { method: 'PATCH', body },
              409,
            );
          }

          const historicalPrimary = await sendMutation(
            fixture,
            baseUrl,
            'BARCODE_HISTORY_PRIMARY_PATCH_ALLOWED',
            barcodeResourcePath(fixture.caseBarcode.barcodeId),
            { method: 'PATCH', body: { isPrimary: true } },
          );
          assert.equal(
            historicalPrimary.response.status,
            200,
            historicalPrimary.responseText,
          );
          expectAudit(
            fixture,
            historicalPrimary,
            'PRODUCT_BARCODE_UPDATED',
            'PRODUCT_BARCODE_UPDATED',
          );
          assert.equal(historicalPrimary.json.data.productBarcode.isPrimary, true);
          assert.equal(
            historicalPrimary.json.data.productBarcode.barcode,
            legacyInvalidBarcode,
          );
          assert.equal(
            historicalPrimary.json.data.productBarcode.barcodeType,
            'PLU',
          );
          const [historicalSaleItemRows] = await pool.execute(
            `SELECT CAST(barcode_id AS CHAR) AS barcodeId
             FROM sale_items
             WHERE sale_id = ?`,
            [historicalSaleId],
          );
          assert.deepEqual(historicalSaleItemRows, [
            { barcodeId: fixture.caseBarcode.barcodeId },
          ]);

          const historicalPreference = await sendMutation(
            fixture,
            baseUrl,
            'BARCODE_HISTORY_PRIMARY_PREFERENCE_ALLOWED',
            barcodeResourcePath(fixture.caseBarcode.barcodeId),
            { method: 'PATCH', body: { isPrimary: false } },
          );
          assert.equal(
            historicalPreference.response.status,
            200,
            historicalPreference.responseText,
          );
          expectAudit(fixture, historicalPreference, 'PRODUCT_BARCODE_UPDATED');
          assert.equal(
            historicalPreference.json.data.productBarcode.isPrimary,
            false,
          );

          const deletedBarcode = await sendMutation(
            fixture,
            baseUrl,
            'BARCODE_DELETE_UNUSED',
            barcodeResourcePath(fixture.internalBarcode.barcodeId),
            { method: 'DELETE' },
          );
          assert.equal(
            deletedBarcode.response.status,
            200,
            deletedBarcode.responseText,
          );
          expectAudit(fixture, deletedBarcode, 'PRODUCT_BARCODE_DELETED');
          assert.equal(
            deletedBarcode.json.data.productBarcode.barcodeId,
            fixture.internalBarcode.barcodeId,
          );
          assert.equal(
            deletedBarcode.json.data.productBarcode.barcode,
            fixture.internalBarcode.barcode,
          );
          assertSafeError(
            await sendRequest(
              baseUrl,
              barcodeResourcePath(fixture.internalBarcode.barcodeId),
              { token: fixture.adminToken },
            ),
            404,
          );

          await expectFailedMutation(
            fixture,
            baseUrl,
            'BARCODE_DELETE_HISTORY_BLOCKED',
            barcodeResourcePath(fixture.caseBarcode.barcodeId),
            { method: 'DELETE' },
            409,
          );
          const retainedHistoricalBarcode = await sendRequest(
            baseUrl,
            barcodeResourcePath(fixture.caseBarcode.barcodeId),
            { token: fixture.adminToken },
          );
          assert.equal(
            retainedHistoricalBarcode.response.status,
            200,
            retainedHistoricalBarcode.responseText,
          );
          assert.equal(
            retainedHistoricalBarcode.json.data.productBarcode.barcodeId,
            fixture.caseBarcode.barcodeId,
          );

          assertSafeError(
            await sendRequest(baseUrl, barcodeResourcePath('0'), {
              token: fixture.adminToken,
            }),
            400,
          );
          assertSafeError(
            await sendRequest(
              baseUrl,
              `/api/admin/catalog/variants/${MAX_UNSIGNED_BIGINT}/barcodes`,
              { token: fixture.adminToken },
            ),
            404,
          );
        },
      );

      await t.test(
        'serializes activation, package history, primary, and reference writes',
        async () => {
          fixture.activationRaceVariant = await createVariantViaApi(
            fixture,
            baseUrl,
            'CONCURRENCY_CREATE_ACTIVATION_VARIANT',
            fixture.secondProduct.productId,
            {
              unitOfMeasureId: fixture.eachUnitId,
              sku: `T5B-ACT-RACE-${fixture.token}`,
              variantName: `Activation Race ${fixture.token}`,
              defaultSellingPrice: '25.0000',
              status: 'INACTIVE',
              basePackage: {
                packageCode: `ACT_BASE_${fixture.token}`,
                packageName: `Activation base ${fixture.token}`,
              },
            },
          );
          const activationPackages = await sendRequest(
            baseUrl,
            `/api/admin/catalog/variants/${fixture.activationRaceVariant.productVariantId}` +
              '/packages?isBaseUnit=true',
            { token: fixture.adminToken },
          );
          assert.equal(activationPackages.response.status, 200);
          assert.equal(activationPackages.json.data.items.length, 1);
          fixture.activationRaceBase = activationPackages.json.data.items[0];
          rememberId(
            fixture,
            'packages',
            fixture.activationRaceBase.productPackageId,
          );

          const [activationResult, baseMutationResult] = await Promise.all([
            sendMutation(
              fixture,
              baseUrl,
              'CONCURRENCY_VARIANT_ACTIVATE',
              `/api/admin/catalog/variants/${fixture.activationRaceVariant.productVariantId}`,
              { method: 'PATCH', body: { status: 'ACTIVE' } },
            ),
            sendMutation(
              fixture,
              baseUrl,
              'CONCURRENCY_BASE_DEACTIVATE',
              packageResourcePath(
                fixture.activationRaceBase.productPackageId,
              ),
              { method: 'PATCH', body: { status: 'INACTIVE' } },
            ),
          ]);
          assert.deepEqual(
            [activationResult.response.status, baseMutationResult.response.status].sort(),
            [200, 409],
          );
          if (activationResult.response.status === 200) {
            expectAudit(fixture, activationResult, 'PRODUCT_VARIANT_UPDATED');
          } else {
            expectNoAudit(fixture, activationResult);
            assertSafeError(activationResult, 409);
          }
          if (baseMutationResult.response.status === 200) {
            expectAudit(
              fixture,
              baseMutationResult,
              'PRODUCT_PACKAGE_UPDATED',
            );
          } else {
            expectNoAudit(fixture, baseMutationResult);
            assertSafeError(baseMutationResult, 409);
          }
          const [activationInvariantRows] = await pool.execute(
            `SELECT
               pv.status,
               SUM(
                 CASE
                   WHEN pp.status = 'ACTIVE' AND pp.is_base_unit = 1 THEN 1
                   ELSE 0
                 END
               ) AS activeBaseCount
             FROM product_variants pv
             LEFT JOIN product_packages pp
               ON pp.product_variant_id = pv.product_variant_id
             WHERE pv.product_variant_id = ?
             GROUP BY pv.product_variant_id, pv.status`,
            [fixture.activationRaceVariant.productVariantId],
          );
          assert.equal(activationInvariantRows.length, 1);
          assert.equal(
            activationInvariantRows[0].status === 'ACTIVE' &&
              Number(activationInvariantRows[0].activeBaseCount) !== 1,
            false,
          );

          fixture.historyRacePackage = await createPackageViaApi(
            fixture,
            baseUrl,
            'CONCURRENCY_CREATE_HISTORY_PACKAGE',
            fixture.mainProduct.productId,
            fixture.mainVariant.productVariantId,
            {
              packageUnitOfMeasureId: fixture.cartonUnitId,
              packageCode: `HISTORY_RACE_${fixture.token}`,
              packageName: `History race ${fixture.token}`,
              conversionToBaseQuantity: '5.000000',
              status: 'ACTIVE',
            },
          );

          const historyRaceConnection = await pool.getConnection();
          let structuralMutationPromise;
          try {
            await historyRaceConnection.beginTransaction();
            await historyRaceConnection.execute(
              `SELECT product_variant_id
               FROM product_variants
               WHERE product_variant_id = ?
               FOR UPDATE`,
              [fixture.mainVariant.productVariantId],
            );

            structuralMutationPromise = sendMutation(
              fixture,
              baseUrl,
              'CONCURRENCY_PACKAGE_HISTORY_PROTECTION',
              packageResourcePath(
                fixture.historyRacePackage.productPackageId,
              ),
              {
                method: 'PATCH',
                body: { conversionToBaseQuantity: '6.000000' },
              },
            );

            const saleNumber = `T5B_SALE_${fixture.token}_HISTORY_RACE`;
            fixture.known.saleNumbers.add(saleNumber);
            await historyRaceConnection.execute(
              `INSERT INTO sales (
                 sale_number, branch_id, cashier_employee_id,
                 status, currency_code
               ) VALUES (?, ?, ?, 'OPEN', 'NGN')`,
              [saleNumber, fixture.branchId, fixture.adminEmployeeId],
            );
            const saleId = rememberId(
              fixture,
              'sales',
              await getLastInsertId(historyRaceConnection),
            );
            await historyRaceConnection.execute(
              `INSERT INTO sale_items (
                 sale_id, line_number, product_variant_id,
                 product_package_id, item_description, sku_snapshot,
                 package_name_snapshot, quantity,
                 package_conversion_factor, base_quantity, unit_price,
                 discount_amount, tax_rate_percent, tax_amount, line_total
               ) VALUES (?, 1, ?, ?, ?, ?, ?, '1.000', '5.000000',
                         '5.000', '1.0000', '0.00', '0.0000', '0.00',
                         '1.00')`,
              [
                saleId,
                fixture.mainVariant.productVariantId,
                fixture.historyRacePackage.productPackageId,
                `TEST Phase 5B history race ${fixture.token}`,
                `T5B-SNAPSHOT-${fixture.token}`,
                `History race ${fixture.token}`,
              ],
            );
            rememberId(
              fixture,
              'saleItems',
              await getLastInsertId(historyRaceConnection),
            );
            await historyRaceConnection.commit();
          } catch (error) {
            await historyRaceConnection.rollback();
            throw error;
          } finally {
            historyRaceConnection.release();
          }

          const structuralMutation = expectNoAudit(
            fixture,
            await structuralMutationPromise,
          );
          assertSafeError(structuralMutation, 409);
          const [historyRaceRows] = await pool.execute(
            `SELECT
               pp.conversion_to_base_quantity AS currentConversion,
               si.package_conversion_factor AS historicalConversion
             FROM product_packages pp
             INNER JOIN sale_items si
               ON si.product_package_id = pp.product_package_id
             WHERE pp.product_package_id = ?`,
            [fixture.historyRacePackage.productPackageId],
          );
          assert.deepEqual(historyRaceRows, [
            {
              currentConversion: '5.000000',
              historicalConversion: '5.000000',
            },
          ]);

          const competingPrimaryA = await createBarcodeViaApi(
            fixture,
            baseUrl,
            'CONCURRENCY_CREATE_PRIMARY_A',
            fixture.mainProduct.productId,
            fixture.mainVariant.productVariantId,
            {
              barcode: `RACE-PRIMARY-A-${fixture.token}`,
              barcodeType: 'CODE_128',
            },
          );
          const competingPrimaryB = await createBarcodeViaApi(
            fixture,
            baseUrl,
            'CONCURRENCY_CREATE_PRIMARY_B',
            fixture.mainProduct.productId,
            fixture.mainVariant.productVariantId,
            {
              barcode: `RACE-PRIMARY-B-${fixture.token}`,
              barcodeType: 'CODE_128',
            },
          );
          const [primaryRaceA, primaryRaceB] = await Promise.all([
            sendMutation(
              fixture,
              baseUrl,
              'CONCURRENCY_PATCH_PRIMARY_A',
              barcodeResourcePath(competingPrimaryA.barcodeId),
              { method: 'PATCH', body: { isPrimary: true } },
            ),
            sendMutation(
              fixture,
              baseUrl,
              'CONCURRENCY_PATCH_PRIMARY_B',
              barcodeResourcePath(competingPrimaryB.barcodeId),
              { method: 'PATCH', body: { isPrimary: true } },
            ),
          ]);
          for (const result of [primaryRaceA, primaryRaceB]) {
            assert.equal(result.response.status, 200, result.responseText);
          }
          const [primaryCountRows] = await pool.execute(
            `SELECT
               COUNT(*) AS primaryCount,
               MAX(CAST(barcode_id AS CHAR)) AS primaryBarcodeId
             FROM product_barcodes
             WHERE product_variant_id = ?
               AND product_package_id IS NULL
               AND is_primary = 1`,
            [fixture.mainVariant.productVariantId],
          );
          assert.equal(Number(primaryCountRows[0].primaryCount), 1);
          const winnerIsA =
            primaryCountRows[0].primaryBarcodeId ===
            competingPrimaryA.barcodeId;
          const winnerResult = winnerIsA ? primaryRaceA : primaryRaceB;
          const loserResult = winnerIsA ? primaryRaceB : primaryRaceA;
          expectAudit(
            fixture,
            winnerResult,
            'PRODUCT_BARCODE_UPDATED',
            'PRODUCT_BARCODE_UPDATED',
          );
          expectAudit(fixture, loserResult, 'PRODUCT_BARCODE_UPDATED');

          const categoryMutation = sendMutation(
            fixture,
            baseUrl,
            'CONCURRENCY_CATEGORY_DEACTIVATE',
            `/api/admin/catalog/categories/${fixture.raceCategoryId}`,
            { method: 'PATCH', body: { isActive: false } },
          );
          const productReferenceMutation = sendMutation(
            fixture,
            baseUrl,
            'CONCURRENCY_PRODUCT_REFERENCE',
            `/api/admin/catalog/products/${fixture.raceProduct.productId}`,
            {
              method: 'PATCH',
              body: { categoryId: fixture.raceCategoryId },
            },
          );
          const [categoryRace, productReferenceRace] = await Promise.all([
            categoryMutation,
            productReferenceMutation,
          ]);
          assert.deepEqual(
            [categoryRace.response.status, productReferenceRace.response.status].sort(),
            [200, 409],
          );
          if (categoryRace.response.status === 200) {
            expectAudit(fixture, categoryRace, 'CATEGORY_UPDATED');
          } else {
            expectNoAudit(fixture, categoryRace);
            assertSafeError(categoryRace, 409);
          }
          if (productReferenceRace.response.status === 200) {
            expectAudit(fixture, productReferenceRace, 'PRODUCT_UPDATED');
          } else {
            expectNoAudit(fixture, productReferenceRace);
            assertSafeError(productReferenceRace, 409);
          }
          const [referenceInvariantRows] = await pool.execute(
            `SELECT
               CAST(p.category_id AS CHAR) AS categoryId,
               p.status,
               c.is_active AS categoryIsActive
             FROM products p
             INNER JOIN categories c ON c.category_id = p.category_id
             WHERE p.product_id = ?`,
            [fixture.raceProduct.productId],
          );
          assert.equal(referenceInvariantRows.length, 1);
          assert.equal(referenceInvariantRows[0].status, 'ACTIVE');
          assert.equal(Boolean(referenceInvariantRows[0].categoryIsActive), true);
          if (
            referenceInvariantRows[0].categoryId === fixture.raceCategoryId
          ) {
            assert.equal(categoryRace.response.status, 409);
          }
        },
      );

      await t.test(
        'keeps collection contracts deterministic and limits physical deletion',
        async () => {
          fixture.requiredLotVariant = await createVariantViaApi(
            fixture,
            baseUrl,
            'VARIANT_CREATE_REQUIRED_EXPIRY',
            fixture.mainProduct.productId,
            {
              unitOfMeasureId: fixture.eachUnitId,
              sku: `T5B-REQ-LOT-${fixture.token}`,
              variantName: `Required lot ${fixture.token}`,
              lotTrackingMode: 'REQUIRED',
              requiresExpiryDate: true,
              defaultSellingPrice: '15.0000',
              status: 'INACTIVE',
            },
          );
          assert.equal(
            fixture.requiredLotVariant.lotTrackingMode,
            'REQUIRED',
          );
          assert.equal(fixture.requiredLotVariant.requiresExpiryDate, true);

          await expectFailedMutation(
            fixture,
            baseUrl,
            'VARIANT_MISSING_REQUIRED_PRICE',
            `/api/admin/catalog/products/${fixture.mainProduct.productId}/variants`,
            {
              method: 'POST',
              body: {
                unitOfMeasureId: fixture.eachUnitId,
                sku: `T5B-NO-PRICE-${fixture.token}`,
                variantName: `Missing price ${fixture.token}`,
                status: 'INACTIVE',
              },
            },
            400,
          );

          const collectionDefinitions = [
            {
              path: '/api/admin/catalog/products',
              countSql: 'SELECT COUNT(*) AS count FROM products',
              parameters: [],
            },
            {
              path:
                `/api/admin/catalog/products/${fixture.mainProduct.productId}` +
                '/variants',
              countSql:
                'SELECT COUNT(*) AS count FROM product_variants WHERE product_id = ?',
              parameters: [fixture.mainProduct.productId],
            },
            {
              path:
                `/api/admin/catalog/variants/${fixture.mainVariant.productVariantId}/packages`,
              countSql:
                'SELECT COUNT(*) AS count FROM product_packages WHERE product_variant_id = ?',
              parameters: [fixture.mainVariant.productVariantId],
            },
            {
              path:
                `/api/admin/catalog/variants/${fixture.mainVariant.productVariantId}/barcodes`,
              countSql:
                'SELECT COUNT(*) AS count FROM product_barcodes WHERE product_variant_id = ?',
              parameters: [fixture.mainVariant.productVariantId],
            },
          ];

          for (const definition of collectionDefinitions) {
            const [[countRow]] = await pool.execute(
              definition.countSql,
              definition.parameters,
            );
            const defaultPage = await sendRequest(baseUrl, definition.path, {
              token: fixture.adminToken,
            });
            assert.equal(defaultPage.response.status, 200);
            assertPagination(defaultPage.json.data, {
              page: 1,
              limit: 20,
              totalItems: Number(countRow.count),
              totalPages:
                Number(countRow.count) === 0
                  ? 0
                  : Math.ceil(Number(countRow.count) / 20),
            });
            for (const item of defaultPage.json.data.items) {
              assertNoSecretMaterial(item, fixture);
            }

            const maximumPage = await sendRequest(
              baseUrl,
              `${definition.path}?limit=100`,
              { token: fixture.adminToken },
            );
            assert.equal(maximumPage.response.status, 200);
            assertPagination(maximumPage.json.data, {
              page: 1,
              limit: 100,
              totalItems: Number(countRow.count),
            });

            const injectionLikeSearch = await sendRequest(
              baseUrl,
              `${definition.path}?search=${encodeURIComponent("%' OR 1=1 --")}`,
              { token: fixture.adminToken },
            );
            assert.equal(injectionLikeSearch.response.status, 200);
            assertPagination(injectionLikeSearch.json.data, {
              page: 1,
              limit: 20,
            });
          }

          const deletePaths = [
            `/api/admin/catalog/products/${fixture.mainProduct.productId}`,
            `/api/admin/catalog/variants/${fixture.mainVariant.productVariantId}`,
            packageResourcePath(fixture.cartonPackage.productPackageId),
          ];
          for (const path of deletePaths) {
            assertSafeError(
              await sendRequest(baseUrl, path, {
                method: 'DELETE',
                token: fixture.adminToken,
              }),
              404,
            );
          }
        },
      );

      await t.test(
        'writes actor-aware audit snapshots only for committed mutations',
        async () => {
          const classifiedRequestIds = new Set([
            ...fixture.expectedAuditActions.keys(),
            ...fixture.noAuditRequestIds,
          ]);
          assert.deepEqual(
            [...classifiedRequestIds].sort(),
            [...fixture.requestIds].sort(),
            'Every mutation request must be classified as audited or deliberately unaudited.',
          );
          for (const requestId of fixture.noAuditRequestIds) {
            assert.equal(fixture.expectedAuditActions.has(requestId), false);
          }

          const requestIds = [...fixture.requestIds];
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
             WHERE request_id IN (${placeholders(requestIds)})
             ORDER BY audit_log_id`,
            requestIds,
          );
          const auditRows = rows.map((row) => ({
            ...row,
            beforeValues: parseJsonColumn(row.beforeValues),
            afterValues: parseJsonColumn(row.afterValues),
          }));
          for (const row of auditRows) {
            rememberId(fixture, 'audits', row.auditLogId);
          }

          const rowsByRequestId = new Map();
          for (const row of auditRows) {
            const requestRows = rowsByRequestId.get(row.requestId) ?? [];
            requestRows.push(row);
            rowsByRequestId.set(row.requestId, requestRows);
          }
          assert.equal(
            auditRows.length,
            [...fixture.expectedAuditActions.values()].reduce(
              (total, actions) => total + actions.length,
              0,
            ),
          );

          for (const [requestId, expectedActions] of
            fixture.expectedAuditActions) {
            assert.deepEqual(
              (rowsByRequestId.get(requestId) ?? [])
                .map((row) => row.actionType)
                .sort(),
              expectedActions,
              `Unexpected audit actions for ${requestId}.`,
            );
          }
          for (const requestId of fixture.noAuditRequestIds) {
            assert.equal(rowsByRequestId.has(requestId), false);
          }

          const requiredProductActions = [
            'PRODUCT_CREATED',
            'PRODUCT_UPDATED',
            'PRODUCT_VARIANT_CREATED',
            'PRODUCT_VARIANT_UPDATED',
            'PRODUCT_PACKAGE_CREATED',
            'PRODUCT_PACKAGE_UPDATED',
            'PRODUCT_BARCODE_CREATED',
            'PRODUCT_BARCODE_UPDATED',
            'PRODUCT_BARCODE_DELETED',
          ];
          assert.deepEqual(
            [
              ...new Set(
                auditRows
                  .map((row) => row.actionType)
                  .filter((actionType) => actionType.startsWith('PRODUCT_')),
              ),
            ].sort(),
            requiredProductActions.sort(),
          );

          for (const row of auditRows) {
            assertIdString(row.auditLogId);
            assertIdString(row.userId);
            assert.match(row.entityRecordId, /^[1-9]\d*$/);
            assert.equal(row.branchId, null);
            assert.equal(row.userAgent, TEST_USER_AGENT);
            assert.ok(row.occurredAt);
            assert.equal(typeof row.entityType, 'string');
            assert.equal(typeof row.notes, 'string');

            if (row.requestId.includes('GLOBAL_MANAGER_PRODUCT_CREATE')) {
              assert.equal(row.userId, fixture.managerUserId);
              assert.equal(row.employeeId, null);
            } else {
              assert.equal(row.userId, fixture.adminUserId);
              assert.equal(row.employeeId, fixture.adminEmployeeId);
            }

            if (row.actionType.endsWith('_CREATED')) {
              assert.equal(row.beforeValues, null);
              assert.ok(row.afterValues);
            } else if (row.actionType === 'PRODUCT_BARCODE_DELETED') {
              assert.ok(row.beforeValues);
              assert.equal(row.afterValues, null);
            } else {
              assert.ok(row.beforeValues);
              assert.ok(row.afterValues);
            }
            assertNoSecretMaterial(row, fixture);
          }

          const nestedCreateRows = auditRows.filter((row) =>
            row.requestId.includes('VARIANT_CREATE_ACTIVE_WITH_BASE'),
          );
          assert.deepEqual(
            nestedCreateRows.map((row) => row.entityType).sort(),
            ['product_packages', 'product_variants'],
          );

          for (const [requestId, expectedActions] of
            fixture.expectedAuditActions) {
            if (
              expectedActions.length !== 2 ||
              expectedActions.some(
                (actionType) =>
                  actionType !== 'PRODUCT_BARCODE_UPDATED',
              )
            ) {
              continue;
            }

            const switchRows = rowsByRequestId.get(requestId) ?? [];
            assert.equal(switchRows.length, 2);
            assert.equal(
              new Set(switchRows.map((row) => row.entityRecordId)).size,
              2,
            );
            assert.equal(
              switchRows.some(
                (row) =>
                  row.beforeValues.isPrimary === true &&
                  row.afterValues.isPrimary === false,
              ),
              true,
            );
            assert.equal(
              switchRows.some((row) => row.afterValues.isPrimary === true),
              true,
            );
          }

          const deleteAuditRows = auditRows.filter(
            (auditRow) =>
              auditRow.actionType === 'PRODUCT_BARCODE_DELETED',
          );
          assert.equal(deleteAuditRows.length, 1);
          assert.equal(deleteAuditRows[0].entityType, 'product_barcodes');
          assert.equal(
            deleteAuditRows[0].entityRecordId,
            fixture.internalBarcode.barcodeId,
          );
          assert.equal(
            deleteAuditRows[0].beforeValues.barcode,
            fixture.internalBarcode.barcode,
          );
          assert.equal(deleteAuditRows[0].afterValues, null);

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
        await verifyFixtureCleanup(fixture);
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
          'Phase 5B integration cleanup failed.',
        );
      }
    }
  },
);
