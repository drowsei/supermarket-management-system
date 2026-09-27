import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import bcrypt from 'bcrypt';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const [{ default: app }, { pool }, access, { ensureAccessControl }, jwt] =
  await Promise.all([
    import('../src/app.js'),
    import('../src/config/database.js'),
    import('../src/config/accessControl.js'),
    import('../src/repositories/accessControlSeed.repository.js'),
    import('../src/utils/jwt.js'),
  ]);

const { ACCESS_CONTROL_PERMISSIONS, SYSTEM_ADMIN_ROLE } = access;
const { signAccessToken } = jwt;
const TEST_TIMEOUT_MS = 600_000;
const MAX_UNSIGNED_BIGINT = '18446744073709551615';

function fixtureDefinition() {
  const token = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
  return {
    token,
    lower: token.toLowerCase(),
    prefix: `TEST_P12_${token}`,
    requestCounter: 0,
    setupComplete: false,
    cleaned: false,
  };
}

const placeholders = (values) => values.map(() => '?').join(', ');

async function lastId(connection) {
  const [rows] = await connection.execute(
    'SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id',
  );
  return rows[0].id;
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
  const headers = new Headers(options.headers);
  const token = Object.hasOwn(options, 'token')
    ? options.token
    : fixture.tokens.actor;
  if (token) headers.set('authorization', `Bearer ${token}`);
  headers.set('user-agent', 'TEST_PHASE12_SALES/1.0');
  headers.set(
    'x-request-id',
    `${fixture.prefix}_${fixture.requestCounter}_${options.label ?? 'REQUEST'}`.slice(0, 100),
  );
  let body;
  if (options.body !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(options.body);
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET', headers, body,
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    json: text ? JSON.parse(text) : null,
    requestId: headers.get('x-request-id'),
  };
}

function status(result, expected) {
  assert.equal(result.status, expected, result.text);
  if (expected >= 400) {
    assert.equal(result.json?.success, false);
    for (const forbidden of [
      'ER_', 'sqlMessage', 'sqlState', 'constraint', 'stack',
      'DB_PASSWORD', 'uq_sales_', 'uq_inventory_',
    ]) assert.equal(result.text.includes(forbidden), false);
  }
}

function branchRoot(fixture, branchId = fixture.branchAId) {
  return `/api/admin/branches/${branchId}`;
}

async function insertEmployee(connection, fixture, name, state, branchId) {
  await connection.execute(
    `INSERT INTO employees (
       employee_number, first_name, last_name, hire_date, employment_status,
       termination_date
     ) VALUES (?, 'Phase12', ?, '2020-01-01', ?,
       CASE WHEN ? = 'TERMINATED' THEN '2025-01-01' ELSE NULL END)`,
    [`P12E_${name}_${fixture.token}`, name, state, state],
  );
  const id = await lastId(connection);
  fixture.employeeIds.push(id);
  fixture.employeeByName[name] = id;
  if (branchId) {
    await connection.execute(
      `INSERT INTO employee_branch_assignments (
         employee_id, branch_id, job_title, started_on, is_primary
       ) VALUES (?, ?, 'Phase 12 Test', '2020-01-01', 0)`,
      [id, branchId],
    );
  }
  return id;
}

