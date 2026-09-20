import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
const TEST_USER_AGENT = 'TEST_PHASE6_SUPPLIER_CATALOG/1.0';

function fixtureDefinition() {
  const token = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
  const lower = token.toLowerCase();

  return {
    token,
    lower,
    prefix: `TEST_P6_${token}`,
    requestCounter: 0,
    requestIds: [],
    supplierIds: [],
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

async function send(baseUrl, path, options = {}) {
  const headers = new Headers(options.headers);
  if (options.token) headers.set('authorization', `Bearer ${options.token}`);
  headers.set('user-agent', TEST_USER_AGENT);
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
  };
}

async function tracked(fixture, baseUrl, label, path, options = {}) {
  fixture.requestCounter += 1;
  const requestId = `${fixture.prefix}_${fixture.requestCounter}_${label}`.slice(
    0,
    100,
  );
  fixture.requestIds.push(requestId);

  return {
    ...(await send(baseUrl, path, {
      ...options,
      token: options.token ?? fixture.tokens.admin,
      headers: { ...options.headers, 'x-request-id': requestId },
    })),
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
  for (const forbidden of ['ER_', 'sqlMessage', 'constraint', 'stack', 'DB_PASSWORD']) {
    assert.equal(serialized.includes(forbidden), false);
  }
}

async function createFixture(fixture) {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    const seed = await ensureAccessControl(connection);
    assert.equal(seed.permissionCount, 32);
    assert.equal(seed.assignedPermissionCount, 32);

    const permissionCodes = ACCESS_CONTROL_PERMISSIONS.map(({ code }) => code);
    assert.equal(permissionCodes.length, 32);
    assert.equal(new Set(permissionCodes).size, 32);
    const [permissionRows] = await connection.execute(
      `SELECT CAST(permission_id AS CHAR) AS permissionId, permission_code AS code
       FROM permissions
       WHERE permission_code IN (${placeholders(permissionCodes)})`,
      permissionCodes,
    );
    const permissionIds = Object.fromEntries(
      permissionRows.map((row) => [row.code, row.permissionId]),
    );

    await connection.execute(
      `INSERT INTO branches (
         branch_code, branch_name, address_line_1, city,
         country_code, currency_code, timezone, status
       ) VALUES (?, ?, '1 Supplier Test Street', 'Lagos',
                 'NG', 'NGN', 'Africa/Lagos', 'ACTIVE')`,
      [`T6B_${fixture.token}`, `${fixture.prefix} Branch`],
    );
    fixture.branchId = await lastInsertId(connection);

    const roleDefinitions = {
      read: ['suppliers.read'],
      manage: ['suppliers.manage'],
      catalog: ['catalog.read', 'catalog.manage'],
      products: ['products.read', 'products.manage'],
      pricing: ['pricing.read', 'pricing.manage'],
      scoped: ['suppliers.read', 'suppliers.manage'],
      none: [],
    };
    fixture.roleIds = {};

    for (const [name, codes] of Object.entries(roleDefinitions)) {
      await connection.execute(
        `INSERT INTO roles (role_code, role_name, description, is_active)
         VALUES (?, ?, 'Temporary Phase 6 role', 1)`,
        [`T6_${name.toUpperCase()}_${fixture.token}`, `${fixture.prefix} ${name}`],
      );
      const roleId = await lastInsertId(connection);
      fixture.roleIds[name] = roleId;

      for (const code of codes) {
        await connection.execute(
          `INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)`,
          [roleId, permissionIds[code]],
        );
      }
    }

    const [systemRoleRows] = await connection.execute(
      `SELECT CAST(role_id AS CHAR) AS roleId
       FROM roles
       WHERE role_code = ?`,
      [SYSTEM_ADMIN_ROLE.code],
    );
    fixture.systemRoleId = systemRoleRows[0].roleId;
    const passwordHash = await bcrypt.hash(
      `Phase6-${fixture.token}-Password!`,
      Number(process.env.BCRYPT_ROUNDS),
    );
    const users = [
      ['admin', 0, fixture.systemRoleId, null],
      ['must', 1, fixture.systemRoleId, null],
      ['read', 0, fixture.roleIds.read, null],
      ['manage', 0, fixture.roleIds.manage, null],
      ['catalog', 0, fixture.roleIds.catalog, null],
      ['products', 0, fixture.roleIds.products, null],
      ['pricing', 0, fixture.roleIds.pricing, null],
      ['scoped', 0, fixture.roleIds.scoped, fixture.branchId],
      ['none', 0, fixture.roleIds.none, null],
    ];
    fixture.userIds = [];
    fixture.tokens = {};

    for (const [name, mustChange, roleId, branchId] of users) {
      await connection.execute(
        `INSERT INTO users (
           username, email, password_hash, is_active, must_change_password
         ) VALUES (?, ?, ?, 1, ?)`,
        [
          `t6.${name}.${fixture.lower}`,
          `t6.${name}.${fixture.lower}@example.invalid`,
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

    await connection.execute(
      `INSERT INTO units_of_measure (
         unit_code, unit_name, symbol, allows_fraction
       ) VALUES (?, ?, ?, 0)`,
      [`T6U_${fixture.token}`, `${fixture.prefix} unit`, `t6${fixture.token}`],
    );
    fixture.unitId = await lastInsertId(connection);
    await connection.execute(
      `INSERT INTO units_of_measure (
         unit_code, unit_name, symbol, allows_fraction
       ) VALUES (?, ?, ?, 0)`,
      [`T6X_${fixture.token}`, `${fixture.prefix} alternate unit`, `x6${fixture.token}`],
    );
    fixture.alternateUnitId = await lastInsertId(connection);
    await connection.execute(
      `INSERT INTO categories (
         category_code, category_name, description, is_active
       ) VALUES (?, ?, 'Phase 6 fixture', 1)`,
      [`T6C_${fixture.token}`, `${fixture.prefix} category`],
    );
    fixture.categoryId = await lastInsertId(connection);
    await connection.execute(
      `INSERT INTO products (
         category_id, product_code, product_name, status
       ) VALUES (?, ?, ?, 'ACTIVE')`,
      [fixture.categoryId, `T6P_${fixture.token}`, `${fixture.prefix} product`],
    );
    fixture.productId = await lastInsertId(connection);
    fixture.variantIds = [];
    fixture.packageIds = [];

    for (let index = 1; index <= 3; index += 1) {
      await connection.execute(
        `INSERT INTO product_variants (
           product_id, unit_of_measure_id, sku, variant_name,
           default_selling_price, status
         ) VALUES (?, ?, ?, ?, '100.0000', 'ACTIVE')`,
        [
          fixture.productId,
          fixture.unitId,
          `T6V${index}_${fixture.token}`,
          `${fixture.prefix} variant ${index}`,
        ],
      );
      const variantId = await lastInsertId(connection);
      fixture.variantIds.push(variantId);
      await connection.execute(
        `INSERT INTO product_packages (
           product_variant_id, package_unit_of_measure_id,
           package_code, package_name, conversion_to_base_quantity,
           is_base_unit, is_purchasable, is_sellable, status
         ) VALUES (?, ?, ?, ?, '1.000000', 1, 1, 1, 'ACTIVE')`,
        [
          variantId,
          fixture.unitId,
          `T6PK${index}_${fixture.token}`,
          `${fixture.prefix} package ${index}`,
        ],
      );
      fixture.packageIds.push(await lastInsertId(connection));
    }

    await connection.execute(
      `INSERT INTO product_packages (
         product_variant_id, package_unit_of_measure_id,
         package_code, package_name, conversion_to_base_quantity,
         is_base_unit, is_purchasable, is_sellable, status
       ) VALUES (?, ?, ?, ?, '24.000000', 0, 1, 1, 'ACTIVE')`,
      [
        fixture.variantIds[2],
        fixture.unitId,
        `T6RPK_${fixture.token}`,
        `${fixture.prefix} race package`,
      ],
    );
    fixture.racePackageId = await lastInsertId(connection);
    fixture.packageIds.push(fixture.racePackageId);

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

  try {
    await connection.beginTransaction();
    await connection.execute(
      `DELETE FROM audit_logs WHERE request_id LIKE ?`,
      [`${fixture.prefix}%`],
    );
    if (fixture.supplierIds.length) {
      await connection.execute(
        `DELETE FROM supplier_product_packages
         WHERE supplier_id IN (${placeholders(fixture.supplierIds)})`,
        fixture.supplierIds,
      );
      await connection.execute(
        `DELETE FROM supplier_products
         WHERE supplier_id IN (${placeholders(fixture.supplierIds)})`,
        fixture.supplierIds,
      );
      await connection.execute(
        `DELETE FROM suppliers
         WHERE supplier_id IN (${placeholders(fixture.supplierIds)})`,
        fixture.supplierIds,
      );
    }
    await connection.execute(
      `DELETE FROM product_packages
       WHERE product_variant_id IN (${placeholders(fixture.variantIds)})`,
      fixture.variantIds,
    );
    await connection.execute(
      `DELETE FROM product_variants WHERE product_id = ?`,
      [fixture.productId],
    );
    await connection.execute(`DELETE FROM products WHERE product_id = ?`, [fixture.productId]);
    await connection.execute(`DELETE FROM categories WHERE category_id = ?`, [fixture.categoryId]);
    await connection.execute(
      `DELETE FROM units_of_measure WHERE unit_of_measure_id IN (?, ?)`,
      [fixture.unitId, fixture.alternateUnitId],
    );
    await connection.execute(
      `DELETE FROM users WHERE user_id IN (${placeholders(fixture.userIds)})`,
      fixture.userIds,
    );
    const roleIds = Object.values(fixture.roleIds);
    await connection.execute(
      `DELETE FROM roles WHERE role_id IN (${placeholders(roleIds)})`,
      roleIds,
    );
    await connection.execute(`DELETE FROM branches WHERE branch_id = ?`, [fixture.branchId]);
    await connection.commit();
    fixture.cleaned = true;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

test(
  'Phase 6 supplier and supplier-catalog API integration',
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const fixture = fixtureDefinition();
    let server;

    try {
      await createFixture(fixture);
      server = await startServer();
      const address = server.address();
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const root = '/api/admin/suppliers';

      await t.test('enforces global supplier permissions and password state', async () => {
        const routes = [
          ['GET', root],
          ['GET', `${root}/999999999`],
          ['POST', root],
          ['PATCH', `${root}/999999999`],
          ['GET', `${root}/999999999/products`],
          ['POST', `${root}/999999999/products`],
          ['GET', `${root}/999999999/products/999999999`],
          ['PATCH', `${root}/999999999/products/999999999`],
          ['GET', `${root}/999999999/products/999999999/packages`],
          ['POST', `${root}/999999999/products/999999999/packages`],
          ['GET', `${root}/999999999/product-packages/999999999`],
          ['PATCH', `${root}/999999999/product-packages/999999999`],
        ];

        for (const [method, path] of routes) {
          assertSafeError(await send(baseUrl, path, { method }), 401);
          assertSafeError(
            await send(baseUrl, path, { method, token: fixture.tokens.must }),
            403,
          );

          for (const name of [
            'none',
            'catalog',
            'products',
            'pricing',
            'scoped',
          ]) {
            assertSafeError(
              await send(baseUrl, path, {
                method,
                token: fixture.tokens[name],
              }),
              403,
            );
          }
        }

        assertStatus(await send(baseUrl, root, { token: fixture.tokens.read }), 200);

        for (const [method, path] of routes) {
          if (method === 'GET') {
            assertSafeError(
              await send(baseUrl, path, {
                method,
                token: fixture.tokens.manage,
              }),
              403,
            );
          } else {
            assertSafeError(
              await send(baseUrl, path, { method, token: fixture.tokens.read }),
              403,
            );
          }
        }
      });

      await t.test('creates, lists, updates, and retires supplier masters safely', async () => {
        const create = await tracked(fixture, baseUrl, 'supplier-create', root, {
          method: 'POST',
          body: {
            supplierCode: `t6s_a_${fixture.token}`,
            supplierName: `${fixture.prefix} Supplier A`,
            contactName: 'Ada Supplier',
            email: `ADA.${fixture.lower}@example.invalid`,
            phone: '+234 800 000 0000',
            taxIdentifier: `TIN-${fixture.token}`,
            addressLine1: '1 Market Road',
            city: 'Lagos',
            countryCode: 'ng',
            paymentTermsDays: 30,
          },
        });
        assertStatus(create, 201);
        const supplier = create.json.data.supplier;
        assertId(supplier.supplierId);
        fixture.supplierIds.push(supplier.supplierId);
        fixture.supplierAId = supplier.supplierId;
        assert.equal(supplier.supplierCode, `T6S_A_${fixture.token}`);
        assert.equal(supplier.email, `ada.${fixture.lower}@example.invalid`);
        assert.equal(supplier.countryCode, 'NG');
        assert.equal(supplier.status, 'ACTIVE');

        const second = await tracked(fixture, baseUrl, 'supplier-create-b', root, {
          method: 'POST',
          token: fixture.tokens.manage,
          body: {
            supplierCode: `T6S_B_${fixture.token}`,
            supplierName: `${fixture.prefix} Supplier B`,
          },
        });
        assertStatus(second, 201);
        fixture.supplierBId = second.json.data.supplier.supplierId;
        fixture.supplierIds.push(fixture.supplierBId);

        const list = await send(
          baseUrl,
          `${root}?search=${fixture.token}&status=ACTIVE&page=1&limit=20`,
          { token: fixture.tokens.read },
        );
        assertStatus(list, 200);
        assert.ok(list.json.data.items.length >= 2);
        const detail = await send(baseUrl, `${root}/${fixture.supplierAId}`, {
          token: fixture.tokens.read,
        });
        assertStatus(detail, 200);

        const update = await tracked(
          fixture,
          baseUrl,
          'supplier-update',
          `${root}/${fixture.supplierAId}`,
          { method: 'PATCH', body: { contactName: 'Ada Updated', status: 'INACTIVE' } },
        );
        assertStatus(update, 200);
        assert.equal(update.json.data.supplier.status, 'INACTIVE');
        const noOp = await tracked(
          fixture,
          baseUrl,
          'supplier-noop',
          `${root}/${fixture.supplierAId}`,
          { method: 'PATCH', body: { contactName: 'Ada Updated', status: 'INACTIVE' } },
        );
        assertStatus(noOp, 200);
        fixture.noOpRequestId = noOp.requestId;

        const inactiveRelationship = await tracked(
          fixture,
          baseUrl,
          'inactive-supplier-relationship',
          `${root}/${fixture.supplierAId}/products`,
          {
            method: 'POST',
            body: { productVariantId: fixture.variantIds[0] },
          },
        );
        assertSafeError(inactiveRelationship, 409);
        fixture.inactiveFailedRequestId = inactiveRelationship.requestId;

        const duplicate = await tracked(fixture, baseUrl, 'supplier-duplicate', root, {
          method: 'POST',
          body: {
            supplierCode: `T6S_A_${fixture.token}`,
            supplierName: 'Duplicate',
          },
        });
        assertSafeError(duplicate, 409);
        fixture.failedRequestId = duplicate.requestId;
        assertSafeError(
          await send(baseUrl, root, {
            method: 'POST',
            token: fixture.tokens.admin,
            body: { supplierCode: 'X', supplierName: 'X', unknown: true },
          }),
          400,
        );
        assertSafeError(
          await send(baseUrl, root, {
            method: 'POST',
            token: fixture.tokens.admin,
            body: {
              supplierCode: `T6_BAD_${fixture.token}`,
              supplierName: 'Invalid supplier',
              email: 'not-an-email',
            },
          }),
          400,
        );
        assertSafeError(
          await send(baseUrl, `${root}/${fixture.supplierAId}`, {
            method: 'PATCH',
            token: fixture.tokens.admin,
            body: { status: 'DELETED' },
          }),
          400,
        );
        assertSafeError(
          await send(baseUrl, `${root}/not-an-id`, { token: fixture.tokens.admin }),
          400,
        );
        assertSafeError(
          await send(baseUrl, `${root}/18446744073709551615`, {
            token: fixture.tokens.admin,
          }),
          404,
        );
        assertStatus(
          await send(baseUrl, `${root}/${fixture.supplierAId}`, {
            method: 'DELETE',
            token: fixture.tokens.admin,
          }),
          404,
        );

        const reactivate = await tracked(
          fixture,
          baseUrl,
          'supplier-reactivate',
          `${root}/${fixture.supplierAId}`,
          { method: 'PATCH', body: { status: 'ACTIVE' } },
        );
        assertStatus(reactivate, 200);
      });

      await t.test('manages supplier-to-variant relationships and exact quantities', async () => {
        const productRoot = `${root}/${fixture.supplierAId}/products`;
        const create = await tracked(fixture, baseUrl, 'product-create', productRoot, {
          method: 'POST',
          body: {
            productVariantId: fixture.variantIds[0],
            supplierSku: `sp-a-${fixture.token}`,
            isPreferred: true,
            leadTimeDays: 5,
            minimumOrderQuantity: '12.500',
          },
        });
        assertStatus(create, 201);
        const record = create.json.data.supplierProduct;
        assert.equal(record.supplierProductId, fixture.variantIds[0]);
        assert.equal(record.productVariantId, fixture.variantIds[0]);
        assert.equal(record.minimumOrderQuantity, '12.500');

        assertStatus(
          await send(baseUrl, `${productRoot}?isPreferred=true&limit=10`, {
            token: fixture.tokens.read,
          }),
          200,
        );
        assertStatus(
          await send(baseUrl, `${productRoot}/${fixture.variantIds[0]}`, {
            token: fixture.tokens.read,
          }),
          200,
        );
        const update = await tracked(
          fixture,
          baseUrl,
          'product-update',
          `${productRoot}/${fixture.variantIds[0]}`,
          {
            method: 'PATCH',
            body: { supplierSku: `SP-A2-${fixture.token}`, leadTimeDays: 9 },
          },
        );
        assertStatus(update, 200);
        const noOp = await tracked(
          fixture,
          baseUrl,
          'product-noop',
          `${productRoot}/${fixture.variantIds[0]}`,
          {
            method: 'PATCH',
            body: { supplierSku: `SP-A2-${fixture.token}`, leadTimeDays: 9 },
          },
        );
        assertStatus(noOp, 200);
        fixture.productNoOpRequestId = noOp.requestId;

        assertSafeError(
          await tracked(fixture, baseUrl, 'product-duplicate', productRoot, {
            method: 'POST',
            body: { productVariantId: fixture.variantIds[0] },
          }),
          409,
        );
        assertSafeError(
          await send(baseUrl, productRoot, {
            method: 'POST',
            token: fixture.tokens.admin,
            body: {
              productVariantId: fixture.variantIds[1],
              minimumOrderQuantity: 2.5,
            },
          }),
          400,
        );
        assertSafeError(
          await send(
            baseUrl,
            `${root}/${fixture.supplierBId}/products/${fixture.variantIds[0]}`,
            { token: fixture.tokens.admin },
          ),
          404,
        );
        assertStatus(
          await send(baseUrl, `${productRoot}/${fixture.variantIds[0]}`, {
            method: 'DELETE',
            token: fixture.tokens.admin,
          }),
          404,
        );

        const preferredConflict = await tracked(
          fixture,
          baseUrl,
          'preferred-conflict',
          `${root}/${fixture.supplierBId}/products`,
          {
            method: 'POST',
            body: { productVariantId: fixture.variantIds[0], isPreferred: true },
          },
        );
        assertSafeError(preferredConflict, 409);
      });

      await t.test('manages supplier package definitions with full ownership checks', async () => {
        const nested = `${root}/${fixture.supplierAId}/products/${fixture.variantIds[0]}/packages`;
        const create = await tracked(fixture, baseUrl, 'package-create', nested, {
          method: 'POST',
          body: {
            productPackageId: fixture.packageIds[0],
            supplierPackageSku: `SPP-${fixture.token}`,
            minimumPackageQuantity: '3.250',
            isActive: true,
          },
        });
        assertStatus(create, 201);
        const record = create.json.data.supplierProductPackage;
        assert.equal(record.supplierProductPackageId, fixture.packageIds[0]);
        assert.equal(record.productVariantId, fixture.variantIds[0]);
        assert.equal(record.minimumPackageQuantity, '3.250');

        assertStatus(
          await send(baseUrl, `${nested}?isActive=true&limit=10`, {
            token: fixture.tokens.read,
          }),
          200,
        );
        const direct = `${root}/${fixture.supplierAId}/product-packages/${fixture.packageIds[0]}`;
        assertStatus(await send(baseUrl, direct, { token: fixture.tokens.read }), 200);
        const update = await tracked(fixture, baseUrl, 'package-update', direct, {
          method: 'PATCH',
          body: { minimumPackageQuantity: '4.000', isActive: false },
        });
        assertStatus(update, 200);
        const noOp = await tracked(fixture, baseUrl, 'package-noop', direct, {
          method: 'PATCH',
          body: { minimumPackageQuantity: '4.000', isActive: false },
        });
        assertStatus(noOp, 200);
        fixture.packageNoOpRequestId = noOp.requestId;

        assertSafeError(
          await send(baseUrl, nested, {
            method: 'POST',
            token: fixture.tokens.admin,
            body: { productPackageId: fixture.packageIds[0] },
          }),
          409,
        );
        assertSafeError(
          await send(baseUrl, nested, {
            method: 'POST',
            token: fixture.tokens.admin,
            body: { productPackageId: fixture.packageIds[1] },
          }),
          409,
        );
        assertSafeError(
          await send(baseUrl, nested, {
            method: 'POST',
            token: fixture.tokens.admin,
            body: {
              productPackageId: fixture.packageIds[0],
              minimumPackageQuantity: '1.0000',
            },
          }),
          400,
        );
        assertSafeError(
          await send(
            baseUrl,
            `${root}/${fixture.supplierBId}/product-packages/${fixture.packageIds[0]}`,
            { token: fixture.tokens.admin },
          ),
          404,
        );
        assertStatus(
          await send(baseUrl, direct, {
            method: 'DELETE',
            token: fixture.tokens.admin,
          }),
          404,
        );
      });

      await t.test('serializes duplicate creates and conflicting relationship patches', async () => {
        const rootA = `${root}/${fixture.supplierAId}/products`;
        const duplicateResults = await Promise.all([
          tracked(fixture, baseUrl, 'race-create-a', rootA, {
            method: 'POST',
            body: { productVariantId: fixture.variantIds[1] },
          }),
          tracked(fixture, baseUrl, 'race-create-b', rootA, {
            method: 'POST',
            body: { productVariantId: fixture.variantIds[1] },
          }),
        ]);
        assert.deepEqual(
          duplicateResults.map((result) => result.response.status).sort(),
          [201, 409],
        );

        const relationshipPath = `${rootA}/${fixture.variantIds[1]}`;
        const patchResults = await Promise.all([
          tracked(fixture, baseUrl, 'race-patch-a', relationshipPath, {
            method: 'PATCH',
            body: { supplierSku: `RACE-A-${fixture.token}`, leadTimeDays: 3 },
          }),
          tracked(fixture, baseUrl, 'race-patch-b', relationshipPath, {
            method: 'PATCH',
            body: { supplierSku: `RACE-B-${fixture.token}`, leadTimeDays: 9 },
          }),
        ]);
        patchResults.forEach((result) => assertStatus(result, 200));
        const final = await send(baseUrl, relationshipPath, {
          token: fixture.tokens.admin,
        });
        assertStatus(final, 200);
        const pair = [
          final.json.data.supplierProduct.supplierSku,
          final.json.data.supplierProduct.leadTimeDays,
        ];
        assert.ok(
          JSON.stringify(pair) === JSON.stringify([`RACE-A-${fixture.token}`, 3]) ||
            JSON.stringify(pair) === JSON.stringify([`RACE-B-${fixture.token}`, 9]),
        );
      });

      await t.test('serializes Phase 5B structural mutations with supplier writes', async () => {
        const rootA = `${root}/${fixture.supplierAId}/products`;
        const [createProduct, mutateVariant] = await Promise.all([
          tracked(fixture, baseUrl, 'variant-race-create', rootA, {
            method: 'POST',
            body: { productVariantId: fixture.variantIds[2] },
          }),
          tracked(
            fixture,
            baseUrl,
            'variant-race-mutate',
            `/api/admin/catalog/variants/${fixture.variantIds[2]}`,
            {
              method: 'PATCH',
              body: { unitOfMeasureId: fixture.alternateUnitId },
            },
          ),
        ]);
        assertStatus(createProduct, 201);
        assertSafeError(mutateVariant, 409);

        const nested = `${rootA}/${fixture.variantIds[2]}/packages`;
        const [createPackage, mutatePackage] = await Promise.all([
          tracked(fixture, baseUrl, 'package-race-create', nested, {
            method: 'POST',
            body: { productPackageId: fixture.racePackageId },
          }),
          tracked(
            fixture,
            baseUrl,
            'package-race-mutate',
            `/api/admin/catalog/packages/${fixture.racePackageId}`,
            {
              method: 'PATCH',
              body: { conversionToBaseQuantity: '2.000000' },
            },
          ),
        ]);
        assertStatus(createPackage, 201);
        assert.ok([200, 409].includes(mutatePackage.response.status));
        if (mutatePackage.response.status === 409) assertSafeError(mutatePackage, 409);

        const [rows] = await pool.execute(
          `SELECT COUNT(*) AS count
           FROM supplier_product_packages spp
           INNER JOIN product_packages pp
             ON pp.product_package_id = spp.product_package_id
            AND pp.product_variant_id = spp.product_variant_id
           WHERE spp.supplier_id = ?
             AND spp.product_package_id = ?`,
          [fixture.supplierAId, fixture.racePackageId],
        );
        assert.equal(Number(rows[0].count), 1);
      });

      await t.test('audits writes only and creates no inventory or Phase 7 rows', async () => {
        const [noOpRows] = await pool.execute(
          `SELECT request_id AS requestId, COUNT(*) AS count
           FROM audit_logs
           WHERE request_id IN (?, ?, ?)
           GROUP BY request_id`,
          [
            fixture.noOpRequestId,
            fixture.productNoOpRequestId,
            fixture.packageNoOpRequestId,
          ],
        );
        assert.deepEqual(noOpRows, []);
        const [failedRows] = await pool.execute(
          `SELECT COUNT(*) AS count FROM audit_logs WHERE request_id IN (?, ?)`,
          [fixture.failedRequestId, fixture.inactiveFailedRequestId],
        );
        assert.equal(Number(failedRows[0].count), 0);
        const [actions] = await pool.execute(
          `SELECT DISTINCT action_type AS actionType
           FROM audit_logs
           WHERE request_id LIKE ?`,
          [`${fixture.prefix}%`],
        );
        const actionTypes = new Set(actions.map((row) => row.actionType));
        for (const expected of [
          'SUPPLIER_CREATED',
          'SUPPLIER_UPDATED',
          'SUPPLIER_PRODUCT_CREATED',
          'SUPPLIER_PRODUCT_UPDATED',
          'SUPPLIER_PRODUCT_PACKAGE_CREATED',
          'SUPPLIER_PRODUCT_PACKAGE_UPDATED',
        ]) {
          assert.equal(actionTypes.has(expected), true, expected);
        }
        const [branchAudits] = await pool.execute(
          `SELECT COUNT(*) AS count
           FROM audit_logs
           WHERE request_id LIKE ? AND branch_id IS NOT NULL`,
          [`${fixture.prefix}%`],
        );
        assert.equal(Number(branchAudits[0].count), 0);

        for (const [table, column] of [
          ['branch_inventory', 'product_variant_id'],
          ['inventory_transaction_items', 'product_variant_id'],
          ['inventory_lots', 'product_variant_id'],
          ['purchase_order_items', 'product_variant_id'],
          ['goods_receipt_items', 'product_variant_id'],
        ]) {
          const [rows] = await pool.execute(
            `SELECT COUNT(*) AS count FROM ${table}
             WHERE ${column} IN (${placeholders(fixture.variantIds)})`,
            fixture.variantIds,
          );
          assert.equal(Number(rows[0].count), 0, table);
        }
        const [branchLotRows] = await pool.execute(
          `SELECT COUNT(*) AS count
           FROM branch_lot_inventory bli
           INNER JOIN inventory_lots il
             ON il.inventory_lot_id = bli.inventory_lot_id
           WHERE il.product_variant_id IN (${placeholders(fixture.variantIds)})`,
          fixture.variantIds,
        );
        assert.equal(Number(branchLotRows[0].count), 0, 'branch_lot_inventory');
        const [purchaseOrders] = await pool.execute(
          `SELECT COUNT(*) AS count FROM purchase_orders
           WHERE supplier_id IN (${placeholders(fixture.supplierIds)})`,
          fixture.supplierIds,
        );
        assert.equal(Number(purchaseOrders[0].count), 0);
        for (const path of ['/api/admin/purchase-orders', '/api/admin/receipts']) {
          assertStatus(await send(baseUrl, path, { token: fixture.tokens.admin }), 404);
        }
      });
    } finally {
      await stopServer(server);
      await cleanupFixture(fixture);

      if (fixture.setupComplete) {
        const [rows] = await pool.execute(
          `SELECT
             (SELECT COUNT(*) FROM suppliers WHERE supplier_code LIKE 'T6S\\_%') +
             (SELECT COUNT(*) FROM products WHERE product_code LIKE 'T6P\\_%') +
             (SELECT COUNT(*) FROM users WHERE username LIKE 't6.%') +
             (SELECT COUNT(*) FROM audit_logs WHERE request_id LIKE 'TEST_P6\\_%')
               AS fixtureCount`,
        );
        assert.equal(Number(rows[0].fixtureCount), 0);
      }

      await pool.end();
    }
  },
);
