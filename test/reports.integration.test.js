import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const [{ default: app }, { pool }, access, seed, jwt, dates] = await Promise.all([
  import('../src/app.js'),
  import('../src/config/database.js'),
  import('../src/config/accessControl.js'),
  import('../src/repositories/accessControlSeed.repository.js'),
  import('../src/utils/jwt.js'),
  import('../src/utils/reportDateRange.js'),
]);

const { ACCESS_CONTROL_PERMISSIONS, SYSTEM_ADMIN_ROLE } = access;
const { ensureAccessControl } = seed;
const { signAccessToken } = jwt;
const { currentLocalDate, shiftDate } = dates;
const TEST_TIMEOUT_MS = 600_000;

function fixtureDefinition() {
  const token = randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
  return { token, prefix: `TEST_P15_${token}`, requestCount: 0 };
}

async function lastId(connection) {
  const [rows] = await connection.execute('SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id');
  return rows[0].id;
}

async function insertTransaction(connection, fixture, branchId, employeeId, suffix, type, occurredAt, items) {
  await connection.execute(
    `INSERT INTO inventory_transactions (
       branch_id, transaction_number, transaction_type, occurred_at,
       created_by_employee_id, notes
     ) VALUES (?, ?, ?, ?, ?, ?)`,
    [branchId, `P15TX_${suffix}_${fixture.token}`, type, occurredAt, employeeId, fixture.prefix],
  );
  const id = await lastId(connection);
  let line = 1;
  for (const item of items) {
    await connection.execute(
      `INSERT INTO inventory_transaction_items (
         inventory_transaction_id, line_number, product_variant_id, quantity_change, unit_cost
       ) VALUES (?, ?, ?, ?, ?)`,
      [id, line, item.variantId, item.quantity, item.unitCost],
    );
    line += 1;
  }
  return id;
}

