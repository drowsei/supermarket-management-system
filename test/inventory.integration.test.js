import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import bcrypt from 'bcrypt';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const [{ default: app }, { pool }, { ensureAccessControl }, access, { signAccessToken }] =
  await Promise.all([
    import('../src/app.js'),
    import('../src/config/database.js'),
    import('../src/repositories/accessControlSeed.repository.js'),
    import('../src/config/accessControl.js'),
    import('../src/utils/jwt.js'),
  ]);

const { ACCESS_CONTROL_PERMISSIONS, SYSTEM_ADMIN_ROLE } = access;
const TIMEOUT_MS = 600_000;

function fixtureDefinition() {
  const token = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
  return { token, prefix: `TEST_P8_${token}`, setupComplete: false, cleaned: false };
}

const placeholders = (values) => values.map(() => '?').join(', ');

async function lastId(connection) {
  const [rows] = await connection.execute('SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id');
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
  const headers = new Headers(options.headers);
  if (options.token !== null) {
    headers.set('authorization', `Bearer ${options.token ?? fixture.tokens.admin}`);
  }
  headers.set('user-agent', 'TEST_PHASE8_INVENTORY/1.0');
  let body;
  if (options.body !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(options.body);
  }
  fixture.requestCounter += 1;
  headers.set('x-request-id', `${fixture.prefix}_${fixture.requestCounter}`);
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET', headers, body,
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null, text };
}

function status(result, expected) {
  assert.equal(result.status, expected, result.text);
  if (expected >= 400) {
    assert.equal(result.json?.success, false);
    for (const forbidden of ['sqlMessage', 'DB_PASSWORD', 'stack']) {
      assert.equal(result.text.includes(forbidden), false);
    }
  }
}

