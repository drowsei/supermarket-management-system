import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import bcrypt from 'bcrypt';
import dotenv from 'dotenv';

import { reconstructWeightedAverage } from '../src/utils/salesDecimal.js';

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
const placeholders = (values) => values.map(() => '?').join(', ');

function fixtureDefinition() {
  const token = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
  return {
    token,
    lower: token.toLowerCase(),
    prefix: `TEST_P14_${token}`,
    requestCounter: 0,
    setupComplete: false,
    cleaned: false,
  };
}

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
  const token = Object.hasOwn(options, 'token') ? options.token : fixture.tokens.actor;
  if (token) headers.set('authorization', `Bearer ${token}`);
  headers.set('user-agent', 'TEST_PHASE14_RETURNS/1.0');
  headers.set('x-request-id', `${fixture.prefix}_${fixture.requestCounter}_${options.label ?? 'REQUEST'}`.slice(0, 100));
  let body;
  if (options.body !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(options.body);
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET', headers, body,
  });
  const text = await response.text();
  return { status: response.status, text, json: text ? JSON.parse(text) : null };
}

function status(result, expected) {
  assert.equal(result.status, expected, result.text);
  if (expected >= 400) {
    assert.equal(result.json?.success, false);
    for (const forbidden of [
      'ER_', 'sqlMessage', 'sqlState', 'constraint', 'stack', 'DB_PASSWORD',
      'uq_sales_returns', 'uq_sale_payments',
    ]) assert.equal(result.text.includes(forbidden), false);
  }
}

function root(fixture, branchId = fixture.branchAId) {
  return `/api/admin/branches/${branchId}`;
}

function returnsRoot(fixture, saleId = fixture.saleId, branchId = fixture.branchAId) {
  return `${root(fixture, branchId)}/sales/${saleId}/returns`;
}

async function createReturn(fixture, baseUrl, token = fixture.tokens.actor) {
  const result = await send(fixture, baseUrl, returnsRoot(fixture), {
    method: 'POST', token, body: { notes: fixture.prefix },
  });
  status(result, 201);
  return result.json.data.salesReturn;
}

