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

const TEST_TIMEOUT_MS = 600_000;
const MAX_UNSIGNED_BIGINT = '18446744073709551615';
const TEST_USER_AGENT = 'TEST_PHASE5C_PRICING/1.0';
const DUE_AT = '2000-01-01T00:00:00.000000Z';
const FUTURE_AT = '2099-01-01T00:00:00.000000Z';

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
    'Phase 5C live integration tests require the documented environment variables.',
  );
}

function fixtureDefinition() {
  const token = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
  const lowerToken = token.toLowerCase();

  return {
    token,
    lowerToken,
    auditPrefix: `TEST_P5C_${token}`,
    requestCounter: 0,
    expectedAudits: new Map(),
    noAuditRequests: new Set(),
    setupCommitted: false,
    ids: {
      branches: [],
      employees: [],
      assignments: [],
      roles: [],
      users: [],
      userRoles: [],
      units: [],
      categories: [],
      products: [],
      variants: [],
      packages: [],
    },
  };
}

function assertId(value) {
  assert.equal(typeof value, 'string');
  assert.match(value, /^[1-9]\d*$/);
}

async function lastInsertId(connection) {
  const [rows] = await connection.execute(
    'SELECT CAST(LAST_INSERT_ID() AS CHAR) AS insertedId',
  );
  return rows[0].insertedId;
}

async function rememberInsert(connection, fixture, collection) {
  const id = await lastInsertId(connection);
  assertId(id);
  fixture.ids[collection].push(id);
  return id;
}

function placeholders(values) {
  return values.map(() => '?').join(', ');
}

function startServer() {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1');
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
}