async function createFixture(fixture) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const seed = await ensureAccessControl(connection);
    assert.equal(seed.permissionCount, 30);
    assert.equal(seed.assignedPermissionCount, 30);
    assert.equal(ACCESS_CONTROL_PERMISSIONS.length, 30);
    const [permissionRows] = await connection.execute(
      `SELECT CAST(permission_id AS CHAR) AS id, permission_code AS code
       FROM permissions WHERE permission_code IN (${placeholders(ACCESS_CONTROL_PERMISSIONS)})`,
      ACCESS_CONTROL_PERMISSIONS.map(({ code }) => code),
    );
    const permissionIds = Object.fromEntries(permissionRows.map((row) => [row.code, row.id]));
    const [systemRows] = await connection.execute(
      'SELECT CAST(role_id AS CHAR) AS id FROM roles WHERE role_code = ?',
      [SYSTEM_ADMIN_ROLE.code],
    );
    fixture.systemRoleId = systemRows[0].id;

    fixture.branchIds = [];
    for (const suffix of ['A', 'B']) {
      await connection.execute(
        `INSERT INTO branches (
           branch_code, branch_name, address_line_1, city,
           country_code, currency_code, timezone, status
         ) VALUES (?, ?, '1 Test Street', 'Lagos', 'NG', 'NGN', 'Africa/Lagos', 'ACTIVE')`,
        [`P8${suffix}_${fixture.token}`, `${fixture.prefix} Branch ${suffix}`],
      );
      fixture.branchIds.push(await lastId(connection));
    }
    [fixture.branchId, fixture.otherBranchId] = fixture.branchIds;

    fixture.employeeIds = [];
    for (const [name, branchId] of [['admin', fixture.branchId], ['writer', fixture.branchId], ['wrong', fixture.otherBranchId]]) {
      await connection.execute(
        `INSERT INTO employees (
           employee_number, first_name, last_name, hire_date, employment_status
         ) VALUES (?, 'Phase', ?, CURRENT_DATE(), 'ACTIVE')`,
        [`P8_${name}_${fixture.token}`, name],
      );
      const employeeId = await lastId(connection);
      fixture.employeeIds.push(employeeId);
      fixture[`${name}EmployeeId`] = employeeId;
      await connection.execute(
        `INSERT INTO employee_branch_assignments (
           employee_id, branch_id, job_title, started_on, is_primary
         ) VALUES (?, ?, 'Inventory Test', CURRENT_DATE(), 1)`,
        [employeeId, branchId],
      );
    }

    const rolePermissions = {
      none: [],
      catalogOnly: ['catalog.read', 'catalog.manage'],
      productsOnly: ['products.read', 'products.manage'],
      pricingOnly: ['pricing.read', 'pricing.manage'],
      suppliersOnly: ['suppliers.read', 'suppliers.manage'],
      purchasingOnly: ['purchasing.read', 'purchasing.manage'],
      receivingOnly: ['receiving.read', 'receiving.manage'],
      read: ['inventory.read'],
      manage: ['inventory.manage'],
      wrongBranch: ['inventory.read', 'inventory.manage'],
      globalRead: ['inventory.read'],
    };
    fixture.roleIds = [];
    const roleIds = {};
    for (const [name, codes] of Object.entries(rolePermissions)) {
      await connection.execute(
        'INSERT INTO roles (role_code, role_name, is_active) VALUES (?, ?, 1)',
        [`P8_${name.toUpperCase()}_${fixture.token}`, `${fixture.prefix} ${name}`],
      );
      const id = await lastId(connection);
      fixture.roleIds.push(id);
      roleIds[name] = id;
      for (const code of codes) {
        await connection.execute(
          'INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
          [id, permissionIds[code]],
        );
      }
    }
    const hash = await bcrypt.hash(`Phase8-${fixture.token}-Password!`, Number(process.env.BCRYPT_ROUNDS));
    fixture.userIds = [];
    fixture.tokens = {};
    const users = [
      ['admin', fixture.adminEmployeeId, fixture.systemRoleId, null, 0],
      ['system', null, fixture.systemRoleId, null, 0],
      ['must', null, fixture.systemRoleId, null, 1],
      ['none', null, roleIds.none, null, 0],
      ['catalogOnly', null, roleIds.catalogOnly, null, 0],
      ['productsOnly', null, roleIds.productsOnly, null, 0],
      ['pricingOnly', null, roleIds.pricingOnly, null, 0],
      ['suppliersOnly', null, roleIds.suppliersOnly, null, 0],
      ['purchasingOnly', null, roleIds.purchasingOnly, null, 0],
      ['receivingOnly', null, roleIds.receivingOnly, null, 0],
      ['read', null, roleIds.read, fixture.branchId, 0],
      ['manage', fixture.writerEmployeeId, roleIds.manage, fixture.branchId, 0],
      ['wrongBranch', fixture.wrongEmployeeId, roleIds.wrongBranch, fixture.otherBranchId, 0],
      ['globalRead', null, roleIds.globalRead, null, 0],
    ];
    for (const [name, employeeId, roleId, branchId, mustChange] of users) {
      await connection.execute(
        `INSERT INTO users (
           employee_id, username, email, password_hash,
           is_active, must_change_password
         ) VALUES (?, ?, ?, ?, 1, ?)`,
        [employeeId, `p8.${name}.${fixture.token.toLowerCase()}`,
          `p8.${name}.${fixture.token.toLowerCase()}@example.invalid`, hash, mustChange],
      );
      const id = await lastId(connection);
      fixture.userIds.push(id);
      await connection.execute('INSERT INTO user_roles (user_id, role_id, branch_id) VALUES (?, ?, ?)',
        [id, roleId, branchId]);
      fixture.tokens[name] = signAccessToken(id).accessToken;
    }

    await connection.execute(
      `INSERT INTO units_of_measure (unit_code, unit_name, symbol, allows_fraction)
       VALUES (?, ?, ?, 0)`,
      [`P8U_${fixture.token}`, `${fixture.prefix} bottle`, `p8${fixture.token}`],
    );
    fixture.unitId = await lastId(connection);
    await connection.execute(
      'INSERT INTO categories (category_code, category_name, is_active) VALUES (?, ?, 1)',
      [`P8C_${fixture.token}`, `${fixture.prefix} Category`],
    );
    fixture.categoryId = await lastId(connection);
    await connection.execute(
      'INSERT INTO brands (brand_code, brand_name, is_active) VALUES (?, ?, 1)',
      [`P8B_${fixture.token}`, `${fixture.prefix} Brand`],
    );
    fixture.brandId = await lastId(connection);
    await connection.execute(
      `INSERT INTO products (category_id, brand_id, product_code, product_name, status)
       VALUES (?, ?, ?, ?, 'ACTIVE')`,
      [fixture.categoryId, fixture.brandId, `P8P_${fixture.token}`, `${fixture.prefix} Product`],
    );
    fixture.productId = await lastId(connection);
    fixture.variantIds = [];
    fixture.packageIds = [];
    for (const [key, mode] of [['none', 'NONE'], ['required', 'REQUIRED'], ['optional', 'OPTIONAL'], ['new', 'NONE'], ['race', 'NONE']]) {
      await connection.execute(
        `INSERT INTO product_variants (
           product_id, unit_of_measure_id, sku, variant_name, lot_tracking_mode,
           default_selling_price, status
         ) VALUES (?, ?, ?, ?, ?, '10.0000', 'ACTIVE')`,
        [fixture.productId, fixture.unitId, `P8V_${key.toUpperCase()}_${fixture.token}`,
          `${fixture.prefix} ${key}`, mode],
      );
      const variantId = await lastId(connection);
      fixture.variantIds.push(variantId);
      fixture[`${key}VariantId`] = variantId;
      await connection.execute(
        `INSERT INTO product_packages (
           product_variant_id, package_unit_of_measure_id, package_code,
           package_name, conversion_to_base_quantity, is_base_unit,
           is_purchasable, is_sellable, status
         ) VALUES (?, ?, ?, ?, '1.000000', 1, 1, 1, 'ACTIVE')`,
        [variantId, fixture.unitId, `BASE_${key.toUpperCase()}`, `${key} bottle`],
      );
      fixture.packageIds.push(await lastId(connection));
    }
    await connection.execute(
      `INSERT INTO branch_inventory (branch_id, product_variant_id, quantity_on_hand)
       VALUES (?, ?, '5.000'), (?, ?, '7.000')`,
      [fixture.branchId, fixture.noneVariantId, fixture.branchId, fixture.optionalVariantId],
    );

    await connection.execute(
      'INSERT INTO suppliers (supplier_code, supplier_name, status) VALUES (?, ?, ?)',
      [`P8S_${fixture.token}`, `${fixture.prefix} Supplier`, 'ACTIVE'],
    );
    fixture.supplierId = await lastId(connection);
    await connection.execute(
      `INSERT INTO purchase_orders (
         purchase_order_number, branch_id, supplier_id, status, ordered_at,
         created_by_employee_id, approved_by_employee_id, approved_at,
         currency_code, subtotal_amount, total_amount, notes
       ) VALUES (?, ?, ?, 'APPROVED', UTC_TIMESTAMP(6), ?, ?, UTC_TIMESTAMP(6),
         'NGN', '10.00', '10.00', ?)`,
      [`P8PO-${fixture.token}`, fixture.branchId, fixture.supplierId,
        fixture.adminEmployeeId, fixture.adminEmployeeId, `${fixture.prefix} receipt`],
    );
    fixture.orderId = await lastId(connection);
    await connection.execute(
      `INSERT INTO purchase_order_items (
         purchase_order_id, line_number, product_variant_id, product_package_id,
         item_description, ordered_package_quantity, package_conversion_factor,
         ordered_quantity, unit_cost, discount_amount, tax_rate_percent,
         tax_amount, line_total
       ) VALUES (?, 1, ?, ?, ?, '5.000', '1.000000', '5.000',
         '2.0000', '0.00', '0.0000', '0.00', '10.00')`,
      [fixture.orderId, fixture.requiredVariantId, fixture.packageIds[1], `${fixture.prefix} item`],
    );
    fixture.orderItemId = await lastId(connection);
    await connection.execute(
      `INSERT INTO goods_receipts (
         goods_receipt_number, purchase_order_id, branch_id, supplier_id,
         status, received_at, received_by_employee_id, notes
       ) VALUES (?, ?, ?, ?, 'DRAFT', UTC_TIMESTAMP(6), ?, ?)`,
      [`P8GR-${fixture.token}`, fixture.orderId, fixture.branchId,
        fixture.supplierId, fixture.adminEmployeeId, `${fixture.prefix} receipt`],
    );
    fixture.receiptId = await lastId(connection);
    await connection.execute(
      `INSERT INTO goods_receipt_items (
         goods_receipt_id, purchase_order_id, purchase_order_item_id,
         product_variant_id, line_number, package_quantity_accepted,
         package_quantity_rejected, package_conversion_factor,
         quantity_accepted, quantity_rejected, actual_unit_cost,
         discount_amount, tax_amount, line_total
       ) VALUES (?, ?, ?, ?, 1, '5.000', '0.000', '1.000000',
         '5.000', '0.000', '2.0000', '0.00', '0.00', '10.00')`,
      [fixture.receiptId, fixture.orderId, fixture.orderItemId, fixture.requiredVariantId],
    );
    fixture.receiptItemId = await lastId(connection);
    fixture.orderIds = [fixture.orderId];
    fixture.receiptIds = [fixture.receiptId];

    for (const [key, variantId, lotNumber, lotStatus, branchStatus, qty] of [
      ['optionalLotId', fixture.optionalVariantId, `${fixture.prefix}-opt`, 'ACTIVE', 'QUARANTINED', '3.000'],
      ['recalledLotId', fixture.optionalVariantId, `${fixture.prefix}-recalled`, 'RECALLED', 'BLOCKED', '1.000'],
      ['zeroLotId', fixture.optionalVariantId, `${fixture.prefix}-zero`, 'ACTIVE', 'BLOCKED', '0.000'],
      ['otherLotId', fixture.optionalVariantId, `${fixture.prefix}-other`, 'ACTIVE', 'AVAILABLE', '1.000'],
    ]) {
      await connection.execute(
        `INSERT INTO inventory_lots (
           product_variant_id, lot_number, expires_on, status, created_by_employee_id
         ) VALUES (?, ?, '2030-12-31', ?, ?)`,
        [variantId, lotNumber, lotStatus, fixture.adminEmployeeId],
      );
      const lotId = await lastId(connection);
      fixture[key] = lotId;
      await connection.execute(
        `INSERT INTO branch_lot_inventory (
           branch_id, inventory_lot_id, quantity_on_hand, status
         ) VALUES (?, ?, ?, ?)`,
        [key === 'otherLotId' ? fixture.otherBranchId : fixture.branchId,
          lotId, qty, branchStatus],
      );
    }
    await connection.commit();
    fixture.setupComplete = true;
    fixture.requestCounter = 0;
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
    await connection.execute('DELETE FROM audit_logs WHERE request_id LIKE ?', [`${fixture.prefix}%`]);
    await connection.execute(
      `DELETE FROM audit_logs WHERE user_id IN (${placeholders(fixture.userIds)})`, fixture.userIds,
    );
    const [transactionRows] = await connection.execute(
      `SELECT CAST(inventory_transaction_id AS CHAR) AS id FROM goods_receipts
       WHERE goods_receipt_id IN (${placeholders(fixture.receiptIds)})
         AND inventory_transaction_id IS NOT NULL`, fixture.receiptIds,
    );
    const transactionIds = transactionRows.map((row) => row.id);
    if (fixture.syntheticTransactionId) transactionIds.push(fixture.syntheticTransactionId);
    if (transactionIds.length) {
      await connection.execute(
        `DELETE itla FROM inventory_transaction_lot_allocations itla
         INNER JOIN inventory_transaction_items iti
           ON iti.inventory_transaction_item_id = itla.inventory_transaction_item_id
         WHERE iti.inventory_transaction_id IN (${placeholders(transactionIds)})`, transactionIds,
      );
    }
    await connection.execute(
      `DELETE gril FROM goods_receipt_item_lots gril
       INNER JOIN goods_receipt_items gri
         ON gri.goods_receipt_item_id = gril.goods_receipt_item_id
       WHERE gri.goods_receipt_id IN (${placeholders(fixture.receiptIds)})`, fixture.receiptIds,
    );
    await connection.execute(
      `DELETE FROM branch_lot_inventory WHERE branch_id IN (?, ?)
       AND inventory_lot_id IN (
         SELECT inventory_lot_id FROM inventory_lots
         WHERE product_variant_id IN (${placeholders(fixture.variantIds)})
       )`, [fixture.branchId, fixture.otherBranchId, ...fixture.variantIds],
    );
    await connection.execute(
      `DELETE FROM goods_receipt_items
       WHERE goods_receipt_id IN (${placeholders(fixture.receiptIds)})`, fixture.receiptIds,
    );
    await connection.execute(
      `DELETE FROM goods_receipts
       WHERE goods_receipt_id IN (${placeholders(fixture.receiptIds)})`, fixture.receiptIds,
    );
    if (transactionIds.length) {
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
    }
    await connection.execute(
      `DELETE FROM branch_inventory WHERE branch_id IN (?, ?)
       AND product_variant_id IN (${placeholders(fixture.variantIds)})`,
      [fixture.branchId, fixture.otherBranchId, ...fixture.variantIds],
    );
    await connection.execute(
      `DELETE FROM inventory_lots WHERE product_variant_id IN (${placeholders(fixture.variantIds)})`,
      fixture.variantIds,
    );
    await connection.execute(
      `DELETE FROM purchase_order_items
       WHERE purchase_order_id IN (${placeholders(fixture.orderIds)})`, fixture.orderIds,
    );
    await connection.execute(
      `DELETE FROM purchase_orders
       WHERE purchase_order_id IN (${placeholders(fixture.orderIds)})`, fixture.orderIds,
    );
    await connection.execute('DELETE FROM suppliers WHERE supplier_id = ?', [fixture.supplierId]);
    await connection.execute(
      `DELETE FROM product_packages WHERE product_package_id IN (${placeholders(fixture.packageIds)})`,
      fixture.packageIds,
    );
    await connection.execute('DELETE FROM product_variants WHERE product_id = ?', [fixture.productId]);
    await connection.execute('DELETE FROM products WHERE product_id = ?', [fixture.productId]);
    await connection.execute('DELETE FROM brands WHERE brand_id = ?', [fixture.brandId]);
    await connection.execute('DELETE FROM categories WHERE category_id = ?', [fixture.categoryId]);
    await connection.execute('DELETE FROM units_of_measure WHERE unit_of_measure_id = ?', [fixture.unitId]);
    await connection.execute(
      `DELETE FROM users WHERE user_id IN (${placeholders(fixture.userIds)})`, fixture.userIds,
    );
    await connection.execute(
      `DELETE FROM roles WHERE role_id IN (${placeholders(fixture.roleIds)})`, fixture.roleIds,
    );
    await connection.execute(
      `DELETE FROM employee_branch_assignments
       WHERE employee_id IN (${placeholders(fixture.employeeIds)})`, fixture.employeeIds,
    );
    await connection.execute(
      `DELETE FROM employees WHERE employee_id IN (${placeholders(fixture.employeeIds)})`,
      fixture.employeeIds,
    );
    await connection.execute(
      'DELETE FROM branches WHERE branch_id IN (?, ?)', fixture.branchIds,
    );
    await connection.commit();
    fixture.cleaned = true;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function createReceiptPrerequisite(fixture, variantId, packageId, label) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      `INSERT INTO purchase_orders (
         purchase_order_number, branch_id, supplier_id, status, ordered_at,
         created_by_employee_id, approved_by_employee_id, approved_at,
         currency_code, subtotal_amount, total_amount, notes
       ) VALUES (?, ?, ?, 'APPROVED', UTC_TIMESTAMP(6), ?, ?, UTC_TIMESTAMP(6),
         'NGN', '4.00', '4.00', ?)`,
      [`P8${label}-${fixture.token}`, fixture.branchId, fixture.supplierId,
        fixture.adminEmployeeId, fixture.adminEmployeeId, `${fixture.prefix} ${label}`],
    );
    const orderId = await lastId(connection);
    await connection.execute(
      `INSERT INTO purchase_order_items (
         purchase_order_id, line_number, product_variant_id, product_package_id,
         item_description, ordered_package_quantity, package_conversion_factor,
         ordered_quantity, unit_cost, discount_amount, tax_rate_percent,
         tax_amount, line_total
       ) VALUES (?, 1, ?, ?, ?, '2.000', '1.000000', '2.000',
         '2.0000', '0.00', '0.0000', '0.00', '4.00')`,
      [orderId, variantId, packageId, `${fixture.prefix} ${label} item`],
    );
    const orderItemId = await lastId(connection);
    await connection.execute(
      `INSERT INTO goods_receipts (
         goods_receipt_number, purchase_order_id, branch_id, supplier_id,
         status, received_at, received_by_employee_id, notes
       ) VALUES (?, ?, ?, ?, 'DRAFT', UTC_TIMESTAMP(6), ?, ?)`,
      [`P8${label}-GR-${fixture.token}`, orderId, fixture.branchId,
        fixture.supplierId, fixture.adminEmployeeId, `${fixture.prefix} ${label}`],
    );
    const receiptId = await lastId(connection);
    await connection.execute(
      `INSERT INTO goods_receipt_items (
         goods_receipt_id, purchase_order_id, purchase_order_item_id,
         product_variant_id, line_number, package_quantity_accepted,
         package_quantity_rejected, package_conversion_factor,
         quantity_accepted, quantity_rejected, actual_unit_cost,
         discount_amount, tax_amount, line_total
       ) VALUES (?, ?, ?, ?, 1, '2.000', '0.000', '1.000000',
         '2.000', '0.000', '2.0000', '0.00', '0.00', '4.00')`,
      [receiptId, orderId, orderItemId, variantId],
    );
    const receiptItemId = await lastId(connection);
    await connection.commit();
    fixture.orderIds.push(orderId);
    fixture.receiptIds.push(receiptId);
    return { orderId, receiptId, receiptItemId };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function holdBranchLockAndRace(fixture, tasks) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      'SELECT branch_id FROM branches WHERE branch_id = ? FOR UPDATE',
      [fixture.branchId],
    );
    const pending = tasks.map((task) => task());
    await new Promise((resolve) => setTimeout(resolve, 80));
    await connection.commit();
    return await Promise.all(pending);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function nonInventoryBoundarySnapshot(fixture) {
  const queries = [
    ['product', 'SELECT product_code, product_name, status, updated_at FROM products WHERE product_id = ?', [fixture.productId]],
    ['variants', `SELECT sku, variant_name, status, updated_at FROM product_variants
      WHERE product_id = ? ORDER BY product_variant_id`, [fixture.productId]],
    ['packages', `SELECT package_code, status, conversion_to_base_quantity, updated_at
      FROM product_packages WHERE product_variant_id IN (${placeholders(fixture.variantIds)})
      ORDER BY product_package_id`, fixture.variantIds],
    ['supplier', 'SELECT supplier_code, supplier_name, status, updated_at FROM suppliers WHERE supplier_id = ?', [fixture.supplierId]],
    ['order', 'SELECT status, subtotal_amount, total_amount, updated_at FROM purchase_orders WHERE purchase_order_id = ?', [fixture.orderId]],
    ['receipt', 'SELECT status, inventory_transaction_id, updated_at FROM goods_receipts WHERE goods_receipt_id = ?', [fixture.receiptId]],
    ['variantPrices', 'SELECT COUNT(*) AS count FROM branch_variant_prices WHERE branch_id = ?', [fixture.branchId]],
    ['packagePrices', 'SELECT COUNT(*) AS count FROM branch_package_prices WHERE branch_id = ?', [fixture.branchId]],
  ];
  const result = {};
  for (const [key, sql, params] of queries) {
    const [rows] = await pool.execute(sql, params);
    result[key] = rows;
  }
  return result;
}