async function insertEmployee(connection, fixture, name, branchId) {
  await connection.execute(
    `INSERT INTO employees (
       employee_number, first_name, last_name, hire_date, employment_status
     ) VALUES (?, 'Phase14', ?, '2020-01-01', 'ACTIVE')`,
    [`P14E_${name}_${fixture.token}`, name],
  );
  const id = await lastId(connection);
  fixture.employeeIds.push(id);
  fixture.employeeByName[name] = id;
  if (branchId) {
    await connection.execute(
      `INSERT INTO employee_branch_assignments (
         employee_id, branch_id, job_title, started_on, is_primary
       ) VALUES (?, ?, 'Phase 14 Test', '2020-01-01', 0)`,
      [id, branchId],
    );
  }
  return id;
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
         ) VALUES (?, ?, '14 Returns Test Street', 'Lagos',
                   'NG', 'NGN', 'Africa/Lagos', 'ACTIVE')`,
        [`P14${suffix}_${fixture.token}`, `${fixture.prefix} Branch ${suffix}`],
      );
      fixture.branchIds.push(await lastId(connection));
    }
    [fixture.branchAId, fixture.branchBId] = fixture.branchIds;

    fixture.employeeIds = [];
    fixture.employeeByName = {};
    await insertEmployee(connection, fixture, 'actor', fixture.branchAId);
    await insertEmployee(connection, fixture, 'approver', fixture.branchAId);
    await insertEmployee(connection, fixture, 'wrong', fixture.branchBId);

    const codes = ACCESS_CONTROL_PERMISSIONS.map(({ code }) => code);
    const [permissionRows] = await connection.execute(
      `SELECT CAST(permission_id AS CHAR) AS permissionId,
         permission_code AS permissionCode FROM permissions
       WHERE permission_code IN (${placeholders(codes)})`,
      codes,
    );
    const permissions = Object.fromEntries(
      permissionRows.map((row) => [row.permissionCode, row.permissionId]),
    );
    const definitions = {
      none: [], read: ['returns.read'], manage: ['returns.manage'],
      both: ['returns.read', 'returns.manage', 'till_sessions.read', 'till_sessions.manage'],
    };
    fixture.roleIds = [];
    fixture.roleByName = {};
    for (const [name, permissionCodes] of Object.entries(definitions)) {
      await connection.execute(
        `INSERT INTO roles (role_code, role_name, description, is_active)
         VALUES (?, ?, 'Temporary Phase 14 role', 1)`,
        [`P14_${name.toUpperCase()}_${fixture.token}`, `${fixture.prefix} ${name}`],
      );
      const roleId = await lastId(connection);
      fixture.roleIds.push(roleId);
      fixture.roleByName[name] = roleId;
      for (const code of permissionCodes) {
        await connection.execute(
          'INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
          [roleId, permissions[code]],
        );
      }
    }
    const [systemRows] = await connection.execute(
      'SELECT CAST(role_id AS CHAR) AS roleId FROM roles WHERE role_code = ?',
      [SYSTEM_ADMIN_ROLE.code],
    );
    const hash = await bcrypt.hash(
      `Phase14-${fixture.token}-Password!`, Number(process.env.BCRYPT_ROUNDS),
    );
    const users = [
      ['admin', null, systemRows[0].roleId, null],
      ['reader', null, fixture.roleByName.read, fixture.branchAId],
      ['unlinkedManage', null, fixture.roleByName.manage, fixture.branchAId],
      ['actor', fixture.employeeByName.actor, fixture.roleByName.both, fixture.branchAId],
      ['approver', fixture.employeeByName.approver, fixture.roleByName.both, fixture.branchAId],
      ['wrong', fixture.employeeByName.wrong, fixture.roleByName.both, null],
    ];
    fixture.userIds = [];
    fixture.tokens = {};
    for (const [name, employeeId, roleId, scopedBranchId] of users) {
      await connection.execute(
        `INSERT INTO users (
           employee_id, username, email, password_hash, is_active, must_change_password
         ) VALUES (?, ?, ?, ?, 1, 0)`,
        [employeeId, `p14.${name}.${fixture.lower}`,
          `p14.${name}.${fixture.lower}@example.invalid`, hash],
      );
      const userId = await lastId(connection);
      fixture.userIds.push(userId);
      await connection.execute(
        'INSERT INTO user_roles (user_id, role_id, branch_id) VALUES (?, ?, ?)',
        [userId, roleId, scopedBranchId],
      );
      fixture.tokens[name] = signAccessToken(userId).accessToken;
    }

    await connection.execute(
      `INSERT INTO pos_registers (branch_id, register_code, register_name, status)
       VALUES (?, ?, ?, 'ACTIVE')`,
      [fixture.branchAId, `P14REG_${fixture.token}`, `${fixture.prefix} Register`],
    );
    fixture.registerId = await lastId(connection);
    await connection.execute(
      `INSERT INTO till_sessions (
         session_number, branch_id, pos_register_id, cashier_employee_id,
         opened_by_employee_id, status, opened_at, currency_code,
         opening_cash_amount, notes
       ) VALUES (?, ?, ?, ?, ?, 'OPEN', UTC_TIMESTAMP(6), 'NGN', 100.00, ?)`,
      [`P14TS_${fixture.token}`, fixture.branchAId, fixture.registerId,
        fixture.employeeByName.actor, fixture.employeeByName.actor, fixture.prefix],
    );
    fixture.tillId = await lastId(connection);

    await connection.execute(
      'INSERT INTO categories (category_code, category_name, is_active) VALUES (?, ?, 1)',
      [`P14CAT_${fixture.token}`, `${fixture.prefix} Category`],
    );
    fixture.categoryId = await lastId(connection);
    await connection.execute(
      `INSERT INTO units_of_measure (unit_code, unit_name, symbol, allows_fraction)
       VALUES (?, ?, 'ea', 0)`,
      [`P14U_${fixture.token}`, `${fixture.prefix} Unit`],
    );
    fixture.unitId = await lastId(connection);
    fixture.productIds = [];
    fixture.variantIds = [];
    fixture.packageIds = [];
    fixture.catalog = {};
    for (const [name, lotMode, price] of [
      ['none', 'NONE', '33.3333'], ['required', 'REQUIRED', '10.0000'],
      ['optional', 'OPTIONAL', '0.0000'],
    ]) {
      await connection.execute(
        `INSERT INTO products (category_id, product_code, product_name, status)
         VALUES (?, ?, ?, 'ACTIVE')`,
        [fixture.categoryId, `P14P_${name}_${fixture.token}`, `${fixture.prefix} ${name}`],
      );
      const productId = await lastId(connection);
      fixture.productIds.push(productId);
      await connection.execute(
        `INSERT INTO product_variants (
           product_id, unit_of_measure_id, sku, variant_name, is_fractional,
           lot_tracking_mode, requires_expiry_date, default_selling_price, status
         ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, 'ACTIVE')`,
        [productId, fixture.unitId, `P14SKU_${name}_${fixture.token}`,
          `${name} Variant`, lotMode, lotMode === 'NONE' ? 0 : 1, price],
      );
      const variantId = await lastId(connection);
      fixture.variantIds.push(variantId);
      await connection.execute(
        `INSERT INTO product_packages (
           product_variant_id, package_unit_of_measure_id, package_code,
           package_name, conversion_to_base_quantity, is_base_unit,
           is_purchasable, is_sellable, status
         ) VALUES (?, ?, 'BASE', 'Each', '1.000000', 1, 1, 1, 'ACTIVE')`,
        [variantId, fixture.unitId],
      );
      const packageId = await lastId(connection);
      fixture.packageIds.push(packageId);
      fixture.catalog[name] = { productId, variantId, packageId };
    }

    fixture.lotIds = [];
    for (const [suffix, expiresOn] of [['A', '2030-12-31'], ['B', '2029-12-31']]) {
      await connection.execute(
        `INSERT INTO inventory_lots (
           product_variant_id, lot_number, expires_on, status, created_by_employee_id
         ) VALUES (?, ?, ?, 'ACTIVE', ?)`,
        [fixture.catalog.required.variantId, `P14LOT_${suffix}_${fixture.token}`,
          expiresOn, fixture.employeeByName.actor],
      );
      fixture.lotIds.push(await lastId(connection));
    }
    [fixture.lotAId, fixture.lotBId] = fixture.lotIds;
    await connection.execute(
      `INSERT INTO inventory_lots (
         product_variant_id, lot_number, expires_on, status, created_by_employee_id
       ) VALUES (?, ?, '2031-12-31', 'ACTIVE', ?)`,
      [fixture.catalog.optional.variantId, `P14LOT_OPTIONAL_${fixture.token}`,
        fixture.employeeByName.actor],
    );
    fixture.optionalLotId = await lastId(connection);
    fixture.lotIds.push(fixture.optionalLotId);

    fixture.inventoryTransactionIds = [];
    fixture.inventoryTransactionItemIds = [];
    await connection.execute(
      `INSERT INTO inventory_transactions (
         branch_id, transaction_number, transaction_type, occurred_at,
         created_by_employee_id, notes
       ) VALUES (?, ?, 'OPENING_BALANCE', UTC_TIMESTAMP(6), ?, ?)`,
      [fixture.branchAId, `P14IT_OPEN_${fixture.token}`,
        fixture.employeeByName.actor, fixture.prefix],
    );
    fixture.openingTransactionId = await lastId(connection);
    fixture.inventoryTransactionIds.push(fixture.openingTransactionId);
    for (const [line, variantId, quantity, cost] of [
      [1, fixture.catalog.none.variantId, '100.000', '4.0000'],
      [2, fixture.catalog.required.variantId, '40.000', '5.0000'],
      [3, fixture.catalog.optional.variantId, '20.000', '6.0000'],
    ]) {
      await connection.execute(
        `INSERT INTO inventory_transaction_items (
           inventory_transaction_id, line_number, product_variant_id,
           quantity_change, unit_cost
         ) VALUES (?, ?, ?, ?, ?)`,
        [fixture.openingTransactionId, line, variantId, quantity, cost],
      );
      fixture.inventoryTransactionItemIds.push(await lastId(connection));
    }
    const requiredOpeningItemId = fixture.inventoryTransactionItemIds[1];
    for (const lotId of fixture.lotIds) {
      if (lotId === fixture.optionalLotId) continue;
      await connection.execute(
        `INSERT INTO inventory_transaction_lot_allocations (
           inventory_transaction_item_id, inventory_lot_id,
           product_variant_id, quantity_change, unit_cost
         ) VALUES (?, ?, ?, '20.000', '5.0000')`,
        [requiredOpeningItemId, lotId, fixture.catalog.required.variantId],
      );
    }
    const optionalOpeningItemId = fixture.inventoryTransactionItemIds[2];
    await connection.execute(
      `INSERT INTO inventory_transaction_lot_allocations (
         inventory_transaction_item_id, inventory_lot_id,
         product_variant_id, quantity_change, unit_cost
       ) VALUES (?, ?, ?, '10.000', '6.0000')`,
      [optionalOpeningItemId, fixture.optionalLotId,
        fixture.catalog.optional.variantId],
    );
    await connection.execute(
      `INSERT INTO inventory_transactions (
         branch_id, transaction_number, transaction_type, occurred_at,
         created_by_employee_id, notes
       ) VALUES (?, ?, 'SALE', UTC_TIMESTAMP(6), ?, ?)`,
      [fixture.branchAId, `P14IT_SALE_${fixture.token}`,
        fixture.employeeByName.actor, fixture.prefix],
    );
    fixture.saleTransactionId = await lastId(connection);
    fixture.inventoryTransactionIds.push(fixture.saleTransactionId);
    for (const [line, variantId, quantity, cost] of [
      [1, fixture.catalog.none.variantId, '-3.000', '4.0000'],
      [2, fixture.catalog.required.variantId, '-6.000', '5.0000'],
      [3, fixture.catalog.optional.variantId, '-6.000', '6.0000'],
    ]) {
      await connection.execute(
        `INSERT INTO inventory_transaction_items (
           inventory_transaction_id, line_number, product_variant_id,
           quantity_change, unit_cost
         ) VALUES (?, ?, ?, ?, ?)`,
        [fixture.saleTransactionId, line, variantId, quantity, cost],
      );
      fixture.inventoryTransactionItemIds.push(await lastId(connection));
    }
    const requiredSaleTxnItemId = fixture.inventoryTransactionItemIds[4];
    for (const [lotId, quantity] of [[fixture.lotAId, '-4.000'], [fixture.lotBId, '-2.000']]) {
      await connection.execute(
        `INSERT INTO inventory_transaction_lot_allocations (
           inventory_transaction_item_id, inventory_lot_id,
           product_variant_id, quantity_change, unit_cost
         ) VALUES (?, ?, ?, ?, '5.0000')`,
        [requiredSaleTxnItemId, lotId, fixture.catalog.required.variantId, quantity],
      );
    }
    const optionalSaleTxnItemId = fixture.inventoryTransactionItemIds[5];
    await connection.execute(
      `INSERT INTO inventory_transaction_lot_allocations (
         inventory_transaction_item_id, inventory_lot_id,
         product_variant_id, quantity_change, unit_cost
       ) VALUES (?, ?, ?, '-4.000', '6.0000')`,
      [optionalSaleTxnItemId, fixture.optionalLotId,
        fixture.catalog.optional.variantId],
    );
    for (const [variantId, quantity] of [
      [fixture.catalog.none.variantId, '97.000'],
      [fixture.catalog.required.variantId, '34.000'],
      [fixture.catalog.optional.variantId, '14.000'],
    ]) {
      await connection.execute(
        `INSERT INTO branch_inventory (
           branch_id, product_variant_id, quantity_on_hand, version_number
         ) VALUES (?, ?, ?, 1)`,
        [fixture.branchAId, variantId, quantity],
      );
    }
    for (const [lotId, quantity] of [[fixture.lotAId, '16.000'], [fixture.lotBId, '18.000']]) {
      await connection.execute(
        `INSERT INTO branch_lot_inventory (
           branch_id, inventory_lot_id, quantity_on_hand, status, version_number
         ) VALUES (?, ?, ?, 'AVAILABLE', 1)`,
        [fixture.branchAId, lotId, quantity],
      );
    }
    await connection.execute(
      `INSERT INTO branch_lot_inventory (
         branch_id, inventory_lot_id, quantity_on_hand, status, version_number
       ) VALUES (?, ?, '6.000', 'AVAILABLE', 1)`,
      [fixture.branchAId, fixture.optionalLotId],
    );

    await connection.execute(
      `INSERT INTO sales (
         sale_number, branch_id, pos_register_id, till_session_id,
         cashier_employee_id, inventory_transaction_id, status, sold_at,
         currency_code, subtotal_amount, discount_amount, tax_amount,
         total_amount, notes
       ) VALUES (?, ?, ?, ?, ?, ?, 'COMPLETED', UTC_TIMESTAMP(6),
                 'NGN', 160.00, 0.00, 0.00, 160.00, ?)`,
      [`P14SALE_${fixture.token}`, fixture.branchAId, fixture.registerId,
        fixture.tillId, fixture.employeeByName.actor, fixture.saleTransactionId,
        fixture.prefix],
    );
    fixture.saleId = await lastId(connection);
    fixture.saleItemIds = [];
    for (const definition of [
      [1, fixture.catalog.none, '3.000', '33.3333', '4.0000', '100.00'],
      [2, fixture.catalog.required, '6.000', '10.0000', '5.0000', '60.00'],
      [3, fixture.catalog.optional, '6.000', '0.0000', '6.0000', '0.00'],
    ]) {
      const [line, catalog, quantity, price, cost, total] = definition;
      await connection.execute(
        `INSERT INTO sale_items (
           sale_id, line_number, product_variant_id, product_package_id,
           item_description, sku_snapshot, package_name_snapshot, quantity,
           package_conversion_factor, base_quantity, unit_price, unit_cost,
           discount_amount, tax_rate_percent, tax_amount, line_total
         ) VALUES (?, ?, ?, ?, ?, ?, 'Each', ?, '1.000000', ?, ?, ?,
                   0.00, 0.0000, 0.00, ?)`,
        [fixture.saleId, line, catalog.variantId, catalog.packageId,
          `${fixture.prefix} line ${line}`, `P14SKU_${line}_${fixture.token}`,
          quantity, quantity, price, cost, total],
      );
      fixture.saleItemIds.push(await lastId(connection));
    }
    [fixture.noneSaleItemId, fixture.requiredSaleItemId,
      fixture.optionalSaleItemId] = fixture.saleItemIds;
    for (const [lotId, quantity] of [[fixture.lotAId, '4.000'], [fixture.lotBId, '2.000']]) {
      await connection.execute(
        `INSERT INTO sale_item_lots (
           sale_item_id, inventory_lot_id, product_variant_id, base_quantity_allocated
         ) VALUES (?, ?, ?, ?)`,
        [fixture.requiredSaleItemId, lotId,
          fixture.catalog.required.variantId, quantity],
      );
    }

    await connection.execute(
      `INSERT INTO sale_item_lots (
         sale_item_id, inventory_lot_id, product_variant_id, base_quantity_allocated
       ) VALUES (?, ?, ?, '4.000')`,
      [fixture.optionalSaleItemId, fixture.optionalLotId,
        fixture.catalog.optional.variantId],
    );

    await connection.execute(
      `INSERT INTO sales (
         sale_number, branch_id, pos_register_id, till_session_id,
         cashier_employee_id, status, currency_code,
         subtotal_amount, discount_amount, tax_amount, total_amount, notes
       ) VALUES (?, ?, ?, ?, ?, 'OPEN', 'NGN', 0.00, 0.00, 0.00, 0.00, ?)`,
      [`P14OPEN_${fixture.token}`, fixture.branchAId, fixture.registerId,
        fixture.tillId, fixture.employeeByName.actor, fixture.prefix],
    );
    fixture.openSaleId = await lastId(connection);
    await connection.execute(
      `INSERT INTO sale_items (
         sale_id, line_number, product_variant_id, product_package_id,
         item_description, sku_snapshot, package_name_snapshot, quantity,
         package_conversion_factor, base_quantity, unit_price, unit_cost,
         discount_amount, tax_rate_percent, tax_amount, line_total
       ) VALUES (?, 1, ?, ?, ?, ?, 'Each', '1.000', '1.000000', '1.000',
                 '0.0000', '4.0000', '0.00', '0.0000', '0.00', '0.00')`,
      [fixture.openSaleId, fixture.catalog.none.variantId,
        fixture.catalog.none.packageId, `${fixture.prefix} cross-sale item`,
        `P14SKU_CROSS_${fixture.token}`],
    );
    fixture.openSaleItemId = await lastId(connection);
    fixture.saleItemIds.push(fixture.openSaleItemId);

    fixture.paymentMethodIds = [];
    fixture.paymentMethods = {};
    for (const [name, type, requiresReference, active] of [
      ['card', 'CARD', 0, 1], ['cash', 'CASH', 0, 1],
      ['reference', 'BANK_TRANSFER', 1, 1], ['inactive', 'OTHER', 0, 0],
    ]) {
      await connection.execute(
        `INSERT INTO payment_methods (
           method_code, method_name, method_type, requires_reference, is_active
         ) VALUES (?, ?, ?, ?, ?)`,
        [`P14${name.toUpperCase()}_${fixture.token}`, `${fixture.prefix} ${name}`,
          type, requiresReference, active],
      );
      const id = await lastId(connection);
      fixture.paymentMethodIds.push(id);
      fixture.paymentMethods[name] = id;
    }
    await connection.execute(
      `INSERT INTO sale_payments (
         payment_number, sale_id, payment_method_id, processed_by_employee_id,
         payment_type, status, amount, currency_code, paid_at, notes
       ) VALUES (?, ?, ?, ?, 'PAYMENT', 'COMPLETED', 160.00,
                 'NGN', UTC_TIMESTAMP(6), ?)`,
      [`P14PAY_${fixture.token}`, fixture.saleId, fixture.paymentMethods.card,
        fixture.employeeByName.actor, fixture.prefix],
    );
    fixture.originalPaymentId = await lastId(connection);

    fixture.specialSales = {};
    for (const [name, collectedAmount] of [['race', '100.00'], ['cap', '80.00']]) {
      await connection.execute(
        `INSERT INTO inventory_transactions (
           branch_id, transaction_number, transaction_type, occurred_at,
           created_by_employee_id, notes
         ) VALUES (?, ?, 'SALE', UTC_TIMESTAMP(6), ?, ?)`,
        [fixture.branchAId, `P14IT_${name.toUpperCase()}_${fixture.token}`,
          fixture.employeeByName.actor, fixture.prefix],
      );
      const inventoryTransactionId = await lastId(connection);
      fixture.inventoryTransactionIds.push(inventoryTransactionId);
      await connection.execute(
        `INSERT INTO sales (
           sale_number, branch_id, pos_register_id, till_session_id,
           cashier_employee_id, inventory_transaction_id, status, sold_at,
           currency_code, subtotal_amount, discount_amount, tax_amount,
           total_amount, notes
         ) VALUES (?, ?, ?, ?, ?, ?, 'COMPLETED', UTC_TIMESTAMP(6), 'NGN',
                   100.00, 0.00, 0.00, 100.00, ?)`,
        [`P14${name.toUpperCase()}_${fixture.token}`, fixture.branchAId,
          fixture.registerId, fixture.tillId, fixture.employeeByName.actor,
          inventoryTransactionId, fixture.prefix],
      );
      const saleId = await lastId(connection);
      await connection.execute(
        `INSERT INTO sale_items (
           sale_id, line_number, product_variant_id, product_package_id,
           item_description, sku_snapshot, package_name_snapshot, quantity,
           package_conversion_factor, base_quantity, unit_price, unit_cost,
           discount_amount, tax_rate_percent, tax_amount, line_total
         ) VALUES (?, 1, ?, ?, ?, ?, 'Each', '100.000', '1.000000', '100.000',
                   '1.0000', '1.0000', 0.00, 0.0000, 0.00, 100.00)`,
        [saleId, fixture.catalog.none.variantId, fixture.catalog.none.packageId,
          `${fixture.prefix} ${name} line`, `P14SKU_${name.toUpperCase()}_${fixture.token}`],
      );
      const saleItemId = await lastId(connection);
      fixture.saleItemIds.push(saleItemId);
      await connection.execute(
        `INSERT INTO sale_payments (
           payment_number, sale_id, payment_method_id, processed_by_employee_id,
           payment_type, status, amount, currency_code, paid_at, notes
         ) VALUES (?, ?, ?, ?, 'PAYMENT', 'COMPLETED', ?,
                   'NGN', UTC_TIMESTAMP(6), ?)`,
        [`P14PAY_${name.toUpperCase()}_${fixture.token}`, saleId,
          fixture.paymentMethods.card, fixture.employeeByName.actor,
          collectedAmount, fixture.prefix],
      );
      fixture.specialSales[name] = { saleId, saleItemId, paymentId: await lastId(connection) };
    }
    fixture.saleIds = [fixture.saleId, fixture.openSaleId,
      fixture.specialSales.race.saleId, fixture.specialSales.cap.saleId];

    fixture.returnReasonIds = [];
    fixture.returnReasons = {};
    for (const [name, defaultRestockable, approval] of [
      ['standard', 1, 0], ['approval', 1, 1], ['damaged', 0, 0],
    ]) {
      await connection.execute(
        `INSERT INTO return_reasons (
           reason_code, reason_name, description,
           default_restockable, requires_approval, is_active
         ) VALUES (?, ?, ?, ?, ?, 1)`,
        [`P14_${name.toUpperCase()}_${fixture.token}`, `${fixture.prefix} ${name}`,
          fixture.prefix, defaultRestockable, approval],
      );
      const id = await lastId(connection);
      fixture.returnReasonIds.push(id);
      fixture.returnReasons[name] = id;
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
  const del = async (table, column, ids) => {
    if (ids?.length) await connection.execute(
      `DELETE FROM ${table} WHERE ${column} IN (${placeholders(ids)})`, ids,
    );
  };
  try {
    await connection.beginTransaction();
    await connection.execute(
      'DELETE FROM audit_logs WHERE request_id LIKE ? OR notes LIKE ?',
      [`${fixture.prefix}%`, `%${fixture.prefix}%`],
    );
    await connection.execute(
      `DELETE FROM sale_payments
       WHERE sale_id IN (${placeholders(fixture.saleIds)})`,
      fixture.saleIds,
    );
    const [returnTransactionRows] = await connection.execute(
      `SELECT CAST(inventory_transaction_id AS CHAR) AS inventoryTransactionId
       FROM sales_returns
       WHERE original_sale_id IN (${placeholders(fixture.saleIds)})
         AND inventory_transaction_id IS NOT NULL`,
      fixture.saleIds,
    );
    const transactionIds = [
      ...fixture.inventoryTransactionIds,
      ...returnTransactionRows.map((row) => row.inventoryTransactionId),
    ];
    await connection.execute(
      `DELETE FROM inventory_transaction_lot_allocations
       WHERE inventory_transaction_item_id IN (
         SELECT inventory_transaction_item_id FROM inventory_transaction_items
         WHERE inventory_transaction_id IN (${placeholders(transactionIds)})
       )`,
      transactionIds,
    );
    await connection.execute(
      `DELETE FROM sales_return_items
       WHERE original_sale_id IN (${placeholders(fixture.saleIds)})`,
      fixture.saleIds,
    );
    await connection.execute(
      `DELETE FROM sales_returns
       WHERE original_sale_id IN (${placeholders(fixture.saleIds)})`,
      fixture.saleIds,
    );
    await connection.execute(
      `DELETE FROM sale_item_lots
       WHERE sale_item_id IN (${placeholders(fixture.saleItemIds)})`,
      fixture.saleItemIds,
    );
    await connection.execute(
      `DELETE FROM sale_items WHERE sale_id IN (${placeholders(fixture.saleIds)})`,
      fixture.saleIds,
    );
    await connection.execute(
      `DELETE FROM sales WHERE sale_id IN (${placeholders(fixture.saleIds)})`,
      fixture.saleIds,
    );
    await connection.execute(
      `DELETE FROM inventory_transaction_items
       WHERE inventory_transaction_id IN (${placeholders(transactionIds)})`,
      transactionIds,
    );
    await connection.execute(
      `DELETE FROM inventory_transactions
       WHERE inventory_transaction_id IN (${placeholders(transactionIds)})`,
      transactionIds,
    );
    await connection.execute('DELETE FROM branch_lot_inventory WHERE branch_id = ?', [fixture.branchAId]);
    await connection.execute('DELETE FROM branch_inventory WHERE branch_id = ?', [fixture.branchAId]);
    await del('inventory_lots', 'inventory_lot_id', fixture.lotIds);
    await del('return_reasons', 'return_reason_id', fixture.returnReasonIds);
    await del('payment_methods', 'payment_method_id', fixture.paymentMethodIds);
    await del('product_packages', 'product_package_id', fixture.packageIds);
    await del('product_variants', 'product_variant_id', fixture.variantIds);
    await del('products', 'product_id', fixture.productIds);
    await connection.execute('DELETE FROM units_of_measure WHERE unit_of_measure_id = ?', [fixture.unitId]);
    await connection.execute('DELETE FROM categories WHERE category_id = ?', [fixture.categoryId]);
    await connection.execute('DELETE FROM till_sessions WHERE till_session_id = ?', [fixture.tillId]);
    await connection.execute('DELETE FROM pos_registers WHERE pos_register_id = ?', [fixture.registerId]);
    await del('user_roles', 'user_id', fixture.userIds);
    await del('users', 'user_id', fixture.userIds);
    await del('role_permissions', 'role_id', fixture.roleIds);
    await del('roles', 'role_id', fixture.roleIds);
    await del('employee_branch_assignments', 'employee_id', fixture.employeeIds);
    await del('employees', 'employee_id', fixture.employeeIds);
    await del('branches', 'branch_id', fixture.branchIds);
    await connection.commit();
    fixture.cleaned = true;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

test('Phase 14 sales returns and refunds integration', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const fixture = fixtureDefinition();
  let server;
  try {
    await createFixture(fixture);
    server = await startServer();
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    await t.test('defines exactly two new permissions and fifteen return routes', async () => {
      for (const code of ['returns.read', 'returns.manage']) {
        assert.equal(ACCESS_CONTROL_PERMISSIONS.some((item) => item.code === code), true);
      }
      assert.equal(ACCESS_CONTROL_PERMISSIONS.length, 44);
      const source = await readFile('src/routes/admin/sales/return.routes.js', 'utf8');
      assert.equal((source.match(/router\.(?:get|post|patch|delete)\(/g) ?? []).length, 15);
      for (const forbidden of ['/exchange', '/store-credit', '/void-sale', 'reports']) {
        assert.equal(source.includes(forbidden), false);
      }
    });

    await t.test('enforces branch read scope and the separate operational write gate', async () => {
      const path = returnsRoot(fixture);
      status(await send(fixture, baseUrl, path, { token: null }), 401);
      status(await send(fixture, baseUrl, path, { token: fixture.tokens.reader }), 200);
      status(await send(fixture, baseUrl, path, {
        method: 'POST', token: fixture.tokens.reader, body: {},
      }), 403);
      status(await send(fixture, baseUrl, path, {
        method: 'POST', token: fixture.tokens.unlinkedManage, body: {},
      }), 403);
      status(await send(fixture, baseUrl, path, { token: fixture.tokens.wrong }), 403);
      status(await send(fixture, baseUrl,
        returnsRoot(fixture, fixture.saleId, fixture.branchBId),
        { token: fixture.tokens.admin }), 404);
    });

    await t.test('creates only against completed sales and validates strict contracts', async () => {
      status(await send(fixture, baseUrl, returnsRoot(fixture, fixture.openSaleId), {
        method: 'POST', body: {},
      }), 409);
      status(await send(fixture, baseUrl, returnsRoot(fixture), {
        method: 'POST', body: { invented: true },
      }), 400);
      status(await send(fixture, baseUrl, `${returnsRoot(fixture)}?unknown=x`), 400);
      const created = await createReturn(fixture, baseUrl);
      assert.match(created.salesReturnId, /^[1-9]\d*$/);
      assert.match(created.returnNumber, /^RET-[A-F0-9]{32}$/);
      assert.equal(created.status, 'DRAFT');
      const itemPath = `${returnsRoot(fixture)}/${created.salesReturnId}/items`;
      const itemBody = {
        returnReasonId: fixture.returnReasons.standard,
        itemCondition: 'UNOPENED', isRestockable: true,
      };
      status(await send(fixture, baseUrl, itemPath, {
        method: 'POST', body: {
          ...itemBody, originalSaleItemId: fixture.openSaleItemId,
          quantityReturned: '1.000',
        },
      }), 404);
      status(await send(fixture, baseUrl, itemPath, {
        method: 'POST', body: {
          ...itemBody, originalSaleItemId: fixture.noneSaleItemId,
          quantityReturned: '4.000',
        },
      }), 409);
      status(await send(fixture, baseUrl, itemPath, {
        method: 'POST', body: {
          ...itemBody, originalSaleItemId: fixture.noneSaleItemId,
          quantityReturned: '0.500',
        },
      }), 409);
      status(await send(fixture, baseUrl,
        `${itemPath}/18446744073709551615`,
        { method: 'PATCH', body: { notes: 'not found' } }), 404);
      status(await send(fixture, baseUrl,
        `${returnsRoot(fixture)}/18446744073709551615`,
        { token: fixture.tokens.admin }), 404);
      fixture.contractReturnId = created.salesReturnId;
      status(await send(fixture, baseUrl,
        `${returnsRoot(fixture)}/${created.salesReturnId}/cancel`,
        { method: 'POST', body: {} }), 200);
    });

    await t.test('uses immutable sale snapshots, exact partial rounding, editing, and draft deletion', async () => {
      const salesReturn = await createReturn(fixture, baseUrl);
      const itemPath = `${returnsRoot(fixture)}/${salesReturn.salesReturnId}/items`;
      const added = await send(fixture, baseUrl, itemPath, {
        method: 'POST',
        body: {
          originalSaleItemId: fixture.noneSaleItemId,
          returnReasonId: fixture.returnReasons.standard,
          quantityReturned: '1.000', itemCondition: 'UNOPENED', isRestockable: true,
        },
      });
      status(added, 201);
      assert.equal(added.json.data.item.refundAmount, '33.33');
      assert.equal(added.json.data.item.originalUnitCost, '4.0000');
      const itemId = added.json.data.item.salesReturnItemId;
      const updated = await send(fixture, baseUrl, `${itemPath}/${itemId}`, {
        method: 'PATCH', body: { quantityReturned: '2.000' },
      });
      status(updated, 200);
      assert.equal(updated.json.data.item.refundAmount, '66.67');
      status(await send(fixture, baseUrl, `${itemPath}/${itemId}`, {
        method: 'PATCH', body: { productVariantId: fixture.catalog.required.variantId },
      }), 400);
      status(await send(fixture, baseUrl, `${itemPath}/${itemId}`, { method: 'DELETE' }), 204);
      status(await send(fixture, baseUrl,
        `${returnsRoot(fixture)}/${salesReturn.salesReturnId}/cancel`,
        { method: 'POST', body: {} }), 200);
    });

    await t.test('serializes competing cumulative return commitments', async () => {
      const first = await createReturn(fixture, baseUrl);
      const second = await createReturn(fixture, baseUrl);
      const body = {
        originalSaleItemId: fixture.noneSaleItemId,
        returnReasonId: fixture.returnReasons.standard,
        quantityReturned: '2.000', itemCondition: 'UNOPENED', isRestockable: true,
      };
      const results = await Promise.all([
        send(fixture, baseUrl, `${returnsRoot(fixture)}/${first.salesReturnId}/items`, {
          method: 'POST', body,
        }),
        send(fixture, baseUrl, `${returnsRoot(fixture)}/${second.salesReturnId}/items`, {
          method: 'POST', body,
        }),
      ]);
      assert.deepEqual(results.map((value) => value.status).sort(), [201, 409]);
      for (const id of [first.salesReturnId, second.salesReturnId]) {
        status(await send(fixture, baseUrl, `${returnsRoot(fixture)}/${id}/cancel`, {
          method: 'POST', body: {},
        }), 200);
      }
    });

    await t.test('posts aggregate stock once with original cost and immutable sale evidence', async () => {
      const salesReturn = await createReturn(fixture, baseUrl);
      fixture.noneReturnId = salesReturn.salesReturnId;
      const added = await send(fixture, baseUrl,
        `${returnsRoot(fixture)}/${salesReturn.salesReturnId}/items`, {
          method: 'POST', body: {
            originalSaleItemId: fixture.noneSaleItemId,
            returnReasonId: fixture.returnReasons.standard,
            quantityReturned: '1.000', itemCondition: 'UNOPENED', isRestockable: true,
          },
        });
      status(added, 201);
      const completePath = `${returnsRoot(fixture)}/${salesReturn.salesReturnId}/complete`;
      const completed = await send(fixture, baseUrl, completePath, { method: 'POST', body: {} });
      status(completed, 200);
      assert.equal(completed.json.data.salesReturn.status, 'COMPLETED');
      assert.equal(completed.json.data.salesReturn.refundTotalAmount, '33.33');
      assert.match(completed.json.data.salesReturn.inventoryTransactionId, /^[1-9]\d*$/);
      status(await send(fixture, baseUrl, completePath, { method: 'POST', body: {} }), 409);
      status(await send(fixture, baseUrl,
        `${returnsRoot(fixture)}/${salesReturn.salesReturnId}/cancel`,
        { method: 'POST', body: {} }), 409);
      const [rows] = await pool.execute(
        `SELECT bi.quantity_on_hand AS quantityOnHand,
           bi.version_number AS versionNumber,
           it.transaction_type AS transactionType,
           iti.quantity_change AS quantityChange, iti.unit_cost AS unitCost, s.status
         FROM branch_inventory bi
         JOIN sales s ON s.sale_id = ?
         JOIN inventory_transactions it ON it.inventory_transaction_id = ?
         JOIN inventory_transaction_items iti
           ON iti.inventory_transaction_id = it.inventory_transaction_id
         WHERE bi.branch_id = ? AND bi.product_variant_id = ?`,
        [fixture.saleId, completed.json.data.salesReturn.inventoryTransactionId,
          fixture.branchAId, fixture.catalog.none.variantId],
      );
      assert.deepEqual(
        [rows[0].quantityOnHand, rows[0].versionNumber, rows[0].transactionType,
          rows[0].quantityChange, rows[0].unitCost, rows[0].status],
        ['98.000', 2, 'CUSTOMER_RETURN', '1.000', '4.0000', 'COMPLETED'],
      );
      const [history] = await pool.execute(
        `SELECT iti.quantity_change AS quantityChange, iti.unit_cost AS unitCost
         FROM inventory_transactions it
         JOIN inventory_transaction_items iti
           ON iti.inventory_transaction_id = it.inventory_transaction_id
         WHERE it.branch_id = ? AND iti.product_variant_id = ?
         ORDER BY it.occurred_at, it.inventory_transaction_id,
           iti.line_number, iti.inventory_transaction_item_id`,
        [fixture.branchAId, fixture.catalog.none.variantId],
      );
      assert.deepEqual(reconstructWeightedAverage(history, '98.000'), {
        outcome: 'calculated', unitCost: '4.0000',
      });
    });

    await t.test('requires independent approval and restores deterministic original lots', async () => {
      const salesReturn = await createReturn(fixture, baseUrl);
      fixture.lotReturnId = salesReturn.salesReturnId;
      const added = await send(fixture, baseUrl,
        `${returnsRoot(fixture)}/${salesReturn.salesReturnId}/items`, {
          method: 'POST', body: {
            originalSaleItemId: fixture.requiredSaleItemId,
            returnReasonId: fixture.returnReasons.approval,
            quantityReturned: '2.000', itemCondition: 'UNOPENED', isRestockable: true,
          },
        });
      status(added, 201);
      assert.equal(added.json.data.salesReturn.approvalRequired, true);
      status(await send(fixture, baseUrl,
        `${returnsRoot(fixture)}/${salesReturn.salesReturnId}/complete`,
        { method: 'POST', body: {} }), 409);
      status(await send(fixture, baseUrl,
        `${returnsRoot(fixture)}/${salesReturn.salesReturnId}/submit`,
        { method: 'POST', body: {} }), 200);
      status(await send(fixture, baseUrl,
        `${returnsRoot(fixture)}/${salesReturn.salesReturnId}/approve`,
        { method: 'POST', body: {} }), 409);
      status(await send(fixture, baseUrl,
        `${returnsRoot(fixture)}/${salesReturn.salesReturnId}/approve`,
        { method: 'POST', body: {}, token: fixture.tokens.approver }), 200);
      const completed = await send(fixture, baseUrl,
        `${returnsRoot(fixture)}/${salesReturn.salesReturnId}/complete`,
        { method: 'POST', body: {} });
      status(completed, 200);
      assert.equal(completed.json.data.salesReturn.items[0].inventoryLotId, fixture.lotAId);
      const [balances] = await pool.execute(
        `SELECT CAST(bli.inventory_lot_id AS CHAR) AS inventoryLotId,
           bli.quantity_on_hand AS quantityOnHand
         FROM branch_lot_inventory bli
         JOIN inventory_lots il ON il.inventory_lot_id = bli.inventory_lot_id
         WHERE bli.branch_id = ? AND il.product_variant_id = ?
         ORDER BY bli.inventory_lot_id`,
        [fixture.branchAId, fixture.catalog.required.variantId],
      );
      assert.deepEqual(balances.map((row) => [row.inventoryLotId, row.quantityOnHand]), [
        [fixture.lotAId, '18.000'], [fixture.lotBId, '18.000'],
      ]);
    });


    await t.test('rolls back a late unsafe-lot posting failure without partial effects', async () => {
      const salesReturn = await createReturn(fixture, baseUrl);
      status(await send(fixture, baseUrl,
        `${returnsRoot(fixture)}/${salesReturn.salesReturnId}/items`, {
          method: 'POST', body: {
            originalSaleItemId: fixture.requiredSaleItemId,
            returnReasonId: fixture.returnReasons.standard,
            quantityReturned: '1.000', itemCondition: 'UNOPENED', isRestockable: true,
          },
        }), 201);
      const [beforeRows] = await pool.execute(
        `SELECT quantity_on_hand AS quantityOnHand, version_number AS versionNumber
         FROM branch_inventory WHERE branch_id = ? AND product_variant_id = ?`,
        [fixture.branchAId, fixture.catalog.required.variantId],
      );
      const [beforeLotRows] = await pool.execute(
        `SELECT quantity_on_hand AS quantityOnHand, version_number AS versionNumber
         FROM branch_lot_inventory WHERE branch_id = ? AND inventory_lot_id = ?`,
        [fixture.branchAId, fixture.lotAId],
      );
      await pool.execute("UPDATE inventory_lots SET status = 'RECALLED' WHERE inventory_lot_id = ?", [fixture.lotAId]);
      const failed = await send(fixture, baseUrl,
        `${returnsRoot(fixture)}/${salesReturn.salesReturnId}/complete`,
        { method: 'POST', body: {}, label: 'LATE_ROLLBACK' });
      await pool.execute("UPDATE inventory_lots SET status = 'ACTIVE' WHERE inventory_lot_id = ?", [fixture.lotAId]);
      status(failed, 409);
      const [afterRows] = await pool.execute(
        `SELECT bi.quantity_on_hand AS quantityOnHand,
           bi.version_number AS versionNumber, sr.status,
           CAST(sr.inventory_transaction_id AS CHAR) AS inventoryTransactionId,
           (SELECT COUNT(*) FROM audit_logs WHERE request_id LIKE ?) AS auditCount
         FROM branch_inventory bi JOIN sales_returns sr ON sr.sales_return_id = ?
         WHERE bi.branch_id = ? AND bi.product_variant_id = ?`,
        [`${fixture.prefix}%LATE_ROLLBACK`, salesReturn.salesReturnId,
          fixture.branchAId, fixture.catalog.required.variantId],
      );
      assert.deepEqual(afterRows[0], {
        ...beforeRows[0], status: 'DRAFT', inventoryTransactionId: null, auditCount: '0',
      });
      const [afterLotRows] = await pool.execute(
        `SELECT quantity_on_hand AS quantityOnHand, version_number AS versionNumber
         FROM branch_lot_inventory WHERE branch_id = ? AND inventory_lot_id = ?`,
        [fixture.branchAId, fixture.lotAId],
      );
      assert.deepEqual(afterLotRows, beforeLotRows);
      const ledgerNote = `Stock restored by sales return ${salesReturn.returnNumber}.`;
      const [[rollbackEvidence]] = await pool.execute(
        `SELECT
           (SELECT COUNT(*) FROM inventory_transactions WHERE notes = ?) AS transactionCount,
           (SELECT COUNT(*) FROM inventory_transaction_items iti
              JOIN inventory_transactions it
                ON it.inventory_transaction_id = iti.inventory_transaction_id
            WHERE it.notes = ?) AS itemCount,
           (SELECT COUNT(*) FROM inventory_transaction_lot_allocations itla
              JOIN inventory_transaction_items iti
                ON iti.inventory_transaction_item_id = itla.inventory_transaction_item_id
              JOIN inventory_transactions it
                ON it.inventory_transaction_id = iti.inventory_transaction_id
            WHERE it.notes = ?) AS allocationCount`,
        [ledgerNote, ledgerNote, ledgerNote],
      );
      assert.deepEqual(rollbackEvidence, {
        transactionCount: '0', itemCount: '0', allocationCount: '0',
      });
      status(await send(fixture, baseUrl,
        `${returnsRoot(fixture)}/${salesReturn.salesReturnId}/cancel`,
        { method: 'POST', body: {} }), 200);
    });

    await t.test('records non-restockable merchandise without inventing inventory movement', async () => {
      const salesReturn = await createReturn(fixture, baseUrl);
      const added = await send(fixture, baseUrl,
        `${returnsRoot(fixture)}/${salesReturn.salesReturnId}/items`, {
          method: 'POST', body: {
            originalSaleItemId: fixture.noneSaleItemId,
            returnReasonId: fixture.returnReasons.damaged,
            quantityReturned: '1.000', itemCondition: 'DAMAGED', isRestockable: false,
          },
        });
      status(added, 201);
      const completed = await send(fixture, baseUrl,
        `${returnsRoot(fixture)}/${salesReturn.salesReturnId}/complete`,
        { method: 'POST', body: {} });
      status(completed, 200);
      assert.equal(completed.json.data.salesReturn.inventoryTransactionId, null);
      const [rows] = await pool.execute(
        'SELECT quantity_on_hand AS quantityOnHand FROM branch_inventory WHERE branch_id = ? AND product_variant_id = ?',
        [fixture.branchAId, fixture.catalog.none.variantId],
      );
      assert.equal(rows[0].quantityOnHand, '98.000');
    });


    await t.test('balances final partial money and restores the remaining original lots', async () => {
      const finalNone = await createReturn(fixture, baseUrl);
      status(await send(fixture, baseUrl,
        `${returnsRoot(fixture)}/${finalNone.salesReturnId}/items`, {
          method: 'POST', body: {
            originalSaleItemId: fixture.noneSaleItemId,
            returnReasonId: fixture.returnReasons.damaged,
            quantityReturned: '1.000', itemCondition: 'DAMAGED', isRestockable: false,
          },
        }), 201);
      const finalNoneResult = await send(fixture, baseUrl,
        `${returnsRoot(fixture)}/${finalNone.salesReturnId}/complete`,
        { method: 'POST', body: {} });
      status(finalNoneResult, 200);
      assert.equal(finalNoneResult.json.data.salesReturn.refundTotalAmount, '33.33');
      const [moneyRows] = await pool.execute(
        `SELECT SUM(sri.refund_amount) AS refundAmount,
           SUM(sri.quantity_returned) AS quantityReturned
         FROM sales_return_items sri
         JOIN sales_returns sr ON sr.sales_return_id = sri.sales_return_id
         WHERE sri.original_sale_item_id = ? AND sr.status = 'COMPLETED'`,
        [fixture.noneSaleItemId],
      );
      assert.deepEqual(moneyRows[0], { refundAmount: '100.00', quantityReturned: '3.000' });

      const multiLot = await createReturn(fixture, baseUrl);
      fixture.multiLotReturnId = multiLot.salesReturnId;
      status(await send(fixture, baseUrl,
        `${returnsRoot(fixture)}/${multiLot.salesReturnId}/items`, {
          method: 'POST', body: {
            originalSaleItemId: fixture.requiredSaleItemId,
            returnReasonId: fixture.returnReasons.standard,
            quantityReturned: '4.000', itemCondition: 'UNOPENED', isRestockable: true,
          },
        }), 201);
      const completed = await send(fixture, baseUrl,
        `${returnsRoot(fixture)}/${multiLot.salesReturnId}/complete`,
        { method: 'POST', body: {} });
      status(completed, 200);
      assert.equal(completed.json.data.salesReturn.refundTotalAmount, '40.00');
      assert.equal(completed.json.data.salesReturn.items[0].inventoryLotId, null);
      const [allocations] = await pool.execute(
        `SELECT CAST(itla.inventory_lot_id AS CHAR) AS inventoryLotId,
           itla.quantity_change AS quantityChange
         FROM inventory_transaction_items iti
         JOIN inventory_transaction_lot_allocations itla
           ON itla.inventory_transaction_item_id = iti.inventory_transaction_item_id
         WHERE iti.inventory_transaction_id = ? ORDER BY itla.inventory_lot_id`,
        [completed.json.data.salesReturn.inventoryTransactionId],
      );
      assert.deepEqual(allocations.map((row) => [row.inventoryLotId, row.quantityChange]), [
        [fixture.lotAId, '2.000'], [fixture.lotBId, '2.000'],
      ]);
    });

    await t.test('restores OPTIONAL provenance plus aggregate remainder for a zero-value full return', async () => {
      const salesReturn = await createReturn(fixture, baseUrl);
      const itemRoot = `${returnsRoot(fixture)}/${salesReturn.salesReturnId}/items`;
      status(await send(fixture, baseUrl, itemRoot, {
        method: 'POST', body: {
          originalSaleItemId: fixture.optionalSaleItemId,
          returnReasonId: fixture.returnReasons.standard,
          quantityReturned: '6.000', itemCondition: 'UNOPENED', isRestockable: true,
        },
      }), 201);
      const completed = await send(fixture, baseUrl,
        `${returnsRoot(fixture)}/${salesReturn.salesReturnId}/complete`,
        { method: 'POST', body: {} });
      status(completed, 200);
      const result = completed.json.data.salesReturn;
      assert.equal(result.refundTotalAmount, '0.00');
      assert.equal(result.items[0].inventoryLotId, null);
      assert.match(result.inventoryTransactionId, /^[1-9]\d*$/);
      const [[stock]] = await pool.execute(
        `SELECT bi.quantity_on_hand AS quantityOnHand,
           bi.version_number AS inventoryVersion,
           bli.quantity_on_hand AS lotQuantityOnHand,
           bli.version_number AS lotVersion,
           iti.quantity_change AS quantityChange, iti.unit_cost AS unitCost,
           itla.quantity_change AS lotQuantityChange, itla.unit_cost AS lotUnitCost
         FROM branch_inventory bi
         JOIN branch_lot_inventory bli
           ON bli.branch_id = bi.branch_id AND bli.inventory_lot_id = ?
         JOIN inventory_transaction_items iti
           ON iti.inventory_transaction_id = ?
          AND iti.product_variant_id = bi.product_variant_id
         LEFT JOIN inventory_transaction_lot_allocations itla
           ON itla.inventory_transaction_item_id = iti.inventory_transaction_item_id
         WHERE bi.branch_id = ? AND bi.product_variant_id = ?`,
        [fixture.optionalLotId, result.inventoryTransactionId,
          fixture.branchAId, fixture.catalog.optional.variantId],
      );
      assert.deepEqual(stock, {
        quantityOnHand: '20.000', inventoryVersion: 2,
        lotQuantityOnHand: '10.000', lotVersion: 2,
        quantityChange: '6.000', unitCost: '6.0000',
        lotQuantityChange: '4.000', lotUnitCost: '6.0000',
      });
      const [history] = await pool.execute(
        `SELECT iti.quantity_change AS quantityChange, iti.unit_cost AS unitCost
         FROM inventory_transactions it
         JOIN inventory_transaction_items iti
           ON iti.inventory_transaction_id = it.inventory_transaction_id
         WHERE it.branch_id = ? AND iti.product_variant_id = ?
         ORDER BY it.occurred_at, it.inventory_transaction_id,
           iti.line_number, iti.inventory_transaction_item_id`,
        [fixture.branchAId, fixture.catalog.optional.variantId],
      );
      assert.deepEqual(reconstructWeightedAverage(history, '20.000'), {
        outcome: 'calculated', unitCost: '6.0000',
      });
      const refundRoot = `${returnsRoot(fixture)}/${salesReturn.salesReturnId}/refunds`;
      status(await send(fixture, baseUrl, refundRoot, {
        method: 'POST', body: {
          paymentMethodId: fixture.paymentMethods.card, amount: '0.00',
        },
      }), 400);
      status(await send(fixture, baseUrl, refundRoot, {
        method: 'POST', body: {
          paymentMethodId: fixture.paymentMethods.card, amount: '0.01',
        },
      }), 409);
    });

    await t.test('creates linked REFUND attempts, enforces exact caps, and supports split settlement', async () => {
      const refundRoot = `${returnsRoot(fixture)}/${fixture.noneReturnId}/refunds`;
      status(await send(fixture, baseUrl, refundRoot, {
        method: 'POST', body: { paymentMethodId: fixture.paymentMethods.inactive, amount: '1.00' },
      }), 409);
      status(await send(fixture, baseUrl, refundRoot, {
        method: 'POST', body: { paymentMethodId: fixture.paymentMethods.reference, amount: '1.00' },
      }), 400);
      const first = await send(fixture, baseUrl, refundRoot, {
        method: 'POST', body: { paymentMethodId: fixture.paymentMethods.card, amount: '10.00' },
      });
      status(first, 201);
      assert.equal(first.json.data.payment.paymentType, 'REFUND');
      assert.equal(first.json.data.payment.status, 'PENDING');
      assert.equal(first.json.data.payment.salesReturnId, fixture.noneReturnId);
      assert.equal(first.json.data.payment.processedByEmployeeId,
        fixture.employeeByName.actor);
      assert.equal(first.json.data.payment.currencyCode, 'NGN');
      assert.match(first.json.data.payment.paymentNumber, /^PAY-[A-F0-9]{32}$/);
      const firstCompletion = await send(fixture, baseUrl,
        `${refundRoot}/${first.json.data.payment.salePaymentId}/complete`,
        { method: 'POST', body: {} });
      status(firstCompletion, 200);
      assert.equal(firstCompletion.json.data.payment.status, 'COMPLETED');
      assert.match(firstCompletion.json.data.payment.paidAt, /Z$/);
      const races = await Promise.all([
        send(fixture, baseUrl, refundRoot, {
          method: 'POST', body: { paymentMethodId: fixture.paymentMethods.card, amount: '23.33' },
        }),
        send(fixture, baseUrl, refundRoot, {
          method: 'POST', body: { paymentMethodId: fixture.paymentMethods.card, amount: '23.33' },
        }),
      ]);
      assert.deepEqual(races.map((value) => value.status).sort(), [201, 409]);
      const winner = races.find((value) => value.status === 201);
      assert.notEqual(winner.json.data.payment.paymentNumber,
        first.json.data.payment.paymentNumber);
      status(await send(fixture, baseUrl,
        `${refundRoot}/${winner.json.data.payment.salePaymentId}/complete`,
        { method: 'POST', body: {} }), 200);
      status(await send(fixture, baseUrl,
        `${refundRoot}/${winner.json.data.payment.salePaymentId}/complete`,
        { method: 'POST', body: {} }), 409);
      status(await send(fixture, baseUrl,
        `${refundRoot}/18446744073709551615/complete`,
        { method: 'POST', body: {} }), 404);
      const listed = await send(fixture, baseUrl, refundRoot);
      status(listed, 200);
      assert.deepEqual(listed.json.data.summary, {
        returnTotal: '33.33', completedRefundAmount: '33.33',
        pendingRefundAmount: '0.00', activeRefundAmount: '33.33',
        outstandingRefundAmount: '0.00', isFullyRefunded: true,
      });
    });

    await t.test('serializes exact refund races, terminal actions, and the sale-level cap', async () => {
      const raceSale = fixture.specialSales.race;
      const raceRoot = returnsRoot(fixture, raceSale.saleId);
      const created = await send(fixture, baseUrl, raceRoot, {
        method: 'POST', body: { notes: fixture.prefix },
      });
      status(created, 201);
      const raceReturnId = created.json.data.salesReturn.salesReturnId;
      status(await send(fixture, baseUrl, `${raceRoot}/${raceReturnId}/items`, {
        method: 'POST', body: {
          originalSaleItemId: raceSale.saleItemId,
          returnReasonId: fixture.returnReasons.damaged,
          quantityReturned: '100.000', itemCondition: 'DAMAGED', isRestockable: false,
        },
      }), 201);
      status(await send(fixture, baseUrl, `${raceRoot}/${raceReturnId}/complete`, {
        method: 'POST', body: {},
      }), 200);
      const refundRoot = `${raceRoot}/${raceReturnId}/refunds`;
      const sixtyRace = await Promise.all(['60.00', '60.00'].map((amount) =>
        send(fixture, baseUrl, refundRoot, {
          method: 'POST', body: { paymentMethodId: fixture.paymentMethods.card, amount },
        })));
      assert.deepEqual(sixtyRace.map((value) => value.status).sort(), [201, 409]);
      const sixtyWinner = sixtyRace.find((value) => value.status === 201);
      const failed = await send(fixture, baseUrl,
        `${refundRoot}/${sixtyWinner.json.data.payment.salePaymentId}/fail`, {
          method: 'POST', body: {},
        });
      status(failed, 200);
      assert.equal(failed.json.data.payment.status, 'FAILED');
      assert.equal(failed.json.data.payment.paidAt, null);
      status(await send(fixture, baseUrl,
        `${refundRoot}/${sixtyWinner.json.data.payment.salePaymentId}/complete`, {
          method: 'POST', body: {},
        }), 409);

      const exactSplit = await Promise.all(['40.00', '60.00'].map((amount) =>
        send(fixture, baseUrl, refundRoot, {
          method: 'POST', body: { paymentMethodId: fixture.paymentMethods.card, amount },
        })));
      assert.deepEqual(exactSplit.map((value) => value.status).sort(), [201, 201]);
      assert.equal(new Set(exactSplit.map((value) =>
        value.json.data.payment.paymentNumber)).size, 2);
      for (const result of exactSplit) {
        assert.equal(result.json.data.payment.status, 'PENDING');
        assert.equal(result.json.data.payment.currencyCode, 'NGN');
        assert.equal(result.json.data.payment.processedByEmployeeId,
          fixture.employeeByName.actor);
      }
      const duplicateComplete = await Promise.all([0, 1].map(() =>
        send(fixture, baseUrl,
          `${refundRoot}/${exactSplit[0].json.data.payment.salePaymentId}/complete`, {
            method: 'POST', body: {},
          })));
      assert.deepEqual(duplicateComplete.map((value) => value.status).sort(), [200, 409]);
      status(await send(fixture, baseUrl,
        `${refundRoot}/${exactSplit[1].json.data.payment.salePaymentId}/complete`, {
          method: 'POST', body: {},
        }), 200);
      const listed = await send(fixture, baseUrl, refundRoot);
      status(listed, 200);
      assert.deepEqual(listed.json.data.summary, {
        returnTotal: '100.00', completedRefundAmount: '100.00',
        pendingRefundAmount: '0.00', activeRefundAmount: '100.00',
        outstandingRefundAmount: '0.00', isFullyRefunded: true,
      });
      status(await send(fixture, baseUrl, refundRoot, {
        method: 'POST', body: {
          paymentMethodId: fixture.paymentMethods.card, amount: '0.01',
        },
      }), 409);

      const capSale = fixture.specialSales.cap;
      const capRoot = returnsRoot(fixture, capSale.saleId);
      const capCreated = await send(fixture, baseUrl, capRoot, {
        method: 'POST', body: { notes: fixture.prefix },
      });
      status(capCreated, 201);
      const capReturnId = capCreated.json.data.salesReturn.salesReturnId;
      status(await send(fixture, baseUrl, `${capRoot}/${capReturnId}/items`, {
        method: 'POST', body: {
          originalSaleItemId: capSale.saleItemId,
          returnReasonId: fixture.returnReasons.damaged,
          quantityReturned: '100.000', itemCondition: 'DAMAGED', isRestockable: false,
        },
      }), 201);
      status(await send(fixture, baseUrl, `${capRoot}/${capReturnId}/complete`, {
        method: 'POST', body: {},
      }), 200);
      const saleCap = await send(fixture, baseUrl,
        `${capRoot}/${capReturnId}/refunds`, {
          method: 'POST', body: {
            paymentMethodId: fixture.paymentMethods.card, amount: '90.00',
          },
        });
      status(saleCap, 409);
      assert.match(saleCap.json.message, /completed payment collected/i);
    });

    await t.test('reconciles cash exactly and rolls back the till-close loser', async () => {
      const refundRoot = `${returnsRoot(fixture)}/${fixture.lotReturnId}/refunds`;
      for (const transition of ['fail', 'cancel']) {
        const created = await send(fixture, baseUrl, refundRoot, {
          method: 'POST', body: {
            paymentMethodId: fixture.paymentMethods.cash, amount: '1.00',
          },
        });
        status(created, 201);
        const transitioned = await send(fixture, baseUrl,
          `${refundRoot}/${created.json.data.payment.salePaymentId}/${transition}`,
          { method: 'POST', body: {} });
        status(transitioned, 200);
        assert.equal(transitioned.json.data.payment.status,
          transition === 'fail' ? 'FAILED' : 'CANCELLED');
        status(await send(fixture, baseUrl,
          `${refundRoot}/${created.json.data.payment.salePaymentId}/complete`,
          { method: 'POST', body: {} }), 409);
      }
      const noncash = await send(fixture, baseUrl, refundRoot, {
        method: 'POST', body: {
          paymentMethodId: fixture.paymentMethods.card, amount: '1.00',
        },
      });
      status(noncash, 201);
      status(await send(fixture, baseUrl,
        `${refundRoot}/${noncash.json.data.payment.salePaymentId}/complete`,
        { method: 'POST', body: {} }), 200);
      const completedCash = await send(fixture, baseUrl, refundRoot, {
        method: 'POST', body: {
          paymentMethodId: fixture.paymentMethods.cash, amount: '2.00',
        },
      });
      status(completedCash, 201);
      status(await send(fixture, baseUrl,
        `${refundRoot}/${completedCash.json.data.payment.salePaymentId}/complete`,
        { method: 'POST', body: {} }), 200);

      const racingCash = await send(fixture, baseUrl, refundRoot, {
        method: 'POST', body: {
          paymentMethodId: fixture.paymentMethods.cash, amount: '5.00',
        },
      });
      status(racingCash, 201);
      const blockedCash = await send(fixture, baseUrl, refundRoot, {
        method: 'POST', body: {
          paymentMethodId: fixture.paymentMethods.cash, amount: '2.00',
        },
      });
      status(blockedCash, 201);
      const [refundResult, closeResult] = await Promise.all([
        send(fixture, baseUrl,
          `${refundRoot}/${racingCash.json.data.payment.salePaymentId}/complete`,
          { method: 'POST', body: {} }),
        send(fixture, baseUrl, `${root(fixture)}/till-sessions/${fixture.tillId}/close`, {
          method: 'POST', body: { actualClosingCashAmount: '100.00' },
        }),
      ]);
      status(closeResult, 200);
      assert.ok([200, 409].includes(refundResult.status), refundResult.text);
      const expected = refundResult.status === 200 ? '93.00' : '98.00';
      assert.equal(closeResult.json.data.tillSession.expectedClosingCashAmount, expected);
      if (refundResult.status === 409) {
        status(await send(fixture, baseUrl,
          `${refundRoot}/${racingCash.json.data.payment.salePaymentId}/cancel`,
          { method: 'POST', body: {} }), 200);
      }

      const afterClose = await send(fixture, baseUrl,
        `${refundRoot}/${blockedCash.json.data.payment.salePaymentId}/complete`, {
          method: 'POST', body: {}, label: 'CASH_AFTER_CLOSE',
        });
      status(afterClose, 409);
      const [[rollback]] = await pool.execute(
        `SELECT sp.status, DATE_FORMAT(sp.paid_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS paidAt,
           ts.expected_closing_cash_amount AS expectedClosingCashAmount,
           (SELECT COUNT(*) FROM audit_logs WHERE request_id LIKE ?) AS auditCount
         FROM sale_payments sp JOIN till_sessions ts ON ts.till_session_id = ?
         WHERE sp.sale_payment_id = ?`,
        [`${fixture.prefix}%CASH_AFTER_CLOSE`, fixture.tillId,
          blockedCash.json.data.payment.salePaymentId],
      );
      assert.deepEqual(rollback, {
        status: 'PENDING', paidAt: null,
        expectedClosingCashAmount: expected, auditCount: '0',
      });
      status(await send(fixture, baseUrl,
        `${refundRoot}/${blockedCash.json.data.payment.salePaymentId}/cancel`,
        { method: 'POST', body: {} }), 200);
      status(await send(fixture, baseUrl, refundRoot, {
        method: 'POST', body: {
          paymentMethodId: fixture.paymentMethods.cash, amount: '1.00',
        },
      }), 409);
    });

    await t.test('resolves a pending inactive method and accepts an exact concurrent split', async () => {
      const lotRefundRoot = `${returnsRoot(fixture)}/${fixture.lotReturnId}/refunds`;
      const externalReference = `${fixture.prefix}_BANK_REF`;
      const pending = await send(fixture, baseUrl, lotRefundRoot, {
        method: 'POST', body: {
          paymentMethodId: fixture.paymentMethods.reference,
          amount: '1.00', externalReference,
        },
      });
      status(pending, 201);
      await pool.execute('UPDATE payment_methods SET is_active = 0 WHERE payment_method_id = ?', [fixture.paymentMethods.reference]);
      status(await send(fixture, baseUrl,
        `${lotRefundRoot}/${pending.json.data.payment.salePaymentId}/complete`,
        { method: 'POST', body: {} }), 200);
      status(await send(fixture, baseUrl, lotRefundRoot, {
        method: 'POST', body: {
          paymentMethodId: fixture.paymentMethods.reference,
          amount: '1.00', externalReference: `${externalReference}_NEW`,
        },
      }), 409);
      await pool.execute('UPDATE payment_methods SET is_active = 1 WHERE payment_method_id = ?', [fixture.paymentMethods.reference]);
      status(await send(fixture, baseUrl, lotRefundRoot, {
        method: 'POST', body: {
          paymentMethodId: fixture.paymentMethods.reference,
          amount: '1.00', externalReference,
        },
      }), 409);

      const splitRoot = `${returnsRoot(fixture)}/${fixture.multiLotReturnId}/refunds`;
      const split = await Promise.all(['15.00', '25.00'].map((amount) =>
        send(fixture, baseUrl, splitRoot, {
          method: 'POST', body: { paymentMethodId: fixture.paymentMethods.card, amount },
        })));
      assert.deepEqual(split.map((value) => value.status).sort(), [201, 201]);
      for (const result of split) {
        status(await send(fixture, baseUrl,
          `${splitRoot}/${result.json.data.payment.salePaymentId}/complete`,
          { method: 'POST', body: {} }), 200);
      }
      const listed = await send(fixture, baseUrl, splitRoot);
      status(listed, 200);
      assert.equal(listed.json.data.summary.completedRefundAmount, '40.00');
      assert.equal(listed.json.data.summary.isFullyRefunded, true);
    });

    await t.test('persists only successful audits and exposes no Phase 15 surface', async () => {
      const [audits] = await pool.execute(
        `SELECT action_type AS actionType FROM audit_logs
         WHERE request_id LIKE ? ORDER BY audit_log_id`,
        [`${fixture.prefix}%`],
      );
      const actions = new Set(audits.map((row) => row.actionType));
      for (const action of [
        'SALES_RETURN_CREATED', 'SALES_RETURN_ITEM_CREATED',
        'SALES_RETURN_ITEM_UPDATED', 'SALES_RETURN_ITEM_DELETED',
        'SALES_RETURN_COMPLETED', 'SALES_RETURN_CANCELLED',
        'SALES_RETURN_SUBMITTED', 'SALES_RETURN_APPROVED',
        'SALE_REFUND_CREATED', 'SALE_REFUND_COMPLETED',
        'SALE_REFUND_FAILED', 'SALE_REFUND_CANCELLED',
      ]) assert.equal(actions.has(action), true, action);
      status(await send(fixture, baseUrl, '/api/admin/reports/returns', {
        token: fixture.tokens.admin,
      }), 404);
      const [originalRows] = await pool.execute(
        `SELECT s.status, sp.payment_type AS paymentType, sp.status AS paymentStatus,
           sp.amount FROM sales s JOIN sale_payments sp ON sp.sale_payment_id = ?
         WHERE s.sale_id = ?`,
        [fixture.originalPaymentId, fixture.saleId],
      );
      assert.deepEqual(originalRows[0], {
        status: 'COMPLETED', paymentType: 'PAYMENT',
        paymentStatus: 'COMPLETED', amount: '160.00',
      });
    });
  } finally {
    await stopServer(server);
    await cleanupFixture(fixture);
    await pool.end();
  }
});
