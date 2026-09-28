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

function fixtureDefinition() {
  const token = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
  return {
    token,
    prefix: `TEST_P7_${token}`,
    requestCounter: 0,
    requestIds: [],
    setupComplete: false,
    cleaned: false,
  };
}

function placeholders(values) {
  return values.map(() => '?').join(', ');
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

async function send(baseUrl, path, options = {}) {
  const headers = new Headers(options.headers);
  if (options.token) headers.set('authorization', `Bearer ${options.token}`);
  headers.set('user-agent', 'TEST_PHASE7_PURCHASING/1.0');
  let body;
  if (options.body !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(options.body);
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET', headers, body,
  });
  const text = await response.text();
  return { response, text, json: text ? JSON.parse(text) : null };
}

async function tracked(fixture, baseUrl, label, path, options = {}) {
  fixture.requestCounter += 1;
  const requestId = `${fixture.prefix}_${fixture.requestCounter}_${label}`.slice(0, 100);
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

function assertStatus(result, status) {
  assert.equal(result.response.status, status, result.text);
}

function assertSafeError(result, status) {
  assertStatus(result, status);
  assert.equal(result.json?.success, false);
  const serialized = JSON.stringify(result.json);
  for (const forbidden of ['ER_', 'sqlMessage', 'constraint', 'stack', 'DB_PASSWORD']) {
    assert.equal(serialized.includes(forbidden), false);
  }
}

function quantityScaled(value) {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(`${whole}${fraction.padEnd(3, '0')}`);
}

function futureUtcTimestamp(hours = 24) {
  const date = new Date(Date.now() + hours * 60 * 60 * 1000);
  return date.toISOString().replace('Z', '000Z');
}

async function branchQuantity(branchId, productVariantId) {
  const [rows] = await pool.execute(
    `SELECT quantity_on_hand AS quantity FROM branch_inventory
     WHERE branch_id = ? AND product_variant_id = ?`,
    [branchId, productVariantId],
  );
  return rows[0]?.quantity ?? '0.000';
}

async function createFixture(fixture) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const seed = await ensureAccessControl(connection);
    assert.equal(seed.permissionCount, 45);
    assert.equal(seed.assignedPermissionCount, 45);
    assert.equal(ACCESS_CONTROL_PERMISSIONS.length, 45);
    const [permissionRows] = await connection.execute(
      `SELECT CAST(permission_id AS CHAR) AS id, permission_code AS code
       FROM permissions WHERE permission_code IN (${placeholders(
         ACCESS_CONTROL_PERMISSIONS.map(({ code }) => code),
       )})`,
      ACCESS_CONTROL_PERMISSIONS.map(({ code }) => code),
    );
    const permissionIds = Object.fromEntries(
      permissionRows.map((row) => [row.code, row.id]),
    );
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
        [`P7${suffix}_${fixture.token}`, `${fixture.prefix} Branch ${suffix}`],
      );
      fixture.branchIds.push(await lastId(connection));
    }
    [fixture.branchId, fixture.otherBranchId] = fixture.branchIds;

    await connection.execute(
      `INSERT INTO employees (
         employee_number, first_name, last_name, hire_date, employment_status
       ) VALUES (?, 'Phase', 'Seven', CURRENT_DATE(), 'ACTIVE')`,
      [`P7EMP_${fixture.token}`],
    );
    fixture.employeeId = await lastId(connection);
    await connection.execute(
      `INSERT INTO employee_branch_assignments (
         employee_id, branch_id, job_title, started_on, is_primary
       ) VALUES (?, ?, 'Purchasing Test', CURRENT_DATE(), 1)`,
      [fixture.employeeId, fixture.branchId],
    );
    await connection.execute(
      `INSERT INTO employees (
         employee_number, first_name, last_name, hire_date, employment_status
       ) VALUES (?, 'Wrong', 'Branch', CURRENT_DATE(), 'ACTIVE')`,
      [`P7WRONG_${fixture.token}`],
    );
    fixture.wrongEmployeeId = await lastId(connection);
    await connection.execute(
      `INSERT INTO employee_branch_assignments (
         employee_id, branch_id, job_title, started_on, is_primary
       ) VALUES (?, ?, 'Wrong Branch Test', CURRENT_DATE(), 1)`,
      [fixture.wrongEmployeeId, fixture.branchId],
    );
    await connection.execute(
      `INSERT INTO employees (
         employee_number, first_name, last_name, hire_date, employment_status
       ) VALUES (?, 'Manage', 'Writer', CURRENT_DATE(), 'ACTIVE')`,
      [`P7WRITE_${fixture.token}`],
    );
    fixture.writerEmployeeId = await lastId(connection);
    await connection.execute(
      `INSERT INTO employee_branch_assignments (
         employee_id, branch_id, job_title, started_on, is_primary
       ) VALUES (?, ?, 'Phase 7 Writer', CURRENT_DATE(), 1)`,
      [fixture.writerEmployeeId, fixture.branchId],
    );
    fixture.employeeIds = [
      fixture.employeeId,
      fixture.wrongEmployeeId,
      fixture.writerEmployeeId,
    ];

    fixture.roleIds = [];
    const roleDefinitions = {
      none: [],
      catalogOnly: ['catalog.read', 'catalog.manage'],
      productsOnly: ['products.read', 'products.manage'],
      suppliersOnly: ['suppliers.read', 'suppliers.manage'],
      pricingOnly: ['pricing.read', 'pricing.manage'],
      read: ['purchasing.read', 'receiving.read'],
      manage: ['purchasing.manage', 'receiving.manage'],
      wrongBranch: ['purchasing.read', 'purchasing.manage', 'receiving.read', 'receiving.manage'],
      globalPhase7: ['purchasing.read', 'purchasing.manage', 'receiving.read', 'receiving.manage'],
    };
    const namedRoleIds = {};
    for (const [name, codes] of Object.entries(roleDefinitions)) {
      await connection.execute(
        `INSERT INTO roles (role_code, role_name, is_active)
         VALUES (?, ?, 1)`,
        [`P7_${name.toUpperCase()}_${fixture.token}`, `${fixture.prefix} ${name}`],
      );
      const roleId = await lastId(connection);
      fixture.roleIds.push(roleId);
      namedRoleIds[name] = roleId;
      for (const code of codes) {
        await connection.execute(
          'INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
          [roleId, permissionIds[code]],
        );
      }
    }

    const hash = await bcrypt.hash(
      `Phase7-${fixture.token}-Password!`,
      Number(process.env.BCRYPT_ROUNDS),
    );
    fixture.userIds = [];
    fixture.tokens = {};
    const users = [
      ['admin', fixture.employeeId, fixture.systemRoleId, null, 0],
      ['system', null, fixture.systemRoleId, null, 0],
      ['must', null, fixture.systemRoleId, null, 1],
      ['none', null, namedRoleIds.none, null, 0],
      ['catalogOnly', null, namedRoleIds.catalogOnly, null, 0],
      ['productsOnly', null, namedRoleIds.productsOnly, null, 0],
      ['suppliersOnly', null, namedRoleIds.suppliersOnly, null, 0],
      ['pricingOnly', null, namedRoleIds.pricingOnly, fixture.branchId, 0],
      ['read', null, namedRoleIds.read, fixture.branchId, 0],
      ['manage', fixture.writerEmployeeId, namedRoleIds.manage, fixture.branchId, 0],
      ['wrongBranch', fixture.wrongEmployeeId, namedRoleIds.wrongBranch, fixture.otherBranchId, 0],
      ['globalPhase7', null, namedRoleIds.globalPhase7, null, 0],
    ];
    for (const [name, employeeId, roleId, branchId, mustChange] of users) {
      await connection.execute(
        `INSERT INTO users (
           employee_id, username, email, password_hash,
           is_active, must_change_password
         ) VALUES (?, ?, ?, ?, 1, ?)`,
        [
          employeeId,
          `p7.${name}.${fixture.token.toLowerCase()}`,
          `p7.${name}.${fixture.token.toLowerCase()}@example.invalid`,
          hash,
          mustChange,
        ],
      );
      const userId = await lastId(connection);
      fixture.userIds.push(userId);
      await connection.execute(
        `INSERT INTO user_roles (user_id, role_id, branch_id)
         VALUES (?, ?, ?)`,
        [userId, roleId, branchId],
      );
      fixture.tokens[name] = signAccessToken(userId).accessToken;
    }

    await connection.execute(
      `INSERT INTO units_of_measure (
         unit_code, unit_name, symbol, allows_fraction
       ) VALUES (?, ?, ?, 0)`,
      [`P7U_${fixture.token}`, `${fixture.prefix} bottle`, `p7${fixture.token}`],
    );
    fixture.unitId = await lastId(connection);
    await connection.execute(
      `INSERT INTO categories (category_code, category_name, is_active)
       VALUES (?, ?, 1)`,
      [`P7C_${fixture.token}`, `${fixture.prefix} Category`],
    );
    fixture.categoryId = await lastId(connection);
    await connection.execute(
      `INSERT INTO products (category_id, product_code, product_name, status)
       VALUES (?, ?, ?, 'ACTIVE')`,
      [fixture.categoryId, `P7P_${fixture.token}`, `${fixture.prefix} Product`],
    );
    fixture.productId = await lastId(connection);

    fixture.variantIds = [];
    fixture.packageIds = [];
    for (const [suffix, lotMode, expiry] of [
      ['NONE', 'NONE', 0],
      ['REQ', 'REQUIRED', 1],
      ['RACE', 'NONE', 0],
      ['OPT', 'OPTIONAL', 0],
      ['CROSS', 'NONE', 0],
    ]) {
      await connection.execute(
        `INSERT INTO product_variants (
           product_id, unit_of_measure_id, sku, variant_name,
           lot_tracking_mode, requires_expiry_date,
           default_selling_price, status
         ) VALUES (?, ?, ?, ?, ?, ?, '10.0000', 'ACTIVE')`,
        [
          fixture.productId, fixture.unitId, `P7V_${suffix}_${fixture.token}`,
          `${fixture.prefix} ${suffix}`, lotMode, expiry,
        ],
      );
      const variantId = await lastId(connection);
      fixture.variantIds.push(variantId);
      await connection.execute(
        `INSERT INTO product_packages (
           product_variant_id, package_unit_of_measure_id, package_code,
           package_name, conversion_to_base_quantity, is_base_unit,
           is_purchasable, is_sellable, status
         ) VALUES (?, ?, ?, ?, '1.000000', 1, 1, 1, 'ACTIVE')`,
        [variantId, fixture.unitId, `BASE_${suffix}`, `${suffix} bottle`],
      );
      fixture.packageIds.push(await lastId(connection));
    }
    fixture.noneVariantId = fixture.variantIds[0];
    fixture.requiredVariantId = fixture.variantIds[1];
    fixture.raceVariantId = fixture.variantIds[2];
    fixture.optionalVariantId = fixture.variantIds[3];
    fixture.crossVariantId = fixture.variantIds[4];
    await connection.execute(
      `INSERT INTO product_packages (
         product_variant_id, package_unit_of_measure_id, package_code,
         package_name, conversion_to_base_quantity, is_base_unit,
         is_purchasable, is_sellable, status
       ) VALUES (?, ?, 'CARTON', 'Carton of 24', '24.000000', 0, 1, 1, 'ACTIVE')`,
      [fixture.noneVariantId, fixture.unitId],
    );
    fixture.cartonId = await lastId(connection);
    fixture.packageIds.push(fixture.cartonId);
    await connection.execute(
      `INSERT INTO product_packages (
         product_variant_id, package_unit_of_measure_id, package_code,
         package_name, conversion_to_base_quantity, is_base_unit,
         is_purchasable, is_sellable, status
       ) VALUES (?, ?, 'CROSS_PACK', 'Cross-phase pack', '6.000000', 0, 1, 1, 'ACTIVE')`,
      [fixture.crossVariantId, fixture.unitId],
    );
    fixture.crossPackageId = await lastId(connection);
    fixture.packageIds.push(fixture.crossPackageId);

    await connection.execute(
      `INSERT INTO suppliers (supplier_code, supplier_name, status)
       VALUES (?, ?, 'ACTIVE')`,
      [`P7S_${fixture.token}`, `${fixture.prefix} Supplier`],
    );
    fixture.supplierId = await lastId(connection);
    await connection.execute(
      `INSERT INTO suppliers (supplier_code, supplier_name, status)
       VALUES (?, ?, 'INACTIVE')`,
      [`P7SI_${fixture.token}`, `${fixture.prefix} Inactive Supplier`],
    );
    fixture.inactiveSupplierId = await lastId(connection);
    fixture.supplierIds = [fixture.supplierId, fixture.inactiveSupplierId];
    for (const variantId of fixture.variantIds) {
      await connection.execute(
        `INSERT INTO supplier_products (
           supplier_id, product_variant_id, minimum_order_quantity
         ) VALUES (?, ?, '1.000')`,
        [fixture.supplierId, variantId],
      );
    }
    for (let index = 0; index < fixture.variantIds.length; index += 1) {
      await connection.execute(
        `INSERT INTO supplier_product_packages (
           supplier_id, product_variant_id, product_package_id,
           minimum_package_quantity, is_active
         ) VALUES (?, ?, ?, '1.000', 1)`,
        [fixture.supplierId, fixture.variantIds[index], fixture.packageIds[index]],
      );
    }
    await connection.execute(
      `INSERT INTO supplier_product_packages (
         supplier_id, product_variant_id, product_package_id,
         minimum_package_quantity, is_active
       ) VALUES (?, ?, ?, '1.000', 1)`,
      [fixture.supplierId, fixture.noneVariantId, fixture.cartonId],
    );
    await connection.execute(
      `INSERT INTO supplier_product_packages (
         supplier_id, product_variant_id, product_package_id,
         minimum_package_quantity, is_active
       ) VALUES (?, ?, ?, '1.000', 1)`,
      [fixture.supplierId, fixture.crossVariantId, fixture.crossPackageId],
    );

    await connection.execute(
      `INSERT INTO purchase_orders (
         purchase_order_number, branch_id, supplier_id, status,
         created_by_employee_id, currency_code, subtotal_amount, total_amount, notes
       ) VALUES (?, ?, ?, 'DRAFT', ?, 'NGN', '2.00', '2.00', ?)`,
      [
        `P7AUTH-D-${fixture.token}`, fixture.branchId, fixture.supplierId,
        fixture.employeeId, `${fixture.prefix} authorization draft`,
      ],
    );
    fixture.authPurchaseOrderId = await lastId(connection);
    await connection.execute(
      `INSERT INTO purchase_order_items (
         purchase_order_id, line_number, product_variant_id, product_package_id,
         item_description, ordered_package_quantity, package_conversion_factor,
         ordered_quantity, unit_cost, discount_amount, tax_rate_percent,
         tax_amount, line_total
       ) VALUES (?, 1, ?, ?, ?, '1.000', '1.000000', '1.000',
         '2.0000', '0.00', '0.0000', '0.00', '2.00')`,
      [
        fixture.authPurchaseOrderId, fixture.noneVariantId, fixture.packageIds[0],
        `${fixture.prefix} authorization draft item`,
      ],
    );
    fixture.authPurchaseOrderItemId = await lastId(connection);

    await connection.execute(
      `INSERT INTO purchase_orders (
         purchase_order_number, branch_id, supplier_id, status, ordered_at,
         created_by_employee_id, approved_by_employee_id, approved_at,
         currency_code, subtotal_amount, total_amount, notes
       ) VALUES (?, ?, ?, 'APPROVED', UTC_TIMESTAMP(6), ?, ?, UTC_TIMESTAMP(6),
         'NGN', '2.00', '2.00', ?)`,
      [
        `P7AUTH-A-${fixture.token}`, fixture.branchId, fixture.supplierId,
        fixture.employeeId, fixture.employeeId,
        `${fixture.prefix} authorization approved`,
      ],
    );
    fixture.authApprovedPurchaseOrderId = await lastId(connection);
    await connection.execute(
      `INSERT INTO purchase_order_items (
         purchase_order_id, line_number, product_variant_id, product_package_id,
         item_description, ordered_package_quantity, package_conversion_factor,
         ordered_quantity, unit_cost, discount_amount, tax_rate_percent,
         tax_amount, line_total
       ) VALUES (?, 1, ?, ?, ?, '1.000', '1.000000', '1.000',
         '2.0000', '0.00', '0.0000', '0.00', '2.00')`,
      [
        fixture.authApprovedPurchaseOrderId, fixture.noneVariantId,
        fixture.packageIds[0], `${fixture.prefix} authorization approved item`,
      ],
    );
    fixture.authApprovedPurchaseOrderItemId = await lastId(connection);
    await connection.execute(
      `INSERT INTO goods_receipts (
         goods_receipt_number, purchase_order_id, branch_id, supplier_id,
         status, received_at, received_by_employee_id, notes
       ) VALUES (?, ?, ?, ?, 'DRAFT', UTC_TIMESTAMP(6), ?, ?)`,
      [
        `P7AUTH-G-${fixture.token}`, fixture.authApprovedPurchaseOrderId,
        fixture.branchId, fixture.supplierId, fixture.employeeId,
        `${fixture.prefix} authorization receipt`,
      ],
    );
    fixture.authGoodsReceiptId = await lastId(connection);
    await connection.execute(
      `INSERT INTO goods_receipt_items (
         goods_receipt_id, purchase_order_id, purchase_order_item_id,
         product_variant_id, line_number, package_quantity_accepted,
         package_quantity_rejected, package_conversion_factor,
         quantity_accepted, quantity_rejected, actual_unit_cost,
         discount_amount, tax_amount, line_total
       ) VALUES (?, ?, ?, ?, 1, '1.000', '0.000', '1.000000',
         '1.000', '0.000', '2.0000', '0.00', '0.00', '2.00')`,
      [
        fixture.authGoodsReceiptId, fixture.authApprovedPurchaseOrderId,
        fixture.authApprovedPurchaseOrderItemId, fixture.noneVariantId,
      ],
    );
    fixture.authGoodsReceiptItemId = await lastId(connection);

    for (const [key, variantId, lotNumber, status, expiresOn] of [
      ['wrongVariantLotId', fixture.optionalVariantId, `${fixture.prefix}-WRONG-VARIANT`, 'ACTIVE', null],
      ['recalledLotId', fixture.requiredVariantId, `${fixture.prefix}-RECALLED`, 'RECALLED', '2027-12-31'],
      ['closedLotId', fixture.requiredVariantId, `${fixture.prefix}-CLOSED`, 'CLOSED', '2027-12-31'],
    ]) {
      await connection.execute(
        `INSERT INTO inventory_lots (
           product_variant_id, lot_number, expires_on, status,
           created_by_employee_id
         ) VALUES (?, ?, ?, ?, ?)`,
        [variantId, lotNumber, expiresOn, status, fixture.employeeId],
      );
      fixture[key] = await lastId(connection);
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
    const [transactionRows] = await connection.execute(
      `SELECT CAST(gr.inventory_transaction_id AS CHAR) AS id
       FROM goods_receipts gr
       INNER JOIN purchase_orders po ON po.purchase_order_id = gr.purchase_order_id
       WHERE po.notes LIKE ? AND gr.inventory_transaction_id IS NOT NULL`,
      [`${fixture.prefix}%`],
    );
    const transactionIds = transactionRows.map((row) => row.id);
    await connection.execute('DELETE FROM audit_logs WHERE request_id LIKE ?', [`${fixture.prefix}%`]);
    await connection.execute(
      `DELETE FROM audit_logs WHERE user_id IN (${placeholders(fixture.userIds)})`,
      fixture.userIds,
    );
    await connection.execute(
      `DELETE itla FROM inventory_transaction_lot_allocations itla
       INNER JOIN inventory_transaction_items iti
         ON iti.inventory_transaction_item_id = itla.inventory_transaction_item_id
       INNER JOIN goods_receipts gr
         ON gr.inventory_transaction_id = iti.inventory_transaction_id
       INNER JOIN purchase_orders po ON po.purchase_order_id = gr.purchase_order_id
       WHERE po.notes LIKE ?`,
      [`${fixture.prefix}%`],
    );
    await connection.execute(
      `DELETE gril FROM goods_receipt_item_lots gril
       INNER JOIN goods_receipt_items gri ON gri.goods_receipt_item_id = gril.goods_receipt_item_id
       INNER JOIN goods_receipts gr ON gr.goods_receipt_id = gri.goods_receipt_id
       INNER JOIN purchase_orders po ON po.purchase_order_id = gr.purchase_order_id
       WHERE po.notes LIKE ?`,
      [`${fixture.prefix}%`],
    );
    if (fixture.variantIds) {
      await connection.execute(
        `DELETE FROM branch_lot_inventory WHERE branch_id IN (?, ?)
         AND inventory_lot_id IN (
           SELECT inventory_lot_id FROM inventory_lots
           WHERE product_variant_id IN (${placeholders(fixture.variantIds)})
         )`,
        [fixture.branchId, fixture.otherBranchId, ...fixture.variantIds],
      );
    }
    await connection.execute(
      `DELETE FROM goods_receipt_items WHERE purchase_order_id IN (
         SELECT purchase_order_id FROM purchase_orders WHERE notes LIKE ?
       )`,
      [`${fixture.prefix}%`],
    );
    await connection.execute(
      `DELETE FROM goods_receipts WHERE purchase_order_id IN (
         SELECT purchase_order_id FROM purchase_orders WHERE notes LIKE ?
       )`,
      [`${fixture.prefix}%`],
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
      `DELETE FROM purchase_order_items WHERE purchase_order_id IN (
         SELECT purchase_order_id FROM purchase_orders WHERE notes LIKE ?
       )`,
      [`${fixture.prefix}%`],
    );
    await connection.execute('DELETE FROM purchase_orders WHERE notes LIKE ?', [`${fixture.prefix}%`]);
    await connection.execute('DELETE FROM supplier_product_packages WHERE supplier_id = ?', [fixture.supplierId]);
    await connection.execute('DELETE FROM supplier_products WHERE supplier_id = ?', [fixture.supplierId]);
    await connection.execute(
      `DELETE FROM suppliers WHERE supplier_id IN (${placeholders(fixture.supplierIds)})`,
      fixture.supplierIds,
    );
    await connection.execute(
      `DELETE FROM product_packages WHERE product_package_id IN (${placeholders(fixture.packageIds)})`,
      fixture.packageIds,
    );
    await connection.execute('DELETE FROM product_variants WHERE product_id = ?', [fixture.productId]);
    await connection.execute('DELETE FROM products WHERE product_id = ?', [fixture.productId]);
    await connection.execute('DELETE FROM categories WHERE category_id = ?', [fixture.categoryId]);
    await connection.execute('DELETE FROM units_of_measure WHERE unit_of_measure_id = ?', [fixture.unitId]);
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
      `DELETE FROM employees
       WHERE employee_id IN (${placeholders(fixture.employeeIds)})`,
      fixture.employeeIds,
    );
    await connection.execute(
      `DELETE FROM branches WHERE branch_id IN (${placeholders(fixture.branchIds)})`,
      fixture.branchIds,
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

async function createApprovedOrder(fixture, baseUrl, variantId, packageId, quantity, label) {
  const root = `/api/admin/branches/${fixture.branchId}/purchase-orders`;
  const create = await tracked(fixture, baseUrl, `${label}-po`, root, {
    method: 'POST',
    body: {
      supplierId: fixture.supplierId,
      shippingAmount: '0.00',
      notes: `${fixture.prefix} ${label}`,
    },
  });
  assertStatus(create, 201);
  const orderId = create.json.data.purchaseOrder.purchaseOrderId;
  const line = await tracked(fixture, baseUrl, `${label}-line`, `${root}/${orderId}/items`, {
    method: 'POST',
    body: {
      productVariantId: variantId,
      productPackageId: packageId,
      orderedPackageQuantity: quantity,
      unitCost: '2.0000',
      discountAmount: '0.00',
      taxRatePercent: '0.0000',
    },
  });
  assertStatus(line, 201);
  assertStatus(await tracked(fixture, baseUrl, `${label}-submit`, `${root}/${orderId}/submit`, { method: 'POST', body: {} }), 200);
  assertStatus(await tracked(fixture, baseUrl, `${label}-approve`, `${root}/${orderId}/approve`, { method: 'POST', body: {} }), 200);
  return { orderId, itemId: line.json.data.item.purchaseOrderItemId };
}

function phase7AuthorizationRoutes(fixture) {
  const poRoot = `/api/admin/branches/${fixture.branchId}/purchase-orders`;
  const po = `${poRoot}/${fixture.authPurchaseOrderId}`;
  const poItem = `${po}/items/${fixture.authPurchaseOrderItemId}`;
  const grRoot = `/api/admin/branches/${fixture.branchId}/goods-receipts`;
  const gr = `${grRoot}/${fixture.authGoodsReceiptId}`;
  const grItem = `${gr}/items/${fixture.authGoodsReceiptItemId}`;
  return [
    { domain: 'purchasing', access: 'read', method: 'GET', path: poRoot },
    {
      domain: 'purchasing', access: 'write', method: 'POST', path: poRoot,
      body: { supplierId: fixture.supplierId, notes: `${fixture.prefix} auth matrix create` },
    },
    { domain: 'purchasing', access: 'read', method: 'GET', path: po },
    {
      domain: 'purchasing', access: 'write', method: 'PATCH', path: po,
      body: { notes: `${fixture.prefix} authorization draft` },
    },
    {
      domain: 'purchasing', access: 'write', method: 'POST', path: `${po}/items`,
      body: {
        productVariantId: fixture.noneVariantId,
        productPackageId: fixture.packageIds[0],
        orderedPackageQuantity: '1.000', unitCost: '2.0000',
      },
    },
    {
      domain: 'purchasing', access: 'write', method: 'PATCH', path: poItem,
      body: { unitCost: '2.0000' },
    },
    { domain: 'purchasing', access: 'write', method: 'DELETE', path: poItem },
    { domain: 'purchasing', access: 'write', method: 'POST', path: `${po}/submit`, body: {} },
    { domain: 'purchasing', access: 'write', method: 'POST', path: `${po}/approve`, body: {} },
    { domain: 'purchasing', access: 'write', method: 'POST', path: `${po}/cancel`, body: {} },
    { domain: 'receiving', access: 'read', method: 'GET', path: grRoot },
    {
      domain: 'receiving', access: 'write', method: 'POST', path: grRoot,
      body: {
        purchaseOrderId: fixture.authApprovedPurchaseOrderId,
        notes: `${fixture.prefix} auth matrix receipt create`,
      },
    },
    { domain: 'receiving', access: 'read', method: 'GET', path: gr },
    {
      domain: 'receiving', access: 'write', method: 'PATCH', path: gr,
      body: { notes: `${fixture.prefix} authorization receipt` },
    },
    {
      domain: 'receiving', access: 'write', method: 'POST', path: `${gr}/items`,
      body: {
        purchaseOrderItemId: fixture.authApprovedPurchaseOrderItemId,
        packageQuantityAccepted: '1.000', packageQuantityRejected: '0.000',
        actualUnitCost: '2.0000',
      },
    },
    {
      domain: 'receiving', access: 'write', method: 'PATCH', path: grItem,
      body: { actualUnitCost: '2.0000' },
    },
    { domain: 'receiving', access: 'write', method: 'DELETE', path: grItem },
    { domain: 'receiving', access: 'write', method: 'POST', path: `${gr}/post`, body: {} },
    { domain: 'receiving', access: 'write', method: 'POST', path: `${gr}/cancel`, body: {} },
  ];
}

test('Phase 7 purchasing and stock receiving integration', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const fixture = fixtureDefinition();
  let server;
  try {
    await createFixture(fixture);
    server = await startServer();
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const poRoot = `/api/admin/branches/${fixture.branchId}/purchase-orders`;
    const grRoot = `/api/admin/branches/${fixture.branchId}/goods-receipts`;

    await t.test('enforces authorization across exactly all 19 Phase 7 routes', async () => {
      const routes = phase7AuthorizationRoutes(fixture);
      assert.equal(routes.length, 19);
      assert.equal(
        new Set(routes.map(({ method, path }) => `${method} ${path}`)).size,
        19,
      );

      const unrelatedRoles = [
        'none', 'catalogOnly', 'productsOnly', 'suppliersOnly',
        'pricingOnly', 'wrongBranch',
      ];
      for (const route of routes) {
        const options = {
          method: route.method,
          ...(route.body === undefined ? {} : { body: route.body }),
        };
        assertSafeError(await send(baseUrl, route.path, options), 401);
        assertSafeError(await send(baseUrl, route.path, {
          ...options, token: fixture.tokens.must,
        }), 403);
        for (const roleName of unrelatedRoles) {
          assertSafeError(await send(baseUrl, route.path, {
            ...options, token: fixture.tokens[roleName],
          }), 403);
        }

        if (route.access === 'read') {
          assertStatus(await send(baseUrl, route.path, {
            ...options, token: fixture.tokens.read,
          }), 200);
          assertSafeError(await send(baseUrl, route.path, {
            ...options, token: fixture.tokens.manage,
          }), 403);
          assertStatus(await send(baseUrl, route.path, {
            ...options, token: fixture.tokens.system,
          }), 200);
          assertStatus(await send(baseUrl, route.path, {
            ...options, token: fixture.tokens.globalPhase7,
          }), 200);
        } else {
          assertSafeError(await send(baseUrl, route.path, {
            ...options, token: fixture.tokens.read,
          }), 403);
          assertSafeError(await send(baseUrl, route.path, {
            ...options, token: fixture.tokens.system,
          }), 403);
          assertSafeError(await send(baseUrl, route.path, {
            ...options, token: fixture.tokens.globalPhase7,
          }), 403);
        }
      }

      assertStatus(await send(baseUrl, poRoot, { token: fixture.tokens.read }), 200);
      assertSafeError(await send(
        baseUrl,
        `/api/admin/branches/${fixture.otherBranchId}/purchase-orders`,
        { token: fixture.tokens.read },
      ), 403);
      assertStatus(await send(baseUrl, poRoot, {
        token: fixture.tokens.globalPhase7,
      }), 200);
      assertStatus(await send(
        baseUrl,
        `/api/admin/branches/${fixture.otherBranchId}/purchase-orders`,
        { token: fixture.tokens.globalPhase7 },
      ), 200);
      assertSafeError(await send(baseUrl, poRoot, {
        token: fixture.tokens.wrongBranch,
      }), 403);
      assertSafeError(await send(
        baseUrl,
        `/api/admin/branches/${fixture.otherBranchId}/purchase-orders`,
        { token: fixture.tokens.wrongBranch },
      ), 403);
    });

    await t.test('lets a branch-assigned manage-only employee reach every write handler', async () => {
      const token = fixture.tokens.manage;
      const createOrder = await send(baseUrl, poRoot, {
        method: 'POST', token,
        body: {
          supplierId: fixture.supplierId,
          notes: `${fixture.prefix} manage-only authorization order`,
        },
      });
      assertStatus(createOrder, 201);

      const po = `${poRoot}/${fixture.authPurchaseOrderId}`;
      const poItem = `${po}/items/${fixture.authPurchaseOrderItemId}`;
      assertStatus(await send(baseUrl, po, {
        method: 'PATCH', token,
        body: { notes: `${fixture.prefix} authorization draft` },
      }), 200);
      assertSafeError(await send(baseUrl, `${po}/items`, {
        method: 'POST', token,
        body: {
          productVariantId: fixture.noneVariantId,
          productPackageId: fixture.packageIds[0],
          orderedPackageQuantity: '1.000', unitCost: '2.0000',
        },
      }), 409);
      assertStatus(await send(baseUrl, poItem, {
        method: 'PATCH', token, body: { unitCost: '2.0000' },
      }), 200);
      assertStatus(await send(baseUrl, poItem, { method: 'DELETE', token }), 200);
      assertSafeError(await send(baseUrl, `${po}/submit`, {
        method: 'POST', token, body: {},
      }), 409);
      assertSafeError(await send(baseUrl, `${po}/approve`, {
        method: 'POST', token, body: {},
      }), 409);
      assertStatus(await send(baseUrl, `${po}/cancel`, {
        method: 'POST', token, body: {},
      }), 200);

      const createReceipt = await send(baseUrl, grRoot, {
        method: 'POST', token,
        body: {
          purchaseOrderId: fixture.authApprovedPurchaseOrderId,
          notes: `${fixture.prefix} manage-only authorization receipt`,
        },
      });
      assertStatus(createReceipt, 201);

      const gr = `${grRoot}/${fixture.authGoodsReceiptId}`;
      const grItem = `${gr}/items/${fixture.authGoodsReceiptItemId}`;
      assertStatus(await send(baseUrl, gr, {
        method: 'PATCH', token,
        body: { notes: `${fixture.prefix} authorization receipt` },
      }), 200);
      assertSafeError(await send(baseUrl, `${gr}/items`, {
        method: 'POST', token,
        body: {
          purchaseOrderItemId: fixture.authApprovedPurchaseOrderItemId,
          packageQuantityAccepted: '1.000', packageQuantityRejected: '0.000',
          actualUnitCost: '2.0000',
        },
      }), 409);
      assertStatus(await send(baseUrl, grItem, {
        method: 'PATCH', token, body: { actualUnitCost: '2.0000' },
      }), 200);
      assertStatus(await send(baseUrl, grItem, { method: 'DELETE', token }), 200);
      assertSafeError(await send(baseUrl, `${gr}/post`, {
        method: 'POST', token, body: {},
      }), 409);
      assertStatus(await send(baseUrl, `${gr}/cancel`, {
        method: 'POST', token, body: {},
      }), 200);
    });

    await t.test('rejects invalid purchase-order identity, eligibility, and lifecycle cases', async () => {
      const token = fixture.tokens.admin;
      const maximumId = '18446744073709551615';
      const validCreate = (overrides = {}) => ({
        supplierId: fixture.supplierId,
        notes: `${fixture.prefix} purchase contract validation`,
        ...overrides,
      });

      assertSafeError(await send(baseUrl, poRoot, {
        method: 'POST', token, body: validCreate({ supplierId: maximumId }),
      }), 404);
      assertSafeError(await send(baseUrl, poRoot, {
        method: 'POST', token,
        body: validCreate({ supplierId: fixture.inactiveSupplierId }),
      }), 409);
      assertSafeError(await send(
        baseUrl, '/api/admin/branches/not-an-id/purchase-orders',
        { token: fixture.tokens.system },
      ), 400);
      assertSafeError(await send(
        baseUrl, `/api/admin/branches/${maximumId}/purchase-orders`,
        { token: fixture.tokens.system },
      ), 404);
      assertSafeError(await send(baseUrl, poRoot, {
        method: 'POST', token,
        body: validCreate({ status: 'DRAFT' }),
      }), 400);
      for (const body of [
        validCreate({ supplierQuoteNumber: 'Q'.repeat(101) }),
        validCreate({ notes: 'N'.repeat(1001) }),
        validCreate({ expectedAt: '2026-09-20 10:00:00' }),
        validCreate({ expectedAt: '2026-02-30T10:00:00Z' }),
        validCreate({ shippingAmount: 1 }),
        validCreate({ shippingAmount: '1.001' }),
      ]) {
        assertSafeError(await send(baseUrl, poRoot, {
          method: 'POST', token, body,
        }), 400);
      }
      assertSafeError(await send(baseUrl, `${poRoot}/not-an-id`, { token }), 400);
      assertSafeError(await send(baseUrl, `${poRoot}/${maximumId}`, { token }), 404);
      assertSafeError(await send(
        baseUrl,
        `/api/admin/branches/${fixture.otherBranchId}/purchase-orders/${fixture.authApprovedPurchaseOrderId}`,
        { token: fixture.tokens.system },
      ), 404);
      assertStatus(await send(
        baseUrl, `${poRoot}/${fixture.authApprovedPurchaseOrderId}`,
        { method: 'DELETE', token },
      ), 404);

      const create = await send(baseUrl, poRoot, {
        method: 'POST', token, body: validCreate(),
      });
      assertStatus(create, 201);
      const orderId = create.json.data.purchaseOrder.purchaseOrderId;
      fixture.contractOrderId = orderId;
      const itemRoot = `${poRoot}/${orderId}/items`;
      const itemBody = (overrides = {}) => ({
        productVariantId: fixture.noneVariantId,
        productPackageId: fixture.packageIds[0],
        orderedPackageQuantity: '1.000',
        unitCost: '2.0000',
        ...overrides,
      });

      assertStatus(await send(baseUrl, `${poRoot}/${orderId}`, {
        method: 'PATCH', token, body: { expectedAt: null },
      }), 200);

      assertSafeError(await send(baseUrl, `${poRoot}/${orderId}/submit`, {
        method: 'POST', token, body: {},
      }), 409);
      assertSafeError(await send(baseUrl, `${poRoot}/${orderId}/approve`, {
        method: 'POST', token, body: {},
      }), 409);
      assertSafeError(await send(baseUrl, itemRoot, {
        method: 'POST', token,
        body: itemBody({ productPackageId: null, orderedPackageQuantity: '0.500' }),
      }), 409);
      assertSafeError(await send(baseUrl, itemRoot, {
        method: 'POST', token,
        body: itemBody({
          productPackageId: fixture.cartonId,
          orderedPackageQuantity: '0.500',
        }),
      }), 409);
      assertSafeError(await send(baseUrl, itemRoot, {
        method: 'POST', token,
        body: itemBody({ productPackageId: fixture.packageIds[1] }),
      }), 404);

      try {
        await pool.execute(
          "UPDATE products SET status = 'INACTIVE' WHERE product_id = ?",
          [fixture.productId],
        );
        assertSafeError(await send(baseUrl, itemRoot, {
          method: 'POST', token, body: itemBody(),
        }), 409);
      } finally {
        await pool.execute(
          "UPDATE products SET status = 'ACTIVE' WHERE product_id = ?",
          [fixture.productId],
        );
      }
      try {
        await pool.execute(
          "UPDATE product_variants SET status = 'INACTIVE' WHERE product_variant_id = ?",
          [fixture.noneVariantId],
        );
        assertSafeError(await send(baseUrl, itemRoot, {
          method: 'POST', token, body: itemBody(),
        }), 409);
      } finally {
        await pool.execute(
          "UPDATE product_variants SET status = 'ACTIVE' WHERE product_variant_id = ?",
          [fixture.noneVariantId],
        );
      }
      try {
        await pool.execute(
          "UPDATE product_packages SET status = 'INACTIVE' WHERE product_package_id = ?",
          [fixture.packageIds[0]],
        );
        assertSafeError(await send(baseUrl, itemRoot, {
          method: 'POST', token, body: itemBody(),
        }), 409);
      } finally {
        await pool.execute(
          "UPDATE product_packages SET status = 'ACTIVE' WHERE product_package_id = ?",
          [fixture.packageIds[0]],
        );
      }
      try {
        await pool.execute(
          'UPDATE product_packages SET is_purchasable = 0 WHERE product_package_id = ?',
          [fixture.packageIds[0]],
        );
        assertSafeError(await send(baseUrl, itemRoot, {
          method: 'POST', token, body: itemBody(),
        }), 409);
      } finally {
        await pool.execute(
          'UPDATE product_packages SET is_purchasable = 1 WHERE product_package_id = ?',
          [fixture.packageIds[0]],
        );
      }

      try {
        await pool.execute(
          `DELETE FROM supplier_product_packages
           WHERE supplier_id = ? AND product_variant_id = ?`,
          [fixture.supplierId, fixture.optionalVariantId],
        );
        await pool.execute(
          `DELETE FROM supplier_products
           WHERE supplier_id = ? AND product_variant_id = ?`,
          [fixture.supplierId, fixture.optionalVariantId],
        );
        assertSafeError(await send(baseUrl, itemRoot, {
          method: 'POST', token,
          body: itemBody({
            productVariantId: fixture.optionalVariantId,
            productPackageId: null,
          }),
        }), 409);
      } finally {
        await pool.execute(
          `INSERT IGNORE INTO supplier_products (
             supplier_id, product_variant_id, minimum_order_quantity
           ) VALUES (?, ?, '1.000')`,
          [fixture.supplierId, fixture.optionalVariantId],
        );
        await pool.execute(
          `INSERT IGNORE INTO supplier_product_packages (
             supplier_id, product_variant_id, product_package_id,
             minimum_package_quantity, is_active
           ) VALUES (?, ?, ?, '1.000', 1)`,
          [
            fixture.supplierId, fixture.optionalVariantId,
            fixture.packageIds[3],
          ],
        );
      }

      const item = await send(baseUrl, itemRoot, {
        method: 'POST', token, body: itemBody(),
      });
      assertStatus(item, 201);
      fixture.contractOrderItemId = item.json.data.item.purchaseOrderItemId;
      assertStatus(await send(baseUrl, `${poRoot}/${orderId}/submit`, {
        method: 'POST', token, body: {},
      }), 200);
      assertSafeError(await send(baseUrl, `${poRoot}/${orderId}/submit`, {
        method: 'POST', token, body: {},
      }), 409);
      assertSafeError(await send(baseUrl, grRoot, {
        method: 'POST', token,
        body: { purchaseOrderId: orderId, notes: `${fixture.prefix} submitted receipt` },
      }), 409);
      assertStatus(await send(baseUrl, `${poRoot}/${orderId}/approve`, {
        method: 'POST', token, body: {},
      }), 200);
      assertSafeError(await send(baseUrl, `${poRoot}/${orderId}/approve`, {
        method: 'POST', token, body: {},
      }), 409);
      assertStatus(await send(baseUrl, `${poRoot}/${orderId}/cancel`, {
        method: 'POST', token, body: { reason: 'Contract validation complete' },
      }), 200);
      assertSafeError(await send(baseUrl, `${poRoot}/${orderId}/cancel`, {
        method: 'POST', token, body: {},
      }), 409);
      assertSafeError(await send(baseUrl, grRoot, {
        method: 'POST', token,
        body: { purchaseOrderId: orderId, notes: `${fixture.prefix} cancelled receipt` },
      }), 409);
    });

    await t.test('rejects invalid receipt identities, source states, invoices, and item ownership', async () => {
      const token = fixture.tokens.admin;
      const maximumId = '18446744073709551615';
      assertSafeError(await send(baseUrl, `${grRoot}/not-an-id`, { token }), 400);
      assertSafeError(await send(baseUrl, `${grRoot}/${maximumId}`, { token }), 404);
      assertSafeError(await send(
        baseUrl,
        `/api/admin/branches/${fixture.otherBranchId}/goods-receipts/${fixture.authGoodsReceiptId}`,
        { token: fixture.tokens.system },
      ), 404);

      const draftOrder = await send(baseUrl, poRoot, {
        method: 'POST', token,
        body: {
          supplierId: fixture.supplierId,
          notes: `${fixture.prefix} draft source-state order`,
        },
      });
      assertStatus(draftOrder, 201);
      assertSafeError(await send(baseUrl, grRoot, {
        method: 'POST', token,
        body: {
          purchaseOrderId: draftOrder.json.data.purchaseOrder.purchaseOrderId,
          notes: `${fixture.prefix} draft source-state receipt`,
        },
      }), 409);

      const invoiceNumber = `P7-INV-${fixture.token}`;
      const receipt = await send(baseUrl, grRoot, {
        method: 'POST', token,
        body: {
          purchaseOrderId: fixture.authApprovedPurchaseOrderId,
          supplierInvoiceNumber: invoiceNumber,
          notes: `${fixture.prefix} receipt contract validation`,
        },
      });
      assertStatus(receipt, 201);
      assert.match(
        receipt.json.data.goodsReceipt.goodsReceiptNumber,
        /^GR-[A-F0-9]{32}$/,
      );
      assert.equal(receipt.json.data.goodsReceipt.branchId, fixture.branchId);
      assert.equal(receipt.json.data.goodsReceipt.supplierId, fixture.supplierId);
      const receiptId = receipt.json.data.goodsReceipt.goodsReceiptId;
      assertSafeError(await send(baseUrl, grRoot, {
        method: 'POST', token,
        body: {
          purchaseOrderId: fixture.authApprovedPurchaseOrderId,
          supplierInvoiceNumber: invoiceNumber,
          notes: `${fixture.prefix} duplicate supplier invoice`,
        },
      }), 409);
      const noOp = await tracked(
        fixture, baseUrl, 'receipt-contract-noop', `${grRoot}/${receiptId}`,
        {
          method: 'PATCH',
          body: { supplierInvoiceNumber: invoiceNumber },
        },
      );
      assertStatus(noOp, 200);
      fixture.receiptNoOpRequestId = noOp.requestId;
      assertSafeError(await send(baseUrl, `${grRoot}/${receiptId}/items`, {
        method: 'POST', token,
        body: {
          purchaseOrderItemId: fixture.contractOrderItemId,
          packageQuantityAccepted: '1.000',
          packageQuantityRejected: '0.000',
          actualUnitCost: '2.0000',
        },
      }), 404);
      const item = await send(baseUrl, `${grRoot}/${receiptId}/items`, {
        method: 'POST', token,
        body: {
          purchaseOrderItemId: fixture.authApprovedPurchaseOrderItemId,
          packageQuantityAccepted: '1.000',
          packageQuantityRejected: '0.000',
          actualUnitCost: '2.0000',
        },
      });
      assertStatus(item, 201);
      assertSafeError(await send(baseUrl, `${grRoot}/${receiptId}/items`, {
        method: 'POST', token,
        body: {
          purchaseOrderItemId: fixture.authApprovedPurchaseOrderItemId,
          packageQuantityAccepted: '1.000',
          packageQuantityRejected: '0.000',
          actualUnitCost: '2.0000',
        },
      }), 409);
      assertStatus(await send(baseUrl, `${grRoot}/${receiptId}/cancel`, {
        method: 'POST', token, body: {},
      }), 200);

      const rejectedReceipt = await send(baseUrl, grRoot, {
        method: 'POST', token,
        body: {
          purchaseOrderId: fixture.authApprovedPurchaseOrderId,
          notes: `${fixture.prefix} rejected-only receipt`,
        },
      });
      assertStatus(rejectedReceipt, 201);
      const rejectedReceiptId = rejectedReceipt.json.data.goodsReceipt.goodsReceiptId;
      const rejectedItem = await send(
        baseUrl, `${grRoot}/${rejectedReceiptId}/items`,
        {
          method: 'POST', token,
          body: {
            purchaseOrderItemId: fixture.authApprovedPurchaseOrderItemId,
            packageQuantityAccepted: '0.000',
            packageQuantityRejected: '1.000',
            actualUnitCost: '2.0000',
          },
        },
      );
      assertStatus(rejectedItem, 201);
      const stockBeforeRejectedPost = await branchQuantity(
        fixture.branchId, fixture.noneVariantId,
      );
      assertSafeError(await send(baseUrl, `${grRoot}/${rejectedReceiptId}/post`, {
        method: 'POST', token, body: {},
      }), 409);
      const rejectedDetail = await send(
        baseUrl, `${grRoot}/${rejectedReceiptId}`, { token },
      );
      assertStatus(rejectedDetail, 200);
      assert.equal(rejectedDetail.json.data.goodsReceipt.status, 'DRAFT');
      assert.equal(rejectedDetail.json.data.goodsReceipt.inventoryTransactionId, null);
      assert.equal(
        await branchQuantity(fixture.branchId, fixture.noneVariantId),
        stockBeforeRejectedPost,
      );
      assertStatus(await send(baseUrl, `${grRoot}/${rejectedReceiptId}/cancel`, {
        method: 'POST', token, body: {},
      }), 200);
    });

    await t.test('creates exact purchase snapshots and advances the order lifecycle', async () => {
      const create = await tracked(fixture, baseUrl, 'main-po-create', poRoot, {
        method: 'POST',
        body: {
          supplierId: fixture.supplierId,
          expectedAt: futureUtcTimestamp(),
          supplierQuoteNumber: `QUOTE-${fixture.token}`,
          shippingAmount: '3.00',
          notes: `${fixture.prefix} main`,
        },
      });
      assertStatus(create, 201);
      const order = create.json.data.purchaseOrder;
      fixture.mainOrderId = order.purchaseOrderId;
      assert.match(order.purchaseOrderNumber, /^PO-[A-F0-9]{32}$/);
      assert.equal(order.currencyCode, 'NGN');
      assert.equal(order.totalAmount, '3.00');

      assertSafeError(await send(
        baseUrl,
        `${poRoot}/${fixture.mainOrderId}/items`,
        {
          method: 'POST',
          token: fixture.tokens.admin,
          body: {
            productVariantId: fixture.noneVariantId,
            productPackageId: null,
            orderedPackageQuantity: '999999999999.000',
            unitCost: '999999999999999.9999',
          },
        },
      ), 400);
      assertSafeError(await send(
        baseUrl,
        `${poRoot}/${fixture.mainOrderId}/items`,
        {
          method: 'POST',
          token: fixture.tokens.admin,
          body: {
            productVariantId: fixture.noneVariantId,
            productPackageId: fixture.cartonId,
            orderedPackageQuantity: '999999999999.999',
            unitCost: '1.0000',
          },
        },
      ), 400);

      const carton = await tracked(
        fixture, baseUrl, 'main-carton', `${poRoot}/${fixture.mainOrderId}/items`,
        {
          method: 'POST',
          body: {
            productVariantId: fixture.noneVariantId,
            productPackageId: fixture.cartonId,
            orderedPackageQuantity: '2.000',
            unitCost: '1.2500',
            discountAmount: '2.00',
            taxRatePercent: '10.0000',
          },
        },
      );
      assertStatus(carton, 201);
      fixture.mainCartonItemId = carton.json.data.item.purchaseOrderItemId;
      assert.equal(carton.json.data.item.packageConversionFactor, '24.000000');
      assert.equal(carton.json.data.item.orderedQuantity, '48.000');
      assert.equal(carton.json.data.item.taxAmount, '5.80');
      assert.equal(carton.json.data.item.lineTotal, '63.80');

      const base = await tracked(
        fixture, baseUrl, 'main-base', `${poRoot}/${fixture.mainOrderId}/items`,
        {
          method: 'POST',
          body: {
            productVariantId: fixture.noneVariantId,
            productPackageId: null,
            orderedPackageQuantity: '12.000',
            unitCost: '2.0000',
          },
        },
      );
      assertStatus(base, 201);
      fixture.mainBaseItemId = base.json.data.item.purchaseOrderItemId;
      assert.equal(base.json.data.purchaseOrder.subtotalAmount, '84.00');
      assert.equal(base.json.data.purchaseOrder.totalAmount, '90.80');

      assertStatus(await tracked(
        fixture, baseUrl, 'main-header-update', `${poRoot}/${fixture.mainOrderId}`,
        { method: 'PATCH', body: { notes: `${fixture.prefix} main updated` } },
      ), 200);
      assertStatus(await tracked(
        fixture, baseUrl, 'main-item-update',
        `${poRoot}/${fixture.mainOrderId}/items/${fixture.mainBaseItemId}`,
        { method: 'PATCH', body: { unitCost: '2.5000' } },
      ), 200);

      const noOp = await tracked(
        fixture, baseUrl, 'main-noop', `${poRoot}/${fixture.mainOrderId}`,
        { method: 'PATCH', body: { shippingAmount: '3.00' } },
      );
      assertStatus(noOp, 200);
      fixture.noOpRequestId = noOp.requestId;

      const detail = await send(baseUrl, `${poRoot}/${fixture.mainOrderId}`, {
        token: fixture.tokens.admin,
      });
      assertStatus(detail, 200);
      assert.equal(detail.json.data.items.length, 2);
      assert.equal(detail.json.data.items[0].acceptedQuantity, '0.000');

      assertStatus(await tracked(fixture, baseUrl, 'main-submit', `${poRoot}/${fixture.mainOrderId}/submit`, { method: 'POST', body: {} }), 200);
      const approve = await tracked(fixture, baseUrl, 'main-approve', `${poRoot}/${fixture.mainOrderId}/approve`, { method: 'POST', body: {} });
      assertStatus(approve, 200);
      assert.equal(approve.json.data.purchaseOrder.status, 'APPROVED');
      assert.equal(approve.json.data.purchaseOrder.approvedByEmployeeId, fixture.employeeId);
      assertSafeError(await send(baseUrl, `${poRoot}/${fixture.mainOrderId}`, {
        method: 'PATCH', token: fixture.tokens.admin, body: { notes: 'too late' },
      }), 409);
    });

    await t.test('posts partial receipts with rejected quantities and exact stock', async () => {
      const create = await tracked(fixture, baseUrl, 'receipt-one', grRoot, {
        method: 'POST',
        body: {
          purchaseOrderId: fixture.mainOrderId,
          supplierDeliveryNote: `DN-${fixture.token}-1`,
          notes: `${fixture.prefix} receipt one`,
        },
      });
      assertStatus(create, 201);
      const receiptId = create.json.data.goodsReceipt.goodsReceiptId;
      const item = await tracked(fixture, baseUrl, 'receipt-one-item', `${grRoot}/${receiptId}/items`, {
        method: 'POST',
        body: {
          purchaseOrderItemId: fixture.mainCartonItemId,
          packageQuantityAccepted: '1.000',
          packageQuantityRejected: '0.500',
          actualUnitCost: '1.5000',
          discountAmount: '0.00',
          taxAmount: '0.00',
        },
      });
      assertStatus(item, 201);
      assert.equal(item.json.data.item.quantityAccepted, '24.000');
      assert.equal(item.json.data.item.quantityRejected, '12.000');
      assert.equal(item.json.data.item.lineTotal, '36.00');
      assertSafeError(await tracked(fixture, baseUrl, 'receipt-one-invalid-lot', `${grRoot}/${receiptId}/post`, {
        method: 'POST',
        body: {
          lotAllocations: [{
            goodsReceiptItemId: item.json.data.item.goodsReceiptItemId,
            lots: [{ lotNumber: `${fixture.prefix}-NOT-ALLOWED`, quantityReceived: '24.000' }],
          }],
        },
      }), 409);
      const posted = await tracked(fixture, baseUrl, 'receipt-one-post', `${grRoot}/${receiptId}/post`, {
        method: 'POST', body: {},
      });
      assertStatus(posted, 200);
      assert.equal(posted.json.data.purchaseOrderStatus, 'PARTIALLY_RECEIVED');
      const [inventoryRows] = await pool.execute(
        `SELECT quantity_on_hand AS quantity, version_number AS version
         FROM branch_inventory WHERE branch_id = ? AND product_variant_id = ?`,
        [fixture.branchId, fixture.noneVariantId],
      );
      assert.equal(inventoryRows[0].quantity, '24.000');
      assertSafeError(await send(baseUrl, `${grRoot}/${receiptId}/post`, {
        method: 'POST', token: fixture.tokens.admin, body: {},
      }), 409);
      assertSafeError(await send(baseUrl, `${grRoot}/${receiptId}`, {
        method: 'PATCH', token: fixture.tokens.admin,
        body: { notes: `${fixture.prefix} immutable posted receipt` },
      }), 409);
      assertSafeError(await send(
        baseUrl,
        `${grRoot}/${receiptId}/items/${item.json.data.item.goodsReceiptItemId}`,
        {
          method: 'PATCH', token: fixture.tokens.admin,
          body: { actualUnitCost: '3.0000' },
        },
      ), 409);
      assertSafeError(await send(
        baseUrl,
        `${grRoot}/${receiptId}/items/${item.json.data.item.goodsReceiptItemId}`,
        { method: 'DELETE', token: fixture.tokens.admin },
      ), 409);
      assertSafeError(await send(baseUrl, `${grRoot}/${receiptId}/cancel`, {
        method: 'POST', token: fixture.tokens.admin, body: {},
      }), 409);
      const [ledgerRows] = await pool.execute(
        `SELECT COUNT(*) AS count FROM inventory_transactions it
         INNER JOIN goods_receipts gr ON gr.inventory_transaction_id = it.inventory_transaction_id
         WHERE gr.goods_receipt_id = ? AND it.transaction_type = 'PURCHASE_RECEIPT'`,
        [receiptId],
      );
      assert.equal(Number(ledgerRows[0].count), 1);
      const partialReceipt = await send(baseUrl, grRoot, {
        method: 'POST', token: fixture.tokens.admin,
        body: {
          purchaseOrderId: fixture.mainOrderId,
          notes: `${fixture.prefix} partial-state receipt`,
        },
      });
      assertStatus(partialReceipt, 201);
      assert.equal(partialReceipt.json.data.goodsReceipt.branchId, fixture.branchId);
      assert.equal(partialReceipt.json.data.goodsReceipt.supplierId, fixture.supplierId);
      assertStatus(await send(
        baseUrl,
        `${grRoot}/${partialReceipt.json.data.goodsReceipt.goodsReceiptId}/cancel`,
        { method: 'POST', token: fixture.tokens.admin, body: {} },
      ), 200);
      assertSafeError(await send(baseUrl, `${poRoot}/${fixture.mainOrderId}/cancel`, {
        method: 'POST', token: fixture.tokens.admin, body: {},
      }), 409);
    });

    await t.test('serializes purchase-order line numbers and complete item patches', async () => {
      const create = await tracked(fixture, baseUrl, 'concurrent-po', poRoot, {
        method: 'POST',
        body: { supplierId: fixture.supplierId, notes: `${fixture.prefix} concurrent PO` },
      });
      assertStatus(create, 201);
      const orderId = create.json.data.purchaseOrder.purchaseOrderId;
      const bodies = [
        {
          productVariantId: fixture.noneVariantId,
          productPackageId: fixture.packageIds[0],
          orderedPackageQuantity: '2.000', unitCost: '3.0000',
        },
        {
          productVariantId: fixture.requiredVariantId,
          productPackageId: fixture.packageIds[1],
          orderedPackageQuantity: '3.000', unitCost: '4.0000',
        },
      ];
      const creates = await Promise.all(bodies.map((body) => send(
        baseUrl,
        `${poRoot}/${orderId}/items`,
        { method: 'POST', token: fixture.tokens.admin, body },
      )));
      for (const result of creates) assertStatus(result, 201);
      const createdItems = creates.map((result) => result.json.data.item);
      assert.equal(new Set(createdItems.map((item) => item.lineNumber)).size, 2);
      const targetId = createdItems.find(
        (item) => item.productVariantId === fixture.noneVariantId,
      ).purchaseOrderItemId;
      const patchBodies = [
        {
          orderedPackageQuantity: '4.000', unitCost: '5.0000',
          discountAmount: '1.00', taxRatePercent: '5.0000',
        },
        {
          orderedPackageQuantity: '6.000', unitCost: '7.0000',
          discountAmount: '2.00', taxRatePercent: '10.0000',
        },
      ];
      const patches = await Promise.all(patchBodies.map((body) => send(
        baseUrl,
        `${poRoot}/${orderId}/items/${targetId}`,
        { method: 'PATCH', token: fixture.tokens.admin, body },
      )));
      for (const result of patches) assertStatus(result, 200);
      const detail = await send(baseUrl, `${poRoot}/${orderId}`, {
        token: fixture.tokens.admin,
      });
      assertStatus(detail, 200);
      const persisted = detail.json.data.items.find(
        (item) => item.purchaseOrderItemId === targetId,
      );
      assert.equal(
        patchBodies.some((body) =>
          body.orderedPackageQuantity === persisted.orderedPackageQuantity &&
          body.unitCost === persisted.unitCost &&
          body.discountAmount === persisted.discountAmount &&
          body.taxRatePercent === persisted.taxRatePercent),
        true,
      );
      const removed = createdItems.find(
        (item) => item.productVariantId === fixture.requiredVariantId,
      );
      assertStatus(await tracked(
        fixture, baseUrl, 'concurrent-delete',
        `${poRoot}/${orderId}/items/${removed.purchaseOrderItemId}`,
        { method: 'DELETE' },
      ), 200);
      assertStatus(await tracked(fixture, baseUrl, 'concurrent-cancel', `${poRoot}/${orderId}/cancel`, {
        method: 'POST', body: {},
      }), 200);
    });

    await t.test('enforces required lots and rolls back failed posting atomically', async () => {
      const order = await createApprovedOrder(
        fixture, baseUrl, fixture.requiredVariantId, fixture.packageIds[1], '5.000', 'required',
      );
      const receipt = await tracked(fixture, baseUrl, 'required-receipt', grRoot, {
        method: 'POST', body: { purchaseOrderId: order.orderId, notes: `${fixture.prefix} required receipt` },
      });
      assertStatus(receipt, 201);
      const receiptId = receipt.json.data.goodsReceipt.goodsReceiptId;
      const item = await tracked(fixture, baseUrl, 'required-item', `${grRoot}/${receiptId}/items`, {
        method: 'POST',
        body: {
          purchaseOrderItemId: order.itemId,
          packageQuantityAccepted: '5.000', packageQuantityRejected: '0.000',
          actualUnitCost: '2.0000',
        },
      });
      assertStatus(item, 201);
      const itemId = item.json.data.item.goodsReceiptItemId;
      assertSafeError(await send(baseUrl, `${grRoot}/${receiptId}/post`, {
        method: 'POST', token: fixture.tokens.admin,
        body: {
          lotAllocations: [{
            goodsReceiptItemId: itemId,
            lots: [{ lotNumber: null, quantityReceived: '5.000' }],
          }],
        },
      }), 400);
      const [beforeFailureLedgerRows] = await pool.execute(
        `SELECT COUNT(*) AS count FROM inventory_transactions
         WHERE branch_id = ? AND transaction_type = 'PURCHASE_RECEIPT'`,
        [fixture.branchId],
      );
      const failedPost = await tracked(fixture, baseUrl, 'required-fail', `${grRoot}/${receiptId}/post`, {
        method: 'POST', body: {},
      });
      assertSafeError(failedPost, 409);
      fixture.failedPostRequestId = failedPost.requestId;
      const [failedRows] = await pool.execute(
        `SELECT status, inventory_transaction_id AS transactionId
         FROM goods_receipts WHERE goods_receipt_id = ?`,
        [receiptId],
      );
      assert.equal(failedRows[0].status, 'DRAFT');
      assert.equal(failedRows[0].transactionId, null);

      const [failedArtifacts] = await pool.execute(
        `SELECT
           (SELECT COUNT(*) FROM goods_receipt_item_lots
            WHERE goods_receipt_item_id = ?) AS receiptLotCount,
           (SELECT COUNT(*) FROM branch_inventory
            WHERE branch_id = ? AND product_variant_id = ?) AS inventoryCount,
           (SELECT COUNT(*) FROM branch_lot_inventory bli
            INNER JOIN inventory_lots il
              ON il.inventory_lot_id = bli.inventory_lot_id
            WHERE bli.branch_id = ? AND il.product_variant_id = ?) AS lotBalanceCount,
           (SELECT COUNT(*) FROM inventory_transactions
            WHERE branch_id = ? AND transaction_type = 'PURCHASE_RECEIPT') AS ledgerCount,
           (SELECT COUNT(*)
            FROM inventory_transaction_lot_allocations itla
            INNER JOIN inventory_transaction_items iti
              ON iti.inventory_transaction_item_id = itla.inventory_transaction_item_id
            INNER JOIN goods_receipts gr
              ON gr.inventory_transaction_id = iti.inventory_transaction_id
            WHERE gr.goods_receipt_id = ?) AS ledgerLotCount,
           (SELECT COUNT(*) FROM audit_logs
            WHERE request_id = ?) AS auditCount`,
        [
          itemId,
          fixture.branchId, fixture.requiredVariantId,
          fixture.branchId, fixture.requiredVariantId,
          fixture.branchId,
          receiptId,
          failedPost.requestId,
        ],
      );
      assert.equal(Number(failedArtifacts[0].receiptLotCount), 0);
      assert.equal(Number(failedArtifacts[0].inventoryCount), 0);
      assert.equal(Number(failedArtifacts[0].lotBalanceCount), 0);
      assert.equal(
        Number(failedArtifacts[0].ledgerCount),
        Number(beforeFailureLedgerRows[0].count),
      );
      assert.equal(Number(failedArtifacts[0].ledgerLotCount), 0);
      assert.equal(Number(failedArtifacts[0].auditCount), 0);

      assertSafeError(await send(baseUrl, `${grRoot}/${receiptId}/post`, {
        method: 'POST', token: fixture.tokens.admin,
        body: {
          lotAllocations: [{
            goodsReceiptItemId: itemId,
            lots: [{
              lotNumber: `${fixture.prefix}-BAD-DATES`,
              manufacturedOn: '2027-09-01', expiresOn: '2026-09-01',
              quantityReceived: '5.000',
            }],
          }],
        },
      }), 400);

      for (const lots of [
        [{
          lotNumber: `${fixture.prefix}-PARTIAL`,
          expiresOn: '2027-09-01', quantityReceived: '4.000',
        }],
        [{ inventoryLotId: fixture.wrongVariantLotId, quantityReceived: '5.000' }],
        [{ inventoryLotId: fixture.recalledLotId, quantityReceived: '5.000' }],
        [{ inventoryLotId: fixture.closedLotId, quantityReceived: '5.000' }],
        [{ lotNumber: `${fixture.prefix}-NO-EXPIRY`, quantityReceived: '5.000' }],
      ]) {
        assertSafeError(await send(baseUrl, `${grRoot}/${receiptId}/post`, {
          method: 'POST', token: fixture.tokens.admin,
          body: {
            lotAllocations: [{ goodsReceiptItemId: itemId, lots }],
          },
        }), 409);
      }

      const [afterInvalidLotRows] = await pool.execute(
        `SELECT gr.status, gr.inventory_transaction_id AS transactionId,
           (SELECT COUNT(*) FROM inventory_lots
            WHERE product_variant_id = ?
              AND lot_number IN (?, ?, ?)) AS failedLotCount
         FROM goods_receipts gr WHERE gr.goods_receipt_id = ?`,
        [
          fixture.requiredVariantId,
          `${fixture.prefix}-PARTIAL`,
          `${fixture.prefix}-NO-EXPIRY`,
          `${fixture.prefix}-BAD-DATES`,
          receiptId,
        ],
      );
      assert.equal(afterInvalidLotRows[0].status, 'DRAFT');
      assert.equal(afterInvalidLotRows[0].transactionId, null);
      assert.equal(Number(afterInvalidLotRows[0].failedLotCount), 0);

      const post = await tracked(fixture, baseUrl, 'required-post', `${grRoot}/${receiptId}/post`, {
        method: 'POST',
        body: {
          lotAllocations: [{
            goodsReceiptItemId: itemId,
            lots: [{
              lotNumber: `${fixture.prefix}-LOT-A`,
              manufacturedOn: '2026-09-01', expiresOn: '2027-09-01',
              quantityReceived: '5.000',
            }],
          }],
        },
      });
      assertStatus(post, 200);
      const detail = await send(baseUrl, `${grRoot}/${receiptId}`, { token: fixture.tokens.admin });
      assertStatus(detail, 200);
      assert.equal(detail.json.data.lotAllocations.length, 1);
      const [lotRows] = await pool.execute(
        `SELECT bli.quantity_on_hand AS quantity, bli.status
         FROM branch_lot_inventory bli
         INNER JOIN inventory_lots il ON il.inventory_lot_id = bli.inventory_lot_id
         WHERE bli.branch_id = ? AND il.product_variant_id = ?`,
        [fixture.branchId, fixture.requiredVariantId],
      );
      assert.equal(lotRows[0].quantity, '5.000');
      assert.equal(lotRows[0].status, 'AVAILABLE');
      fixture.reusableLotId = detail.json.data.lotAllocations[0].inventoryLotId;

      const [postingRows] = await pool.execute(
        `SELECT it.transaction_type AS transactionType,
           CAST(it.branch_id AS CHAR) AS branchId,
           CAST(it.created_by_employee_id AS CHAR) AS employeeId,
           DATE_FORMAT(it.occurred_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS occurredAt,
           DATE_FORMAT(gr.received_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS receivedAt,
           iti.quantity_change AS quantityChange, iti.unit_cost AS unitCost,
           (SELECT COUNT(*) FROM goods_receipt_item_lots
            WHERE goods_receipt_item_id = gri.goods_receipt_item_id) AS receiptLotCount,
           (SELECT quantity_received FROM goods_receipt_item_lots
            WHERE goods_receipt_item_id = gri.goods_receipt_item_id
            LIMIT 1) AS receiptLotQuantity,
           (SELECT COUNT(*) FROM inventory_transaction_lot_allocations
            WHERE inventory_transaction_item_id = iti.inventory_transaction_item_id)
             AS ledgerLotCount,
           (SELECT quantity_change FROM inventory_transaction_lot_allocations
            WHERE inventory_transaction_item_id = iti.inventory_transaction_item_id
            LIMIT 1) AS ledgerLotQuantity,
           (SELECT COUNT(*) FROM audit_logs
            WHERE request_id = ? AND action_type = 'GOODS_RECEIPT_POSTED')
             AS postedAuditCount
         FROM goods_receipts gr
         INNER JOIN goods_receipt_items gri
           ON gri.goods_receipt_id = gr.goods_receipt_id
         INNER JOIN inventory_transactions it
           ON it.inventory_transaction_id = gr.inventory_transaction_id
         INNER JOIN inventory_transaction_items iti
           ON iti.inventory_transaction_id = it.inventory_transaction_id
          AND iti.product_variant_id = gri.product_variant_id
         WHERE gr.goods_receipt_id = ?`,
        [post.requestId, receiptId],
      );
      assert.equal(postingRows.length, 1);
      assert.equal(postingRows[0].transactionType, 'PURCHASE_RECEIPT');
      assert.equal(postingRows[0].branchId, fixture.branchId);
      assert.equal(postingRows[0].employeeId, fixture.employeeId);
      assert.equal(postingRows[0].occurredAt, postingRows[0].receivedAt);
      assert.equal(postingRows[0].quantityChange, '5.000');
      assert.equal(postingRows[0].unitCost, '2.0000');
      assert.equal(Number(postingRows[0].receiptLotCount), 1);
      assert.equal(postingRows[0].receiptLotQuantity, '5.000');
      assert.equal(Number(postingRows[0].ledgerLotCount), 1);
      assert.equal(postingRows[0].ledgerLotQuantity, '5.000');
      assert.equal(Number(postingRows[0].postedAuditCount), 1);
    });

    await t.test('edits draft receipts and reuses existing lot identity safely', async () => {
      const editableOrder = await createApprovedOrder(
        fixture, baseUrl, fixture.optionalVariantId, fixture.packageIds[3], '2.000', 'editable',
      );
      const receipt = await tracked(fixture, baseUrl, 'editable-receipt', grRoot, {
        method: 'POST',
        body: {
          purchaseOrderId: editableOrder.orderId,
          supplierDeliveryNote: `EDIT-${fixture.token}`,
          notes: `${fixture.prefix} editable receipt`,
        },
      });
      assertStatus(receipt, 201);
      const receiptId = receipt.json.data.goodsReceipt.goodsReceiptId;
      const headerPatch = await tracked(fixture, baseUrl, 'editable-header', `${grRoot}/${receiptId}`, {
        method: 'PATCH',
        body: { supplierInvoiceNumber: `INV-${fixture.token}-EDIT` },
      });
      assertStatus(headerPatch, 200);
      const item = await tracked(fixture, baseUrl, 'editable-item', `${grRoot}/${receiptId}/items`, {
        method: 'POST',
        body: {
          purchaseOrderItemId: editableOrder.itemId,
          packageQuantityAccepted: '1.000', packageQuantityRejected: '1.000',
          actualUnitCost: '2.0000',
        },
      });
      assertStatus(item, 201);
      const itemId = item.json.data.item.goodsReceiptItemId;
      const itemPatch = await tracked(fixture, baseUrl, 'editable-item-patch', `${grRoot}/${receiptId}/items/${itemId}`, {
        method: 'PATCH',
        body: {
          packageQuantityAccepted: '2.000', packageQuantityRejected: '0.000',
          actualUnitCost: '2.5000', discountAmount: '1.00', taxAmount: '0.50',
        },
      });
      assertStatus(itemPatch, 200);
      assert.equal(itemPatch.json.data.item.lineTotal, '4.50');
      assertStatus(await tracked(fixture, baseUrl, 'editable-item-delete', `${grRoot}/${receiptId}/items/${itemId}`, {
        method: 'DELETE',
      }), 200);
      assertStatus(await tracked(fixture, baseUrl, 'editable-receipt-cancel', `${grRoot}/${receiptId}/cancel`, {
        method: 'POST', body: {},
      }), 200);
      assertStatus(await tracked(fixture, baseUrl, 'editable-order-cancel', `${poRoot}/${editableOrder.orderId}/cancel`, {
        method: 'POST', body: {},
      }), 200);

      const reuseOrder = await createApprovedOrder(
        fixture, baseUrl, fixture.requiredVariantId, fixture.packageIds[1], '2.000', 'reuse',
      );
      const reuseReceipt = await tracked(fixture, baseUrl, 'reuse-receipt', grRoot, {
        method: 'POST', body: { purchaseOrderId: reuseOrder.orderId, notes: `${fixture.prefix} reuse receipt` },
      });
      assertStatus(reuseReceipt, 201);
      const reuseReceiptId = reuseReceipt.json.data.goodsReceipt.goodsReceiptId;
      const reuseItem = await tracked(fixture, baseUrl, 'reuse-item', `${grRoot}/${reuseReceiptId}/items`, {
        method: 'POST',
        body: {
          purchaseOrderItemId: reuseOrder.itemId,
          packageQuantityAccepted: '2.000', packageQuantityRejected: '0.000',
          actualUnitCost: '2.0000',
        },
      });
      assertStatus(reuseItem, 201);
      assertSafeError(await send(baseUrl, `${grRoot}/${reuseReceiptId}/post`, {
        method: 'POST', token: fixture.tokens.admin,
        body: {
          lotAllocations: [{
            goodsReceiptItemId: reuseItem.json.data.item.goodsReceiptItemId,
            lots: [{
              lotNumber: `${fixture.prefix}-LOT-A`,
              manufacturedOn: '2026-09-01', expiresOn: '2028-09-01',
              quantityReceived: '2.000',
            }],
          }],
        },
      }), 409);
      const reusePost = await tracked(fixture, baseUrl, 'reuse-post', `${grRoot}/${reuseReceiptId}/post`, {
        method: 'POST',
        body: {
          lotAllocations: [{
            goodsReceiptItemId: reuseItem.json.data.item.goodsReceiptItemId,
            lots: [{ inventoryLotId: fixture.reusableLotId, quantityReceived: '2.000' }],
          }],
        },
      });
      assertStatus(reusePost, 200);
      const [lotRows] = await pool.execute(
        `SELECT quantity_on_hand AS quantity FROM branch_lot_inventory
         WHERE branch_id = ? AND inventory_lot_id = ?`,
        [fixture.branchId, fixture.reusableLotId],
      );
      assert.equal(lotRows[0].quantity, '7.000');
    });

    await t.test('serializes competing receipt posts and never over-receives', async () => {
      const order = await createApprovedOrder(
        fixture, baseUrl, fixture.raceVariantId, fixture.packageIds[2], '1.000', 'race',
      );
      const receiptIds = [];
      for (const suffix of ['a', 'b']) {
        const receipt = await tracked(fixture, baseUrl, `race-receipt-${suffix}`, grRoot, {
          method: 'POST', body: { purchaseOrderId: order.orderId, notes: `${fixture.prefix} race ${suffix}` },
        });
        assertStatus(receipt, 201);
        const receiptId = receipt.json.data.goodsReceipt.goodsReceiptId;
        receiptIds.push(receiptId);
        assertStatus(await tracked(fixture, baseUrl, `race-item-${suffix}`, `${grRoot}/${receiptId}/items`, {
          method: 'POST',
          body: {
            purchaseOrderItemId: order.itemId,
            packageQuantityAccepted: '1.000', packageQuantityRejected: '0.000',
            actualUnitCost: '2.0000',
          },
        }), 201);
      }
      const results = await Promise.all(
        receiptIds.map((receiptId) => send(baseUrl, `${grRoot}/${receiptId}/post`, {
          method: 'POST', token: fixture.tokens.admin, body: {},
        })),
      );
      assert.deepEqual(results.map((result) => result.response.status).sort(), [200, 409]);
      const [stockRows] = await pool.execute(
        `SELECT quantity_on_hand AS quantity FROM branch_inventory
         WHERE branch_id = ? AND product_variant_id = ?`,
        [fixture.branchId, fixture.raceVariantId],
      );
      assert.equal(stockRows[0].quantity, '1.000');
      const receivedOrder = await send(baseUrl, `${poRoot}/${order.orderId}`, {
        token: fixture.tokens.admin,
      });
      assertStatus(receivedOrder, 200);
      assert.equal(receivedOrder.json.data.purchaseOrder.status, 'RECEIVED');
      assertSafeError(await send(baseUrl, grRoot, {
        method: 'POST', token: fixture.tokens.admin,
        body: {
          purchaseOrderId: order.orderId,
          notes: `${fixture.prefix} fully received source-state receipt`,
        },
      }), 409);
    });

    await t.test('serializes lifecycle changes and cross-phase package history', async () => {
      const create = await tracked(fixture, baseUrl, 'lifecycle-po', poRoot, {
        method: 'POST',
        body: { supplierId: fixture.supplierId, notes: `${fixture.prefix} lifecycle race` },
      });
      assertStatus(create, 201);
      const orderId = create.json.data.purchaseOrder.purchaseOrderId;
      const line = await tracked(fixture, baseUrl, 'lifecycle-line', `${poRoot}/${orderId}/items`, {
        method: 'POST',
        body: {
          productVariantId: fixture.noneVariantId,
          productPackageId: fixture.packageIds[0],
          orderedPackageQuantity: '2.000', unitCost: '2.0000',
        },
      });
      assertStatus(line, 201);
      const itemId = line.json.data.item.purchaseOrderItemId;
      const [submit, patch] = await Promise.all([
        send(baseUrl, `${poRoot}/${orderId}/submit`, {
          method: 'POST', token: fixture.tokens.admin, body: {},
        }),
        send(baseUrl, `${poRoot}/${orderId}/items/${itemId}`, {
          method: 'PATCH', token: fixture.tokens.admin,
          body: { orderedPackageQuantity: '3.000', unitCost: '3.0000' },
        }),
      ]);
      assertStatus(submit, 200);
      assert.equal([200, 409].includes(patch.response.status), true, patch.text);
      const submitted = await send(baseUrl, `${poRoot}/${orderId}`, {
        token: fixture.tokens.admin,
      });
      assertStatus(submitted, 200);
      assert.equal(submitted.json.data.purchaseOrder.status, 'SUBMITTED');
      assert.equal(
        ['2.000', '3.000'].includes(submitted.json.data.items[0].orderedPackageQuantity),
        true,
      );

      const [approve, cancel] = await Promise.all([
        send(baseUrl, `${poRoot}/${orderId}/approve`, {
          method: 'POST', token: fixture.tokens.admin, body: {},
        }),
        send(baseUrl, `${poRoot}/${orderId}/cancel`, {
          method: 'POST', token: fixture.tokens.admin, body: { reason: 'Concurrent lifecycle test' },
        }),
      ]);
      assert.equal([200, 409].includes(approve.response.status), true, approve.text);
      assert.equal([200, 409].includes(cancel.response.status), true, cancel.text);
      assert.equal(
        [approve.response.status, cancel.response.status].includes(200),
        true,
      );
      const lifecycleFinal = await send(baseUrl, `${poRoot}/${orderId}`, {
        token: fixture.tokens.admin,
      });
      assertStatus(lifecycleFinal, 200);
      assert.equal(
        ['APPROVED', 'CANCELLED'].includes(lifecycleFinal.json.data.purchaseOrder.status),
        true,
      );

      const crossCreate = await tracked(fixture, baseUrl, 'cross-po', poRoot, {
        method: 'POST',
        body: { supplierId: fixture.supplierId, notes: `${fixture.prefix} cross-phase race` },
      });
      assertStatus(crossCreate, 201);
      const crossOrderId = crossCreate.json.data.purchaseOrder.purchaseOrderId;
      const [lineCreate, packagePatch] = await Promise.all([
        send(baseUrl, `${poRoot}/${crossOrderId}/items`, {
          method: 'POST', token: fixture.tokens.admin,
          body: {
            productVariantId: fixture.crossVariantId,
            productPackageId: fixture.crossPackageId,
            orderedPackageQuantity: '1.000', unitCost: '2.0000',
          },
        }),
        send(baseUrl, `/api/admin/catalog/packages/${fixture.crossPackageId}`, {
          method: 'PATCH', token: fixture.tokens.admin,
          body: { conversionToBaseQuantity: '8.000000' },
        }),
      ]);
      assertStatus(lineCreate, 201);
      assert.equal([200, 409].includes(packagePatch.response.status), true, packagePatch.text);
      const crossDetail = await send(baseUrl, `${poRoot}/${crossOrderId}`, {
        token: fixture.tokens.admin,
      });
      assertStatus(crossDetail, 200);
      assert.equal(
        crossDetail.json.data.items[0].packageConversionFactor,
        packagePatch.response.status === 200 ? '8.000000' : '6.000000',
      );
      assertStatus(await tracked(
        fixture, baseUrl, 'cross-cancel', `${poRoot}/${crossOrderId}/cancel`,
        { method: 'POST', body: {} },
      ), 200);
    });

    await t.test('prevents duplicate posts and preserves concurrent stock increments', async () => {
      const duplicateOrder = await createApprovedOrder(
        fixture, baseUrl, fixture.noneVariantId, fixture.packageIds[0], '2.000', 'duplicate-post',
      );
      const duplicateReceipt = await tracked(fixture, baseUrl, 'duplicate-receipt', grRoot, {
        method: 'POST', body: { purchaseOrderId: duplicateOrder.orderId, notes: `${fixture.prefix} duplicate post` },
      });
      assertStatus(duplicateReceipt, 201);
      const duplicateReceiptId = duplicateReceipt.json.data.goodsReceipt.goodsReceiptId;
      assertStatus(await tracked(fixture, baseUrl, 'duplicate-item', `${grRoot}/${duplicateReceiptId}/items`, {
        method: 'POST',
        body: {
          purchaseOrderItemId: duplicateOrder.itemId,
          packageQuantityAccepted: '2.000', packageQuantityRejected: '0.000',
          actualUnitCost: '2.0000',
        },
      }), 201);
      const beforeDuplicate = await branchQuantity(fixture.branchId, fixture.noneVariantId);
      const duplicatePosts = await Promise.all([1, 2].map(() => send(
        baseUrl, `${grRoot}/${duplicateReceiptId}/post`,
        { method: 'POST', token: fixture.tokens.admin, body: {} },
      )));
      assert.deepEqual(
        duplicatePosts.map((result) => result.response.status).sort(),
        [200, 409],
      );
      const afterDuplicate = await branchQuantity(fixture.branchId, fixture.noneVariantId);
      assert.equal(quantityScaled(afterDuplicate) - quantityScaled(beforeDuplicate), 2_000n);
      const [duplicateLedgers] = await pool.execute(
        `SELECT COUNT(*) AS count FROM inventory_transactions it
         INNER JOIN goods_receipts gr
           ON gr.inventory_transaction_id = it.inventory_transaction_id
         WHERE gr.goods_receipt_id = ?`,
        [duplicateReceiptId],
      );
      assert.equal(Number(duplicateLedgers[0].count), 1);

      const independent = [];
      for (const [label, quantity] of [['independent-a', '2.000'], ['independent-b', '3.000']]) {
        const order = await createApprovedOrder(
          fixture, baseUrl, fixture.crossVariantId, fixture.packageIds[4], quantity, label,
        );
        const receipt = await tracked(fixture, baseUrl, `${label}-receipt`, grRoot, {
          method: 'POST', body: { purchaseOrderId: order.orderId, notes: `${fixture.prefix} ${label}` },
        });
        assertStatus(receipt, 201);
        const receiptId = receipt.json.data.goodsReceipt.goodsReceiptId;
        assertStatus(await tracked(fixture, baseUrl, `${label}-item`, `${grRoot}/${receiptId}/items`, {
          method: 'POST',
          body: {
            purchaseOrderItemId: order.itemId,
            packageQuantityAccepted: quantity, packageQuantityRejected: '0.000',
            actualUnitCost: '2.0000',
          },
        }), 201);
        independent.push(receiptId);
      }
      const beforeIndependent = await branchQuantity(fixture.branchId, fixture.crossVariantId);
      const independentPosts = await Promise.all(independent.map((receiptId) => send(
        baseUrl, `${grRoot}/${receiptId}/post`,
        { method: 'POST', token: fixture.tokens.admin, body: {} },
      )));
      for (const result of independentPosts) assertStatus(result, 200);
      const afterIndependent = await branchQuantity(fixture.branchId, fixture.crossVariantId);
      assert.equal(quantityScaled(afterIndependent) - quantityScaled(beforeIndependent), 5_000n);

      const patchOrder = await createApprovedOrder(
        fixture, baseUrl, fixture.optionalVariantId, fixture.packageIds[3], '4.000', 'post-patch',
      );
      const patchReceipt = await tracked(fixture, baseUrl, 'post-patch-receipt', grRoot, {
        method: 'POST', body: { purchaseOrderId: patchOrder.orderId, notes: `${fixture.prefix} post patch` },
      });
      assertStatus(patchReceipt, 201);
      const patchReceiptId = patchReceipt.json.data.goodsReceipt.goodsReceiptId;
      const patchItem = await tracked(fixture, baseUrl, 'post-patch-item', `${grRoot}/${patchReceiptId}/items`, {
        method: 'POST',
        body: {
          purchaseOrderItemId: patchOrder.itemId,
          packageQuantityAccepted: '2.000', packageQuantityRejected: '0.000',
          actualUnitCost: '2.0000',
        },
      });
      assertStatus(patchItem, 201);
      const patchItemId = patchItem.json.data.item.goodsReceiptItemId;
      const beforePatchPost = await branchQuantity(fixture.branchId, fixture.optionalVariantId);
      const [postResult, patchResult] = await Promise.all([
        send(baseUrl, `${grRoot}/${patchReceiptId}/post`, {
          method: 'POST', token: fixture.tokens.admin, body: {},
        }),
        send(baseUrl, `${grRoot}/${patchReceiptId}/items/${patchItemId}`, {
          method: 'PATCH', token: fixture.tokens.admin,
          body: { packageQuantityAccepted: '3.000' },
        }),
      ]);
      assertStatus(postResult, 200);
      assert.equal([200, 409].includes(patchResult.response.status), true, patchResult.text);
      const patchDetail = await send(baseUrl, `${grRoot}/${patchReceiptId}`, {
        token: fixture.tokens.admin,
      });
      assertStatus(patchDetail, 200);
      assert.equal(patchDetail.json.data.goodsReceipt.status, 'POSTED');
      assert.equal(patchDetail.json.data.lotAllocations.length, 0);
      const afterPatchPost = await branchQuantity(fixture.branchId, fixture.optionalVariantId);
      assert.equal(
        quantityScaled(afterPatchPost) - quantityScaled(beforePatchPost),
        quantityScaled(patchDetail.json.data.items[0].quantityAccepted),
      );
    });

    await t.test('serializes same-lot creation across independent receipts', async () => {
      const receiptEntries = [];
      for (const label of ['lot-race-a', 'lot-race-b']) {
        const order = await createApprovedOrder(
          fixture, baseUrl, fixture.optionalVariantId, fixture.packageIds[3], '1.000', label,
        );
        const receipt = await tracked(fixture, baseUrl, `${label}-receipt`, grRoot, {
          method: 'POST', body: { purchaseOrderId: order.orderId, notes: `${fixture.prefix} ${label}` },
        });
        assertStatus(receipt, 201);
        const receiptId = receipt.json.data.goodsReceipt.goodsReceiptId;
        const item = await tracked(fixture, baseUrl, `${label}-item`, `${grRoot}/${receiptId}/items`, {
          method: 'POST',
          body: {
            purchaseOrderItemId: order.itemId,
            packageQuantityAccepted: '1.000', packageQuantityRejected: '0.000',
            actualUnitCost: '2.0000',
          },
        });
        assertStatus(item, 201);
        receiptEntries.push({
          receiptId,
          goodsReceiptItemId: item.json.data.item.goodsReceiptItemId,
        });
      }
      const lotNumber = `${fixture.prefix}-LOT-RACE`;
      const posts = await Promise.all(receiptEntries.map((entry) => send(
        baseUrl, `${grRoot}/${entry.receiptId}/post`,
        {
          method: 'POST', token: fixture.tokens.admin,
          body: {
            lotAllocations: [{
              goodsReceiptItemId: entry.goodsReceiptItemId,
              lots: [{ lotNumber, quantityReceived: '1.000' }],
            }],
          },
        },
      )));
      for (const result of posts) assertStatus(result, 200);
      const [lotRows] = await pool.execute(
        `SELECT CAST(il.inventory_lot_id AS CHAR) AS inventoryLotId,
           bli.quantity_on_hand AS quantity
         FROM inventory_lots il
         INNER JOIN branch_lot_inventory bli
           ON bli.inventory_lot_id = il.inventory_lot_id
         WHERE il.product_variant_id = ? AND BINARY il.lot_number = BINARY ?
           AND bli.branch_id = ?`,
        [fixture.optionalVariantId, lotNumber, fixture.branchId],
      );
      assert.equal(lotRows.length, 1);
      assert.equal(lotRows[0].quantity, '2.000');

      const caseOrder = await createApprovedOrder(
        fixture, baseUrl, fixture.optionalVariantId, fixture.packageIds[3],
        '2.000', 'lot-case',
      );
      const caseReceipt = await tracked(fixture, baseUrl, 'lot-case-receipt', grRoot, {
        method: 'POST',
        body: {
          purchaseOrderId: caseOrder.orderId,
          notes: `${fixture.prefix} exact lot case`,
        },
      });
      assertStatus(caseReceipt, 201);
      const caseReceiptId = caseReceipt.json.data.goodsReceipt.goodsReceiptId;
      const caseItem = await tracked(
        fixture, baseUrl, 'lot-case-item', `${grRoot}/${caseReceiptId}/items`,
        {
          method: 'POST',
          body: {
            purchaseOrderItemId: caseOrder.itemId,
            packageQuantityAccepted: '2.000',
            packageQuantityRejected: '0.000',
            actualUnitCost: '2.0000',
          },
        },
      );
      assertStatus(caseItem, 201);
      const lowerCaseLotNumber = lotNumber.toLowerCase();
      assertSafeError(await send(baseUrl, `${grRoot}/${caseReceiptId}/post`, {
        method: 'POST', token: fixture.tokens.admin,
        body: {
          lotAllocations: [{
            goodsReceiptItemId: caseItem.json.data.item.goodsReceiptItemId,
            lots: [{ lotNumber: lowerCaseLotNumber, quantityReceived: '1.000' }],
          }],
        },
      }), 409);
      assertStatus(await tracked(
        fixture, baseUrl, 'lot-case-post', `${grRoot}/${caseReceiptId}/post`,
        {
          method: 'POST',
          body: {
            lotAllocations: [{
              goodsReceiptItemId: caseItem.json.data.item.goodsReceiptItemId,
              lots: [{ lotNumber: lowerCaseLotNumber, quantityReceived: '2.000' }],
            }],
          },
        },
      ), 200);
      const [caseRows] = await pool.execute(
        `SELECT lot_number AS lotNumber FROM inventory_lots
         WHERE product_variant_id = ?
           AND (
             BINARY lot_number = BINARY ?
             OR BINARY lot_number = BINARY ?
           )
         ORDER BY BINARY lot_number`,
        [fixture.optionalVariantId, lotNumber, lowerCaseLotNumber],
      );
      assert.equal(caseRows.length, 2);
      assert.deepEqual(
        new Set(caseRows.map((row) => row.lotNumber)),
        new Set([lotNumber, lowerCaseLotNumber]),
      );
    });

    await t.test('supports draft cancellation without inventory mutation', async () => {
      const order = await createApprovedOrder(
        fixture, baseUrl, fixture.noneVariantId, fixture.packageIds[0], '2.000', 'cancel',
      );
      const receipt = await tracked(fixture, baseUrl, 'cancel-receipt', grRoot, {
        method: 'POST', body: { purchaseOrderId: order.orderId, notes: `${fixture.prefix} cancelled receipt` },
      });
      assertStatus(receipt, 201);
      const receiptId = receipt.json.data.goodsReceipt.goodsReceiptId;
      const beforeCancel = await branchQuantity(
        fixture.branchId, fixture.noneVariantId,
      );
      const cancelled = await tracked(fixture, baseUrl, 'cancel-receipt-action', `${grRoot}/${receiptId}/cancel`, {
        method: 'POST', body: {},
      });
      assertStatus(cancelled, 200);
      assert.equal(cancelled.json.data.goodsReceipt.status, 'CANCELLED');
      const afterCancel = await branchQuantity(
        fixture.branchId, fixture.noneVariantId,
      );
      assert.equal(afterCancel, beforeCancel);
      const orderCancel = await tracked(fixture, baseUrl, 'cancel-order-action', `${poRoot}/${order.orderId}/cancel`, {
        method: 'POST', body: { reason: 'Supplier could not fulfil' },
      });
      assertStatus(orderCancel, 200);
      assert.equal(orderCancel.json.data.purchaseOrder.status, 'CANCELLED');
    });

    await t.test('writes only committed audit actions and exposes no inventory API', async () => {
      const [noOpRows] = await pool.execute(
        'SELECT COUNT(*) AS count FROM audit_logs WHERE request_id IN (?, ?, ?)',
        [
          fixture.noOpRequestId,
          fixture.receiptNoOpRequestId,
          fixture.failedPostRequestId,
        ],
      );
      assert.equal(Number(noOpRows[0].count), 0);
      const [auditRows] = await pool.execute(
        `SELECT action_type AS actionType FROM audit_logs
         WHERE request_id LIKE ? ORDER BY audit_log_id`,
        [`${fixture.prefix}%`],
      );
      const actions = new Set(auditRows.map((row) => row.actionType));
      for (const action of [
        'PURCHASE_ORDER_CREATED', 'PURCHASE_ORDER_UPDATED',
        'PURCHASE_ORDER_ITEM_CREATED', 'PURCHASE_ORDER_ITEM_UPDATED',
        'PURCHASE_ORDER_ITEM_DELETED', 'PURCHASE_ORDER_SUBMITTED',
        'PURCHASE_ORDER_APPROVED', 'PURCHASE_ORDER_CANCELLED',
        'GOODS_RECEIPT_CREATED', 'GOODS_RECEIPT_UPDATED',
        'GOODS_RECEIPT_ITEM_CREATED', 'GOODS_RECEIPT_ITEM_UPDATED',
        'GOODS_RECEIPT_ITEM_DELETED', 'GOODS_RECEIPT_POSTED',
        'GOODS_RECEIPT_CANCELLED',
      ]) assert.equal(actions.has(action), true, action);

      const [sellingPriceChanges] = await pool.execute(
        `SELECT
           (SELECT COUNT(*) FROM product_variants
            WHERE product_variant_id IN (${placeholders(fixture.variantIds)})
              AND default_selling_price <> '10.0000') +
           (SELECT COUNT(*) FROM product_packages
            WHERE product_package_id IN (${placeholders(fixture.packageIds)})
              AND default_selling_price IS NOT NULL) +
           (SELECT COUNT(*) FROM branch_variant_prices
            WHERE branch_id = ? AND product_variant_id IN (${placeholders(fixture.variantIds)})) +
           (SELECT COUNT(*) FROM branch_package_prices
            WHERE branch_id = ? AND product_package_id IN (${placeholders(fixture.packageIds)}))
           AS count`,
        [
          ...fixture.variantIds, ...fixture.packageIds,
          fixture.branchId, ...fixture.variantIds,
          fixture.branchId, ...fixture.packageIds,
        ],
      );
      assert.equal(Number(sellingPriceChanges[0].count), 0);
      const [supplierConfigChanges] = await pool.execute(
        `SELECT
           (SELECT COUNT(*) FROM supplier_products
            WHERE supplier_id = ?
              AND (minimum_order_quantity <> '1.000' OR is_preferred <> 0)) +
           (SELECT COUNT(*) FROM supplier_product_packages
            WHERE supplier_id = ?
              AND (minimum_package_quantity <> '1.000' OR is_active <> 1))
           AS count`,
        [fixture.supplierId, fixture.supplierId],
      );
      assert.equal(Number(supplierConfigChanges[0].count), 0);
      assertStatus(await send(baseUrl, '/api/admin/inventory', {
        token: fixture.tokens.admin,
      }), 404);
    });
  } finally {
    await stopServer(server);
    await cleanupFixture(fixture);
    const [remainingRows] = await pool.execute(
      `SELECT (
         (SELECT COUNT(*) FROM branches WHERE branch_code LIKE 'P7%') +
         (SELECT COUNT(*) FROM users WHERE username LIKE 'p7.%') +
         (SELECT COUNT(*) FROM suppliers WHERE supplier_code LIKE 'P7S_%') +
         (SELECT COUNT(*) FROM products WHERE product_code LIKE 'P7P_%') +
         (SELECT COUNT(*) FROM inventory_lots WHERE lot_number LIKE 'TEST_P7_%')
       ) AS count`,
    );
    assert.equal(Number(remainingRows[0].count), 0);
    await pool.end();
  }
});