async function createFixture(fixture) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const seeded = await ensureAccessControl(connection);
    assert.equal(seeded.permissionCount, 45);
    assert.equal(seeded.assignedPermissionCount, 45);
    assert.equal(ACCESS_CONTROL_PERMISSIONS.length, 45);

    fixture.branchIds = [];
    for (const branch of [
      ['A', 'NGN', 'Africa/Lagos'],
      ['B', 'GBP', 'America/New_York'],
    ]) {
      await connection.execute(
        `INSERT INTO branches (
           branch_code, branch_name, address_line_1, city,
           country_code, currency_code, timezone, status
         ) VALUES (?, ?, 'Phase 15 Street', 'Test City', 'NG', ?, ?, 'ACTIVE')`,
        [`P15${branch[0]}_${fixture.token}`, `${fixture.prefix} Branch ${branch[0]}`, branch[1], branch[2]],
      );
      fixture.branchIds.push(await lastId(connection));
    }
    [fixture.branchAId, fixture.branchBId] = fixture.branchIds;

    fixture.employeeIds = [];
    for (const [suffix, branchId] of [['A', fixture.branchAId], ['B', fixture.branchBId]]) {
      await connection.execute(
        `INSERT INTO employees (
           employee_number, first_name, last_name, hire_date, employment_status
         ) VALUES (?, 'Phase15', ?, '2020-01-01', 'ACTIVE')`,
        [`P15E${suffix}_${fixture.token}`, `Employee${suffix}`],
      );
      const employeeId = await lastId(connection);
      fixture.employeeIds.push(employeeId);
      await connection.execute(
        `INSERT INTO employee_branch_assignments (
           employee_id, branch_id, job_title, started_on, is_primary
         ) VALUES (?, ?, 'Phase 15 Test', '2020-01-01', 0)`,
        [employeeId, branchId],
      );
    }
    [fixture.employeeAId, fixture.employeeBId] = fixture.employeeIds;

    const [permissionRows] = await connection.execute(
      `SELECT CAST(permission_id AS CHAR) AS id FROM permissions
       WHERE permission_code = 'reports.read'`,
    );
    fixture.roleIds = [];
    for (const suffix of ['GLOBAL', 'SCOPED', 'NONE', 'LINKED']) {
      await connection.execute(
        `INSERT INTO roles (role_code, role_name, description, is_active)
         VALUES (?, ?, 'Temporary Phase 15 role', 1)`,
        [`P15_${suffix}_${fixture.token}`, `${fixture.prefix} ${suffix}`],
      );
      const roleId = await lastId(connection);
      fixture.roleIds.push(roleId);
      fixture[`role${suffix}`] = roleId;
      if (suffix !== 'NONE') {
        await connection.execute(
          'INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
          [roleId, permissionRows[0].id],
        );
      }
    }

    fixture.userIds = [];
    fixture.tokens = {};
    const users = [
      ['global', null, fixture.roleGLOBAL, null],
      ['scoped', null, fixture.roleSCOPED, fixture.branchAId],
      ['none', null, fixture.roleNONE, null],
      ['linked', fixture.employeeAId, fixture.roleLINKED, null],
    ];
    for (const [name, employeeId, roleId, branchId] of users) {
      await connection.execute(
        `INSERT INTO users (
           employee_id, username, email, password_hash, is_active, must_change_password
         ) VALUES (?, ?, ?, 'TEST_P15_HASH', 1, 0)`,
        [employeeId, `p15.${name}.${fixture.token.toLowerCase()}`,
          `p15.${name}.${fixture.token.toLowerCase()}@example.invalid`],
      );
      const userId = await lastId(connection);
      fixture.userIds.push(userId);
      await connection.execute(
        'INSERT INTO user_roles (user_id, role_id, branch_id) VALUES (?, ?, ?)',
        [userId, roleId, branchId],
      );
      fixture.tokens[name] = signAccessToken(userId).accessToken;
    }

    await connection.execute(
      `INSERT INTO pos_registers (branch_id, register_code, register_name, status)
       VALUES (?, ?, ?, 'ACTIVE')`,
      [fixture.branchAId, `P15REG_${fixture.token}`, `${fixture.prefix} Register`],
    );
    fixture.registerId = await lastId(connection);
    await connection.execute(
      `INSERT INTO till_sessions (
         session_number, branch_id, pos_register_id, cashier_employee_id,
         opened_by_employee_id, status, opened_at, currency_code,
         opening_cash_amount, notes
       ) VALUES (?, ?, ?, ?, ?, 'OPEN', '2026-06-01 23:00:00', 'NGN', 100.00, ?)`,
      [`P15TS_${fixture.token}`, fixture.branchAId, fixture.registerId,
        fixture.employeeAId, fixture.employeeAId, fixture.prefix],
    );
    fixture.tillId = await lastId(connection);

    await connection.execute(
      'INSERT INTO categories (category_code, category_name, is_active) VALUES (?, ?, 1)',
      [`P15CAT_${fixture.token}`, `${fixture.prefix} Category`],
    );
    fixture.categoryId = await lastId(connection);
    fixture.unitIds = [];
    for (const [code, name, symbol] of [
      [`P15EACH_${fixture.token}`, `${fixture.prefix} Each`, 'ea'],
      [`P15KG_${fixture.token}`, `${fixture.prefix} Kilogram`, 'kg'],
    ]) {
      await connection.execute(
        `INSERT INTO units_of_measure (unit_code, unit_name, symbol, allows_fraction)
         VALUES (?, ?, ?, 1)`,
        [code, name, symbol],
      );
      fixture.unitIds.push(await lastId(connection));
    }
    [fixture.unitId, fixture.kgUnitId] = fixture.unitIds;
    await connection.execute(
      `INSERT INTO products (category_id, product_code, product_name, status)
       VALUES (?, ?, ?, 'ACTIVE')`,
      [fixture.categoryId, `P15P_${fixture.token}`, `${fixture.prefix} Product`],
    );
    fixture.productId = await lastId(connection);
    fixture.variantIds = [];
    for (const [suffix, name, tracking] of [
      ['COST', 'Costed', 'OPTIONAL'], ['LEGACY', 'Legacy', 'NONE'], ['NOCOST', 'No Cost', 'NONE'],
    ]) {
      await connection.execute(
        `INSERT INTO product_variants (
           product_id, unit_of_measure_id, sku, variant_name,
           is_fractional, lot_tracking_mode, requires_expiry_date,
           default_selling_price, status
         ) VALUES (?, ?, ?, ?, 1, ?, ?, 10.0000, 'ACTIVE')`,
        [fixture.productId, suffix === 'LEGACY' ? fixture.kgUnitId : fixture.unitId,
          `P15${suffix}_${fixture.token}`,
          `${fixture.prefix} ${name}`, tracking, tracking === 'OPTIONAL' ? 1 : 0],
      );
      fixture.variantIds.push(await lastId(connection));
    }
    [fixture.costedVariantId, fixture.legacyVariantId, fixture.noCostVariantId] = fixture.variantIds;

    await connection.execute(
      `INSERT INTO customers (
         customer_number, customer_type, first_name, last_name, status
       ) VALUES (?, 'INDIVIDUAL', 'Phase', 'Fifteen', 'ACTIVE')`,
      [`P15CUS_${fixture.token}`],
    );
    fixture.customerId = await lastId(connection);
    await connection.execute(
      `INSERT INTO suppliers (supplier_code, supplier_name, status)
       VALUES (?, ?, 'ACTIVE')`,
      [`P15SUP_${fixture.token}`, `${fixture.prefix} Supplier`],
    );
    fixture.supplierId = await lastId(connection);
    fixture.paymentMethodIds = [];
    for (const [suffix, type] of [['CASH', 'CASH'], ['CARD', 'CARD']]) {
      await connection.execute(
        `INSERT INTO payment_methods (
           method_code, method_name, method_type, requires_reference, is_active
         ) VALUES (?, ?, ?, 0, 1)`,
        [`P15${suffix}_${fixture.token}`, `${fixture.prefix} ${suffix}`, type],
      );
      fixture.paymentMethodIds.push(await lastId(connection));
    }
    [fixture.cashMethodId, fixture.cardMethodId] = fixture.paymentMethodIds;

    const receiptTx = await insertTransaction(
      connection, fixture, fixture.branchAId, fixture.employeeAId,
      'RECEIPT', 'PURCHASE_RECEIPT', '2026-06-01 12:00:00', [
        { variantId: fixture.costedVariantId, quantity: '10.000', unitCost: '2.0000' },
        { variantId: fixture.legacyVariantId, quantity: '2.500', unitCost: null },
      ],
    );
    const sale1Tx = await insertTransaction(
      connection, fixture, fixture.branchAId, fixture.employeeAId,
      'SALE1', 'SALE', '2026-06-01 23:30:00', [
        { variantId: fixture.costedVariantId, quantity: '-2.000', unitCost: '2.0000' },
        { variantId: fixture.legacyVariantId, quantity: '-2.500', unitCost: null },
      ],
    );
    const sale2Tx = await insertTransaction(
      connection, fixture, fixture.branchAId, fixture.employeeAId,
      'SALE2', 'SALE', '2026-06-01 23:40:00', [
        { variantId: fixture.costedVariantId, quantity: '-1.000', unitCost: '2.0000' },
      ],
    );
    const returnTx = await insertTransaction(
      connection, fixture, fixture.branchAId, fixture.employeeAId,
      'RETURN', 'CUSTOMER_RETURN', '2026-06-02 23:30:00', [
        { variantId: fixture.costedVariantId, quantity: '1.000', unitCost: '2.0000' },
      ],
    );
    await insertTransaction(
      connection, fixture, fixture.branchAId, fixture.employeeAId,
      'NOCOST', 'ADJUSTMENT', '2026-06-02 12:00:00', [
        { variantId: fixture.noCostVariantId, quantity: '1.000', unitCost: null },
      ],
    );
    const bOpenTx = await insertTransaction(
      connection, fixture, fixture.branchBId, fixture.employeeBId,
      'BOPEN', 'OPENING_BALANCE', '2026-03-07 12:00:00', [
        { variantId: fixture.costedVariantId, quantity: '1.000', unitCost: '2.0000' },
      ],
    );
    const bSaleTx = await insertTransaction(
      connection, fixture, fixture.branchBId, fixture.employeeBId,
      'BSALE', 'SALE', '2026-03-08 04:30:00', [
        { variantId: fixture.costedVariantId, quantity: '-1.000', unitCost: '2.0000' },
      ],
    );
    fixture.transactionIds = [receiptTx, sale1Tx, sale2Tx, returnTx, bOpenTx, bSaleTx];

    for (const [branchId, variantId, quantity, reorder] of [
      [fixture.branchAId, fixture.costedVariantId, '8.000', '10.000'],
      [fixture.branchAId, fixture.legacyVariantId, '0.000', '0.000'],
      [fixture.branchAId, fixture.noCostVariantId, '1.000', '0.000'],
      [fixture.branchBId, fixture.costedVariantId, '0.000', '0.000'],
    ]) {
      await connection.execute(
        `INSERT INTO branch_inventory (
           branch_id, product_variant_id, quantity_on_hand, reorder_level, reorder_quantity
         ) VALUES (?, ?, ?, ?, '5.000')`,
        [branchId, variantId, quantity, reorder],
      );
    }
    await connection.execute(
      `INSERT INTO inventory_lots (
         product_variant_id, lot_number, expires_on, status, created_by_employee_id
       ) VALUES (?, ?, ?, 'ACTIVE', ?)`,
      [fixture.costedVariantId, `P15LOT_${fixture.token}`,
        shiftDate(currentLocalDate('Africa/Lagos'), 5), fixture.employeeAId],
    );
    fixture.lotId = await lastId(connection);
    await connection.execute(
      `INSERT INTO branch_lot_inventory (
         branch_id, inventory_lot_id, quantity_on_hand, status
       ) VALUES (?, ?, '8.000', 'AVAILABLE')`,
      [fixture.branchAId, fixture.lotId],
    );

    fixture.saleIds = [];
    const saleDefinitions = [
      [fixture.branchAId, fixture.registerId, fixture.tillId, fixture.customerId,
        fixture.employeeAId, sale1Tx, 'A1', '2026-06-01 23:30:00', 'NGN', '27.00', '3.00', '30.00'],
      [fixture.branchAId, fixture.registerId, fixture.tillId, null,
        fixture.employeeAId, sale2Tx, 'A2', '2026-06-01 23:40:00', 'NGN', '15.00', '0.00', '15.00'],
      [fixture.branchBId, null, null, null,
        fixture.employeeBId, bSaleTx, 'B1', '2026-03-08 04:30:00', 'GBP', '5.00', '0.00', '5.00'],
    ];
    for (const definition of saleDefinitions) {
      await connection.execute(
        `INSERT INTO sales (
           branch_id, pos_register_id, till_session_id, customer_id,
           cashier_employee_id, inventory_transaction_id, sale_number,
           status, sold_at, currency_code, subtotal_amount,
           discount_amount, tax_amount, total_amount, notes
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?, ?, ?, 0.00, ?, ?, ?)`,
        [...definition.slice(0, 6), `P15SALE_${definition[6]}_${fixture.token}`,
          ...definition.slice(7), fixture.prefix],
      );
      fixture.saleIds.push(await lastId(connection));
    }
    [fixture.sale1Id, fixture.sale2Id, fixture.saleBId] = fixture.saleIds;

    const saleItems = [
      [fixture.sale1Id, 1, fixture.costedVariantId, 'Costed historical item', `P15COST_${fixture.token}`, '2.000', '2.000', '10.0000', '2.0000', '2.00', '20.00'],
      [fixture.sale1Id, 2, fixture.legacyVariantId, 'Legacy historical item', `P15LEGACY_${fixture.token}`, '2.500', '2.500', '10.0000', null, '1.00', '10.00'],
      [fixture.sale2Id, 1, fixture.costedVariantId, 'Costed historical item', `P15COST_${fixture.token}`, '1.000', '1.000', '15.0000', '2.0000', '0.00', '15.00'],
      [fixture.saleBId, 1, fixture.costedVariantId, 'Costed historical item', `P15COST_${fixture.token}`, '1.000', '1.000', '5.0000', '2.0000', '0.00', '5.00'],
    ];
    fixture.saleItemIds = [];
    for (const item of saleItems) {
      await connection.execute(
        `INSERT INTO sale_items (
           sale_id, line_number, product_variant_id, item_description,
           sku_snapshot, quantity, package_conversion_factor, base_quantity,
           unit_price, unit_cost, discount_amount, tax_rate_percent,
           tax_amount, line_total
         ) VALUES (?, ?, ?, ?, ?, ?, 1.000000, ?, ?, ?, 0.00, 0.0000, ?, ?)`,
        item,
      );
      fixture.saleItemIds.push(await lastId(connection));
    }

    await connection.execute(
      `INSERT INTO return_reasons (
         reason_code, reason_name, default_restockable, requires_approval, is_active
       ) VALUES (?, ?, 1, 0, 1)`,
      [`P15RR_${fixture.token}`, `${fixture.prefix} Reason`],
    );
    fixture.returnReasonId = await lastId(connection);
    await connection.execute(
      `INSERT INTO sales_returns (
         return_number, original_sale_id, branch_id, customer_id,
         processed_by_employee_id, inventory_transaction_id, approval_required,
         status, requested_at, completed_at, refund_total_amount, notes
       ) VALUES (?, ?, ?, ?, ?, ?, 0, 'COMPLETED',
                 '2026-06-02 22:00:00', '2026-06-02 23:30:00', 20.00, ?)`,
      [`P15RET_${fixture.token}`, fixture.sale1Id, fixture.branchAId,
        fixture.customerId, fixture.employeeAId, returnTx, fixture.prefix],
    );
    fixture.returnId = await lastId(connection);
    const returnItems = [
      [fixture.saleItemIds[0], 1, fixture.costedVariantId, 'Costed historical item', `P15COST_${fixture.token}`, '1.000', '1.000', 'UNOPENED', 1, '12.00'],
      [fixture.saleItemIds[1], 2, fixture.legacyVariantId, 'Legacy historical item', `P15LEGACY_${fixture.token}`, '2.500', '2.500', 'DAMAGED', 0, '8.00'],
    ];
    for (const item of returnItems) {
      await connection.execute(
        `INSERT INTO sales_return_items (
           sales_return_id, original_sale_id, original_sale_item_id, line_number,
           product_variant_id, return_reason_id, item_description, sku_snapshot,
           quantity_returned, package_conversion_factor, base_quantity_returned,
           item_condition, is_restockable, refund_amount
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1.000000, ?, ?, ?, ?)`,
        [fixture.returnId, fixture.sale1Id, item[0], item[1], item[2],
          fixture.returnReasonId, ...item.slice(3)],
      );
    }

    const payments = [
      ['PAY1', fixture.sale1Id, null, fixture.cashMethodId, 'PAYMENT', 'COMPLETED', '20.00', '2026-06-01 23:50:00', '2026-06-01 23:50:00'],
      ['PAY2', fixture.sale1Id, null, fixture.cardMethodId, 'PAYMENT', 'COMPLETED', '10.00', '2026-06-01 23:51:00', '2026-06-01 23:51:00'],
      ['PAY3', fixture.sale2Id, null, fixture.cardMethodId, 'PAYMENT', 'COMPLETED', '15.00', '2026-06-01 23:52:00', '2026-06-01 23:52:00'],
      ['REF1', fixture.sale1Id, fixture.returnId, fixture.cashMethodId, 'REFUND', 'COMPLETED', '20.00', '2026-06-03 23:30:00', '2026-06-03 23:30:00'],
      ['REFP', fixture.sale1Id, fixture.returnId, fixture.cashMethodId, 'REFUND', 'PENDING', '5.00', null, '2026-06-02 23:40:00'],
      ['BPAY', fixture.saleBId, null, fixture.cardMethodId, 'PAYMENT', 'COMPLETED', '5.00', '2026-03-08 04:40:00', '2026-03-08 04:40:00'],
    ];
    for (const payment of payments) {
      await connection.execute(
        `INSERT INTO sale_payments (
           payment_number, sale_id, sales_return_id, payment_method_id,
           processed_by_employee_id, payment_type, status, amount,
           currency_code, paid_at, notes, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?,
           (SELECT currency_code FROM sales WHERE sale_id = ?), ?, ?, ?)`,
        [`P15_${payment[0]}_${fixture.token}`, ...payment.slice(1, 4),
          payment[1] === fixture.saleBId ? fixture.employeeBId : fixture.employeeAId,
          ...payment.slice(4, 7), payment[1], payment[7], fixture.prefix, payment[8]],
      );
    }

    await connection.execute(
      `INSERT INTO till_cash_movements (
         till_session_id, movement_type, amount, reason,
         reference_number, recorded_by_employee_id, occurred_at
       ) VALUES (?, 'CASH_IN', 5.00, ?, ?, ?, '2026-06-02 10:00:00'),
                (?, 'CASH_OUT', 2.00, ?, ?, ?, '2026-06-02 11:00:00')`,
      [fixture.tillId, fixture.prefix, `P15IN_${fixture.token}`, fixture.employeeAId,
        fixture.tillId, fixture.prefix, `P15OUT_${fixture.token}`, fixture.employeeAId],
    );

    await connection.execute(
      `INSERT INTO purchase_orders (
         purchase_order_number, branch_id, supplier_id, status, ordered_at,
         created_by_employee_id, approved_by_employee_id, approved_at,
         currency_code, subtotal_amount, discount_amount, tax_amount,
         shipping_amount, total_amount, notes
       ) VALUES (?, ?, ?, 'APPROVED', '2026-06-02 08:00:00', ?, ?,
                 '2026-06-02 09:00:00', 'NGN', 20.00, 0.00, 0.00, 0.00, 20.00, ?)`,
      [`P15PO_${fixture.token}`, fixture.branchAId, fixture.supplierId,
        fixture.employeeAId, fixture.employeeBId, fixture.prefix],
    );
    fixture.purchaseOrderId = await lastId(connection);
    await connection.execute(
      `INSERT INTO purchase_order_items (
         purchase_order_id, line_number, product_variant_id, item_description,
         ordered_package_quantity, package_conversion_factor, ordered_quantity,
         unit_cost, discount_amount, tax_rate_percent, tax_amount, line_total
       ) VALUES (?, 1, ?, ?, 10.000, 1.000000, 10.000,
                 2.0000, 0.00, 0.0000, 0.00, 20.00)`,
      [fixture.purchaseOrderId, fixture.costedVariantId, `${fixture.prefix} ordered item`],
    );
    fixture.purchaseOrderItemId = await lastId(connection);
    await connection.execute(
      `INSERT INTO goods_receipts (
         goods_receipt_number, purchase_order_id, branch_id, supplier_id,
         inventory_transaction_id, status, received_at, posted_at,
         received_by_employee_id, notes
       ) VALUES (?, ?, ?, ?, ?, 'POSTED', '2026-06-03 08:00:00',
                 '2026-06-03 09:00:00', ?, ?)`,
      [`P15GR_${fixture.token}`, fixture.purchaseOrderId, fixture.branchAId,
        fixture.supplierId, receiptTx, fixture.employeeAId, fixture.prefix],
    );
    fixture.goodsReceiptId = await lastId(connection);
    await connection.execute(
      `INSERT INTO goods_receipt_items (
         goods_receipt_id, purchase_order_id, purchase_order_item_id,
         product_variant_id, line_number, package_quantity_accepted,
         package_quantity_rejected, package_conversion_factor,
         quantity_accepted, quantity_rejected, actual_unit_cost,
         discount_amount, tax_amount, line_total
       ) VALUES (?, ?, ?, ?, 1, 10.000, 1.000, 1.000000,
                 10.000, 1.000, 2.0000, 0.00, 0.00, 20.00)`,
      [fixture.goodsReceiptId, fixture.purchaseOrderId,
        fixture.purchaseOrderItemId, fixture.costedVariantId],
    );

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function cleanupFixture(fixture) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const like = `${fixture.prefix}%`;
    const branches = fixture.branchIds ?? [];
    const inList = branches.map(() => '?').join(', ');
    await connection.execute('DELETE FROM audit_logs WHERE request_id LIKE ? OR notes LIKE ?', [like, like]);
    await connection.execute("DELETE FROM sale_payments WHERE payment_number LIKE 'P15_%' AND notes = ?", [fixture.prefix]);
    await connection.execute('DELETE sri FROM sales_return_items sri INNER JOIN sales_returns sr ON sr.sales_return_id = sri.sales_return_id WHERE sr.notes = ?', [fixture.prefix]);
    await connection.execute('DELETE FROM sales_returns WHERE notes = ?', [fixture.prefix]);
    await connection.execute('DELETE si FROM sale_items si INNER JOIN sales s ON s.sale_id = si.sale_id WHERE s.notes = ?', [fixture.prefix]);
    await connection.execute('DELETE FROM sales WHERE notes = ?', [fixture.prefix]);
    await connection.execute('DELETE gri FROM goods_receipt_items gri INNER JOIN goods_receipts gr ON gr.goods_receipt_id = gri.goods_receipt_id WHERE gr.notes = ?', [fixture.prefix]);
    await connection.execute('DELETE FROM goods_receipts WHERE notes = ?', [fixture.prefix]);
    await connection.execute('DELETE poi FROM purchase_order_items poi INNER JOIN purchase_orders po ON po.purchase_order_id = poi.purchase_order_id WHERE po.notes = ?', [fixture.prefix]);
    await connection.execute('DELETE FROM purchase_orders WHERE notes = ?', [fixture.prefix]);
    if (branches.length) {
      await connection.execute(`DELETE FROM branch_lot_inventory WHERE branch_id IN (${inList})`, branches);
    }
    await connection.execute('DELETE FROM inventory_lots WHERE notes IS NULL AND lot_number = ?', [`P15LOT_${fixture.token}`]);
    await connection.execute('DELETE iti FROM inventory_transaction_items iti INNER JOIN inventory_transactions it ON it.inventory_transaction_id = iti.inventory_transaction_id WHERE it.notes = ?', [fixture.prefix]);
    await connection.execute('DELETE FROM inventory_transactions WHERE notes = ?', [fixture.prefix]);
    if (branches.length) {
      await connection.execute(`DELETE FROM branch_inventory WHERE branch_id IN (${inList})`, branches);
    }
    await connection.execute('DELETE tcm FROM till_cash_movements tcm INNER JOIN till_sessions ts ON ts.till_session_id = tcm.till_session_id WHERE ts.notes = ?', [fixture.prefix]);
    await connection.execute('DELETE FROM till_sessions WHERE notes = ?', [fixture.prefix]);
    if (branches.length) {
      await connection.execute(`DELETE FROM pos_registers WHERE branch_id IN (${inList})`, branches);
    }
    await connection.execute('DELETE FROM suppliers WHERE supplier_code = ?', [`P15SUP_${fixture.token}`]);
    await connection.execute('DELETE FROM return_reasons WHERE reason_code = ?', [`P15RR_${fixture.token}`]);
    await connection.execute('DELETE FROM payment_methods WHERE method_code IN (?, ?)', [`P15CASH_${fixture.token}`, `P15CARD_${fixture.token}`]);
    await connection.execute('DELETE FROM customers WHERE customer_number = ?', [`P15CUS_${fixture.token}`]);
    await connection.execute('DELETE FROM product_variants WHERE product_id = ?', [fixture.productId ?? '0']);
    await connection.execute('DELETE FROM products WHERE product_code = ?', [`P15P_${fixture.token}`]);
    await connection.execute('DELETE FROM categories WHERE category_code = ?', [`P15CAT_${fixture.token}`]);
    await connection.execute(
      'DELETE FROM units_of_measure WHERE unit_code IN (?, ?)',
      [`P15EACH_${fixture.token}`, `P15KG_${fixture.token}`],
    );
    if (fixture.userIds?.length) {
      const ids = fixture.userIds.map(() => '?').join(', ');
      await connection.execute(`DELETE FROM user_roles WHERE user_id IN (${ids})`, fixture.userIds);
      await connection.execute(`DELETE FROM users WHERE user_id IN (${ids})`, fixture.userIds);
    }
    if (fixture.roleIds?.length) {
      const ids = fixture.roleIds.map(() => '?').join(', ');
      await connection.execute(`DELETE FROM role_permissions WHERE role_id IN (${ids})`, fixture.roleIds);
      await connection.execute(`DELETE FROM roles WHERE role_id IN (${ids})`, fixture.roleIds);
    }
    if (fixture.employeeIds?.length) {
      const ids = fixture.employeeIds.map(() => '?').join(', ');
      await connection.execute(`DELETE FROM employee_branch_assignments WHERE employee_id IN (${ids})`, fixture.employeeIds);
      await connection.execute(`DELETE FROM employees WHERE employee_id IN (${ids})`, fixture.employeeIds);
    }
    if (branches.length) await connection.execute(`DELETE FROM branches WHERE branch_id IN (${inList})`, branches);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
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
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function send(fixture, baseUrl, path, options = {}) {
  fixture.requestCount += 1;
  const headers = new Headers(options.headers);
  const token = Object.hasOwn(options, 'token') ? options.token : fixture.tokens.global;
  if (token) headers.set('authorization', `Bearer ${token}`);
  headers.set('x-request-id', `${fixture.prefix}_${fixture.requestCount}`);
  const response = await fetch(`${baseUrl}${path}`, { method: options.method ?? 'GET', headers });
  const text = await response.text();
  return { status: response.status, text, json: text ? JSON.parse(text) : null };
}