test('Phase 8 inventory engine', { timeout: TIMEOUT_MS }, async (t) => {
  const fixture = fixtureDefinition();
  let server;
  try {
    await createFixture(fixture);
    server = await startServer();
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const root = `/api/admin/branches/${fixture.branchId}/inventory`;

    await t.test('real Phase 7 receipt establishes lot, projection, and ledger', async () => {
      const posted = await send(fixture, baseUrl,
        `/api/admin/branches/${fixture.branchId}/goods-receipts/${fixture.receiptId}/post`, {
          method: 'POST',
          body: { lotAllocations: [{
            goodsReceiptItemId: fixture.receiptItemId,
            lots: [{ lotNumber: `${fixture.prefix}-Required`, expiresOn: '2030-12-31', quantityReceived: '5.000' }],
          }] },
        });
      status(posted, 200);
      fixture.transactionId = posted.json.data.inventoryTransactionId;
      const [rows] = await pool.execute(
        `SELECT CAST(inventory_lot_id AS CHAR) AS id FROM inventory_lots
         WHERE product_variant_id = ? AND lot_number = ?`,
        [fixture.requiredVariantId, `${fixture.prefix}-Required`],
      );
      fixture.requiredLotId = rows[0].id;
      const [quantity] = await pool.execute(
        `SELECT quantity_on_hand AS quantity FROM branch_inventory
         WHERE branch_id = ? AND product_variant_id = ?`,
        [fixture.branchId, fixture.requiredVariantId],
      );
      assert.equal(quantity[0].quantity, '5.000');
      fixture.nonInventoryBefore = await nonInventoryBoundarySnapshot(fixture);
    });

    await t.test('all eight routes enforce branch permission and actor boundaries', async () => {
      const routes = [
        { method: 'GET', path: root, access: 'read' },
        { method: 'GET', path: `${root}/variants/${fixture.requiredVariantId}`, access: 'read' },
        { method: 'PUT', path: `${root}/variants/${fixture.noneVariantId}/settings`, access: 'write', body: { reorderLevel: '0.000', reorderQuantity: '0.000' } },
        { method: 'GET', path: `${root}/lots`, access: 'read' },
        { method: 'GET', path: `${root}/lots/${fixture.requiredLotId}`, access: 'read' },
        { method: 'PATCH', path: `${root}/lots/${fixture.requiredLotId}/status`, access: 'write', body: { status: 'AVAILABLE' } },
        { method: 'GET', path: `${root}/transactions`, access: 'read' },
        { method: 'GET', path: `${root}/transactions/${fixture.transactionId}`, access: 'read' },
      ];
      assert.equal(routes.length, 8);
      assert.equal(new Set(routes.map((route) => `${route.method} ${route.path}`)).size, 8);
      for (const route of routes) {
        const options = { method: route.method, body: route.body };
        status(await send(fixture, baseUrl, route.path, { ...options, token: null }), 401);
        for (const name of ['must', 'none', 'catalogOnly', 'productsOnly', 'pricingOnly', 'suppliersOnly', 'purchasingOnly', 'receivingOnly', 'wrongBranch']) {
          status(await send(fixture, baseUrl, route.path,
            { ...options, token: fixture.tokens[name] }), name === 'must' ? 403 : 403);
        }
        if (route.access === 'read') {
          status(await send(fixture, baseUrl, route.path,
            { ...options, token: fixture.tokens.read }), 200);
          status(await send(fixture, baseUrl, route.path,
            { ...options, token: fixture.tokens.manage }), 403);
          status(await send(fixture, baseUrl, route.path,
            { ...options, token: fixture.tokens.globalRead }), 200);
          status(await send(fixture, baseUrl, route.path,
            { ...options, token: fixture.tokens.system }), 200);
        } else {
          status(await send(fixture, baseUrl, route.path,
            { ...options, token: fixture.tokens.read }), 403);
          status(await send(fixture, baseUrl, route.path,
            { ...options, token: fixture.tokens.system }), 403);
          status(await send(fixture, baseUrl, route.path,
            { ...options, token: fixture.tokens.manage }), 200);
        }
      }
      status(await send(fixture, baseUrl,
        `/api/admin/branches/${fixture.otherBranchId}/inventory`,
        { token: fixture.tokens.globalRead }), 200);
      status(await send(fixture, baseUrl,
        `/api/admin/branches/${fixture.otherBranchId}/inventory`,
        { token: fixture.tokens.admin }), 403);
    });

    await t.test('inventory read model, filters, exact values, and no read side effects', async () => {
      const result = await send(fixture, baseUrl, root);
      status(result, 200);
      assert.equal(result.json.data.pagination.page, 1);
      assert.equal(result.json.data.pagination.limit, 20);
      assert.deepEqual(result.json.data.items.map((row) => row.productVariantId),
        [fixture.noneVariantId, fixture.requiredVariantId, fixture.optionalVariantId]
          .sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1));
      const required = result.json.data.items.find((row) => row.productVariantId === fixture.requiredVariantId);
      assert.equal(required.quantityOnHand, '5.000');
      assert.equal(required.trackedLotQuantity, '5.000');
      assert.equal(required.untrackedQuantity, '0.000');
      assert.equal(required.consistency.status, 'OK');
      assert.equal(required.stockStatus, 'IN_STOCK');
      const optional = result.json.data.items.find((row) => row.productVariantId === fixture.optionalVariantId);
      assert.equal(optional.quantityOnHand, '7.000');
      assert.equal(optional.trackedLotQuantity, '4.000');
      assert.equal(optional.untrackedQuantity, '3.000');
      assert.equal(optional.consistency.status, 'OK');
      for (const query of [
        `search=${fixture.token}`, `productVariantId=${fixture.requiredVariantId}`,
        `categoryId=${fixture.categoryId}`, `brandId=${fixture.brandId}`,
        'lotTrackingMode=REQUIRED', 'stockStatus=LOW_STOCK', 'stockStatus=IN_STOCK',
        'stockStatus=OUT_OF_STOCK', 'page=1&limit=1',
      ]) status(await send(fixture, baseUrl, `${root}?${query}`), 200);
      const inStock = await send(fixture, baseUrl, `${root}?stockStatus=IN_STOCK`);
      status(inStock, 200);
      assert.equal(inStock.json.data.pagination.totalItems, 3);
      const absent = await send(fixture, baseUrl, `${root}?stockStatus=OUT_OF_STOCK`);
      status(absent, 200);
      assert.equal(absent.json.data.pagination.totalItems, 0);
      const requiredOnly = await send(fixture, baseUrl,
        `${root}?lotTrackingMode=REQUIRED&productVariantId=${fixture.requiredVariantId}`);
      status(requiredOnly, 200);
      assert.deepEqual(requiredOnly.json.data.items.map((row) => row.productVariantId),
        [fixture.requiredVariantId]);
      status(await send(fixture, baseUrl, `${root}?limit=101`), 400);
      const detail = await send(fixture, baseUrl, `${root}/variants/${fixture.requiredVariantId}`);
      status(detail, 200);
      assert.equal(detail.json.data.branchInventory.productVariantId, fixture.requiredVariantId);
      assert.equal(detail.json.data.lots[0].inventoryLotId, fixture.requiredLotId);
      status(await send(fixture, baseUrl, `${root}/variants/${fixture.newVariantId}`), 404);
      status(await send(fixture, baseUrl, `${root}/variants/18446744073709551615`), 404);
      status(await send(fixture, baseUrl, `${root}/variants/nope`), 400);
      status(await send(fixture, baseUrl,
        `/api/admin/branches/${fixture.otherBranchId}/inventory/variants/${fixture.requiredVariantId}`,
        { token: fixture.tokens.system }), 404);
    });

    await t.test('inconsistent projections are reported, not silently repaired', async () => {
      try {
        await pool.execute(
          `UPDATE branch_inventory SET quantity_on_hand = '2.000'
           WHERE branch_id = ? AND product_variant_id = ?`,
          [fixture.branchId, fixture.optionalVariantId],
        );
        const detail = await send(fixture, baseUrl,
          `${root}/variants/${fixture.optionalVariantId}`);
        status(detail, 200);
        assert.equal(detail.json.data.branchInventory.untrackedQuantity, '-2.000');
        assert.equal(detail.json.data.branchInventory.consistency.status, 'WARNING');
        assert.equal(detail.json.data.branchInventory.consistency.issues.includes(
          'LOT_QUANTITY_EXCEEDS_ON_HAND'), true);
        const [afterRead] = await pool.execute(
          `SELECT quantity_on_hand AS quantity FROM branch_inventory
           WHERE branch_id = ? AND product_variant_id = ?`,
          [fixture.branchId, fixture.optionalVariantId],
        );
        assert.equal(afterRead[0].quantity, '2.000');
      } finally {
        await pool.execute(
          `UPDATE branch_inventory SET quantity_on_hand = '7.000'
           WHERE branch_id = ? AND product_variant_id = ?`,
          [fixture.branchId, fixture.optionalVariantId],
        );
      }
    });

    await t.test('settings validation, no-op, version, audit, and stock immutability', async () => {
      const path = `${root}/variants/${fixture.newVariantId}/settings`;
      const body = { reorderLevel: '12.000', reorderQuantity: '24.000' };
      for (const invalid of [
        { ...body, quantityOnHand: '20.000' }, { reorderLevel: 12, reorderQuantity: '24.000' },
        { ...body, versionNumber: 7 }, { reorderLevel: '12.000' },
        { reorderLevel: '-1.000', reorderQuantity: '24.000' },
        { reorderLevel: '1e3', reorderQuantity: '24.000' },
        { reorderLevel: '1.0001', reorderQuantity: '24.000' },
        { reorderLevel: '1000000000000.000', reorderQuantity: '24.000' },
        { reorderLevel: '1.500', reorderQuantity: '24.000' },
      ]) status(await send(fixture, baseUrl, path, { method: 'PUT', body: invalid }), 400);
      const before = await pool.execute(
        `SELECT COUNT(*) AS count FROM inventory_transactions WHERE branch_id = ?`,
        [fixture.branchId],
      );
      const created = await send(fixture, baseUrl, path, { method: 'PUT', body });
      status(created, 200);
      assert.equal(created.json.data.branchInventory.quantityOnHand, '0.000');
      assert.equal(created.json.data.branchInventory.versionNumber, 0);
      const same = await send(fixture, baseUrl, path, { method: 'PUT', body });
      status(same, 200);
      assert.equal(same.json.data.branchInventory.versionNumber, 0);
      const changed = await send(fixture, baseUrl, path, {
        method: 'PUT', body: { reorderLevel: '15.000', reorderQuantity: '30.000' },
      });
      status(changed, 200);
      assert.equal(changed.json.data.branchInventory.versionNumber, 1);
      const [audit] = await pool.execute(
        `SELECT action_type AS actionType FROM audit_logs
         WHERE entity_type = 'branch_inventory' AND entity_record_id = ?
         ORDER BY audit_log_id`, [`${fixture.branchId}:${fixture.newVariantId}`],
      );
      assert.deepEqual(audit.map((row) => row.actionType), [
        'BRANCH_INVENTORY_SETTINGS_CREATED', 'BRANCH_INVENTORY_SETTINGS_UPDATED',
      ]);
      const after = await pool.execute(
        `SELECT COUNT(*) AS count FROM inventory_transactions WHERE branch_id = ?`,
        [fixture.branchId],
      );
      assert.equal(after[0][0].count, before[0][0].count);
      assert.equal((await send(fixture, baseUrl, `${root}/variants/${fixture.newVariantId}`))
        .json.data.branchInventory.stockStatus, 'OUT_OF_STOCK');
    });

    await t.test('branch lot scope, filters, transitions, and audit suppression', async () => {
      const lots = await send(fixture, baseUrl, `${root}/lots`);
      status(lots, 200);
      assert.equal(lots.json.data.items.some((row) => row.inventoryLotId === fixture.otherLotId), false);
      for (const query of [
        `search=${fixture.prefix}`, `productVariantId=${fixture.requiredVariantId}`,
        'branchLotStatus=BLOCKED', 'lotStatus=ACTIVE',
        'expiresBefore=2031-01-01', 'expiresAfter=2029-01-01', 'page=1&limit=1',
      ]) status(await send(fixture, baseUrl, `${root}/lots?${query}`), 200);
      const detail = await send(fixture, baseUrl, `${root}/lots/${fixture.requiredLotId}`);
      status(detail, 200);
      assert.equal(detail.json.data.branchLot.lotNumber, `${fixture.prefix}-Required`);
      assert.equal(detail.json.data.branchLot.quantityOnHand, '5.000');
      assert.equal(detail.json.data.recentTransactions[0].quantityChange, '5.000');
      const requiredOnly = await send(fixture, baseUrl,
        `${root}/lots?productVariantId=${fixture.requiredVariantId}`);
      status(requiredOnly, 200);
      assert.deepEqual(requiredOnly.json.data.items.map((row) => row.inventoryLotId),
        [fixture.requiredLotId]);
      status(await send(fixture, baseUrl, `${root}/lots/${fixture.otherLotId}`), 404);
      status(await send(fixture, baseUrl, `${root}/lots/nope`), 400);
      status(await send(fixture, baseUrl, `${root}/lots/18446744073709551615`), 404);
      const path = `${root}/lots/${fixture.requiredLotId}/status`;
      for (const invalid of ['DEPLETED', 'BOGUS']) {
        status(await send(fixture, baseUrl, path, {
          method: 'PATCH', body: { status: invalid },
        }), invalid === 'DEPLETED' ? 409 : 400);
      }
      const blocked = await send(fixture, baseUrl, path, {
        method: 'PATCH', body: { status: 'BLOCKED' },
      });
      status(blocked, 200);
      assert.equal(blocked.json.data.branchLot.quantityOnHand, '5.000');
      const version = blocked.json.data.branchLot.versionNumber;
      const same = await send(fixture, baseUrl, path, {
        method: 'PATCH', body: { status: 'BLOCKED' },
      });
      status(same, 200);
      assert.equal(same.json.data.branchLot.versionNumber, version);
      for (const lotId of [fixture.recalledLotId, fixture.zeroLotId]) {
        status(await send(fixture, baseUrl, `${root}/lots/${lotId}/status`, {
          method: 'PATCH', body: { status: 'AVAILABLE' },
        }), 409);
      }
      const connection = await pool.getConnection();
      try {
        await connection.execute(
          `INSERT INTO inventory_lots (
             product_variant_id, lot_number, expires_on, status,
             created_by_employee_id
           ) VALUES (?, ?, '2020-01-01', 'ACTIVE', ?)`,
          [fixture.optionalVariantId, `${fixture.prefix}-expired`, fixture.adminEmployeeId],
        );
        fixture.expiredLotId = await lastId(connection);
        await connection.execute(
          `INSERT INTO branch_lot_inventory (
             branch_id, inventory_lot_id, quantity_on_hand, status
           ) VALUES (?, ?, '1.000', 'BLOCKED')`,
          [fixture.branchId, fixture.expiredLotId],
        );
      } finally {
        connection.release();
      }
      const expired = await send(fixture, baseUrl,
        `${root}/lots/${fixture.expiredLotId}`);
      status(expired, 200);
      assert.equal(expired.json.data.branchLot.expiryState, 'EXPIRED');
      status(await send(fixture, baseUrl,
        `${root}/lots/${fixture.expiredLotId}/status`, {
          method: 'PATCH', body: { status: 'AVAILABLE' },
        }), 409);
      const available = await send(fixture, baseUrl, path, {
        method: 'PATCH', body: { status: 'AVAILABLE' },
      });
      status(available, 200);
      assert.equal(available.json.data.branchLot.branchLotStatus, 'AVAILABLE');
      const [audit] = await pool.execute(
        `SELECT action_type AS actionType FROM audit_logs
         WHERE entity_type = 'branch_lot_inventory' AND entity_record_id = ?`,
        [`${fixture.branchId}:${fixture.requiredLotId}`],
      );
      assert.deepEqual(audit.map((row) => row.actionType), [
        'BRANCH_LOT_STATUS_UPDATED', 'BRANCH_LOT_STATUS_UPDATED',
      ]);
    });

    await t.test('ledger filters and historical detail remain read-only', async () => {
      const list = await send(fixture, baseUrl, `${root}/transactions`);
      status(list, 200);
      assert.equal(list.json.data.items.length, 1);
      const tx = list.json.data.items[0];
      assert.equal(tx.inventoryTransactionId, fixture.transactionId);
      for (const query of [
        `search=${tx.transactionNumber}`, 'transactionType=PURCHASE_RECEIPT',
        `productVariantId=${fixture.requiredVariantId}`,
        `inventoryLotId=${fixture.requiredLotId}`,
        `createdByEmployeeId=${fixture.adminEmployeeId}`,
        'from=2020-01-01&to=2030-12-31', 'to=9999-12-31',
        'page=1&limit=1',
      ]) {
        const result = await send(fixture, baseUrl, `${root}/transactions?${query}`);
        status(result, 200);
        assert.equal(result.json.data.items.length, 1);
      }
      status(await send(fixture, baseUrl, `${root}/transactions?transactionType=BAD`), 400);
      const detail = await send(fixture, baseUrl, `${root}/transactions/${fixture.transactionId}`);
      status(detail, 200);
      assert.equal(detail.json.data.items[0].quantityChange, '5.000');
      assert.equal(detail.json.data.items[0].unitCost, '2.0000');
      assert.equal(detail.json.data.items[0].lotAllocations[0].inventoryLotId, fixture.requiredLotId);
      assert.equal(detail.json.data.items[0].consistency.status, 'OK');
      status(await send(fixture, baseUrl, `${root}/transactions/nope`), 400);
      status(await send(fixture, baseUrl, `${root}/transactions/18446744073709551615`), 404);
      status(await send(fixture, baseUrl,
        `/api/admin/branches/${fixture.otherBranchId}/inventory/transactions/${fixture.transactionId}`,
        { token: fixture.tokens.system }), 404);
    });

    await t.test('signed and nullable historical ledger values are never invented', async () => {
      // This direct SQL row is an isolated read-model fixture, not a Phase 8 stock operation.
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        await connection.execute(
          `INSERT INTO inventory_transactions (
             branch_id, transaction_number, transaction_type, occurred_at,
             created_by_employee_id, notes
           ) VALUES (?, ?, 'SALE', UTC_TIMESTAMP(6), ?, ?)`,
          [fixture.branchId, `P8LEDGER-${fixture.token}`, fixture.adminEmployeeId,
            `${fixture.prefix} signed read fixture`],
        );
        fixture.syntheticTransactionId = await lastId(connection);
        await connection.execute(
          `INSERT INTO inventory_transaction_items (
             inventory_transaction_id, line_number, product_variant_id,
             quantity_change, unit_cost
           ) VALUES (?, 1, ?, '-1.000', NULL)`,
          [fixture.syntheticTransactionId, fixture.noneVariantId],
        );
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
      const detail = await send(fixture, baseUrl,
        `${root}/transactions/${fixture.syntheticTransactionId}`);
      status(detail, 200);
      assert.equal(detail.json.data.inventoryTransaction.transactionType, 'SALE');
      assert.equal(detail.json.data.items[0].quantityChange, '-1.000');
      assert.equal(detail.json.data.items[0].unitCost, null);
      assert.deepEqual(detail.json.data.items[0].lotAllocations, []);
      assert.equal(detail.json.data.items[0].consistency.status, 'OK');
      const filtered = await send(fixture, baseUrl,
        `${root}/transactions?transactionType=SALE&productVariantId=${fixture.noneVariantId}`);
      status(filtered, 200);
      assert.deepEqual(filtered.json.data.items.map((row) => row.inventoryTransactionId),
        [fixture.syntheticTransactionId]);
    });

    await t.test('settings writes serialize and preserve complete request pairs', async () => {
      const path = `${root}/variants/${fixture.newVariantId}/settings`;
      const [beforeRows] = await pool.execute(
        `SELECT version_number AS version, quantity_on_hand AS quantity
         FROM branch_inventory WHERE branch_id = ? AND product_variant_id = ?`,
        [fixture.branchId, fixture.newVariantId],
      );
      const pairA = { reorderLevel: '11.000', reorderQuantity: '22.000' };
      const pairB = { reorderLevel: '33.000', reorderQuantity: '44.000' };
      const results = await holdBranchLockAndRace(fixture, [
        () => send(fixture, baseUrl, path, { method: 'PUT', body: pairA }),
        () => send(fixture, baseUrl, path, { method: 'PUT', body: pairB }),
      ]);
      results.forEach((result) => status(result, 200));
      const [afterRows] = await pool.execute(
        `SELECT reorder_level AS level, reorder_quantity AS quantity,
           quantity_on_hand AS stock, version_number AS version
         FROM branch_inventory WHERE branch_id = ? AND product_variant_id = ?`,
        [fixture.branchId, fixture.newVariantId],
      );
      assert.equal([
        `${pairA.reorderLevel}:${pairA.reorderQuantity}`,
        `${pairB.reorderLevel}:${pairB.reorderQuantity}`,
      ].includes(`${afterRows[0].level}:${afterRows[0].quantity}`), true);
      assert.equal(afterRows[0].stock, beforeRows[0].quantity);
      assert.equal(afterRows[0].version, beforeRows[0].version + 2);
    });

    await t.test('Phase 7 receipt racing first-time settings preserves stock and reorder values', async () => {
      const prerequisite = await createReceiptPrerequisite(
        fixture, fixture.raceVariantId, fixture.packageIds[4], 'CREATE_RACE',
      );
      const settings = { reorderLevel: '6.000', reorderQuantity: '12.000' };
      const [posted, configured] = await holdBranchLockAndRace(fixture, [
        () => send(fixture, baseUrl,
          `/api/admin/branches/${fixture.branchId}/goods-receipts/${prerequisite.receiptId}/post`,
          { method: 'POST', body: {} }),
        () => send(fixture, baseUrl, `${root}/variants/${fixture.raceVariantId}/settings`,
          { method: 'PUT', body: settings }),
      ]);
      status(posted, 200);
      status(configured, 200);
      const [rows] = await pool.execute(
        `SELECT quantity_on_hand AS quantity, reorder_level AS level,
           reorder_quantity AS reorderQuantity, version_number AS version
         FROM branch_inventory WHERE branch_id = ? AND product_variant_id = ?`,
        [fixture.branchId, fixture.raceVariantId],
      );
      assert.deepEqual(rows[0], {
        quantity: '2.000', level: '6.000', reorderQuantity: '12.000', version: 1,
      });
      const [ledger] = await pool.execute(
        `SELECT COUNT(*) AS count FROM inventory_transactions
         WHERE inventory_transaction_id = ?`, [posted.json.data.inventoryTransactionId],
      );
      assert.equal(Number(ledger[0].count), 1);
      const low = await send(fixture, baseUrl, `${root}?stockStatus=LOW_STOCK`);
      status(low, 200);
      assert.equal(low.json.data.items.some((row) =>
        row.productVariantId === fixture.raceVariantId), true);
    });

    await t.test('lot status writes and Phase 7 receipts preserve quantity, state, and versions', async () => {
      const path = `${root}/lots/${fixture.requiredLotId}/status`;
      const [beforeRows] = await pool.execute(
        `SELECT quantity_on_hand AS quantity, version_number AS version
         FROM branch_lot_inventory WHERE branch_id = ? AND inventory_lot_id = ?`,
        [fixture.branchId, fixture.requiredLotId],
      );
      const [first, second] = await holdBranchLockAndRace(fixture, [
        () => send(fixture, baseUrl, path, { method: 'PATCH', body: { status: 'QUARANTINED' } }),
        () => send(fixture, baseUrl, path, { method: 'PATCH', body: { status: 'BLOCKED' } }),
      ]);
      status(first, 200);
      status(second, 200);
      const [afterStatus] = await pool.execute(
        `SELECT quantity_on_hand AS quantity, status, version_number AS version
         FROM branch_lot_inventory WHERE branch_id = ? AND inventory_lot_id = ?`,
        [fixture.branchId, fixture.requiredLotId],
      );
      assert.equal(['QUARANTINED', 'BLOCKED'].includes(afterStatus[0].status), true);
      assert.equal(afterStatus[0].quantity, beforeRows[0].quantity);
      assert.equal(afterStatus[0].version, beforeRows[0].version + 2);

      const prerequisite = await createReceiptPrerequisite(
        fixture, fixture.requiredVariantId, fixture.packageIds[1], 'LOT_RACE',
      );
      const [posted, blocked] = await holdBranchLockAndRace(fixture, [
        () => send(fixture, baseUrl,
          `/api/admin/branches/${fixture.branchId}/goods-receipts/${prerequisite.receiptId}/post`, {
            method: 'POST', body: { lotAllocations: [{
              goodsReceiptItemId: prerequisite.receiptItemId,
              lots: [{ inventoryLotId: fixture.requiredLotId, quantityReceived: '2.000' }],
            }] },
          }),
        () => send(fixture, baseUrl, path, { method: 'PATCH', body: { status: 'BLOCKED' } }),
      ]);
      status(posted, 200);
      status(blocked, 200);
      const [finalRows] = await pool.execute(
        `SELECT quantity_on_hand AS quantity, status, version_number AS version
         FROM branch_lot_inventory WHERE branch_id = ? AND inventory_lot_id = ?`,
        [fixture.branchId, fixture.requiredLotId],
      );
      assert.equal(finalRows[0].quantity, '7.000');
      assert.equal(finalRows[0].status, 'BLOCKED');
      assert.equal(finalRows[0].version, afterStatus[0].version +
        (afterStatus[0].status === 'BLOCKED' ? 1 : 2));
      const [stockRows] = await pool.execute(
        `SELECT quantity_on_hand AS quantity FROM branch_inventory
         WHERE branch_id = ? AND product_variant_id = ?`,
        [fixture.branchId, fixture.requiredVariantId],
      );
      assert.equal(stockRows[0].quantity, '7.000');
      const [ledger] = await pool.execute(
        `SELECT COUNT(*) AS count FROM inventory_transactions
         WHERE inventory_transaction_id = ?`, [posted.json.data.inventoryTransactionId],
      );
      assert.equal(Number(ledger[0].count), 1);
    });

    await t.test('no direct stock or generic ledger mutation route is mounted', async () => {
      for (const [method, path] of [
        ['POST', root], ['PATCH', `${root}/variants/${fixture.requiredVariantId}`],
        ['DELETE', `${root}/variants/${fixture.requiredVariantId}`],
        ['POST', `${root}/transactions`],
        ['PATCH', `${root}/transactions/${fixture.transactionId}`],
        ['DELETE', `${root}/transactions/${fixture.transactionId}`],
        ['POST', `${root}/lots`], ['DELETE', `${root}/lots/${fixture.requiredLotId}`],
      ]) status(await send(fixture, baseUrl, path, { method }), 404);
    });

    await t.test('Phase 8 did not mutate catalog, pricing, supplier, or original documents', async () => {
      assert.deepEqual(await nonInventoryBoundarySnapshot(fixture), fixture.nonInventoryBefore);
      const [phase9] = await pool.execute(
        `SELECT
           (SELECT COUNT(*) FROM inventory_adjustments WHERE branch_id = ?) AS adjustments,
           (SELECT COUNT(*) FROM stock_counts WHERE branch_id = ?) AS counts,
           (SELECT COUNT(*) FROM stock_transfers WHERE source_branch_id = ? OR destination_branch_id = ?) AS transfers`,
        [fixture.branchId, fixture.branchId, fixture.branchId, fixture.branchId],
      );
      assert.deepEqual(phase9[0], { adjustments: '0', counts: '0', transfers: '0' });
      const [auditBefore] = await pool.execute(
        'SELECT COUNT(*) AS count FROM audit_logs WHERE request_id LIKE ?', [`${fixture.prefix}%`],
      );
      status(await send(fixture, baseUrl, root), 200);
      status(await send(fixture, baseUrl, `${root}/lots`), 200);
      status(await send(fixture, baseUrl, `${root}/transactions`), 200);
      const [auditAfter] = await pool.execute(
        'SELECT COUNT(*) AS count FROM audit_logs WHERE request_id LIKE ?', [`${fixture.prefix}%`],
      );
      assert.equal(auditAfter[0].count, auditBefore[0].count);
    });
  } finally {
    await stopServer(server);
    await cleanupFixture(fixture);
    const [left] = await pool.execute(
      `SELECT COUNT(*) AS count FROM branches WHERE branch_name LIKE ?`,
      [`${fixture.prefix}%`],
    );
    assert.equal(Number(left[0].count), 0);
    await pool.end();
  }
});