async function stopServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function serverBaseUrl(server) {
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

async function sendRequest(baseUrl, path, options = {}) {
  const headers = new Headers(options.headers);

  if (options.token) headers.set('authorization', `Bearer ${options.token}`);
  if (!headers.has('user-agent')) headers.set('user-agent', TEST_USER_AGENT);

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

  return { response, responseText, json };
}

function nextRequestId(fixture, label) {
  fixture.requestCounter += 1;
  return `${fixture.auditPrefix}_${String(fixture.requestCounter).padStart(3, '0')}_${label}`.slice(0, 100);
}

async function sendTracked(fixture, baseUrl, label, path, options = {}) {
  const requestId = nextRequestId(fixture, label);
  const result = await sendRequest(baseUrl, path, {
    ...options,
    token: options.token ?? fixture.tokens.admin,
    headers: { ...options.headers, 'x-request-id': requestId },
  });
  return { ...result, requestId };
}

function expectAudit(fixture, result, actionType) {
  fixture.expectedAudits.set(result.requestId, actionType);
  return result;
}

function expectNoAudit(fixture, result) {
  fixture.noAuditRequests.add(result.requestId);
  return result;
}

function assertSafeError(result, statusCode) {
  assert.equal(result.response.status, statusCode, result.responseText);
  assert.equal(result.json?.success, false);
  assert.equal(typeof result.json?.message, 'string');
  const serialized = JSON.stringify(result.json);

  for (const forbidden of [
    'ER_',
    'sqlMessage',
    'sqlState',
    'constraint',
    'stack',
    'passwordHash',
    'password_hash',
    'DB_PASSWORD',
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
}

function priceBody(sellingPrice, effectiveFrom = DUE_AT, isActive = true) {
  return { sellingPrice, effectiveFrom, isActive };
}

function branchPriceRoot(fixture, branchId = fixture.branchAId) {
  return `/api/admin/branches/${branchId}/prices`;
}

async function createFixture(fixture) {
  const connection = await pool.getConnection();
  const passwordHash = await bcrypt.hash(
    `Phase5C-${fixture.token}-Password!`,
    Number(process.env.BCRYPT_ROUNDS),
  );

  try {
    await connection.beginTransaction();
    const permissionCodes = ACCESS_CONTROL_PERMISSIONS.map(
      (permission) => permission.code,
    );
    assert.equal(permissionCodes.length, 30);
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

    for (const suffix of ['A', 'B']) {
      await connection.execute(
        `INSERT INTO branches (
           branch_code, branch_name, address_line_1, city,
           country_code, currency_code, timezone, status
         ) VALUES (?, ?, '1 Pricing Test Street', 'Lagos',
                   'NG', 'NGN', 'Africa/Lagos', 'ACTIVE')`,
        [`T5C${suffix}_${fixture.token}`, `TEST Phase 5C Branch ${suffix} ${fixture.token}`],
      );
      fixture[`branch${suffix}Id`] = await rememberInsert(
        connection,
        fixture,
        'branches',
      );
    }

    for (const key of ['scoped', 'unassigned']) {
      await connection.execute(
        `INSERT INTO employees (
           employee_number, first_name, last_name, email,
           hire_date, employment_status
         ) VALUES (?, 'Phase5C', ?, ?, '2020-01-01', 'ACTIVE')`,
        [
          `T5C_${key.toUpperCase()}_${fixture.token}`,
          key,
          `phase5c-${key}-${fixture.lowerToken}@example.invalid`,
        ],
      );
      fixture[`${key}EmployeeId`] = await rememberInsert(
        connection,
        fixture,
        'employees',
      );
    }

    await connection.execute(
      `INSERT INTO employee_branch_assignments (
         employee_id, branch_id, job_title, started_on, is_primary
       ) VALUES (?, ?, 'Pricing Administrator', '2020-01-01', 1)`,
      [fixture.scopedEmployeeId, fixture.branchAId],
    );
    fixture.ids.assignments.push(await lastInsertId(connection));

    const roleDefinitions = {
      both: ['pricing.read', 'pricing.manage', 'products.read', 'products.manage'],
      read: ['pricing.read'],
      manage: ['pricing.manage'],
      catalog: ['catalog.read', 'catalog.manage'],
      products: ['products.read', 'products.manage'],
    };
    fixture.roleIds = {};

    for (const [key, rolePermissions] of Object.entries(roleDefinitions)) {
      await connection.execute(
        `INSERT INTO roles (role_code, role_name, description, is_active)
         VALUES (?, ?, 'Temporary Phase 5C role', 1)`,
        [
          `T5C_${key.toUpperCase()}_${fixture.token}`,
          `TEST Phase 5C ${key} ${fixture.token}`,
        ],
      );
      const roleId = await rememberInsert(connection, fixture, 'roles');
      fixture.roleIds[key] = roleId;

      for (const permissionCode of rolePermissions) {
        await connection.execute(
          `INSERT INTO role_permissions (role_id, permission_id)
           VALUES (?, ?)`,
          [roleId, permissionIds[permissionCode]],
        );
      }
    }

    const users = [
      ['admin', null, 0],
      ['must', null, 1],
      ['denied', null, 0],
      ['catalog', null, 0],
      ['products', null, 0],
      ['scoped', fixture.scopedEmployeeId, 0],
      ['scopedRead', null, 0],
      ['scopedManage', null, 0],
      ['unassigned', fixture.unassignedEmployeeId, 0],
      ['globalRead', null, 0],
      ['globalManage', null, 0],
    ];
    fixture.userIds = {};
    fixture.tokens = {};

    for (const [key, employeeId, mustChange] of users) {
      const username = `t5c.${key.toLowerCase()}.${fixture.lowerToken}`;
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
      const userId = await rememberInsert(connection, fixture, 'users');
      fixture.userIds[key] = userId;
      fixture.tokens[key] = signAccessToken(userId).accessToken;
    }

    const grants = [
      ['admin', 'both', null],
      ['must', 'both', null],
      ['catalog', 'catalog', null],
      ['products', 'products', null],
      ['scoped', 'both', fixture.branchAId],
      ['scopedRead', 'read', fixture.branchAId],
      ['scopedManage', 'manage', fixture.branchAId],
      ['unassigned', 'both', fixture.branchBId],
      ['globalRead', 'read', null],
      ['globalManage', 'manage', null],
    ];

    for (const [userKey, roleKey, branchId] of grants) {
      await connection.execute(
        `INSERT INTO user_roles (user_id, role_id, branch_id)
         VALUES (?, ?, ?)`,
        [fixture.userIds[userKey], fixture.roleIds[roleKey], branchId],
      );
      fixture.ids.userRoles.push(await lastInsertId(connection));
    }

    await connection.execute(
      `INSERT INTO units_of_measure (
         unit_code, unit_name, symbol, allows_fraction
       ) VALUES (?, ?, 'ea', 0)`,
      [`T5CU_${fixture.token}`, `TEST Phase 5C Unit ${fixture.token}`],
    );
    fixture.unitId = await rememberInsert(connection, fixture, 'units');

    await connection.execute(
      `INSERT INTO categories (
         category_code, category_name, description, is_active
       ) VALUES (?, ?, 'Temporary Phase 5C category', 1)`,
      [`T5CC_${fixture.token}`, `TEST Phase 5C Category ${fixture.token}`],
    );
    fixture.categoryId = await rememberInsert(connection, fixture, 'categories');

    await connection.execute(
      `INSERT INTO products (
         category_id, product_code, product_name, status
       ) VALUES (?, ?, ?, 'ACTIVE')`,
      [
        fixture.categoryId,
        `T5CP_${fixture.token}`,
        `TEST Phase 5C Product ${fixture.token}`,
      ],
    );
    fixture.productId = await rememberInsert(connection, fixture, 'products');

    const variants = [
      ['authVariant', 'AUTH', '1.0000'],
      ['mainVariant', 'MAIN', '12.3456'],
      ['derivedVariant', 'DERIVED', '0.1001'],
      ['emptyVariant', 'EMPTY', '3.2100'],
      ['raceVariant', 'RACE', '5.0000'],
    ];

    for (const [key, code, defaultPrice] of variants) {
      await connection.execute(
        `INSERT INTO product_variants (
           product_id, unit_of_measure_id, sku, variant_name,
           units_per_pack, is_fractional, lot_tracking_mode,
           requires_expiry_date, default_selling_price, status
         ) VALUES (?, ?, ?, ?, '1.000', 0, 'NONE', 0, ?, 'ACTIVE')`,
        [
          fixture.productId,
          fixture.unitId,
          `T5C-${code}-${fixture.token}`,
          `TEST ${code} Variant ${fixture.token}`,
          defaultPrice,
        ],
      );
      fixture[`${key}Id`] = await rememberInsert(
        connection,
        fixture,
        'variants',
      );
    }

    async function insertPackage(
      key,
      variantId,
      code,
      conversion,
      defaultPrice,
      isBase = false,
    ) {
      await connection.execute(
        `INSERT INTO product_packages (
           product_variant_id, package_unit_of_measure_id,
           package_code, package_name, conversion_to_base_quantity,
           is_base_unit, is_purchasable, is_sellable,
           default_selling_price, status
         ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, 'ACTIVE')`,
        [
          variantId,
          fixture.unitId,
          `${code}_${fixture.token}`,
          `TEST ${code} Package ${fixture.token}`,
          conversion,
          isBase ? 1 : 0,
          defaultPrice,
        ],
      );
      fixture[`${key}Id`] = await rememberInsert(
        connection,
        fixture,
        'packages',
      );
    }

    await insertPackage('authPackage', fixture.authVariantId, 'AUTH_BASE', '1.000000', '1.0000', true);
    await insertPackage('mainBasePackage', fixture.mainVariantId, 'MAIN_BASE', '1.000000', null, true);
    await insertPackage('branchPackage', fixture.mainVariantId, 'BRANCH_PACK', '2.000000', '6.0000');
    await insertPackage('defaultPackage', fixture.mainVariantId, 'DEFAULT_PACK', '3.000000', '4.5678');
    await insertPackage('lifecyclePackage', fixture.mainVariantId, 'LIFECYCLE_PACK', '4.000000', null);
    await insertPackage('derivedBasePackage', fixture.derivedVariantId, 'DERIVED_BASE', '1.000000', null, true);
    await insertPackage('derivedPackage', fixture.derivedVariantId, 'DERIVED_PACK', '3.333333', null);
    await insertPackage('emptyBasePackage', fixture.emptyVariantId, 'EMPTY_BASE', '1.000000', null, true);
    await insertPackage('raceBasePackage', fixture.raceVariantId, 'RACE_BASE', '1.000000', null, true);

    await connection.execute(
      `INSERT INTO branch_variant_prices (
         branch_id, product_variant_id, selling_price,
         effective_from, is_active, updated_by_employee_id
       ) VALUES (?, ?, '5.0000', '2000-01-01 00:00:00.000000', 1, NULL)`,
      [fixture.branchAId, fixture.authVariantId],
    );
    await connection.execute(
      `INSERT INTO branch_package_prices (
         branch_id, product_package_id, selling_price,
         effective_from, is_active, updated_by_employee_id
       ) VALUES (?, ?, '6.0000', '2000-01-01 00:00:00.000000', 1, NULL)`,
      [fixture.branchAId, fixture.authPackageId],
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

async function deleteByIds(connection, table, idColumn, ids) {
  if (ids.length === 0) return;
  await connection.execute(
    `DELETE FROM ${table} WHERE ${idColumn} IN (${placeholders(ids)})`,
    ids,
  );
}

async function cleanupFixture(fixture) {
  if (!fixture.setupCommitted) return;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    await connection.execute(
      `DELETE FROM audit_logs
       WHERE branch_id IN (?, ?)
          OR request_id LIKE CONCAT(?, '%')`,
      [fixture.branchAId, fixture.branchBId, fixture.auditPrefix],
    );
    await connection.execute(
      'DELETE FROM branch_package_prices WHERE branch_id IN (?, ?)',
      [fixture.branchAId, fixture.branchBId],
    );
    await connection.execute(
      'DELETE FROM branch_variant_prices WHERE branch_id IN (?, ?)',
      [fixture.branchAId, fixture.branchBId],
    );
    await deleteByIds(connection, 'product_packages', 'product_package_id', fixture.ids.packages);
    await deleteByIds(connection, 'product_variants', 'product_variant_id', fixture.ids.variants);
    await deleteByIds(connection, 'products', 'product_id', fixture.ids.products);
    await deleteByIds(connection, 'user_roles', 'user_role_id', fixture.ids.userRoles);
    await deleteByIds(connection, 'users', 'user_id', fixture.ids.users);
    await deleteByIds(connection, 'role_permissions', 'role_id', fixture.ids.roles);
    await deleteByIds(connection, 'roles', 'role_id', fixture.ids.roles);
    await deleteByIds(connection, 'employee_branch_assignments', 'assignment_id', fixture.ids.assignments);
    await deleteByIds(connection, 'employees', 'employee_id', fixture.ids.employees);
    await deleteByIds(connection, 'branches', 'branch_id', fixture.ids.branches);
    await deleteByIds(connection, 'categories', 'category_id', fixture.ids.categories);
    await deleteByIds(connection, 'units_of_measure', 'unit_of_measure_id', fixture.ids.units);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function verifyCleanup(fixture) {
  const checks = [
    ['branches', 'branch_code'],
    ['employees', 'employee_number'],
    ['roles', 'role_code'],
    ['users', 'username'],
    ['units_of_measure', 'unit_code'],
    ['categories', 'category_code'],
    ['products', 'product_code'],
    ['product_variants', 'sku'],
    ['product_packages', 'package_code'],
  ];

  for (const [table, column] of checks) {
    const [rows] = await pool.execute(
      `SELECT COUNT(*) AS count FROM ${table} WHERE ${column} LIKE ?`,
      [`%${fixture.token}%`],
    );
    assert.equal(Number(rows[0].count), 0, `Cleanup left rows in ${table}`);
  }

  const [auditRows] = await pool.execute(
    'SELECT COUNT(*) AS count FROM audit_logs WHERE request_id LIKE CONCAT(?, \'%\')',
    [fixture.auditPrefix],
  );
  assert.equal(Number(auditRows[0].count), 0);
}

async function assertNoStockSideEffects(fixture) {
  const [inventoryRows] = await pool.execute(
    `SELECT COUNT(*) AS count
     FROM branch_inventory
     WHERE branch_id IN (?, ?)`,
    [fixture.branchAId, fixture.branchBId],
  );
  const [transactionRows] = await pool.execute(
    `SELECT COUNT(*) AS count
     FROM inventory_transactions
     WHERE branch_id IN (?, ?)`,
    [fixture.branchAId, fixture.branchBId],
  );
  const [lotRows] = await pool.execute(
    `SELECT COUNT(*) AS count
     FROM inventory_lots
     WHERE product_variant_id IN (${placeholders(fixture.ids.variants)})`,
    fixture.ids.variants,
  );

  assert.equal(Number(inventoryRows[0].count), 0);
  assert.equal(Number(transactionRows[0].count), 0);
  assert.equal(Number(lotRows[0].count), 0);
}

test(
  'Phase 5C branch pricing and effective-price integration',
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const fixture = fixtureDefinition();
    let server;

    try {
      await createFixture(fixture);
      server = await startServer();
      const baseUrl = serverBaseUrl(server);
      const rootA = branchPriceRoot(fixture);
      const rootB = branchPriceRoot(fixture, fixture.branchBId);
      const authBody = priceBody('5.0000');
      const authPackageBody = priceBody('6.0000');
      const routeDefinitions = [
        ['GET', `${rootA}/variants`],
        ['GET', `${rootA}/variants/${fixture.authVariantId}`],
        ['PUT', `${rootA}/variants/${fixture.authVariantId}`, authBody],
        ['GET', `${rootA}/packages`],
        ['GET', `${rootA}/packages/${fixture.authPackageId}`],
        ['PUT', `${rootA}/packages/${fixture.authPackageId}`, authPackageBody],
        ['GET', `${rootA}/effective/variants/${fixture.authVariantId}`],
        ['GET', `${rootA}/effective/packages/${fixture.authPackageId}`],
      ];

      await t.test('enforces the exact branch-aware eight-route surface', async () => {
        for (const [method, path, body] of routeDefinitions) {
          assertSafeError(
            await sendRequest(baseUrl, path, { method, body }),
            401,
          );
          for (const token of [
            fixture.tokens.must,
            fixture.tokens.denied,
            fixture.tokens.catalog,
            fixture.tokens.products,
          ]) {
            assertSafeError(
              await sendRequest(baseUrl, path, { method, body, token }),
              token === fixture.tokens.must ? 403 : 403,
            );
          }

          const wrongBranchPath = path.replace(rootA, rootB);
          assertSafeError(
            await sendRequest(baseUrl, wrongBranchPath, {
              method,
              body,
              token: fixture.tokens.scoped,
            }),
            403,
          );
          assertSafeError(
            await sendRequest(baseUrl, wrongBranchPath, {
              method,
              body,
              token: fixture.tokens.unassigned,
            }),
            403,
          );
        }

        for (const [method, path, body] of routeDefinitions) {
          const result = await sendRequest(baseUrl, path, {
            method,
            body,
            token: fixture.tokens.scoped,
          });
          assert.equal(result.response.status, 200, result.responseText);

          const leastPrivilegeToken =
            method === 'GET'
              ? fixture.tokens.scopedRead
              : fixture.tokens.scopedManage;
          const leastPrivilegeResult = await sendRequest(baseUrl, path, {
            method,
            body,
            token: leastPrivilegeToken,
          });
          assert.equal(
            leastPrivilegeResult.response.status,
            200,
            leastPrivilegeResult.responseText,
          );

          const insufficientPricingToken =
            method === 'GET'
              ? fixture.tokens.scopedManage
              : fixture.tokens.scopedRead;
          assertSafeError(
            await sendRequest(baseUrl, path, {
              method,
              body,
              token: insufficientPricingToken,
            }),
            403,
          );
        }

        for (const [root, variantPrice, packagePrice] of [
          [rootA, '5.0000', '6.0000'],
          [rootB, '5.5000', '6.5000'],
        ]) {
          const variantPut = await sendRequest(
            baseUrl,
            `${root}/variants/${fixture.authVariantId}`,
            {
              method: 'PUT',
              token: fixture.tokens.globalManage,
              body: priceBody(variantPrice),
            },
          );
          assert.equal(variantPut.response.status, 200, variantPut.responseText);
          const packagePut = await sendRequest(
            baseUrl,
            `${root}/packages/${fixture.authPackageId}`,
            {
              method: 'PUT',
              token: fixture.tokens.globalManage,
              body: priceBody(packagePrice),
            },
          );
          assert.equal(packagePut.response.status, 200, packagePut.responseText);
        }

        for (const [method, path] of routeDefinitions.filter(
          ([routeMethod]) => routeMethod === 'GET',
        )) {
          const globalPath = path.replace(rootA, rootB);
          const result = await sendRequest(baseUrl, globalPath, {
            method,
            token: fixture.tokens.globalRead,
          });
          assert.equal(result.response.status, 200, result.responseText);
        }

        for (const [path, status] of [
          ['/api/admin/branches/0/prices/variants', 400],
          [`/api/admin/branches/${MAX_UNSIGNED_BIGINT}/prices/variants`, 404],
          [`${rootA}/variants/0`, 400],
          [`${rootA}/variants/${MAX_UNSIGNED_BIGINT}`, 404],
          [`${rootA}/packages/0`, 400],
          [`${rootA}/packages/${MAX_UNSIGNED_BIGINT}`, 404],
        ]) {
          assertSafeError(
            await sendRequest(baseUrl, path, { token: fixture.tokens.admin }),
            status,
          );
        }

        for (const path of [
          `${rootA}/variants/${fixture.authVariantId}`,
          `${rootA}/packages/${fixture.authPackageId}`,
          `${rootA}/effective/variants/${fixture.authVariantId}`,
          `${rootA}/effective/packages/${fixture.authPackageId}`,
        ]) {
          assertSafeError(
            await sendRequest(baseUrl, path, {
              method: 'DELETE',
              token: fixture.tokens.admin,
            }),
            404,
          );
        }
      });

      await t.test('creates, replaces, validates, and resolves variant prices', async () => {
        assertSafeError(
          await sendRequest(baseUrl, `${rootA}/variants/${fixture.mainVariantId}`, {
            token: fixture.tokens.globalRead,
          }),
          404,
        );
        const fallback = await sendTracked(
          fixture,
          baseUrl,
          'VARIANT_EFFECTIVE_NO_CONFIG',
          `${rootA}/effective/variants/${fixture.mainVariantId}`,
          { token: fixture.tokens.globalRead },
        );
        expectNoAudit(fixture, fallback);
        assert.equal(fallback.response.status, 200);
        assert.deepEqual(
          {
            price: fallback.json.data.effectivePrice.sellingPrice,
            source: fallback.json.data.effectivePrice.source,
          },
          { price: '12.3456', source: 'VARIANT_DEFAULT' },
        );

        const created = expectAudit(
          fixture,
          await sendTracked(
            fixture,
            baseUrl,
            'VARIANT_PRICE_CREATE',
            `${rootA}/variants/${fixture.mainVariantId}`,
            {
              method: 'PUT',
              token: fixture.tokens.scoped,
              body: priceBody('13.5'),
            },
          ),
          'BRANCH_VARIANT_PRICE_CREATED',
        );
        assert.equal(created.response.status, 200, created.responseText);
        const createdPrice = created.json.data.branchVariantPrice;
        assert.equal(createdPrice.sellingPrice, '13.5000');
        assert.equal(createdPrice.effectiveFrom, DUE_AT);
        assert.equal(createdPrice.isActive, true);
        assert.equal(createdPrice.updatedByEmployeeId, fixture.scopedEmployeeId);
        assertId(createdPrice.productVariantId);

        const detail = await sendRequest(
          baseUrl,
          `${rootA}/variants/${fixture.mainVariantId}`,
          { token: fixture.tokens.globalRead },
        );
        assert.equal(detail.response.status, 200);
        assert.equal(detail.json.data.branchVariantPrice.sellingPrice, '13.5000');

        const list = await sendRequest(
          baseUrl,
          `${rootA}/variants?search=${encodeURIComponent(`T5C-MAIN-${fixture.token}`)}&effectiveStatus=EFFECTIVE&limit=1`,
          { token: fixture.tokens.globalRead },
        );
        assert.equal(list.response.status, 200, list.responseText);
        assert.equal(list.json.data.items.length, 1);
        assert.equal(list.json.data.pagination.limit, 1);
        assert.equal(list.json.data.items[0].productVariantId, fixture.mainVariantId);

        const noOp = expectNoAudit(
          fixture,
          await sendTracked(
            fixture,
            baseUrl,
            'VARIANT_PRICE_NOOP',
            `${rootA}/variants/${fixture.mainVariantId}`,
            { method: 'PUT', body: priceBody('13.5000') },
          ),
        );
        assert.equal(noOp.response.status, 200, noOp.responseText);
        assert.equal(
          noOp.json.data.branchVariantPrice.updatedByEmployeeId,
          fixture.scopedEmployeeId,
        );

        const invalidBodies = [
          { ...priceBody('1.0000'), sellingPrice: 1 },
          priceBody('-1'),
          priceBody('1e3'),
          priceBody('1.00001'),
          priceBody('1000000000000000'),
          { ...priceBody('1.0000'), isActive: 1 },
          { ...priceBody('1.0000'), effectiveFrom: '2025-02-29T00:00:00Z' },
          { ...priceBody('1.0000'), effectiveFrom: '2025-01-01T00:00:00+01:00' },
          { ...priceBody('1.0000'), updatedByEmployeeId: fixture.scopedEmployeeId },
          { sellingPrice: '1.0000', effectiveFrom: DUE_AT },
        ];
        for (const [index, body] of invalidBodies.entries()) {
          const failed = expectNoAudit(
            fixture,
            await sendTracked(
              fixture,
              baseUrl,
              `VARIANT_INVALID_${index}`,
              `${rootA}/variants/${fixture.mainVariantId}`,
              { method: 'PUT', body },
            ),
          );
          assertSafeError(failed, 400);
        }

        for (const query of [
          'page=0',
          'limit=101',
          'isActive=1',
          'effectiveStatus=NOW',
          'unsupported=x',
        ]) {
          assertSafeError(
            await sendRequest(baseUrl, `${rootA}/variants?${query}`, {
              token: fixture.tokens.globalRead,
            }),
            400,
          );
        }

        const future = expectAudit(
          fixture,
          await sendTracked(
            fixture,
            baseUrl,
            'VARIANT_PRICE_FUTURE',
            `${rootA}/variants/${fixture.mainVariantId}`,
            { method: 'PUT', body: priceBody('14', FUTURE_AT) },
          ),
          'BRANCH_VARIANT_PRICE_UPDATED',
        );
        assert.equal(future.response.status, 200);
        const futureEffective = await sendRequest(
          baseUrl,
          `${rootA}/effective/variants/${fixture.mainVariantId}`,
          { token: fixture.tokens.globalRead },
        );
        assert.equal(futureEffective.json.data.effectivePrice.source, 'VARIANT_DEFAULT');

        const disabled = expectAudit(
          fixture,
          await sendTracked(
            fixture,
            baseUrl,
            'VARIANT_PRICE_DISABLE',
            `${rootA}/variants/${fixture.mainVariantId}`,
            { method: 'PUT', body: priceBody('14', DUE_AT, false) },
          ),
          'BRANCH_VARIANT_PRICE_UPDATED',
        );
        assert.equal(disabled.response.status, 200);
        const disabledEffective = await sendRequest(
          baseUrl,
          `${rootA}/effective/variants/${fixture.mainVariantId}`,
          { token: fixture.tokens.globalRead },
        );
        assert.equal(disabledEffective.json.data.effectivePrice.source, 'VARIANT_DEFAULT');

        const due = expectAudit(
          fixture,
          await sendTracked(
            fixture,
            baseUrl,
            'VARIANT_PRICE_DUE',
            `${rootA}/variants/${fixture.mainVariantId}`,
            { method: 'PUT', body: priceBody('14.25') },
          ),
          'BRANCH_VARIANT_PRICE_UPDATED',
        );
        assert.equal(due.response.status, 200);
        const dueEffective = await sendRequest(
          baseUrl,
          `${rootA}/effective/variants/${fixture.mainVariantId}`,
          { token: fixture.tokens.globalRead },
        );
        assert.equal(dueEffective.json.data.effectivePrice.sellingPrice, '14.2500');
        assert.equal(dueEffective.json.data.effectivePrice.source, 'BRANCH_VARIANT');

        assertSafeError(
          await sendRequest(baseUrl, `${rootA}/variants/${fixture.emptyVariantId}`, {
            token: fixture.tokens.globalRead,
          }),
          404,
        );
        const emptyEffective = await sendRequest(
          baseUrl,
          `${rootA}/effective/variants/${fixture.emptyVariantId}`,
          { token: fixture.tokens.globalRead },
        );
        assert.equal(emptyEffective.response.status, 200);
        assert.equal(emptyEffective.json.data.effectivePrice.sellingPrice, '3.2100');

        const [countRows] = await pool.execute(
          `SELECT COUNT(*) AS count FROM branch_variant_prices
           WHERE branch_id = ? AND product_variant_id = ?`,
          [fixture.branchAId, fixture.mainVariantId],
        );
        assert.equal(Number(countRows[0].count), 1);
        await assertNoStockSideEffects(fixture);
      });

      await t.test('implements package precedence and exact derived arithmetic', async () => {
        assertSafeError(
          await sendRequest(baseUrl, `${rootA}/packages/${fixture.branchPackageId}`, {
            token: fixture.tokens.globalRead,
          }),
          404,
        );
        const initialDefault = await sendRequest(
          baseUrl,
          `${rootA}/effective/packages/${fixture.branchPackageId}`,
          { token: fixture.tokens.globalRead },
        );
        assert.equal(initialDefault.response.status, 200);
        assert.equal(initialDefault.json.data.effectivePrice.source, 'PACKAGE_DEFAULT');
        assert.equal(initialDefault.json.data.effectivePrice.sellingPrice, '6.0000');

        const created = expectAudit(
          fixture,
          await sendTracked(
            fixture,
            baseUrl,
            'PACKAGE_PRICE_CREATE',
            `${rootA}/packages/${fixture.branchPackageId}`,
            {
              method: 'PUT',
              token: fixture.tokens.scoped,
              body: priceBody('20.5'),
            },
          ),
          'BRANCH_PACKAGE_PRICE_CREATED',
        );
        assert.equal(created.response.status, 200, created.responseText);
        assert.equal(created.json.data.branchPackagePrice.sellingPrice, '20.5000');
        assert.equal(
          created.json.data.branchPackagePrice.updatedByEmployeeId,
          fixture.scopedEmployeeId,
        );

        const branchEffective = await sendRequest(
          baseUrl,
          `${rootA}/effective/packages/${fixture.branchPackageId}`,
          { token: fixture.tokens.globalRead },
        );
        assert.equal(branchEffective.json.data.effectivePrice.source, 'BRANCH_PACKAGE');
        assert.equal(branchEffective.json.data.effectivePrice.sellingPrice, '20.5000');

        const noOp = expectNoAudit(
          fixture,
          await sendTracked(
            fixture,
            baseUrl,
            'PACKAGE_PRICE_NOOP',
            `${rootA}/packages/${fixture.branchPackageId}`,
            { method: 'PUT', body: priceBody('20.5000') },
          ),
        );
        assert.equal(noOp.response.status, 200);
        assert.equal(
          noOp.json.data.branchPackagePrice.updatedByEmployeeId,
          fixture.scopedEmployeeId,
        );

        const future = expectAudit(
          fixture,
          await sendTracked(
            fixture,
            baseUrl,
            'PACKAGE_PRICE_FUTURE',
            `${rootA}/packages/${fixture.branchPackageId}`,
            { method: 'PUT', body: priceBody('22', FUTURE_AT) },
          ),
          'BRANCH_PACKAGE_PRICE_UPDATED',
        );
        assert.equal(future.response.status, 200);
        const futureFallback = await sendRequest(
          baseUrl,
          `${rootA}/effective/packages/${fixture.branchPackageId}`,
          { token: fixture.tokens.globalRead },
        );
        assert.equal(futureFallback.json.data.effectivePrice.source, 'PACKAGE_DEFAULT');

        const disabled = expectAudit(
          fixture,
          await sendTracked(
            fixture,
            baseUrl,
            'PACKAGE_PRICE_DISABLE',
            `${rootA}/packages/${fixture.branchPackageId}`,
            { method: 'PUT', body: priceBody('22', DUE_AT, false) },
          ),
          'BRANCH_PACKAGE_PRICE_UPDATED',
        );
        assert.equal(disabled.response.status, 200);
        const disabledFallback = await sendRequest(
          baseUrl,
          `${rootA}/effective/packages/${fixture.branchPackageId}`,
          { token: fixture.tokens.globalRead },
        );
        assert.equal(disabledFallback.json.data.effectivePrice.source, 'PACKAGE_DEFAULT');

        const due = expectAudit(
          fixture,
          await sendTracked(
            fixture,
            baseUrl,
            'PACKAGE_PRICE_DUE',
            `${rootA}/packages/${fixture.branchPackageId}`,
            { method: 'PUT', body: priceBody('21.125') },
          ),
          'BRANCH_PACKAGE_PRICE_UPDATED',
        );
        assert.equal(due.response.status, 200);

        const packageDefault = await sendRequest(
          baseUrl,
          `${rootA}/effective/packages/${fixture.defaultPackageId}`,
          { token: fixture.tokens.globalRead },
        );
        assert.equal(packageDefault.response.status, 200);
        assert.equal(packageDefault.json.data.effectivePrice.source, 'PACKAGE_DEFAULT');
        assert.equal(packageDefault.json.data.effectivePrice.sellingPrice, '4.5678');
        assertSafeError(
          await sendRequest(baseUrl, `${rootA}/packages/${fixture.defaultPackageId}`, {
            token: fixture.tokens.globalRead,
          }),
          404,
        );

        const derivedDefault = await sendRequest(
          baseUrl,
          `${rootA}/effective/packages/${fixture.derivedPackageId}`,
          { token: fixture.tokens.globalRead },
        );
        assert.equal(derivedDefault.response.status, 200);
        assert.deepEqual(
          {
            price: derivedDefault.json.data.effectivePrice.sellingPrice,
            source: derivedDefault.json.data.effectivePrice.source,
            variantSource:
              derivedDefault.json.data.effectivePrice.variantPriceSource,
          },
          {
            price: '0.3337',
            source: 'DERIVED_FROM_VARIANT',
            variantSource: 'VARIANT_DEFAULT',
          },
        );

        const derivedVariantOverride = expectAudit(
          fixture,
          await sendTracked(
            fixture,
            baseUrl,
            'DERIVED_VARIANT_PRICE_CREATE',
            `${rootA}/variants/${fixture.derivedVariantId}`,
            { method: 'PUT', body: priceBody('0.2002') },
          ),
          'BRANCH_VARIANT_PRICE_CREATED',
        );
        assert.equal(derivedVariantOverride.response.status, 200);
        const derivedBranch = await sendRequest(
          baseUrl,
          `${rootA}/effective/packages/${fixture.derivedPackageId}`,
          { token: fixture.tokens.globalRead },
        );
        assert.deepEqual(
          {
            price: derivedBranch.json.data.effectivePrice.sellingPrice,
            source: derivedBranch.json.data.effectivePrice.source,
            variantPrice: derivedBranch.json.data.effectivePrice.variantSellingPrice,
            variantSource: derivedBranch.json.data.effectivePrice.variantPriceSource,
            conversion: derivedBranch.json.data.effectivePrice.conversionToBaseQuantity,
          },
          {
            price: '0.6673',
            source: 'DERIVED_FROM_VARIANT',
            variantPrice: '0.2002',
            variantSource: 'BRANCH_VARIANT',
            conversion: '3.333333',
          },
        );

        const list = await sendRequest(
          baseUrl,
          `${rootA}/packages?search=${encodeURIComponent('BRANCH_PACK')}&isActive=true`,
          { token: fixture.tokens.globalRead },
        );
        assert.equal(list.response.status, 200);
        assert.equal(list.json.data.items.length, 1);

        for (const body of [
          { ...priceBody('1.0000'), sellingPrice: 1 },
          priceBody('-1'),
          priceBody('1e2'),
          priceBody('1.00001'),
          priceBody('1000000000000000.0000'),
          { ...priceBody('1.0000'), isActive: 'true' },
          { ...priceBody('1.0000'), unknown: true },
          { ...priceBody('1.0000'), effectiveFrom: 'invalid' },
        ]) {
          const failed = expectNoAudit(
            fixture,
            await sendTracked(
              fixture,
              baseUrl,
              'PACKAGE_INVALID',
              `${rootA}/packages/${fixture.branchPackageId}`,
              { method: 'PUT', body },
            ),
          );
          assertSafeError(failed, 400);
        }


        for (const query of [
          'page=0',
          'limit=101',
          'isActive=1',
          'effectiveStatus=NOW',
          'unsupported=x',
        ]) {
          assertSafeError(
            await sendRequest(baseUrl, `${rootA}/packages?${query}`, {
              token: fixture.tokens.globalRead,
            }),
            400,
          );
        }

        const [countRows] = await pool.execute(
          `SELECT COUNT(*) AS count FROM branch_package_prices
           WHERE branch_id = ? AND product_package_id = ?`,
          [fixture.branchAId, fixture.branchPackageId],
        );
        assert.equal(Number(countRows[0].count), 1);
        await assertNoStockSideEffects(fixture);
      });

      await t.test('serializes competing PUTs and a package-history race', async () => {
        const variantBodies = [
          priceBody('21.1111', DUE_AT, true),
          priceBody('22.2222', FUTURE_AT, false),
        ];
        const variantRequests = await Promise.all(
          variantBodies.map((body, index) =>
            sendTracked(
              fixture,
              baseUrl,
              `VARIANT_RACE_${index}`,
              `${rootA}/variants/${fixture.raceVariantId}`,
              { method: 'PUT', body },
            ),
          ),
        );
        for (const result of variantRequests) {
          assert.equal(result.response.status, 200, result.responseText);
        }
        const [variantAuditRows] = await pool.execute(
          `SELECT request_id AS requestId, action_type AS actionType
           FROM audit_logs
           WHERE request_id IN (?, ?)`,
          variantRequests.map((result) => result.requestId),
        );
        assert.deepEqual(
          variantAuditRows.map((row) => row.actionType).sort(),
          ['BRANCH_VARIANT_PRICE_CREATED', 'BRANCH_VARIANT_PRICE_UPDATED'],
        );
        for (const row of variantAuditRows) {
          fixture.expectedAudits.set(row.requestId, row.actionType);
        }
        const [variantRows] = await pool.execute(
          `SELECT selling_price AS sellingPrice,
                  DATE_FORMAT(effective_from, '%Y-%m-%dT%H:%i:%s.%fZ') AS effectiveFrom,
                  is_active AS isActive
           FROM branch_variant_prices
           WHERE branch_id = ? AND product_variant_id = ?`,
          [fixture.branchAId, fixture.raceVariantId],
        );
        assert.equal(variantRows.length, 1);
        assert.equal(
          variantBodies.some(
            (body) =>
              body.sellingPrice === variantRows[0].sellingPrice &&
              body.effectiveFrom === variantRows[0].effectiveFrom &&
              body.isActive === Boolean(variantRows[0].isActive),
          ),
          true,
        );

        const packageBodies = [
          priceBody('31.1111', DUE_AT, true),
          priceBody('32.2222', FUTURE_AT, false),
        ];
        const packageRequests = await Promise.all(
          packageBodies.map((body, index) =>
            sendTracked(
              fixture,
              baseUrl,
              `PACKAGE_RACE_${index}`,
              `${rootA}/packages/${fixture.raceBasePackageId}`,
              { method: 'PUT', body },
            ),
          ),
        );
        for (const result of packageRequests) {
          assert.equal(result.response.status, 200, result.responseText);
        }
        const [packageAuditRows] = await pool.execute(
          `SELECT request_id AS requestId, action_type AS actionType
           FROM audit_logs
           WHERE request_id IN (?, ?)`,
          packageRequests.map((result) => result.requestId),
        );
        assert.deepEqual(
          packageAuditRows.map((row) => row.actionType).sort(),
          ['BRANCH_PACKAGE_PRICE_CREATED', 'BRANCH_PACKAGE_PRICE_UPDATED'],
        );
        for (const row of packageAuditRows) {
          fixture.expectedAudits.set(row.requestId, row.actionType);
        }
        const [packageRows] = await pool.execute(
          `SELECT selling_price AS sellingPrice,
                  DATE_FORMAT(effective_from, '%Y-%m-%dT%H:%i:%s.%fZ') AS effectiveFrom,
                  is_active AS isActive
           FROM branch_package_prices
           WHERE branch_id = ? AND product_package_id = ?`,
          [fixture.branchAId, fixture.raceBasePackageId],
        );
        assert.equal(packageRows.length, 1);
        assert.equal(
          packageBodies.some(
            (body) =>
              body.sellingPrice === packageRows[0].sellingPrice &&
              body.effectiveFrom === packageRows[0].effectiveFrom &&
              body.isActive === Boolean(packageRows[0].isActive),
          ),
          true,
        );

        const pricingRaceRequest = sendTracked(
          fixture,
          baseUrl,
          'LIFECYCLE_RACE_PRICE',
          `${rootA}/packages/${fixture.lifecyclePackageId}`,
          { method: 'PUT', body: priceBody('40.0000') },
        );
        const lifecycleRequestId = nextRequestId(fixture, 'LIFECYCLE_RACE_PACKAGE');
        const lifecycleRaceRequest = sendRequest(
          baseUrl,
          `/api/admin/catalog/packages/${fixture.lifecyclePackageId}`,
          {
            method: 'PATCH',
            token: fixture.tokens.admin,
            headers: { 'x-request-id': lifecycleRequestId },
            body: { conversionToBaseQuantity: '4.500000' },
          },
        );
        const [pricingResult, lifecycleResult] = await Promise.all([
          pricingRaceRequest,
          lifecycleRaceRequest,
        ]);
        assert.equal(pricingResult.response.status, 200, pricingResult.responseText);
        expectAudit(fixture, pricingResult, 'BRANCH_PACKAGE_PRICE_CREATED');
        assert.ok([200, 409].includes(lifecycleResult.response.status));
        if (lifecycleResult.response.status === 200) {
          fixture.expectedAudits.set(lifecycleRequestId, 'PRODUCT_PACKAGE_UPDATED');
        } else {
          fixture.noAuditRequests.add(lifecycleRequestId);
        }
        const [finalLifecycleRows] = await pool.execute(
          `SELECT pp.conversion_to_base_quantity AS conversion,
                  COUNT(bpp.product_package_id) AS priceCount
           FROM product_packages pp
           LEFT JOIN branch_package_prices bpp
             ON bpp.product_package_id = pp.product_package_id
            AND bpp.branch_id = ?
           WHERE pp.product_package_id = ?
           GROUP BY pp.product_package_id`,
          [fixture.branchAId, fixture.lifecyclePackageId],
        );
        assert.equal(Number(finalLifecycleRows[0].priceCount), 1);
        assert.equal(
          finalLifecycleRows[0].conversion,
          lifecycleResult.response.status === 200 ? '4.500000' : '4.000000',
        );
        await assertNoStockSideEffects(fixture);
      });

      await t.test('writes only committed pricing audits and no stock state', async () => {
        const getWithRequest = expectNoAudit(
          fixture,
          await sendTracked(
            fixture,
            baseUrl,
            'GET_NO_AUDIT',
            `${rootA}/variants`,
            { token: fixture.tokens.globalRead },
          ),
        );
        assert.equal(getWithRequest.response.status, 200);

        const requestIds = [
          ...fixture.expectedAudits.keys(),
          ...fixture.noAuditRequests,
        ];
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
             after_values AS afterValues,
             request_id AS requestId,
             user_agent AS userAgent
           FROM audit_logs
           WHERE request_id IN (${placeholders(requestIds)})`,
          requestIds,
        );
        const rowsByRequest = new Map(rows.map((row) => [row.requestId, row]));

        for (const [requestId, actionType] of fixture.expectedAudits) {
          const row = rowsByRequest.get(requestId);
          assert.ok(row, `Missing audit for ${requestId}`);
          assert.equal(row.actionType, actionType);
          assert.equal(row.userAgent, TEST_USER_AGENT);
          assert.ok(
            [
              'branch_variant_prices',
              'branch_package_prices',
              'product_packages',
            ].includes(row.entityType),
          );

          if (actionType.startsWith('BRANCH_')) {
            assert.match(row.entityRecordId, /^\d+:\d+$/);
          } else {
            assert.match(row.entityRecordId, /^\d+$/);
          }

          if (actionType.endsWith('_CREATED')) {
            assert.equal(row.beforeValues, null);
            assert.ok(row.afterValues);
          } else {
            assert.ok(row.beforeValues);
            assert.ok(row.afterValues);
          }

          if (actionType.startsWith('BRANCH_')) {
            assert.equal(row.branchId, fixture.branchAId);
          }
        }
        for (const requestId of fixture.noAuditRequests) {
          assert.equal(rowsByRequest.has(requestId), false);
        }

        const pricingActions = rows
          .map((row) => row.actionType)
          .filter((action) => action.startsWith('BRANCH_'));
        assert.deepEqual(
          [...new Set(pricingActions)].sort(),
          [
            'BRANCH_PACKAGE_PRICE_CREATED',
            'BRANCH_PACKAGE_PRICE_UPDATED',
            'BRANCH_VARIANT_PRICE_CREATED',
            'BRANCH_VARIANT_PRICE_UPDATED',
          ],
        );

        const [createdAuditRows] = await pool.execute(
          `SELECT CAST(user_id AS CHAR) AS userId,
                  CAST(employee_id AS CHAR) AS employeeId,
                  CAST(branch_id AS CHAR) AS branchId,
                  before_values AS beforeValues,
                  after_values AS afterValues
           FROM audit_logs
           WHERE request_id IN (?, ?)`,
          [
            [...fixture.expectedAudits.entries()].find(
              ([, action]) => action === 'BRANCH_VARIANT_PRICE_CREATED',
            )[0],
            [...fixture.expectedAudits.entries()].find(
              ([, action]) => action === 'BRANCH_PACKAGE_PRICE_CREATED',
            )[0],
          ],
        );
        assert.equal(
          createdAuditRows.some(
            (row) =>
              row.userId === fixture.userIds.scoped &&
              row.employeeId === fixture.scopedEmployeeId &&
              row.branchId === fixture.branchAId,
          ),
          true,
        );

        await assertNoStockSideEffects(fixture);
        const [databaseRows] = await pool.execute(
          `SELECT DATABASE() AS databaseName,
                  (SELECT COUNT(*) FROM information_schema.tables
                   WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE') AS tableCount`,
        );
        assert.equal(databaseRows[0].databaseName, 'supermarket_management');
        assert.equal(Number(databaseRows[0].tableCount), 54);

        const canonicalCodes = ACCESS_CONTROL_PERMISSIONS.map(
          (permission) => permission.code,
        );
        const [permissionRows] = await pool.execute(
          `SELECT COUNT(*) AS count FROM permissions
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
        assert.equal(Number(permissionRows[0].count), 30);
        assert.equal(Number(mappingRows[0].count), 30);
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
        await verifyCleanup(fixture);
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
          'Phase 5C integration cleanup failed.',
        );
      }
    }
  },
);