function expectStatus(result, expected) {
  assert.equal(result.status, expected, result.text);
  if (expected >= 400) {
    assert.equal(result.json?.success, false);
    for (const secret of ['ER_', 'sqlMessage', 'DB_PASSWORD', 'stack']) {
      assert.equal(result.text.includes(secret), false);
    }
  }
}

function root(fixture, branchId = fixture.branchAId) {
  return `/api/admin/branches/${branchId}/reports`;
}

function range(from = '2026-01-01', to = '2026-12-31') {
  return `from=${from}&to=${to}`;
}

async function snapshot() {
  const tables = [
    'sales', 'sale_items', 'sale_payments', 'sales_returns', 'sales_return_items',
    'branch_inventory', 'branch_lot_inventory', 'inventory_transactions',
    'inventory_transaction_items', 'purchase_orders', 'goods_receipts',
    'till_sessions', 'till_cash_movements', 'customers', 'audit_logs',
  ];
  const result = {};
  for (const table of tables) {
    const [rows] = await pool.query(`SELECT CAST(COUNT(*) AS CHAR) AS count FROM \`${table}\``);
    result[table] = rows[0].count;
  }
  return result;
}

test('Phase 15 reporting and analytics integration', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const fixture = fixtureDefinition();
  let server;
  try {
    await cleanupFixture(fixture);
    await createFixture(fixture);
    server = await startServer();
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    await t.test('seeds one permission and exposes exactly thirteen GET routes', async () => {
      assert.equal(ACCESS_CONTROL_PERMISSIONS.length, 45);
      assert.equal(new Set(ACCESS_CONTROL_PERMISSIONS.map(({ code }) => code)).size, 45);
      assert.equal(ACCESS_CONTROL_PERMISSIONS.at(-1).code, 'reports.read');
      const [rows] = await pool.execute(
        `SELECT CAST(COUNT(*) AS CHAR) AS count FROM role_permissions rp
         INNER JOIN roles r ON r.role_id = rp.role_id
         WHERE r.role_code = ?`, [SYSTEM_ADMIN_ROLE.code],
      );
      assert.equal(rows[0].count, '45');
      expectStatus(await send(fixture, baseUrl, `${root(fixture)}/overview?${range()}`, { token: null }), 401);
      expectStatus(await send(fixture, baseUrl, `${root(fixture)}/overview?${range()}`, { token: fixture.tokens.none }), 403);
      expectStatus(await send(fixture, baseUrl, `${root(fixture)}/overview?${range()}`, { method: 'POST' }), 404);
    });

    await t.test('enforces global, branch-scoped, and employee-assignment authorization', async () => {
      expectStatus(await send(fixture, baseUrl, `/api/admin/reports/branches?${range()}`, { token: fixture.tokens.scoped }), 403);
      expectStatus(await send(fixture, baseUrl, `/api/admin/reports/branches?${range()}`, { token: fixture.tokens.global }), 200);
      expectStatus(await send(fixture, baseUrl, `${root(fixture)}/overview?${range()}`, { token: fixture.tokens.scoped }), 200);
      expectStatus(await send(fixture, baseUrl, `${root(fixture, fixture.branchBId)}/overview?${range()}`, { token: fixture.tokens.scoped }), 403);
      expectStatus(await send(fixture, baseUrl, `${root(fixture)}/overview?${range()}`, { token: fixture.tokens.linked }), 200);
      expectStatus(await send(fixture, baseUrl, `${root(fixture, fixture.branchBId)}/overview?${range()}`, { token: fixture.tokens.linked }), 403);
    });

    await t.test('strictly validates dates, ranges, enums, pagination, booleans, and IDs', async () => {
      for (const path of [
        `${root(fixture)}/overview`,
        `${root(fixture)}/overview?from=2026-02-30&to=2026-03-01`,
        `${root(fixture)}/overview?from=2026-03-02&to=2026-03-01`,
        `${root(fixture)}/overview?from=2025-01-01&to=2026-01-02`,
        `${root(fixture)}/sales/trend?${range()}&groupBy=quarter`,
        `${root(fixture)}/products?${range()}&sort=DROP_TABLE`,
        `${root(fixture)}/products?${range()}&sortDirection=sideways`,
        `${root(fixture)}/products?${range()}&groupBy=product&sort=soldBaseQuantity`,
        `${root(fixture)}/products?${range()}&groupBy=category&sort=returnedBaseQuantity`,
        `${root(fixture)}/returns?${range()}&isRestockable=yes`,
        `${root(fixture)}/inventory?page=0`,
        `${root(fixture)}/inventory?limit=101`,
        `${root(fixture)}/inventory?productVariantId=1e3`,
        `${root(fixture)}/overview?${range()}&unexpected=true`,
      ]) expectStatus(await send(fixture, baseUrl, path), 400);
      expectStatus(await send(fixture, baseUrl,
        `/api/admin/branches/18446744073709551615/reports/overview?${range()}`), 404);
    });

    await t.test('uses branch-local dates including Lagos midnight and New York DST', async () => {
      const lagosDay1 = await send(fixture, baseUrl, `${root(fixture)}/sales/summary?${range('2026-06-01', '2026-06-01')}`);
      const lagosDay2 = await send(fixture, baseUrl, `${root(fixture)}/sales/summary?${range('2026-06-02', '2026-06-02')}`);
      expectStatus(lagosDay1, 200); expectStatus(lagosDay2, 200);
      assert.equal(lagosDay1.json.data.grossSalesAmount, '0.00');
      assert.equal(lagosDay2.json.data.grossSalesAmount, '45.00');
      const newYork = await send(fixture, baseUrl,
        `${root(fixture, fixture.branchBId)}/sales/summary?${range('2026-03-07', '2026-03-07')}`);
      expectStatus(newYork, 200);
      assert.equal(newYork.json.data.grossSalesAmount, '5.00');
    });

    await t.test('keeps organization currencies separate and avoids join multiplication', async () => {
      const organization = await send(fixture, baseUrl, `/api/admin/reports/branches?${range()}`);
      expectStatus(organization, 200);
      const branchA = organization.json.data.items.find(({ branchId }) => branchId === fixture.branchAId);
      const branchB = organization.json.data.items.find(({ branchId }) => branchId === fixture.branchBId);
      assert.deepEqual([branchA.currencyCode, branchA.grossSalesAmount], ['NGN', '45.00']);
      assert.deepEqual([branchB.currencyCode, branchB.grossSalesAmount], ['GBP', '5.00']);
      assert.deepEqual(
        organization.json.data.summary.totalsByCurrency.map(({ currencyCode, grossSalesAmount }) => [currencyCode, grossSalesAmount]),
        [['GBP', '5.00'], ['NGN', '45.00']],
      );
      assert.equal(Object.hasOwn(organization.json.data.summary, 'grossSalesAmount'), false);
    });

    await t.test('reports completed sales, exact averages, overview counts, and event-period net sales', async () => {
      const summary = await send(fixture, baseUrl, `${root(fixture)}/sales/summary?${range()}`);
      expectStatus(summary, 200);
      assert.deepEqual({
        count: summary.json.data.completedSalesCount,
        gross: summary.json.data.grossSalesAmount,
        average: summary.json.data.averageSaleValue,
        linked: summary.json.data.customerLinkedSalesCount,
        walkIn: summary.json.data.walkInSalesCount,
      }, { count: 2, gross: '45.00', average: '22.50', linked: 1, walkIn: 1 });
      const overview = await send(fixture, baseUrl, `${root(fixture)}/overview?${range()}`);
      expectStatus(overview, 200);
      assert.equal(overview.json.data.returnedMerchandiseAmount, '20.00');
      assert.equal(overview.json.data.completedRefundAmount, '20.00');
      assert.equal(overview.json.data.netSalesAmount, '25.00');
      const day2 = await send(fixture, baseUrl, `${root(fixture)}/overview?${range('2026-06-02', '2026-06-02')}`);
      const day3 = await send(fixture, baseUrl, `${root(fixture)}/overview?${range('2026-06-03', '2026-06-03')}`);
      const day4 = await send(fixture, baseUrl, `${root(fixture)}/overview?${range('2026-06-04', '2026-06-04')}`);
      assert.deepEqual([day2.json.data.grossSalesAmount, day2.json.data.returnedMerchandiseAmount, day2.json.data.completedRefundAmount], ['45.00', '0.00', '0.00']);
      assert.deepEqual([day3.json.data.grossSalesAmount, day3.json.data.returnedMerchandiseAmount, day3.json.data.completedRefundAmount], ['0.00', '20.00', '0.00']);
      assert.deepEqual([day4.json.data.grossSalesAmount, day4.json.data.returnedMerchandiseAmount, day4.json.data.completedRefundAmount], ['0.00', '0.00', '20.00']);
    });

    await t.test('emits deterministic local trend buckets including zero days', async () => {
      const result = await send(fixture, baseUrl,
        `${root(fixture)}/sales/trend?${range('2026-06-01', '2026-06-04')}&groupBy=day`);
      expectStatus(result, 200);
      assert.deepEqual(result.json.data.items.map((item) => item.periodStart), [
        '2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04',
      ]);
      assert.deepEqual(result.json.data.items.map((item) => item.grossSalesAmount), ['0.00', '45.00', '0.00', '0.00']);
      assert.deepEqual(result.json.data.items.map((item) => item.completedRefundAmount), ['0.00', '0.00', '0.00', '20.00']);
    });

    await t.test('reports historical product profit without inventing missing cost', async () => {
      const result = await send(fixture, baseUrl,
        `${root(fixture)}/products?${range()}&groupBy=variant&limit=10`);
      expectStatus(result, 200);
      const costed = result.json.data.items.find(({ productVariantId }) => productVariantId === fixture.costedVariantId);
      const legacy = result.json.data.items.find(({ productVariantId }) => productVariantId === fixture.legacyVariantId);
      assert.deepEqual([
        costed.merchandiseRevenueBeforeReturns,
        costed.historicalCostAmount,
        costed.grossProfitBeforeReturns,
      ], ['33.00', '6.00', '27.00']);
      assert.equal(legacy.historicalCostAmount, null);
      assert.equal(legacy.grossProfitBeforeReturns, null);
      assert.equal(legacy.uncostedLineCount, 1);
    });

    await t.test('never combines incompatible base units into a scalar quantity', async () => {
      const findUnit = (rows, unitOfMeasureId) =>
        rows.find((row) => row.unitOfMeasureId === unitOfMeasureId);
      const mixedScalarFields = [
        'soldBaseQuantity', 'returnedBaseQuantity',
        'restockableBaseQuantity', 'nonRestockableBaseQuantity',
      ];
      const assertNoMixedScalars = (value) => {
        for (const field of mixedScalarFields) assert.equal(Object.hasOwn(value, field), false);
      };

      const organization = await send(fixture, baseUrl, `/api/admin/reports/branches?${range()}`);
      const branch = organization.json.data.items.find(
        ({ branchId }) => branchId === fixture.branchAId,
      );
      expectStatus(organization, 200);
      assertNoMixedScalars(branch);
      assert.deepEqual(
        [
          findUnit(branch.quantitiesByUnit, fixture.unitId).soldBaseQuantity,
          findUnit(branch.quantitiesByUnit, fixture.unitId).returnedBaseQuantity,
          findUnit(branch.quantitiesByUnit, fixture.kgUnitId).soldBaseQuantity,
          findUnit(branch.quantitiesByUnit, fixture.kgUnitId).returnedBaseQuantity,
        ],
        ['3.000', '1.000', '2.500', '2.500'],
      );

      const sales = await send(fixture, baseUrl, `${root(fixture)}/sales/summary?${range()}`);
      expectStatus(sales, 200);
      assertNoMixedScalars(sales.json.data);
      assert.deepEqual(
        [
          findUnit(sales.json.data.quantitiesByUnit, fixture.unitId).soldBaseQuantity,
          findUnit(sales.json.data.quantitiesByUnit, fixture.kgUnitId).soldBaseQuantity,
        ],
        ['3.000', '2.500'],
      );

      const overview = await send(fixture, baseUrl, `${root(fixture)}/overview?${range()}`);
      expectStatus(overview, 200);
      assertNoMixedScalars(overview.json.data);
      const eachOverview = findUnit(overview.json.data.quantitiesByUnit, fixture.unitId);
      const kgOverview = findUnit(overview.json.data.quantitiesByUnit, fixture.kgUnitId);
      assert.deepEqual(
        [
          eachOverview.soldBaseQuantity, eachOverview.returnedBaseQuantity,
          eachOverview.restockableBaseQuantity, eachOverview.nonRestockableBaseQuantity,
          kgOverview.soldBaseQuantity, kgOverview.returnedBaseQuantity,
          kgOverview.restockableBaseQuantity, kgOverview.nonRestockableBaseQuantity,
        ],
        ['3.000', '1.000', '1.000', '0.000', '2.500', '2.500', '0.000', '2.500'],
      );

      const returns = await send(fixture, baseUrl, `${root(fixture)}/returns?${range()}`);
      expectStatus(returns, 200);
      assertNoMixedScalars(returns.json.data.summary);
      const eachReturns = findUnit(returns.json.data.summary.quantitiesByUnit, fixture.unitId);
      const kgReturns = findUnit(returns.json.data.summary.quantitiesByUnit, fixture.kgUnitId);
      assert.deepEqual(
        [
          eachReturns.returnedBaseQuantity, eachReturns.restockableBaseQuantity,
          eachReturns.nonRestockableBaseQuantity, kgReturns.returnedBaseQuantity,
          kgReturns.restockableBaseQuantity, kgReturns.nonRestockableBaseQuantity,
        ],
        ['1.000', '1.000', '0.000', '2.500', '0.000', '2.500'],
      );
      const legacyReturn = returns.json.data.items.find(
        ({ productVariantId }) => productVariantId === fixture.legacyVariantId,
      );
      assert.deepEqual(
        [legacyReturn.returnedBaseQuantity, legacyReturn.unitOfMeasureId, legacyReturn.unitSymbol],
        ['2.500', fixture.kgUnitId, 'kg'],
      );

      for (const groupBy of ['product', 'category']) {
        const grouped = await send(
          fixture, baseUrl, `${root(fixture)}/products?${range()}&groupBy=${groupBy}`,
        );
        expectStatus(grouped, 200);
        const item = grouped.json.data.items[0];
        assert.equal(item.soldBaseQuantity, null);
        assert.equal(item.returnedBaseQuantity, null);
        assert.deepEqual(
          [
            findUnit(item.quantitiesByUnit, fixture.unitId).soldBaseQuantity,
            findUnit(item.quantitiesByUnit, fixture.unitId).returnedBaseQuantity,
            findUnit(item.quantitiesByUnit, fixture.kgUnitId).soldBaseQuantity,
            findUnit(item.quantitiesByUnit, fixture.kgUnitId).returnedBaseQuantity,
          ],
          ['3.000', '1.000', '2.500', '2.500'],
        );
      }

      const variants = await send(
        fixture, baseUrl, `${root(fixture)}/products?${range()}&groupBy=variant&limit=10`,
      );
      expectStatus(variants, 200);
      const eachVariant = variants.json.data.items.find(
        ({ productVariantId }) => productVariantId === fixture.costedVariantId,
      );
      const kgVariant = variants.json.data.items.find(
        ({ productVariantId }) => productVariantId === fixture.legacyVariantId,
      );
      assert.deepEqual(
        [
          eachVariant.soldBaseQuantity, eachVariant.returnedBaseQuantity,
          eachVariant.unitOfMeasureId, eachVariant.unitSymbol,
          kgVariant.soldBaseQuantity, kgVariant.returnedBaseQuantity,
          kgVariant.unitOfMeasureId, kgVariant.unitSymbol,
        ],
        ['3.000', '1.000', fixture.unitId, 'ea',
          '2.500', '2.500', fixture.kgUnitId, 'kg'],
      );
    });

    await t.test('separates return entitlement, pending refund, and settled refund', async () => {
      const returns = await send(fixture, baseUrl, `${root(fixture)}/returns?${range()}`);
      expectStatus(returns, 200);
      assert.deepEqual({
        entitlement: returns.json.data.summary.returnedMerchandiseAmount,
        pending: returns.json.data.summary.pendingRefundAmount,
        completed: returns.json.data.summary.completedRefundAmount,
      }, { entitlement: '20.00', pending: '5.00', completed: '20.00' });
      const refundDay = await send(fixture, baseUrl,
        `${root(fixture)}/returns?${range('2026-06-04', '2026-06-04')}`);
      assert.equal(refundDay.json.data.summary.returnedMerchandiseAmount, '0.00');
      assert.equal(refundDay.json.data.summary.completedRefundAmount, '20.00');
      const payments = await send(fixture, baseUrl, `${root(fixture)}/payments?${range()}`);
      expectStatus(payments, 200);
      assert.deepEqual([
        payments.json.data.summary.completedPaymentAmount,
        payments.json.data.summary.completedRefundAmount,
        payments.json.data.summary.netTenderAmount,
        payments.json.data.summary.pendingCount,
      ], ['45.00', '20.00', '25.00', 1]);
    });

    await t.test('uses current inventory projection, WAC valuation, lots, and signed ledger evidence', async () => {
      const inventory = await send(fixture, baseUrl, `${root(fixture)}/inventory?expiringWithinDays=10&limit=10`);
      expectStatus(inventory, 200);
      const costed = inventory.json.data.items.find(({ productVariantId }) => productVariantId === fixture.costedVariantId);
      assert.deepEqual([
        costed.quantityOnHand, costed.stockState, costed.currentWeightedAverageUnitCost,
        costed.currentValuationAmount, costed.valuationStatus, costed.lotCount,
        costed.expiringLotCount,
      ], ['8.000', 'LOW_STOCK', '2.0000', '16.00', 'AVAILABLE', 1, 1]);
      const noCost = await send(fixture, baseUrl,
        `${root(fixture)}/inventory?productVariantId=${fixture.noCostVariantId}`);
      assert.equal(noCost.json.data.items[0].valuationStatus, 'NO_COST_HISTORY');
      assert.equal(noCost.json.data.items[0].currentValuationAmount, null);
      const movements = await send(fixture, baseUrl, `${root(fixture)}/inventory/movements?${range()}&limit=100`);
      expectStatus(movements, 200);
      const saleMovement = movements.json.data.items.find((item) =>
        item.transactionType === 'SALE' && item.productVariantId === fixture.costedVariantId && item.quantityChange === '-2.000');
      const returned = movements.json.data.items.find((item) => item.transactionType === 'CUSTOMER_RETURN');
      const nullCost = movements.json.data.items.find((item) => item.productVariantId === fixture.noCostVariantId);
      assert.deepEqual([saleMovement.quantityChange, saleMovement.extendedCostAmount], ['-2.000', '-4.00']);
      assert.deepEqual([returned.quantityChange, returned.extendedCostAmount], ['1.000', '2.00']);
      assert.equal(nullCost.extendedCostAmount, null);
    });

    await t.test('reports purchasing and suppliers from ordered and posted event authorities', async () => {
      const purchasing = await send(fixture, baseUrl, `${root(fixture)}/purchasing?${range()}`);
      expectStatus(purchasing, 200);
      assert.deepEqual(purchasing.json.data.orderPeriod, {
        purchaseOrderCount: 1, orderedAmount: '20.00', orderedLineCount: 1,
      });
      assert.deepEqual(purchasing.json.data.receiptPeriod, {
        postedReceiptCount: 1, receiptLineCount: 1, acceptedLineCount: 1,
        rejectedLineCount: 1, actualReceivedCostAmount: '20.00',
      });
      const suppliers = await send(fixture, baseUrl, `${root(fixture)}/suppliers?${range()}`);
      expectStatus(suppliers, 200);
      assert.equal(suppliers.json.data.items.length, 1);
      assert.deepEqual([
        suppliers.json.data.items[0].purchaseOrderCount,
        suppliers.json.data.items[0].orderedAmount,
        suppliers.json.data.items[0].postedReceiptCount,
        suppliers.json.data.items[0].actualReceivedCostAmount,
      ], [1, '20.00', 1, '20.00']);
    });

    await t.test('preserves the approved till formula and identified-customer boundary', async () => {
      const tills = await send(fixture, baseUrl, `${root(fixture)}/tills?${range()}`);
      expectStatus(tills, 200);
      const session = tills.json.data.items[0];
      assert.deepEqual([
        session.openingCashAmount, session.completedCashPaymentAmount,
        session.completedCashRefundAmount, session.cashInAmount,
        session.cashOutAmount, session.calculatedExpectedCashAmount,
        session.actualClosingCashAmount,
      ], ['100.00', '20.00', '20.00', '5.00', '2.00', '103.00', null]);
      const customers = await send(fixture, baseUrl, `${root(fixture)}/customers?${range()}`);
      expectStatus(customers, 200);
      assert.equal(customers.json.data.items.length, 1);
      assert.equal(customers.json.data.items[0].customerId, fixture.customerId);
      assert.deepEqual([
        customers.json.data.items[0].completedSalesCount,
        customers.json.data.items[0].grossSalesAmount,
        customers.json.data.items[0].completedReturnCount,
      ], [1, '30.00', 1]);
    });

    await t.test('keeps pagination stable and all report GETs read-only with no audits', async () => {
      const first = await send(fixture, baseUrl, `${root(fixture)}/products?${range()}&limit=1&page=1`);
      const repeated = await send(fixture, baseUrl, `${root(fixture)}/products?${range()}&limit=1&page=1`);
      assert.deepEqual(first.json.data.items, repeated.json.data.items);
      const before = await snapshot();
      const paths = [
        `/api/admin/reports/branches?${range()}`,
        `${root(fixture)}/overview?${range()}`,
        `${root(fixture)}/sales/summary?${range()}`,
        `${root(fixture)}/sales/trend?${range()}&groupBy=month`,
        `${root(fixture)}/products?${range()}`,
        `${root(fixture)}/returns?${range()}`,
        `${root(fixture)}/payments?${range()}`,
        `${root(fixture)}/inventory`,
        `${root(fixture)}/inventory/movements?${range()}`,
        `${root(fixture)}/purchasing?${range()}`,
        `${root(fixture)}/suppliers?${range()}`,
        `${root(fixture)}/tills?${range()}`,
        `${root(fixture)}/customers?${range()}`,
      ];
      for (const path of paths) expectStatus(await send(fixture, baseUrl, path), 200);
      assert.deepEqual(await snapshot(), before);
      const [auditRows] = await pool.execute(
        'SELECT CAST(COUNT(*) AS CHAR) AS count FROM audit_logs WHERE request_id LIKE ?',
        [`${fixture.prefix}%`],
      );
      assert.equal(auditRows[0].count, '0');
    });
  } finally {
    await stopServer(server);
    await cleanupFixture(fixture);
    await pool.end();
  }
});