async function insertCatalogVariant(
  connection,
  fixture,
  name,
  { taxRateId = null, lotMode = 'NONE', price = '10.0000', fractional = false } = {},
) {
  await connection.execute(
    `INSERT INTO products (
       category_id, tax_rate_id, product_code, product_name, status
     ) VALUES (?, ?, ?, ?, 'ACTIVE')`,
    [fixture.categoryId, taxRateId, `P12P_${name}_${fixture.token}`,
      `${fixture.prefix} ${name}`],
  );
  const productId = await lastId(connection);
  await connection.execute(
    `INSERT INTO product_variants (
       product_id, unit_of_measure_id, sku, variant_name, is_fractional,
       lot_tracking_mode, requires_expiry_date, default_selling_price, status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
    [productId, fractional ? fixture.fractionUnitId : fixture.unitId,
      `P12SKU_${name}_${fixture.token}`, `${name} Variant`, fractional ? 1 : 0,
      lotMode, lotMode === 'NONE' ? 0 : 1, price],
  );
  const variantId = await lastId(connection);
  await connection.execute(
    `INSERT INTO product_packages (
       product_variant_id, package_unit_of_measure_id, package_code,
       package_name, conversion_to_base_quantity, is_base_unit,
       is_purchasable, is_sellable, default_selling_price, status
     ) VALUES (?, ?, 'BASE', ?, '1.000000', 1, 1, 1, NULL, 'ACTIVE')`,
    [variantId, fractional ? fixture.fractionUnitId : fixture.unitId,
      `${name} Base`],
  );
  const packageId = await lastId(connection);
  fixture.productIds.push(productId);
  fixture.variantIds.push(variantId);
  fixture.packageIds.push(packageId);
  fixture.catalog[name] = { productId, variantId, packageId };
  return fixture.catalog[name];
}

async function createFixture(fixture) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const first = await ensureAccessControl(connection);
    const second = await ensureAccessControl(connection);
    assert.deepEqual(
      [first.permissionCount, first.assignedPermissionCount,
        second.permissionCount, second.assignedPermissionCount],
      [44, 44, 44, 44],
    );
    assert.equal(ACCESS_CONTROL_PERMISSIONS.length, 44);
    assert.equal(new Set(ACCESS_CONTROL_PERMISSIONS.map(({ code }) => code)).size, 44);

    fixture.branchIds = [];
    for (const suffix of ['A', 'B']) {
      await connection.execute(
        `INSERT INTO branches (
           branch_code, branch_name, address_line_1, city,
           country_code, currency_code, timezone, status
         ) VALUES (?, ?, '12 Sales Test Street', 'Lagos',
                   'NG', 'NGN', 'Africa/Lagos', 'ACTIVE')`,
        [`P12${suffix}_${fixture.token}`, `${fixture.prefix} Branch ${suffix}`],
      );
      fixture.branchIds.push(await lastId(connection));
    }
    [fixture.branchAId, fixture.branchBId] = fixture.branchIds;

    fixture.employeeIds = [];
    fixture.employeeByName = {};
    await insertEmployee(connection, fixture, 'actor', 'ACTIVE', fixture.branchAId);
    await insertEmployee(connection, fixture, 'manager', 'ACTIVE', fixture.branchAId);
    await insertEmployee(connection, fixture, 'cashier', 'ACTIVE', fixture.branchAId);
    await insertEmployee(connection, fixture, 'onleave', 'ON_LEAVE', fixture.branchAId);
    await insertEmployee(connection, fixture, 'unassigned', 'ACTIVE', null);
    await insertEmployee(connection, fixture, 'wrong', 'ACTIVE', fixture.branchBId);
    await insertEmployee(connection, fixture, 'globalactor', 'ACTIVE', fixture.branchAId);
    await insertEmployee(connection, fixture, 'terminated', 'TERMINATED', fixture.branchAId);

    const permissionCodes = ACCESS_CONTROL_PERMISSIONS.map(({ code }) => code);
    const [permissionRows] = await connection.execute(
      `SELECT CAST(permission_id AS CHAR) AS permissionId,
         permission_code AS permissionCode
       FROM permissions WHERE permission_code IN (${placeholders(permissionCodes)})`,
      permissionCodes,
    );
    const permissionIds = Object.fromEntries(
      permissionRows.map((row) => [row.permissionCode, row.permissionId]),
    );
    const roleDefinitions = {
      none: [], unrelated: ['customers.read'], read: ['sales.read'],
      manage: ['sales.manage'], both: ['sales.read', 'sales.manage', 'till_sessions.manage'],
    };
    fixture.roleIds = [];
    fixture.roleByName = {};
    for (const [name, codes] of Object.entries(roleDefinitions)) {
      await connection.execute(
        `INSERT INTO roles (role_code, role_name, description, is_active)
         VALUES (?, ?, 'Temporary Phase 12 role', 1)`,
        [`P12_${name.toUpperCase()}_${fixture.token}`, `${fixture.prefix} ${name}`],
      );
      const roleId = await lastId(connection);
      fixture.roleIds.push(roleId);
      fixture.roleByName[name] = roleId;
      for (const code of codes) {
        await connection.execute(
          'INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
          [roleId, permissionIds[code]],
        );
      }
    }
    const [systemRows] = await connection.execute(
      'SELECT CAST(role_id AS CHAR) AS roleId FROM roles WHERE role_code = ?',
      [SYSTEM_ADMIN_ROLE.code],
    );
    fixture.systemRoleId = systemRows[0].roleId;
    const hash = await bcrypt.hash(
      `Phase12-${fixture.token}-Password!`, Number(process.env.BCRYPT_ROUNDS),
    );
    const users = [
      ['admin', null, fixture.systemRoleId, null, 0],
      ['must', null, fixture.systemRoleId, null, 1],
      ['none', null, fixture.roleByName.none, null, 0],
      ['unrelated', null, fixture.roleByName.unrelated, null, 0],
      ['read', null, fixture.roleByName.read, fixture.branchAId, 0],
      ['manage', fixture.employeeByName.manager, fixture.roleByName.manage, fixture.branchAId, 0],
      ['actor', fixture.employeeByName.actor, fixture.roleByName.both, fixture.branchAId, 0],
      ['wrong', fixture.employeeByName.wrong, fixture.roleByName.both, null, 0],
      ['wrongscope', null, fixture.roleByName.read, fixture.branchBId, 0],
      ['onleave', fixture.employeeByName.onleave, fixture.roleByName.manage, null, 0],
      ['unassigned', fixture.employeeByName.unassigned, fixture.roleByName.manage, null, 0],
      ['globalactor', fixture.employeeByName.globalactor, fixture.roleByName.both, null, 0],
      ['terminated', fixture.employeeByName.terminated, fixture.roleByName.manage, null, 0],
    ];
    fixture.userIds = [];
    fixture.tokens = {};
    for (const [name, employeeId, roleId, scopedBranchId, mustChange] of users) {
      await connection.execute(
        `INSERT INTO users (
           employee_id, username, email, password_hash,
           is_active, must_change_password
         ) VALUES (?, ?, ?, ?, 1, ?)`,
        [employeeId, `p12.${name}.${fixture.lower}`,
          `p12.${name}.${fixture.lower}@example.invalid`, hash, mustChange],
      );
      const userId = await lastId(connection);
      fixture.userIds.push(userId);
      await connection.execute(
        `INSERT INTO user_roles (user_id, role_id, branch_id)
         VALUES (?, ?, ?)`,
        [userId, roleId, scopedBranchId],
      );
      fixture.tokens[name] = signAccessToken(userId).accessToken;
    }

    await connection.execute(
      `INSERT INTO pos_registers (
         branch_id, register_code, register_name, status
       ) VALUES (?, ?, ?, 'ACTIVE')`,
      [fixture.branchAId, `P12REG_${fixture.token}`, `${fixture.prefix} Register`],
    );
    fixture.registerId = await lastId(connection);
    await connection.execute(
      `INSERT INTO till_sessions (
         session_number, branch_id, pos_register_id, cashier_employee_id,
         opened_by_employee_id, status, opened_at, currency_code,
         opening_cash_amount, notes
       ) VALUES (?, ?, ?, ?, ?, 'OPEN', UTC_TIMESTAMP(6), 'NGN', 0.00, ?)`,
      [`P12TS_${fixture.token}`, fixture.branchAId, fixture.registerId,
        fixture.employeeByName.cashier, fixture.employeeByName.actor, fixture.prefix],
    );
    fixture.tillId = await lastId(connection);

    await connection.execute(
      `INSERT INTO payment_methods (
         method_code, method_name, method_type, requires_reference, is_active
       ) VALUES (?, ?, 'CARD', 0, 1)`,
      [`P12PAY_${fixture.token}`, `${fixture.prefix} Payment`],
    );
    fixture.paymentMethodId = await lastId(connection);

    fixture.customerIds = [];
    for (const [name, state] of [['Active', 'ACTIVE'], ['Blocked', 'BLOCKED'], ['Inactive', 'INACTIVE']]) {
      await connection.execute(
        `INSERT INTO customers (
           customer_number, customer_type, first_name, last_name, status
         ) VALUES (?, 'INDIVIDUAL', 'Phase12', ?, ?)`,
        [`P12C_${name}_${fixture.token}`, name, state],
      );
      const id = await lastId(connection);
      fixture.customerIds.push(id);
      fixture[`customer${name}Id`] = id;
    }

    await connection.execute(
      `INSERT INTO categories (category_code, category_name, is_active)
       VALUES (?, ?, 1)`,
      [`P12CAT_${fixture.token}`, `${fixture.prefix} Category`],
    );
    fixture.categoryId = await lastId(connection);
    fixture.unitIds = [];
    for (const [code, name, symbol, fractional] of [
      [`P12U_${fixture.token}`, `${fixture.prefix} Unit`, 'ea', 0],
      [`P12F_${fixture.token}`, `${fixture.prefix} Fraction`, 'kg', 1],
      [`P12K_${fixture.token}`, `${fixture.prefix} Carton`, 'ctn', 0],
    ]) {
      await connection.execute(
        `INSERT INTO units_of_measure (
           unit_code, unit_name, symbol, allows_fraction
         ) VALUES (?, ?, ?, ?)`,
        [code, name, symbol, fractional],
      );
      fixture.unitIds.push(await lastId(connection));
    }
    [fixture.unitId, fixture.fractionUnitId, fixture.cartonUnitId] = fixture.unitIds;
    fixture.taxIds = [];
    for (const [code, inclusive] of [['EX', 0], ['IN', 1]]) {
      await connection.execute(
        `INSERT INTO tax_rates (
           tax_code, tax_name, rate_percent, is_inclusive, is_active
         ) VALUES (?, ?, '7.5000', ?, 1)`,
        [`P12T${code}_${fixture.token}`, `${fixture.prefix} ${code}`, inclusive],
      );
      fixture.taxIds.push(await lastId(connection));
    }
    [fixture.taxExclusiveId, fixture.taxInclusiveId] = fixture.taxIds;

    fixture.productIds = [];
    fixture.variantIds = [];
    fixture.packageIds = [];
    fixture.catalog = {};
    const carton = await insertCatalogVariant(connection, fixture, 'Carton', {
      taxRateId: fixture.taxExclusiveId, price: '4.0000',
    });
    await connection.execute(
      `INSERT INTO product_packages (
         product_variant_id, package_unit_of_measure_id, package_code,
         package_name, conversion_to_base_quantity, is_base_unit,
         is_purchasable, is_sellable, default_selling_price, status
       ) VALUES (?, ?, 'CARTON', 'Carton of 24', '24.000000',
                 0, 1, 1, '110.0000', 'ACTIVE')`,
      [carton.variantId, fixture.cartonUnitId],
    );
    carton.cartonPackageId = await lastId(connection);
    fixture.packageIds.push(carton.cartonPackageId);
    fixture.barcode = `CaseBarcode-${fixture.token}`;
    await connection.execute(
      `INSERT INTO product_barcodes (
         product_variant_id, product_package_id, barcode, barcode_type, is_primary
       ) VALUES (?, ?, ?, 'CODE_128', 1)`,
      [carton.variantId, carton.cartonPackageId, fixture.barcode],
    );
    fixture.barcodeId = await lastId(connection);
    await connection.execute(
      `INSERT INTO branch_package_prices (
         branch_id, product_package_id, selling_price,
         effective_from, is_active, updated_by_employee_id
       ) VALUES (?, ?, '100.0000', '2020-01-01 00:00:00', 1, ?)`,
      [fixture.branchAId, carton.cartonPackageId, fixture.employeeByName.actor],
    );

    await insertCatalogVariant(connection, fixture, 'Required', {
      lotMode: 'REQUIRED', price: '10.0000',
    });
    await insertCatalogVariant(connection, fixture, 'Optional', {
      lotMode: 'OPTIONAL', price: '10.0000',
    });
    await insertCatalogVariant(connection, fixture, 'Inclusive', {
      taxRateId: fixture.taxInclusiveId, price: '100.0000',
    });
    await insertCatalogVariant(connection, fixture, 'Unknown', { price: '5.0000' });
    await insertCatalogVariant(connection, fixture, 'Mismatch', { price: '5.0000' });
    await insertCatalogVariant(connection, fixture, 'Race', { price: '5.0000' });
    await insertCatalogVariant(connection, fixture, 'Fractional', {
      price: '8.0000', fractional: true,
    });
    const packageDefault = await insertCatalogVariant(
      connection, fixture, 'PackageDefault', { price: '3.0000' },
    );
    await connection.execute(
      `UPDATE product_packages SET default_selling_price = '12.0000'
       WHERE product_package_id = ?`,
      [packageDefault.packageId],
    );
    const derived = await insertCatalogVariant(
      connection, fixture, 'Derived', { price: '5.0000' },
    );
    await connection.execute(
      `INSERT INTO product_packages (
         product_variant_id, package_unit_of_measure_id, package_code,
         package_name, conversion_to_base_quantity, is_base_unit,
         is_purchasable, is_sellable, default_selling_price, status
       ) VALUES (?, ?, 'TRIPLE', 'Triple Pack', '3.000000',
                 0, 1, 1, NULL, 'ACTIVE')`,
      [derived.variantId, fixture.unitId],
    );
    derived.triplePackageId = await lastId(connection);
    fixture.packageIds.push(derived.triplePackageId);
    await insertCatalogVariant(connection, fixture, 'BranchVariant', { price: '6.0000' });
    await insertCatalogVariant(connection, fixture, 'RoundWac', { price: '5.0000' });
    await insertCatalogVariant(connection, fixture, 'ExactWac', { price: '5.0000' });

    const stock = [
      ['Carton', '100.000', '3.0000'],
      ['Required', '13.000', '4.0000'],
      ['Optional', '10.000', '2.0000'],
      ['Inclusive', '10.000', '1.0000'],
      ['Unknown', '2.000', null],
      ['Mismatch', '2.000', '1.0000'],
      ['Race', '10.000', '2.5000'],
      ['Fractional', '10.000', '2.0000'],
      ['PackageDefault', '10.000', '2.0000'],
      ['Derived', '20.000', '2.0000'],
      ['BranchVariant', '10.000', '2.0000'],
      ['RoundWac', '1.000', '1.0000'],
      ['ExactWac', '10.000', '2.0000'],
    ];
    await connection.execute(
      `INSERT INTO inventory_transactions (
         branch_id, transaction_number, transaction_type, occurred_at,
         created_by_employee_id, notes
       ) VALUES (?, ?, 'OPENING_BALANCE', '2026-01-01 00:00:00', ?, ?)`,
      [fixture.branchAId, `P12IT_${fixture.token}`,
        fixture.employeeByName.actor, fixture.prefix],
    );
    fixture.openingTransactionId = await lastId(connection);
    let line = 0;
    for (const [name, quantity, cost] of stock) {
      line += 1;
      const catalog = fixture.catalog[name];
      const ledgerQuantity = name === 'Mismatch' ? '1.000' : quantity;
      await connection.execute(
        `INSERT INTO inventory_transaction_items (
           inventory_transaction_id, line_number, product_variant_id,
           quantity_change, unit_cost
         ) VALUES (?, ?, ?, ?, ?)`,
        [fixture.openingTransactionId, line, catalog.variantId, ledgerQuantity, cost],
      );
      await connection.execute(
        `INSERT INTO branch_inventory (
           branch_id, product_variant_id, quantity_on_hand, version_number
         ) VALUES (?, ?, ?, 0)`,
        [fixture.branchAId, catalog.variantId, quantity],
      );
    }

    await connection.execute(
      `INSERT INTO inventory_transactions (
         branch_id, transaction_number, transaction_type, occurred_at,
         created_by_employee_id, notes
       ) VALUES (?, ?, 'ADJUSTMENT', '2026-01-02 00:00:00', ?, ?)`,
      [fixture.branchAId, `P12WAC_${fixture.token}`,
        fixture.employeeByName.actor, fixture.prefix],
    );
    fixture.wacTransactionId = await lastId(connection);
    await connection.execute(
      `INSERT INTO inventory_transaction_items (
         inventory_transaction_id, line_number, product_variant_id,
         quantity_change, unit_cost
       ) VALUES
         (?, 1, ?, '2.000', '2.0000'),
         (?, 2, ?, '10.000', '4.0000')`,
      [fixture.wacTransactionId, fixture.catalog.RoundWac.variantId,
        fixture.wacTransactionId, fixture.catalog.ExactWac.variantId],
    );
    await connection.execute(
      `UPDATE branch_inventory SET quantity_on_hand = '3.000'
       WHERE branch_id = ? AND product_variant_id = ?`,
      [fixture.branchAId, fixture.catalog.RoundWac.variantId],
    );
    await connection.execute(
      `UPDATE branch_inventory SET quantity_on_hand = '20.000'
       WHERE branch_id = ? AND product_variant_id = ?`,
      [fixture.branchAId, fixture.catalog.ExactWac.variantId],
    );
    await connection.execute(
      `INSERT INTO branch_variant_prices (
         branch_id, product_variant_id, selling_price,
         effective_from, is_active, updated_by_employee_id
       ) VALUES (?, ?, '7.0000', '2020-01-01 00:00:00', 1, ?)`,
      [fixture.branchAId, fixture.catalog.BranchVariant.variantId,
        fixture.employeeByName.actor],
    );

    fixture.lotIds = [];
    for (const [name, lotNumber, expiry, quantity] of [
      ['Required', 'REQ-A', '2027-01-01', '3.000'],
      ['Required', 'REQ-B', '2028-01-01', '10.000'],
      ['Optional', 'OPT-A', '2027-06-01', '4.000'],
      ['Optional', 'OPT-EXPIRED', '2026-01-01', '3.000'],
    ]) {
      const catalog = fixture.catalog[name];
      await connection.execute(
        `INSERT INTO inventory_lots (
           product_variant_id, lot_number, expires_on, status,
           created_by_employee_id, notes
         ) VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
        [catalog.variantId, `${fixture.prefix}_${lotNumber}`, expiry,
          fixture.employeeByName.actor, fixture.prefix],
      );
      const lotId = await lastId(connection);
      fixture.lotIds.push(lotId);
      fixture[lotNumber.replace('-', '')] = lotId;
      await connection.execute(
        `INSERT INTO branch_lot_inventory (
           branch_id, inventory_lot_id, quantity_on_hand, status, version_number
         ) VALUES (?, ?, ?, 'AVAILABLE', 0)`,
        [fixture.branchAId, lotId, quantity],
      );
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
  try {
    await connection.beginTransaction();
    const branchIds = fixture.branchIds;
    await connection.execute(
      `DELETE FROM audit_logs WHERE branch_id IN (${placeholders(branchIds)})
         OR user_id IN (${placeholders(fixture.userIds)})`,
      [...branchIds, ...fixture.userIds],
    );
    await connection.execute(
      `DELETE sp FROM sale_payments sp INNER JOIN sales s ON s.sale_id = sp.sale_id
       WHERE s.branch_id IN (${placeholders(branchIds)})`,
      branchIds,
    );
    await connection.execute(
      `DELETE sil FROM sale_item_lots sil
       INNER JOIN sale_items si ON si.sale_item_id = sil.sale_item_id
       INNER JOIN sales s ON s.sale_id = si.sale_id
       WHERE s.branch_id IN (${placeholders(branchIds)})`,
      branchIds,
    );
    await connection.execute(
      `DELETE si FROM sale_items si INNER JOIN sales s ON s.sale_id = si.sale_id
       WHERE s.branch_id IN (${placeholders(branchIds)})`,
      branchIds,
    );
    await connection.execute(
      `DELETE FROM sales WHERE branch_id IN (${placeholders(branchIds)})`,
      branchIds,
    );
    await connection.execute(
      'DELETE FROM payment_methods WHERE payment_method_id = ?',
      [fixture.paymentMethodId],
    );
    await connection.execute(
      `DELETE itla FROM inventory_transaction_lot_allocations itla
       INNER JOIN inventory_transaction_items iti
         ON iti.inventory_transaction_item_id = itla.inventory_transaction_item_id
       INNER JOIN inventory_transactions it
         ON it.inventory_transaction_id = iti.inventory_transaction_id
       WHERE it.branch_id IN (${placeholders(branchIds)})`,
      branchIds,
    );
    await connection.execute(
      `DELETE iti FROM inventory_transaction_items iti
       INNER JOIN inventory_transactions it
         ON it.inventory_transaction_id = iti.inventory_transaction_id
       WHERE it.branch_id IN (${placeholders(branchIds)})`,
      branchIds,
    );
    await connection.execute(
      `DELETE FROM inventory_transactions
       WHERE branch_id IN (${placeholders(branchIds)})`,
      branchIds,
    );
    await connection.execute(
      `DELETE FROM branch_lot_inventory
       WHERE branch_id IN (${placeholders(branchIds)})`,
      branchIds,
    );
    await connection.execute(
      `DELETE FROM inventory_lots
       WHERE product_variant_id IN (${placeholders(fixture.variantIds)})`,
      fixture.variantIds,
    );
    await connection.execute(
      `DELETE FROM branch_inventory
       WHERE branch_id IN (${placeholders(branchIds)})`,
      branchIds,
    );
    await connection.execute(
      `DELETE FROM branch_package_prices
       WHERE branch_id IN (${placeholders(branchIds)})`,
      branchIds,
    );
    await connection.execute(
      `DELETE FROM branch_variant_prices
       WHERE branch_id IN (${placeholders(branchIds)})`,
      branchIds,
    );
    await connection.execute(
      `DELETE FROM product_barcodes
       WHERE product_variant_id IN (${placeholders(fixture.variantIds)})`,
      fixture.variantIds,
    );
    await connection.execute(
      `DELETE FROM product_packages
       WHERE product_variant_id IN (${placeholders(fixture.variantIds)})`,
      fixture.variantIds,
    );
    await connection.execute(
      `DELETE FROM product_variants
       WHERE product_variant_id IN (${placeholders(fixture.variantIds)})`,
      fixture.variantIds,
    );
    await connection.execute(
      `DELETE FROM products WHERE product_id IN (${placeholders(fixture.productIds)})`,
      fixture.productIds,
    );
    await connection.execute(
      `DELETE FROM tax_rates WHERE tax_rate_id IN (${placeholders(fixture.taxIds)})`,
      fixture.taxIds,
    );
    await connection.execute(
      `DELETE FROM categories WHERE category_id = ?`, [fixture.categoryId],
    );
    await connection.execute(
      `DELETE FROM units_of_measure
       WHERE unit_of_measure_id IN (${placeholders(fixture.unitIds)})`,
      fixture.unitIds,
    );
    await connection.execute(
      `DELETE FROM till_sessions WHERE branch_id IN (${placeholders(branchIds)})`,
      branchIds,
    );
    await connection.execute(
      `DELETE FROM pos_registers WHERE branch_id IN (${placeholders(branchIds)})`,
      branchIds,
    );
    await connection.execute(
      `DELETE FROM customers WHERE customer_id IN (${placeholders(fixture.customerIds)})`,
      fixture.customerIds,
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
       WHERE employee_id IN (${placeholders(fixture.employeeIds)})`,
      fixture.employeeIds,
    );
    await connection.execute(
      `DELETE FROM employees WHERE employee_id IN (${placeholders(fixture.employeeIds)})`,
      fixture.employeeIds,
    );
    await connection.execute(
      `DELETE FROM branches WHERE branch_id IN (${placeholders(branchIds)})`,
      branchIds,
    );
    await connection.commit();
    const [rows] = await connection.execute(
      `SELECT
         (SELECT COUNT(*) FROM branches WHERE branch_name LIKE ?) +
         (SELECT COUNT(*) FROM sales WHERE sale_number LIKE ?) +
         (SELECT COUNT(*) FROM audit_logs WHERE request_id LIKE ?) AS count`,
      [`${fixture.prefix}%`, `${fixture.prefix}%`, `${fixture.prefix}%`],
    );
    assert.equal(rows[0].count, '0');
    fixture.cleaned = true;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function createSale(fixture, baseUrl, options = {}) {
  const result = await send(
    fixture,
    baseUrl,
    `${branchRoot(fixture, options.branchId)}/till-sessions/${options.tillId ?? fixture.tillId}/sales`,
    {
      method: 'POST', token: options.token ?? fixture.tokens.actor,
      label: options.label ?? 'CREATE_SALE',
      body: options.body ?? {},
    },
  );
  if (result.status === 201) fixture.lastSale = result.json.data.sale;
  return result;
}

async function addItem(fixture, baseUrl, saleId, body, options = {}) {
  return send(
    fixture, baseUrl, `${branchRoot(fixture, options.branchId)}/sales/${saleId}/items`,
    { method: 'POST', token: options.token ?? fixture.tokens.actor,
      label: options.label ?? 'ADD_ITEM', body },
  );
}

async function ensureCompletedPayment(fixture, saleId) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [sales] = await connection.execute(
      `SELECT status, total_amount AS totalAmount FROM sales
       WHERE sale_id = ? LIMIT 1 FOR UPDATE`,
      [saleId],
    );
    const sale = sales[0];
    if (!sale || sale.status !== 'OPEN' || sale.totalAmount === '0.00') {
      await connection.commit();
      return;
    }
    const [payments] = await connection.execute(
      `SELECT COUNT(*) AS count FROM sale_payments
       WHERE sale_id = ? AND payment_type = 'PAYMENT'
         AND status = 'COMPLETED'`,
      [saleId],
    );
    if (payments[0].count === '0') {
      await connection.execute(
        `INSERT INTO sale_payments (
           payment_number, sale_id, payment_method_id,
           processed_by_employee_id, payment_type, status, amount,
           currency_code, paid_at, notes
         ) VALUES (?, ?, ?, ?, 'PAYMENT', 'COMPLETED', ?,
                   'NGN', UTC_TIMESTAMP(6), ?)`,
        [`TEST_P12_PAY_${fixture.token}_${saleId}`, saleId,
          fixture.paymentMethodId, fixture.employeeByName.actor,
          sale.totalAmount, 'Phase 12 isolated completion prerequisite'],
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function complete(fixture, baseUrl, saleId, options = {}) {
  await ensureCompletedPayment(fixture, saleId);
  return send(
    fixture, baseUrl, `${branchRoot(fixture, options.branchId)}/sales/${saleId}/complete`,
    { method: 'POST', token: options.token ?? fixture.tokens.actor,
      label: options.label ?? 'COMPLETE', body: options.body ?? {} },
  );
}

test(
  'Phase 12 sales and checkout engine integration',
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const fixture = fixtureDefinition();
    let server;
    try {
      await createFixture(fixture);
      server = await startServer();
      const baseUrl = `http://127.0.0.1:${server.address().port}`;
      const root = branchRoot(fixture);

      await t.test('exposes exactly nine schema-locked routes and no Phase 13 aliases', async () => {
        const source = await readFile(
          new URL('../src/routes/admin/sales/index.js', import.meta.url), 'utf8',
        );
        const routes = [...source.matchAll(
          /router\.(get|post|patch|delete)\s*\(\s*['"]([^'"]+)['"]/g,
        )].map((match) => `${match[1].toUpperCase()} ${match[2]}`);
        assert.deepEqual(routes, [
          'GET /sales',
          'POST /till-sessions/:tillSessionId/sales',
          'GET /sales/:saleId',
          'PATCH /sales/:saleId',
          'POST /sales/:saleId/items',
          'PATCH /sales/:saleId/items/:saleItemId',
          'DELETE /sales/:saleId/items/:saleItemId',
          'POST /sales/:saleId/complete',
          'POST /sales/:saleId/cancel',
        ]);
        assert.equal(new Set(routes).size, 9);
        assert.doesNotMatch(source, /void|payment|refund|return|tender|reopen|restore/i);
        for (const path of [
          `${root}/sales/1/void`, `${root}/sales/1/payments`,
          `${root}/sales/1/refunds`, `${root}/checkout/complete`,
        ]) status(await send(fixture, baseUrl, path, { token: fixture.tokens.admin }), 404);
      });

      await t.test('enforces read/manage scope and operational employee gates', async () => {
        status(await send(fixture, baseUrl, `${root}/sales`, { token: null }), 401);
        status(await send(fixture, baseUrl, `${root}/sales`, { token: fixture.tokens.must }), 403);
        status(await send(fixture, baseUrl, `${root}/sales`, { token: fixture.tokens.none }), 403);
        status(await send(fixture, baseUrl, `${root}/sales`, { token: fixture.tokens.unrelated }), 403);
        status(await send(fixture, baseUrl, `${root}/sales`, { token: fixture.tokens.manage }), 403);
        status(await send(fixture, baseUrl, `${root}/sales`, { token: fixture.tokens.read }), 200);
        status(await send(fixture, baseUrl, `${root}/sales`, { token: fixture.tokens.admin }), 200);
        status(await send(fixture, baseUrl, `${root}/sales`, { token: fixture.tokens.wrongscope }), 403);
        status(await createSale(fixture, baseUrl, { token: fixture.tokens.read }), 403);
        status(await createSale(fixture, baseUrl, { token: fixture.tokens.admin }), 403);
        status(await createSale(fixture, baseUrl, { token: fixture.tokens.onleave }), 403);
        status(await createSale(fixture, baseUrl, { token: fixture.tokens.unassigned }), 403);
        status(await createSale(fixture, baseUrl, { token: fixture.tokens.wrong }), 403);
        status(await createSale(fixture, baseUrl, { token: fixture.tokens.terminated }), 403);
        status(await send(fixture, baseUrl, `${root}/sales`, {
          token: fixture.tokens.globalactor,
        }), 200);
        const allowed = await createSale(fixture, baseUrl, { token: fixture.tokens.manage });
        status(allowed, 201);
        assert.equal(allowed.json.data.sale.cashierEmployeeId, fixture.employeeByName.cashier);
        assert.notEqual(allowed.json.data.sale.cashierEmployeeId, fixture.employeeByName.manager);
        const globalWrite = await createSale(fixture, baseUrl, {
          token: fixture.tokens.globalactor, label: 'GLOBAL_ACTOR',
        });
        status(globalWrite, 201);
        status(await send(
          fixture, baseUrl,
          `${branchRoot(fixture, fixture.branchBId)}/sales/${allowed.json.data.sale.saleId}`,
          { token: fixture.tokens.admin },
        ), 404);
      });

      await t.test('validates strict contracts, BIGINT IDs, and active customers', async () => {
        status(await send(fixture, baseUrl, `${root}/sales?unknown=x`, {
          token: fixture.tokens.read,
        }), 400);
        status(await send(fixture, baseUrl, `${root}/sales/0`, {
          token: fixture.tokens.read,
        }), 400);
        status(await send(fixture, baseUrl, `${root}/sales/${MAX_UNSIGNED_BIGINT}`, {
          token: fixture.tokens.read,
        }), 404);
        status(await createSale(fixture, baseUrl, {
          body: { customerId: fixture.customerBlockedId },
        }), 409);
        status(await createSale(fixture, baseUrl, {
          body: { customerId: fixture.customerInactiveId },
        }), 409);
        const active = await createSale(fixture, baseUrl, {
          body: { customerId: fixture.customerActiveId, notes: `${fixture.prefix} active` },
        });
        status(active, 201);
        assert.equal(active.json.data.sale.customerId, fixture.customerActiveId);
        status(await createSale(fixture, baseUrl, { body: { status: 'OPEN' } }), 400);
      });

      await t.test('enforces catalog eligibility, ownership, unit, and decimal contracts', async () => {
        const created = await createSale(fixture, baseUrl, { label: 'ELIGIBILITY_CREATE' });
        status(created, 201);
        const saleId = created.json.data.sale.saleId;
        const fractional = await addItem(fixture, baseUrl, saleId, {
          productVariantId: fixture.catalog.Fractional.variantId,
          quantity: '1.250',
        }, { label: 'FRACTIONAL_ITEM' });
        status(fractional, 201);
        assert.equal(fractional.json.data.item.productPackageId, fixture.catalog.Fractional.packageId);
        assert.equal(fractional.json.data.item.baseQuantity, '1.250');
        assert.equal(fractional.json.data.item.unitPrice, '8.0000');
        assert.equal(fractional.json.data.item.taxRatePercent, '0.0000');
        assert.equal(fractional.json.data.item.taxAmount, '0.00');
        assert.equal(fractional.json.data.item.lineTotal, '10.00');

        status(await addItem(fixture, baseUrl, saleId, {
          productVariantId: fixture.catalog.Carton.variantId,
          productPackageId: fixture.catalog.Carton.cartonPackageId,
          quantity: '1.500',
        }), 409);
        status(await addItem(fixture, baseUrl, saleId, {
          productVariantId: fixture.catalog.Fractional.variantId,
          productPackageId: fixture.catalog.Carton.cartonPackageId,
          quantity: '1.000',
        }), 404);
        status(await addItem(fixture, baseUrl, saleId, {
          productVariantId: fixture.catalog.PackageDefault.variantId,
          productPackageId: MAX_UNSIGNED_BIGINT,
          quantity: '1.000',
        }), 404);

        status(await addItem(fixture, baseUrl, saleId, {
          productVariantId: MAX_UNSIGNED_BIGINT,
          quantity: '1.000',
        }), 404);

        for (const invalidQuantity of [1, '-1.000', '1e0', '1.0001', '1000000000000.000', '']) {
          status(await addItem(fixture, baseUrl, saleId, {
            productVariantId: fixture.catalog.PackageDefault.variantId,
            quantity: invalidQuantity,
          }), 400);
        }
        status(await addItem(fixture, baseUrl, saleId, {
          productVariantId: fixture.catalog.PackageDefault.variantId,
          quantity: '1.000', unitPrice: '1.0000',
        }), 400);

        await pool.execute(
          `UPDATE products SET status = 'INACTIVE' WHERE product_id = ?`,
          [fixture.catalog.PackageDefault.productId],
        );
        status(await addItem(fixture, baseUrl, saleId, {
          productVariantId: fixture.catalog.PackageDefault.variantId, quantity: '1.000',
        }), 409);
        await pool.execute(
          `UPDATE products SET status = 'ACTIVE' WHERE product_id = ?`,
          [fixture.catalog.PackageDefault.productId],
        );

        await pool.execute(
          `UPDATE product_variants SET status = 'INACTIVE' WHERE product_variant_id = ?`,
          [fixture.catalog.PackageDefault.variantId],
        );
        status(await addItem(fixture, baseUrl, saleId, {
          productVariantId: fixture.catalog.PackageDefault.variantId, quantity: '1.000',
        }), 409);
        await pool.execute(
          `UPDATE product_variants SET status = 'ACTIVE' WHERE product_variant_id = ?`,
          [fixture.catalog.PackageDefault.variantId],
        );

        await pool.execute(
          `UPDATE product_packages SET status = 'INACTIVE' WHERE product_package_id = ?`,
          [fixture.catalog.PackageDefault.packageId],
        );
        status(await addItem(fixture, baseUrl, saleId, {
          productVariantId: fixture.catalog.PackageDefault.variantId,
          productPackageId: fixture.catalog.PackageDefault.packageId,
          quantity: '1.000',
        }), 409);
        status(await addItem(fixture, baseUrl, saleId, {
          productVariantId: fixture.catalog.PackageDefault.variantId, quantity: '1.000',
        }), 409);
        await pool.execute(
          `UPDATE product_packages SET status = 'ACTIVE', is_sellable = 0
           WHERE product_package_id = ?`,
          [fixture.catalog.PackageDefault.packageId],
        );
        status(await addItem(fixture, baseUrl, saleId, {
          productVariantId: fixture.catalog.PackageDefault.variantId, quantity: '1.000',
        }), 409);
        await pool.execute(
          `UPDATE product_packages SET is_sellable = 1 WHERE product_package_id = ?`,
          [fixture.catalog.PackageDefault.packageId],
        );
      });

      await t.test('resolves package-default, derived-variant, and branch-variant prices', async () => {
        const created = await createSale(fixture, baseUrl, { label: 'PRICE_FALLBACK_CREATE' });
        status(created, 201);
        const saleId = created.json.data.sale.saleId;
        await pool.execute(
          `INSERT INTO branch_package_prices (
             branch_id, product_package_id, selling_price,
             effective_from, is_active, updated_by_employee_id
           ) VALUES (?, ?, '99.0000', '2099-01-01 00:00:00', 1, ?)`,
          [fixture.branchAId, fixture.catalog.PackageDefault.packageId,
            fixture.employeeByName.actor],
        );
        const packageDefault = await addItem(fixture, baseUrl, saleId, {
          productVariantId: fixture.catalog.PackageDefault.variantId,
          quantity: '1.000',
        });
        status(packageDefault, 201);
        assert.equal(packageDefault.json.data.item.unitPrice, '12.0000');
        await pool.execute(
          `UPDATE branch_package_prices
           SET effective_from = '2020-01-01 00:00:00', is_active = 0,
               selling_price = '98.0000'
           WHERE branch_id = ? AND product_package_id = ?`,
          [fixture.branchAId, fixture.catalog.PackageDefault.packageId],
        );
        const inactiveOverride = await addItem(fixture, baseUrl, saleId, {
          productVariantId: fixture.catalog.PackageDefault.variantId,
          quantity: '1.000',
        });
        status(inactiveOverride, 201);
        assert.equal(inactiveOverride.json.data.item.unitPrice, '12.0000');
        const derived = await addItem(fixture, baseUrl, saleId, {
          productVariantId: fixture.catalog.Derived.variantId,
          productPackageId: fixture.catalog.Derived.triplePackageId,
          quantity: '1.000',
        });
        status(derived, 201);
        assert.equal(derived.json.data.item.unitPrice, '15.0000');
        assert.equal(derived.json.data.item.baseQuantity, '3.000');
        const branchVariant = await addItem(fixture, baseUrl, saleId, {
          productVariantId: fixture.catalog.BranchVariant.variantId,
          quantity: '1.000',
        });
        status(branchVariant, 201);
        assert.equal(branchVariant.json.data.item.unitPrice, '7.0000');
        assert.equal(branchVariant.json.data.sale.subtotalAmount, '46.00');
        assert.equal(branchVariant.json.data.sale.taxAmount, '0.00');
        assert.equal(branchVariant.json.data.sale.totalAmount, '46.00');
      });

      await t.test('creates and patches open carts with no-op audit suppression', async () => {
        const created = await createSale(fixture, baseUrl, {
          body: { notes: `${fixture.prefix} editable` }, label: 'EDIT_CREATE',
        });
        status(created, 201);
        const sale = created.json.data.sale;
        assert.equal(sale.status, 'OPEN');
        assert.equal(sale.totalAmount, '0.00');
        const noOp = await send(fixture, baseUrl, `${root}/sales/${sale.saleId}`, {
          method: 'PATCH', label: 'EDIT_NOOP', body: { notes: sale.notes },
        });
        status(noOp, 200);
        assert.equal(noOp.json.data.sale.updatedAt, sale.updatedAt);
        const [noOpAudit] = await pool.execute(
          'SELECT COUNT(*) AS count FROM audit_logs WHERE request_id = ?',
          [noOp.requestId],
        );
        assert.equal(noOpAudit[0].count, '0');
        const updated = await send(fixture, baseUrl, `${root}/sales/${sale.saleId}`, {
          method: 'PATCH', label: 'EDIT_EFFECTIVE',
          body: { customerId: fixture.customerActiveId, notes: `${fixture.prefix} changed` },
        });
        status(updated, 200);
        assert.equal(updated.json.data.sale.customerId, fixture.customerActiveId);
        status(await send(fixture, baseUrl, `${root}/sales/${sale.saleId}`, {
          method: 'PATCH', body: {},
        }), 400);
      });

      await t.test('uses exact barcode identity, package conversion, pricing, tax, and snapshots', async () => {
        const created = await createSale(fixture, baseUrl, { label: 'CARTON_CREATE' });
        status(created, 201);
        const saleId = created.json.data.sale.saleId;
        status(await addItem(fixture, baseUrl, saleId, {
          barcode: fixture.barcode.toLowerCase(), quantity: '2.000',
        }), 404);
        status(await addItem(fixture, baseUrl, saleId, {
          barcode: fixture.barcode, productVariantId: fixture.catalog.Carton.variantId,
          quantity: '2.000',
        }), 400);
        const itemResult = await addItem(fixture, baseUrl, saleId, {
          barcode: fixture.barcode, quantity: '2.000', discountAmount: '20.00',
        }, { label: 'CARTON_ITEM' });
        status(itemResult, 201);
        const item = itemResult.json.data.item;
        assert.equal(item.barcodeId, fixture.barcodeId);
        assert.equal(item.productPackageId, fixture.catalog.Carton.cartonPackageId);
        assert.equal(item.packageConversionFactor, '24.000000');
        assert.equal(item.baseQuantity, '48.000');
        assert.equal(item.unitPrice, '100.0000');
        assert.equal(item.discountAmount, '20.00');
        assert.equal(item.taxRatePercent, '7.5000');
        assert.equal(item.taxAmount, '13.50');
        assert.equal(item.lineTotal, '193.50');
        assert.equal(itemResult.json.data.sale.subtotalAmount, '200.00');
        assert.equal(itemResult.json.data.sale.totalAmount, '193.50');
        fixture.cartonSaleId = saleId;
        fixture.cartonItemId = item.saleItemId;
      });

      await t.test('keeps price/tax snapshots immutable while patching and deleting lines', async () => {
        await pool.execute(
          `UPDATE branch_package_prices SET selling_price = '999.0000'
           WHERE branch_id = ? AND product_package_id = ?`,
          [fixture.branchAId, fixture.catalog.Carton.cartonPackageId],
        );

        status(await send(
          fixture, baseUrl,
          `${root}/sales/${fixture.cartonSaleId}/items/${fixture.cartonItemId}`,
          { method: 'PATCH', body: {} },
        ), 400);
        const patched = await send(
          fixture, baseUrl,
          `${root}/sales/${fixture.cartonSaleId}/items/${fixture.cartonItemId}`,
          { method: 'PATCH', label: 'ITEM_PATCH',
            body: { quantity: '1.000', discountAmount: '0.00' } },
        );
        status(patched, 200);
        assert.equal(patched.json.data.item.unitPrice, '100.0000');
        assert.equal(patched.json.data.item.taxRatePercent, '7.5000');
        assert.equal(patched.json.data.item.baseQuantity, '24.000');
        const noOp = await send(
          fixture, baseUrl,
          `${root}/sales/${fixture.cartonSaleId}/items/${fixture.cartonItemId}`,
          { method: 'PATCH', label: 'ITEM_NOOP', body: { quantity: '1.000' } },
        );
        status(noOp, 200);
        const [audit] = await pool.execute(
          'SELECT COUNT(*) AS count FROM audit_logs WHERE request_id = ?',
          [noOp.requestId],
        );
        assert.equal(audit[0].count, '0');
        status(await send(
          fixture, baseUrl,
          `${root}/sales/${fixture.cartonSaleId}/items/${fixture.cartonItemId}`,
          { method: 'PATCH', body: { discountAmount: '101.00' } },
        ), 409);

        const scratch = await createSale(fixture, baseUrl, { label: 'DELETE_CREATE' });
        const line = await addItem(fixture, baseUrl, scratch.json.data.sale.saleId, {
          productVariantId: fixture.catalog.Inclusive.variantId,
          productPackageId: null, quantity: '1.000',
        });
        status(line, 201);
        const deleted = await send(
          fixture, baseUrl,
          `${root}/sales/${scratch.json.data.sale.saleId}/items/${line.json.data.item.saleItemId}`,
          { method: 'DELETE', label: 'ITEM_DELETE' },
        );
        status(deleted, 204);
        const detail = await send(
          fixture, baseUrl, `${root}/sales/${scratch.json.data.sale.saleId}`,
          { token: fixture.tokens.read },
        );
        status(detail, 200);
        assert.equal(detail.json.data.sale.items.length, 0);
        assert.equal(detail.json.data.sale.totalAmount, '0.00');
      });

      await t.test('converts inclusive shelf price to exact tax-exclusive line values', async () => {
        const created = await createSale(fixture, baseUrl, { label: 'INCLUSIVE_CREATE' });
        const added = await addItem(fixture, baseUrl, created.json.data.sale.saleId, {
          productVariantId: fixture.catalog.Inclusive.variantId,
          quantity: '1.000', discountAmount: '0.00',
        }, { label: 'INCLUSIVE_ITEM' });
        status(added, 201);
        assert.equal(added.json.data.item.unitPrice, '93.0233');
        assert.equal(added.json.data.item.taxAmount, '6.98');
        assert.equal(added.json.data.item.lineTotal, '100.00');
      });

      await t.test('completes atomically with WAC, negative SALE ledger, and an isolated payment prerequisite', async () => {
        const completed = await complete(
          fixture, baseUrl, fixture.cartonSaleId, { label: 'CARTON_COMPLETE' },
        );
        status(completed, 200);
        const sale = completed.json.data.sale;
        assert.equal(sale.status, 'COMPLETED');
        assert.match(sale.inventoryTransactionId, /^[1-9]\d*$/);
        assert.equal(sale.reversalInventoryTransactionId, null);
        assert.equal(sale.voidedAt, null);
        assert.equal(sale.items[0].unitCost, '3.0000');
        const [inventory] = await pool.execute(
          `SELECT quantity_on_hand AS quantityOnHand, version_number AS versionNumber
           FROM branch_inventory WHERE branch_id = ? AND product_variant_id = ?`,
          [fixture.branchAId, fixture.catalog.Carton.variantId],
        );
        assert.equal(inventory[0].quantityOnHand, '76.000');
        assert.equal(inventory[0].versionNumber, 1);
        const [ledger] = await pool.execute(
          `SELECT it.transaction_type AS transactionType,
             iti.quantity_change AS quantityChange, iti.unit_cost AS unitCost
           FROM inventory_transactions it
           INNER JOIN inventory_transaction_items iti
             ON iti.inventory_transaction_id = it.inventory_transaction_id
           WHERE it.inventory_transaction_id = ?`,
          [sale.inventoryTransactionId],
        );
        assert.deepEqual(ledger, [{
          transactionType: 'SALE', quantityChange: '-24.000', unitCost: '3.0000',
        }]);
        const [payments] = await pool.execute(
          'SELECT COUNT(*) AS count FROM sale_payments WHERE sale_id = ?',
          [fixture.cartonSaleId],
        );
        assert.equal(payments[0].count, '1');
        status(await complete(fixture, baseUrl, fixture.cartonSaleId), 409);
        status(await send(
          fixture, baseUrl, `${root}/sales/${fixture.cartonSaleId}`,
          { method: 'PATCH', body: { notes: 'immutable' } },
        ), 409);
        status(await addItem(fixture, baseUrl, fixture.cartonSaleId, {
          productVariantId: fixture.catalog.Inclusive.variantId,
          quantity: '1.000',
        }), 409);
        status(await send(
          fixture, baseUrl,
          `${root}/sales/${fixture.cartonSaleId}/items/${fixture.cartonItemId}`,
          { method: 'PATCH', body: { quantity: '2.000' } },
        ), 409);
        status(await send(
          fixture, baseUrl,
          `${root}/sales/${fixture.cartonSaleId}/items/${fixture.cartonItemId}`,
          { method: 'DELETE' },
        ), 409);
        status(await send(
          fixture, baseUrl, `${root}/sales/${fixture.cartonSaleId}/cancel`,
          { method: 'POST', body: {} },
        ), 409);
      });

      await t.test('allocates REQUIRED lots by FEFO with positive sale evidence', async () => {
        const created = await createSale(fixture, baseUrl, { label: 'REQ_CREATE' });
        const saleId = created.json.data.sale.saleId;
        const added = await addItem(fixture, baseUrl, saleId, {
          productVariantId: fixture.catalog.Required.variantId,
          quantity: '5.000',
        });
        status(added, 201);
        const completed = await complete(fixture, baseUrl, saleId, { label: 'REQ_COMPLETE' });
        status(completed, 200);
        assert.deepEqual(
          completed.json.data.sale.items[0].lotAllocations.map(
            ({ inventoryLotId, baseQuantityAllocated }) =>
              [inventoryLotId, baseQuantityAllocated],
          ),
          [[fixture.REQA, '3.000'], [fixture.REQB, '2.000']],
        );
        const [lotRows] = await pool.execute(
          `SELECT CAST(inventory_lot_id AS CHAR) AS inventoryLotId,
             quantity_on_hand AS quantityOnHand, status
           FROM branch_lot_inventory
           WHERE branch_id = ? AND inventory_lot_id IN (?, ?)
           ORDER BY inventory_lot_id`,
          [fixture.branchAId, fixture.REQA, fixture.REQB],
        );
        const byId = Object.fromEntries(lotRows.map((row) => [row.inventoryLotId, row]));
        assert.deepEqual(
          [byId[fixture.REQA].quantityOnHand, byId[fixture.REQA].status],
          ['0.000', 'DEPLETED'],
        );
        assert.equal(byId[fixture.REQB].quantityOnHand, '8.000');
        const [allocations] = await pool.execute(
          `SELECT itla.quantity_change AS quantityChange
           FROM inventory_transaction_lot_allocations itla
           INNER JOIN inventory_transaction_items iti
             ON iti.inventory_transaction_item_id = itla.inventory_transaction_item_id
           WHERE iti.inventory_transaction_id = ? ORDER BY itla.inventory_lot_id`,
          [completed.json.data.sale.inventoryTransactionId],
        );
        assert.deepEqual(allocations.map((row) => row.quantityChange), ['-3.000', '-2.000']);
      });

      await t.test('partially allocates OPTIONAL lots and leaves no synthetic lot', async () => {
        const created = await createSale(fixture, baseUrl, { label: 'OPT_CREATE' });
        const saleId = created.json.data.sale.saleId;
        await addItem(fixture, baseUrl, saleId, {
          productVariantId: fixture.catalog.Optional.variantId, quantity: '6.000',
        });
        const completed = await complete(fixture, baseUrl, saleId, { label: 'OPT_COMPLETE' });
        status(completed, 200);
        assert.deepEqual(
          completed.json.data.sale.items[0].lotAllocations.map(
            ({ inventoryLotId, baseQuantityAllocated }) =>
              [inventoryLotId, baseQuantityAllocated],
          ),
          [[fixture.OPTA, '4.000']],
        );
        const [stock] = await pool.execute(
          `SELECT quantity_on_hand AS quantityOnHand FROM branch_inventory
           WHERE branch_id = ? AND product_variant_id = ?`,
          [fixture.branchAId, fixture.catalog.Optional.variantId],
        );
        assert.equal(stock[0].quantityOnHand, '4.000');
      });

      await t.test('rolls back unknown valuation and ledger/projection conflicts', async () => {
        for (const [name, expectedMessage] of [
          ['Unknown', 'valuation'], ['Mismatch', 'ledger'],
        ]) {
          const created = await createSale(fixture, baseUrl, { label: `${name}_CREATE` });
          const saleId = created.json.data.sale.saleId;
          await addItem(fixture, baseUrl, saleId, {
            productVariantId: fixture.catalog[name].variantId, quantity: '1.000',
          });
          const failed = await complete(fixture, baseUrl, saleId, { label: `${name}_FAIL` });
          status(failed, 409);
          assert.match(failed.json.message.toLowerCase(), new RegExp(expectedMessage));
          const [rows] = await pool.execute(
            `SELECT status, inventory_transaction_id AS inventoryTransactionId
             FROM sales WHERE sale_id = ?`,
            [saleId],
          );
          assert.deepEqual(rows[0], { status: 'OPEN', inventoryTransactionId: null });
          const [audits] = await pool.execute(
            `SELECT COUNT(*) AS count FROM audit_logs
             WHERE request_id = ? AND action_type = 'SALE_COMPLETED'`,
            [failed.requestId],
          );
          assert.equal(audits[0].count, '0');
        }
      });

      await t.test('rejects empty completion and REQUIRED lot shortage with aggregate stock', async () => {
        const empty = await createSale(fixture, baseUrl, { label: 'EMPTY_CREATE' });
        status(empty, 201);
        status(await complete(fixture, baseUrl, empty.json.data.sale.saleId, {
          label: 'EMPTY_UNEXPECTED_BODY', body: { unexpected: true },
        }), 400);
        status(await complete(fixture, baseUrl, empty.json.data.sale.saleId, {
          label: 'EMPTY_COMPLETE',
        }), 409);

        await pool.execute(
          `INSERT INTO inventory_transactions (
             branch_id, transaction_number, transaction_type, occurred_at,
             created_by_employee_id, notes
           ) VALUES (?, ?, 'ADJUSTMENT', '2026-02-01 00:00:00', ?, ?)`,
          [fixture.branchAId, `P12REQSHORT_${fixture.token}`,
            fixture.employeeByName.actor, fixture.prefix],
        );
        const transactionId = (await pool.execute(
          'SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id',
        ))[0][0].id;
        await pool.execute(
          `INSERT INTO inventory_transaction_items (
             inventory_transaction_id, line_number, product_variant_id,
             quantity_change, unit_cost
           ) VALUES (?, 1, ?, '2.000', '4.0000')`,
          [transactionId, fixture.catalog.Required.variantId],
        );
        await pool.execute(
          `UPDATE branch_inventory
           SET quantity_on_hand = quantity_on_hand + 2.000,
               version_number = version_number + 1
           WHERE branch_id = ? AND product_variant_id = ?`,
          [fixture.branchAId, fixture.catalog.Required.variantId],
        );
        await pool.execute(
          `UPDATE branch_lot_inventory SET status = 'BLOCKED'
           WHERE branch_id = ? AND inventory_lot_id = ?`,
          [fixture.branchAId, fixture.REQB],
        );
        const created = await createSale(fixture, baseUrl, { label: 'REQ_SHORT_CREATE' });
        const saleId = created.json.data.sale.saleId;
        status(await addItem(fixture, baseUrl, saleId, {
          productVariantId: fixture.catalog.Required.variantId,
          quantity: '9.000',
        }), 201);
        const [beforeTransactions] = await pool.execute(
          `SELECT COUNT(*) AS count FROM inventory_transactions WHERE branch_id = ?`,
          [fixture.branchAId],
        );
        const failed = await complete(fixture, baseUrl, saleId, {
          label: 'REQ_SHORT_COMPLETE',
        });
        status(failed, 409);
        assert.match(failed.json.message.toLowerCase(), /lot/);
        for (const branchLotStatus of ['QUARANTINED']) {
          await pool.execute(
            `UPDATE branch_lot_inventory SET status = ?
             WHERE branch_id = ? AND inventory_lot_id = ?`,
            [branchLotStatus, fixture.branchAId, fixture.REQB],
          );
          status(await complete(fixture, baseUrl, saleId, {
            label: `REQ_${branchLotStatus}_COMPLETE`,
          }), 409);
        }
        await pool.execute(
          `UPDATE branch_lot_inventory SET status = 'AVAILABLE'
           WHERE branch_id = ? AND inventory_lot_id = ?`,
          [fixture.branchAId, fixture.REQB],
        );
        await pool.execute(
          `UPDATE inventory_lots SET status = 'QUARANTINED'
           WHERE inventory_lot_id = ?`,
          [fixture.REQB],
        );
        status(await complete(fixture, baseUrl, saleId, {
          label: 'REQ_GLOBAL_QUARANTINE_COMPLETE',
        }), 409);
        await pool.execute(
          `UPDATE inventory_lots SET status = 'ACTIVE'
           WHERE inventory_lot_id = ?`,
          [fixture.REQB],
        );
        const [afterTransactions] = await pool.execute(
          `SELECT COUNT(*) AS count FROM inventory_transactions WHERE branch_id = ?`,
          [fixture.branchAId],
        );
        assert.deepEqual(afterTransactions[0], beforeTransactions[0]);
        const [failureState] = await pool.execute(
          `SELECT s.status, CAST(s.inventory_transaction_id AS CHAR) AS inventoryTransactionId,
             si.unit_cost AS unitCost,
             (SELECT COUNT(*) FROM sale_item_lots sil
              WHERE sil.sale_item_id = si.sale_item_id) AS saleLotCount
           FROM sales s
           INNER JOIN sale_items si ON si.sale_id = s.sale_id
           WHERE s.sale_id = ?`,
          [saleId],
        );
        assert.deepEqual(failureState[0], {
          status: 'OPEN', inventoryTransactionId: null,
          unitCost: null, saleLotCount: '0',
        });
        const [failedAudit] = await pool.execute(
          `SELECT COUNT(*) AS count FROM audit_logs
           WHERE request_id = ? AND action_type = 'SALE_COMPLETED'`,
          [failed.requestId],
        );
        assert.equal(failedAudit[0].count, '0');
        const [requiredLotState] = await pool.execute(
          `SELECT quantity_on_hand AS quantityOnHand, status
           FROM branch_lot_inventory
           WHERE branch_id = ? AND inventory_lot_id = ?`,
          [fixture.branchAId, fixture.REQB],
        );
        assert.deepEqual(requiredLotState[0], {
          quantityOnHand: '8.000', status: 'AVAILABLE',
        });
        const [requiredStock] = await pool.execute(
          `SELECT quantity_on_hand AS quantityOnHand FROM branch_inventory
           WHERE branch_id = ? AND product_variant_id = ?`,
          [fixture.branchAId, fixture.catalog.Required.variantId],
        );
        assert.equal(requiredStock[0].quantityOnHand, '10.000');
        await pool.execute(
          `UPDATE branch_lot_inventory SET status = 'AVAILABLE'
           WHERE branch_id = ? AND inventory_lot_id = ?`,
          [fixture.branchAId, fixture.REQB],
        );

        const [noneEvidence] = await pool.execute(
          `SELECT
             (SELECT COUNT(*) FROM sale_item_lots sil
              INNER JOIN sale_items si ON si.sale_item_id = sil.sale_item_id
              WHERE si.sale_id = ?) +
             (SELECT COUNT(*) FROM inventory_transaction_lot_allocations itla
              INNER JOIN inventory_transaction_items iti
                ON iti.inventory_transaction_item_id = itla.inventory_transaction_item_id
              INNER JOIN sales s
                ON s.inventory_transaction_id = iti.inventory_transaction_id
              WHERE s.sale_id = ?) AS count`,
          [fixture.cartonSaleId, fixture.cartonSaleId],
        );
        assert.equal(noneEvidence[0].count, '0');
      });

      await t.test('rounds WAC to four places and recovers valuation after a zero reset', async () => {
        const exact = await createSale(fixture, baseUrl, { label: 'EXACT_WAC_CREATE' });
        status(await addItem(fixture, baseUrl, exact.json.data.sale.saleId, {
          productVariantId: fixture.catalog.ExactWac.variantId, quantity: '5.000',
        }), 201);
        const exactResult = await complete(
          fixture, baseUrl, exact.json.data.sale.saleId, { label: 'EXACT_WAC_COMPLETE' },
        );
        status(exactResult, 200);
        assert.equal(exactResult.json.data.sale.items[0].unitCost, '3.0000');
        const [exactLedger] = await pool.execute(
          `SELECT iti.quantity_change AS quantityChange, iti.unit_cost AS unitCost
           FROM inventory_transaction_items iti
           WHERE iti.inventory_transaction_id = ?`,
          [exactResult.json.data.sale.inventoryTransactionId],
        );
        assert.deepEqual(exactLedger, [{ quantityChange: '-5.000', unitCost: '3.0000' }]);
        const [exactStock] = await pool.execute(
          `SELECT quantity_on_hand AS quantityOnHand FROM branch_inventory
           WHERE branch_id = ? AND product_variant_id = ?`,
          [fixture.branchAId, fixture.catalog.ExactWac.variantId],
        );
        assert.equal(exactStock[0].quantityOnHand, '15.000');

        const rounded = await createSale(fixture, baseUrl, { label: 'ROUND_WAC_CREATE' });
        status(await addItem(fixture, baseUrl, rounded.json.data.sale.saleId, {
          productVariantId: fixture.catalog.RoundWac.variantId, quantity: '1.000',
        }), 201);
        const roundedResult = await complete(
          fixture, baseUrl, rounded.json.data.sale.saleId, { label: 'ROUND_WAC_COMPLETE' },
        );
        status(roundedResult, 200);
        assert.equal(roundedResult.json.data.sale.items[0].unitCost, '1.6667');

        const [unknownSales] = await pool.execute(
          `SELECT CAST(s.sale_id AS CHAR) AS saleId
           FROM sales s
           INNER JOIN sale_items si ON si.sale_id = s.sale_id
           WHERE s.branch_id = ? AND s.status = 'OPEN'
             AND si.product_variant_id = ?
           ORDER BY s.sale_id LIMIT 1`,
          [fixture.branchAId, fixture.catalog.Unknown.variantId],
        );
        assert.equal(unknownSales.length, 1);
        await pool.execute(
          `INSERT INTO inventory_transactions (
             branch_id, transaction_number, transaction_type, occurred_at,
             created_by_employee_id, notes
           ) VALUES (?, ?, 'ADJUSTMENT', '2026-03-01 00:00:00', ?, ?)`,
          [fixture.branchAId, `P12RESET_${fixture.token}`,
            fixture.employeeByName.actor, fixture.prefix],
        );
        const resetTransactionId = (await pool.execute(
          'SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id',
        ))[0][0].id;
        await pool.execute(
          `INSERT INTO inventory_transaction_items (
             inventory_transaction_id, line_number, product_variant_id,
             quantity_change, unit_cost
           ) VALUES
             (?, 1, ?, '-2.000', NULL),
             (?, 2, ?, '3.000', '7.3333')`,
          [resetTransactionId, fixture.catalog.Unknown.variantId,
            resetTransactionId, fixture.catalog.Unknown.variantId],
        );
        await pool.execute(
          `UPDATE branch_inventory SET quantity_on_hand = '3.000',
             version_number = version_number + 1
           WHERE branch_id = ? AND product_variant_id = ?`,
          [fixture.branchAId, fixture.catalog.Unknown.variantId],
        );
        const recovered = await complete(
          fixture, baseUrl, unknownSales[0].saleId, { label: 'RESET_COMPLETE' },
        );
        status(recovered, 200);
        assert.equal(recovered.json.data.sale.items[0].unitCost, '7.3333');
      });

      await t.test('serializes competing sales and duplicate completion', async () => {
        const saleIds = [];
        for (const suffix of ['A', 'B']) {
          const created = await createSale(fixture, baseUrl, { label: `RACE_${suffix}` });
          saleIds.push(created.json.data.sale.saleId);
          status(await addItem(fixture, baseUrl, created.json.data.sale.saleId, {
            productVariantId: fixture.catalog.Race.variantId, quantity: '7.000',
          }), 201);
        }
        const results = await Promise.all(
          saleIds.map((saleId, index) => complete(
            fixture, baseUrl, saleId, { label: `RACE_COMPLETE_${index}` },
          )),
        );
        assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
        const [stock] = await pool.execute(
          `SELECT quantity_on_hand AS quantityOnHand FROM branch_inventory
           WHERE branch_id = ? AND product_variant_id = ?`,
          [fixture.branchAId, fixture.catalog.Race.variantId],
        );
        assert.equal(stock[0].quantityOnHand, '3.000');
        const winner = results.find((result) => result.status === 200).json.data.sale.saleId;
        status(await complete(fixture, baseUrl, winner, { label: 'DUPLICATE_COMPLETE' }), 409);
        const aggregateSale = await createSale(fixture, baseUrl, {
          label: 'SAME_VARIANT_AGGREGATE_CREATE',
        });
        for (const suffix of ['A', 'B']) {
          status(await addItem(fixture, baseUrl, aggregateSale.json.data.sale.saleId, {
            productVariantId: fixture.catalog.Race.variantId,
            quantity: '2.000',
          }, { label: `SAME_VARIANT_${suffix}` }), 201);
        }
        status(await complete(
          fixture, baseUrl, aggregateSale.json.data.sale.saleId,
          { label: 'SAME_VARIANT_AGGREGATE_COMPLETE' },
        ), 409);
        const [aggregateStock] = await pool.execute(
          `SELECT quantity_on_hand AS quantityOnHand FROM branch_inventory
           WHERE branch_id = ? AND product_variant_id = ?`,
          [fixture.branchAId, fixture.catalog.Race.variantId],
        );
        assert.equal(aggregateStock[0].quantityOnHand, '3.000');
      });

      await t.test('revalidates catalog, customer, cashier, and currency at completion', async () => {
        const created = await createSale(fixture, baseUrl, {
          body: { customerId: fixture.customerActiveId }, label: 'REVALIDATE_CREATE',
        });
        status(created, 201);
        const saleId = created.json.data.sale.saleId;
        status(await addItem(fixture, baseUrl, saleId, {
          productVariantId: fixture.catalog.PackageDefault.variantId,
          quantity: '1.000',
        }), 201);

        await pool.execute(
          `UPDATE product_packages SET status = 'INACTIVE'
           WHERE product_package_id = ?`,
          [fixture.catalog.PackageDefault.packageId],
        );
        status(await complete(fixture, baseUrl, saleId, {
          label: 'REVALIDATE_PACKAGE',
        }), 409);
        await pool.execute(
          `UPDATE product_packages SET status = 'ACTIVE'
           WHERE product_package_id = ?`,
          [fixture.catalog.PackageDefault.packageId],
        );

        await pool.execute(
          `UPDATE customers SET status = 'BLOCKED' WHERE customer_id = ?`,
          [fixture.customerActiveId],
        );
        status(await complete(fixture, baseUrl, saleId, {
          label: 'REVALIDATE_CUSTOMER',
        }), 409);
        await pool.execute(
          `UPDATE customers SET status = 'ACTIVE' WHERE customer_id = ?`,
          [fixture.customerActiveId],
        );

        await pool.execute(
          `UPDATE employees SET employment_status = 'ON_LEAVE'
           WHERE employee_id = ?`,
          [fixture.employeeByName.cashier],
        );
        status(await complete(fixture, baseUrl, saleId, {
          label: 'REVALIDATE_CASHIER',
        }), 409);
        await pool.execute(
          `UPDATE employees SET employment_status = 'ACTIVE'
           WHERE employee_id = ?`,
          [fixture.employeeByName.cashier],
        );

        await pool.execute(
          `UPDATE sales SET currency_code = 'USD' WHERE sale_id = ?`,
          [saleId],
        );
        status(await complete(fixture, baseUrl, saleId, {
          label: 'REVALIDATE_CURRENCY',
        }), 409);
        await pool.execute(
          `UPDATE sales SET currency_code = 'NGN' WHERE sale_id = ?`,
          [saleId],
        );
        status(await complete(fixture, baseUrl, saleId, {
          label: 'REVALIDATE_SUCCESS',
        }), 200);
      });

      await t.test('serializes line numbers, same-line writes, pricing, and catalog changes', async () => {
        const lineSale = await createSale(fixture, baseUrl, { label: 'LINE_RACE_CREATE' });
        const lineSaleId = lineSale.json.data.sale.saleId;
        const createdLines = await Promise.all([
          addItem(fixture, baseUrl, lineSaleId, {
            productVariantId: fixture.catalog.PackageDefault.variantId,
            quantity: '1.000',
          }, { label: 'LINE_RACE_A' }),
          addItem(fixture, baseUrl, lineSaleId, {
            productVariantId: fixture.catalog.BranchVariant.variantId,
            quantity: '1.000',
          }, { label: 'LINE_RACE_B' }),
        ]);
        assert.deepEqual(createdLines.map((result) => result.status), [201, 201]);
        const detail = await send(
          fixture, baseUrl, `${root}/sales/${lineSaleId}`,
          { token: fixture.tokens.read },
        );
        status(detail, 200);
        assert.deepEqual(
          detail.json.data.sale.items.map((item) => item.lineNumber),
          [1, 2],
        );
        assert.equal(detail.json.data.sale.totalAmount, '19.00');

        const firstItem = detail.json.data.sale.items[0];
        const patches = await Promise.all([
          send(fixture, baseUrl, `${root}/sales/${lineSaleId}/items/${firstItem.saleItemId}`, {
            method: 'PATCH', label: 'SAME_LINE_A', body: { quantity: '2.000' },
          }),
          send(fixture, baseUrl, `${root}/sales/${lineSaleId}/items/${firstItem.saleItemId}`, {
            method: 'PATCH', label: 'SAME_LINE_B', body: { quantity: '3.000' },
          }),
        ]);
        assert.deepEqual(patches.map((result) => result.status), [200, 200]);
        const patchedDetail = await send(
          fixture, baseUrl, `${root}/sales/${lineSaleId}`,
          { token: fixture.tokens.read },
        );
        const persistedFirst = patchedDetail.json.data.sale.items[0];
        assert.equal(['2.000', '3.000'].includes(persistedFirst.quantity), true);
        const expectedTotals = {
          '7.0000': { '2.000': '26.00', '3.000': '33.00' },
          '12.0000': { '2.000': '31.00', '3.000': '43.00' },
        };
        const expectedTotal = expectedTotals[persistedFirst.unitPrice][persistedFirst.quantity];
        assert.equal(patchedDetail.json.data.sale.totalAmount, expectedTotal);

        const priceSale = await createSale(fixture, baseUrl, { label: 'PRICE_RACE_CREATE' });
        const [priced] = await Promise.all([
          addItem(fixture, baseUrl, priceSale.json.data.sale.saleId, {
            productVariantId: fixture.catalog.BranchVariant.variantId,
            quantity: '1.000',
          }, { label: 'PRICE_RACE_ITEM' }),
          pool.execute(
            `UPDATE branch_variant_prices SET selling_price = '9.0000'
             WHERE branch_id = ? AND product_variant_id = ?`,
            [fixture.branchAId, fixture.catalog.BranchVariant.variantId],
          ),
        ]);
        status(priced, 201);
        assert.equal(['7.0000', '9.0000'].includes(priced.json.data.item.unitPrice), true);
        await pool.execute(
          `UPDATE branch_variant_prices SET selling_price = '7.0000'
           WHERE branch_id = ? AND product_variant_id = ?`,
          [fixture.branchAId, fixture.catalog.BranchVariant.variantId],
        );

        const catalogSale = await createSale(fixture, baseUrl, { label: 'CATALOG_RACE_CREATE' });
        const [catalogResult] = await Promise.all([
          addItem(fixture, baseUrl, catalogSale.json.data.sale.saleId, {
            productVariantId: fixture.catalog.PackageDefault.variantId,
            quantity: '1.000',
          }, { label: 'CATALOG_RACE_ITEM' }),
          pool.execute(
            `UPDATE products SET status = 'INACTIVE' WHERE product_id = ?`,
            [fixture.catalog.PackageDefault.productId],
          ),
        ]);
        assert.equal([201, 409].includes(catalogResult.status), true, catalogResult.text);
        await pool.execute(
          `UPDATE products SET status = 'ACTIVE' WHERE product_id = ?`,
          [fixture.catalog.PackageDefault.productId],
        );
      });

      await t.test('serializes completion against cancel and every item mutation', async () => {
        const transitionSale = await createSale(fixture, baseUrl, {
          label: 'COMPLETE_CANCEL_CREATE',
        });
        const transitionSaleId = transitionSale.json.data.sale.saleId;
        status(await addItem(fixture, baseUrl, transitionSaleId, {
          productVariantId: fixture.catalog.Fractional.variantId,
          quantity: '1.000',
        }), 201);
        const transition = await Promise.all([
          complete(fixture, baseUrl, transitionSaleId, { label: 'COMPLETE_CANCEL_COMPLETE' }),
          send(fixture, baseUrl, `${root}/sales/${transitionSaleId}/cancel`, {
            method: 'POST', label: 'COMPLETE_CANCEL_CANCEL', body: {},
          }),
        ]);
        assert.deepEqual(transition.map((result) => result.status).sort(), [200, 409]);
        const [transitionState] = await pool.execute(
          `SELECT status, CAST(inventory_transaction_id AS CHAR) AS inventoryTransactionId,
             cancelled_at AS cancelledAt
           FROM sales WHERE sale_id = ?`,
          [transitionSaleId],
        );
        if (transitionState[0].status === 'COMPLETED') {
          assert.match(transitionState[0].inventoryTransactionId, /^[1-9]\d*$/);
          assert.equal(transitionState[0].cancelledAt, null);
        } else {
          assert.equal(transitionState[0].status, 'CANCELLED');
          assert.equal(transitionState[0].inventoryTransactionId, null);
          assert.notEqual(transitionState[0].cancelledAt, null);
        }

        const postSale = await createSale(fixture, baseUrl, { label: 'POST_COMPLETE_CREATE' });
        const postSaleId = postSale.json.data.sale.saleId;
        status(await addItem(fixture, baseUrl, postSaleId, {
          productVariantId: fixture.catalog.PackageDefault.variantId,
          quantity: '1.000',
        }), 201);
        const [postResult, postComplete] = await Promise.all([
          addItem(fixture, baseUrl, postSaleId, {
            productVariantId: fixture.catalog.BranchVariant.variantId,
            quantity: '1.000',
          }, { label: 'POST_VS_COMPLETE_POST' }),
          complete(fixture, baseUrl, postSaleId, { label: 'POST_VS_COMPLETE_COMPLETE' }),
        ]);
        assert.equal([201, 409].includes(postResult.status), true, postResult.text);
        assert.equal([200, 409].includes(postComplete.status), true, postComplete.text);
        assert.equal(postResult.status < 300 || postComplete.status < 300, true);
        const [postState] = await pool.execute(
          `SELECT s.status,
             CAST(s.inventory_transaction_id AS CHAR) AS inventoryTransactionId,
             s.total_amount AS totalAmount,
             (SELECT COUNT(*) FROM sale_items WHERE sale_id = s.sale_id) AS itemCount
           FROM sales s WHERE sale_id = ?`,
          [postSaleId],
        );
        if (postState[0].status === 'OPEN') {
          assert.equal(postComplete.status, 409);
          assert.equal(postResult.status, 201);
          assert.deepEqual(
            [postState[0].inventoryTransactionId, postState[0].itemCount,
              postState[0].totalAmount],
            [null, '2', '19.00'],
          );
          status(await send(fixture, baseUrl, `${root}/sales/${postSaleId}/cancel`, {
            method: 'POST', label: 'POST_RACE_CLEANUP', body: {},
          }), 200);
        } else {
          assert.equal(postState[0].status, 'COMPLETED');
          assert.equal(postComplete.status, 200);
          assert.match(postState[0].inventoryTransactionId, /^[1-9]\d*$/);
          assert.equal(['1', '2'].includes(postState[0].itemCount), true);
          assert.equal(['12.00', '19.00'].includes(postState[0].totalAmount), true);
        }

        const patchSale = await createSale(fixture, baseUrl, { label: 'PATCH_COMPLETE_CREATE' });
        const patchSaleId = patchSale.json.data.sale.saleId;
        const patchItem = await addItem(fixture, baseUrl, patchSaleId, {
          productVariantId: fixture.catalog.BranchVariant.variantId,
          quantity: '1.000',
        });
        status(patchItem, 201);
        const [patchResult, patchComplete] = await Promise.all([
          send(fixture, baseUrl,
            `${root}/sales/${patchSaleId}/items/${patchItem.json.data.item.saleItemId}`, {
              method: 'PATCH', label: 'PATCH_VS_COMPLETE_PATCH',
              body: { quantity: '2.000' },
            }),
          complete(fixture, baseUrl, patchSaleId, { label: 'PATCH_VS_COMPLETE_COMPLETE' }),
        ]);
        assert.equal([200, 409].includes(patchResult.status), true, patchResult.text);
        assert.equal([200, 409].includes(patchComplete.status), true, patchComplete.text);
        assert.equal(patchResult.status < 300 || patchComplete.status < 300, true);
        const [patchState] = await pool.execute(
          `SELECT s.status,
             CAST(s.inventory_transaction_id AS CHAR) AS inventoryTransactionId,
             s.total_amount AS totalAmount, si.quantity
           FROM sales s
           INNER JOIN sale_items si ON si.sale_id = s.sale_id
           WHERE s.sale_id = ?`,
          [patchSaleId],
        );
        if (patchState[0].status === 'OPEN') {
          assert.equal(patchComplete.status, 409);
          assert.equal(patchResult.status, 200);
          assert.deepEqual(
            [patchState[0].inventoryTransactionId, patchState[0].quantity,
              patchState[0].totalAmount],
            [null, '2.000', '14.00'],
          );
          status(await send(fixture, baseUrl, `${root}/sales/${patchSaleId}/cancel`, {
            method: 'POST', label: 'PATCH_RACE_CLEANUP', body: {},
          }), 200);
        } else {
          assert.equal(patchState[0].status, 'COMPLETED');
          assert.equal(patchComplete.status, 200);
          assert.match(patchState[0].inventoryTransactionId, /^[1-9]\d*$/);
          assert.equal(['1.000', '2.000'].includes(patchState[0].quantity), true);
          assert.equal(['7.00', '14.00'].includes(patchState[0].totalAmount), true);
        }

        const deleteSale = await createSale(fixture, baseUrl, { label: 'DELETE_COMPLETE_CREATE' });
        const deleteSaleId = deleteSale.json.data.sale.saleId;
        const deleteItem = await addItem(fixture, baseUrl, deleteSaleId, {
          productVariantId: fixture.catalog.Derived.variantId,
          quantity: '1.000',
        });
        status(deleteItem, 201);
        const [deleteResult, deleteComplete] = await Promise.all([
          send(fixture, baseUrl,
            `${root}/sales/${deleteSaleId}/items/${deleteItem.json.data.item.saleItemId}`, {
              method: 'DELETE', label: 'DELETE_VS_COMPLETE_DELETE',
            }),
          complete(fixture, baseUrl, deleteSaleId, { label: 'DELETE_VS_COMPLETE_COMPLETE' }),
        ]);
        const deleteStatuses = [deleteResult.status, deleteComplete.status].sort();
        assert.equal(
          JSON.stringify(deleteStatuses) === JSON.stringify([200, 409]) ||
            JSON.stringify(deleteStatuses) === JSON.stringify([204, 409]),
          true,
        );
        const [deleteState] = await pool.execute(
          `SELECT status, CAST(inventory_transaction_id AS CHAR) AS inventoryTransactionId,
             (SELECT COUNT(*) FROM sale_items WHERE sale_id = s.sale_id) AS itemCount
           FROM sales s WHERE sale_id = ?`,
          [deleteSaleId],
        );
        if (deleteState[0].status === 'OPEN') {
          assert.equal(deleteState[0].inventoryTransactionId, null);
          assert.equal(deleteState[0].itemCount, '0');
          status(await send(fixture, baseUrl, `${root}/sales/${deleteSaleId}/cancel`, {
            method: 'POST', label: 'DELETE_RACE_CLEANUP', body: {},
          }), 200);
        } else {
          assert.equal(deleteState[0].status, 'COMPLETED');
          assert.match(deleteState[0].inventoryTransactionId, /^[1-9]\d*$/);
          assert.equal(deleteState[0].itemCount, '1');
        }
      });

      await t.test('serializes sale completion against the real Phase 11 till close', async () => {
        const created = await createSale(fixture, baseUrl, { label: 'CLOSE_RACE_CREATE' });
        const saleId = created.json.data.sale.saleId;
        status(await addItem(fixture, baseUrl, saleId, {
          productVariantId: fixture.catalog.ExactWac.variantId,
          quantity: '1.000',
        }), 201);
        const [completion, close] = await Promise.all([
          complete(fixture, baseUrl, saleId, { label: 'CLOSE_RACE_COMPLETE' }),
          send(fixture, baseUrl, `${root}/till-sessions/${fixture.tillId}/close`, {
            method: 'POST', token: fixture.tokens.actor, label: 'CLOSE_RACE_CLOSE',
            body: { actualClosingCashAmount: '0.00' },
          }),
        ]);
        status(close, 200);
        assert.equal([200, 409].includes(completion.status), true, completion.text);
        const [state] = await pool.execute(
          `SELECT status, CAST(inventory_transaction_id AS CHAR) AS inventoryTransactionId
           FROM sales WHERE sale_id = ?`,
          [saleId],
        );
        if (completion.status === 200) {
          assert.equal(state[0].status, 'COMPLETED');
          assert.match(state[0].inventoryTransactionId, /^[1-9]\d*$/);
        } else {
          assert.equal(state[0].status, 'OPEN');
          assert.equal(state[0].inventoryTransactionId, null);
        }
        await pool.execute(
          `UPDATE till_sessions SET status = 'OPEN', closed_at = NULL,
             closed_by_employee_id = NULL, expected_closing_cash_amount = NULL,
             actual_closing_cash_amount = NULL, cash_difference_amount = NULL
           WHERE till_session_id = ?`,
          [fixture.tillId],
        );
        if (state[0].status === 'OPEN') {
          await pool.execute(
            `DELETE FROM sale_payments WHERE sale_id = ?
             AND payment_number LIKE 'TEST_P12_PAY_%'`,
            [saleId],
          );
          status(await send(fixture, baseUrl, `${root}/sales/${saleId}/cancel`, {
            method: 'POST', label: 'CLOSE_RACE_CLEANUP', body: {},
          }), 200);
        }
      });

      await t.test('cancels open sales without inventory and enforces till state', async () => {
        const created = await createSale(fixture, baseUrl, { label: 'CANCEL_CREATE' });
        const saleId = created.json.data.sale.saleId;
        const before = await pool.execute(
          'SELECT COUNT(*) AS count FROM inventory_transactions WHERE branch_id = ?',
          [fixture.branchAId],
        );
        const cancelled = await send(
          fixture, baseUrl, `${root}/sales/${saleId}/cancel`,
          { method: 'POST', label: 'SALE_CANCEL', body: {} },
        );
        status(cancelled, 200);
        assert.equal(cancelled.json.data.sale.status, 'CANCELLED');
        assert.equal(cancelled.json.data.sale.inventoryTransactionId, null);
        const after = await pool.execute(
          'SELECT COUNT(*) AS count FROM inventory_transactions WHERE branch_id = ?',
          [fixture.branchAId],
        );
        assert.deepEqual(after[0], before[0]);
        status(await send(
          fixture, baseUrl, `${root}/sales/${saleId}/cancel`,
          { method: 'POST', body: {} },
        ), 409);

        status(await send(fixture, baseUrl, `${root}/sales/${saleId}`, {
          method: 'PATCH', body: { notes: 'not mutable' },
        }), 409);
        status(await addItem(fixture, baseUrl, saleId, {
          productVariantId: fixture.catalog.Inclusive.variantId,
          quantity: '1.000',
        }), 409);
        status(await complete(fixture, baseUrl, saleId), 409);
        status(await send(fixture, baseUrl, `${root}/sales/${saleId}/cancel`, {
          method: 'POST', body: { unexpected: true },
        }), 400);

        const open = await createSale(fixture, baseUrl, { label: 'SUSPEND_CREATE' });
        await pool.execute(
          `UPDATE till_sessions SET status = 'SUSPENDED' WHERE till_session_id = ?`,
          [fixture.tillId],
        );
        status(await addItem(fixture, baseUrl, open.json.data.sale.saleId, {
          productVariantId: fixture.catalog.Inclusive.variantId, quantity: '1.000',
        }), 409);
        status(await send(
          fixture, baseUrl, `${root}/sales/${open.json.data.sale.saleId}/cancel`,
          { method: 'POST', body: {} },
        ), 200);
        await pool.execute(
          `UPDATE till_sessions SET status = 'OPEN' WHERE till_session_id = ?`,
          [fixture.tillId],
        );

        const closedTillSale = await createSale(fixture, baseUrl, {
          label: 'CLOSED_TILL_CREATE',
        });
        await pool.execute(
          `UPDATE till_sessions SET status = 'CLOSED', closed_at = UTC_TIMESTAMP(6),
             closed_by_employee_id = ?, expected_closing_cash_amount = '0.00',
             actual_closing_cash_amount = '0.00', cash_difference_amount = '0.00'
           WHERE till_session_id = ?`,
          [fixture.employeeByName.actor, fixture.tillId],
        );
        status(await addItem(fixture, baseUrl, closedTillSale.json.data.sale.saleId, {
          productVariantId: fixture.catalog.Inclusive.variantId,
          quantity: '1.000',
        }), 409);
        status(await createSale(fixture, baseUrl, { label: 'CLOSED_TILL_NEW' }), 409);
        status(await send(
          fixture, baseUrl, `${root}/sales/${closedTillSale.json.data.sale.saleId}/cancel`,
          { method: 'POST', label: 'CLOSED_TILL_CANCEL_SALE', body: {} },
        ), 200);
        await pool.execute(
          `UPDATE till_sessions SET status = 'OPEN', closed_at = NULL,
             closed_by_employee_id = NULL, expected_closing_cash_amount = NULL,
             actual_closing_cash_amount = NULL, cash_difference_amount = NULL
           WHERE till_session_id = ?`,
          [fixture.tillId],
        );

        const cancelledTillSale = await createSale(fixture, baseUrl, {
          label: 'CANCELLED_TILL_CREATE',
        });
        await pool.execute(
          `UPDATE till_sessions SET status = 'CANCELLED', closed_at = UTC_TIMESTAMP(6),
             closed_by_employee_id = ?, expected_closing_cash_amount = NULL,
             actual_closing_cash_amount = NULL, cash_difference_amount = NULL
           WHERE till_session_id = ?`,
          [fixture.employeeByName.actor, fixture.tillId],
        );
        status(await addItem(fixture, baseUrl, cancelledTillSale.json.data.sale.saleId, {
          productVariantId: fixture.catalog.Inclusive.variantId,
          quantity: '1.000',
        }), 409);
        status(await send(
          fixture, baseUrl,
          `${root}/sales/${cancelledTillSale.json.data.sale.saleId}/cancel`,
          { method: 'POST', label: 'CANCELLED_TILL_CANCEL_SALE', body: {} },
        ), 409);
        status(await createSale(fixture, baseUrl, { label: 'CANCELLED_TILL_NEW' }), 409);
        await pool.execute(
          `UPDATE till_sessions SET status = 'OPEN', closed_at = NULL,
             closed_by_employee_id = NULL, expected_closing_cash_amount = NULL,
             actual_closing_cash_amount = NULL, cash_difference_amount = NULL
           WHERE till_session_id = ?`,
          [fixture.tillId],
        );
        status(await send(
          fixture, baseUrl,
          `${root}/sales/${cancelledTillSale.json.data.sale.saleId}/cancel`,
          { method: 'POST', label: 'CANCELLED_TILL_CLEANUP', body: {} },
        ), 200);
      });

      await t.test('writes only the seven Phase 12 audit actions and no adjacent-domain mutation', async () => {
        const [actions] = await pool.execute(
          `SELECT DISTINCT action_type AS actionType FROM audit_logs
           WHERE branch_id = ? AND request_id LIKE ?
             AND action_type LIKE 'SALE%'
           ORDER BY action_type`,
          [fixture.branchAId, `${fixture.prefix}%`],
        );
        const actionSet = new Set(actions.map((row) => row.actionType));
        for (const expected of [
          'SALE_CREATED', 'SALE_UPDATED', 'SALE_ITEM_CREATED',
          'SALE_ITEM_UPDATED', 'SALE_ITEM_DELETED',
          'SALE_COMPLETED', 'SALE_CANCELLED',
        ]) assert.equal(actionSet.has(expected), true, expected);
        assert.equal(actionSet.has('SALE_VOIDED'), false);
        const [forbidden] = await pool.execute(
          `SELECT
             (SELECT COUNT(*) FROM sale_payments sp
              INNER JOIN sales s ON s.sale_id = sp.sale_id
              WHERE s.branch_id = ? AND sp.payment_type = 'REFUND') +
             (SELECT COUNT(*) FROM sales_returns WHERE branch_id = ?) +
             (SELECT COUNT(*) FROM inventory_transactions
              WHERE branch_id = ? AND transaction_type = 'SALE_VOID') AS count`,
          [fixture.branchAId, fixture.branchAId, fixture.branchAId],
        );
        assert.equal(forbidden[0].count, '0');
      });
    } finally {
      const errors = [];
      try { await stopServer(server); } catch (error) { errors.push(error); }
      try { await cleanupFixture(fixture); } catch (error) { errors.push(error); }
      try { await pool.end(); } catch (error) { errors.push(error); }
      if (errors.length > 0) throw new AggregateError(errors, 'Phase 12 cleanup failed');
    }
  },
);
