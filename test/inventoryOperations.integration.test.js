import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';
dotenv.config({ quiet: true });

const [{ default: app }, { pool }, { ensureAccessControl }, access, { signAccessToken }] = await Promise.all([
  import('../src/app.js'), import('../src/config/database.js'),
  import('../src/repositories/accessControlSeed.repository.js'),
  import('../src/config/accessControl.js'), import('../src/utils/jwt.js'),
]);
const { ACCESS_CONTROL_PERMISSIONS, SYSTEM_ADMIN_ROLE } = access;
const TIMEOUT = 600_000;
const placeholders = (items) => items.map(() => '?').join(', ');
async function lastId(connection) { const [rows] = await connection.execute('SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id'); return rows[0].id; }
function startServer() { return new Promise((resolve, reject) => { const server = app.listen(0, '127.0.0.1'); server.once('listening', () => resolve(server)); server.once('error', reject); }); }
function stopServer(server) { return !server?.listening ? Promise.resolve() : new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
function status(result, expected) { assert.equal(result.status, expected, result.text); if (expected >= 400) { assert.equal(result.json?.success, false); for (const secret of ['sqlMessage', 'DB_PASSWORD', 'stack']) assert.equal(result.text.includes(secret), false); } }

async function send(fixture, base, path, { method = 'GET', body, token = fixture.tokens.creator } = {}) {
  const headers = new Headers({ 'user-agent': 'TEST_PHASE9/1.0', 'x-request-id': `${fixture.prefix}_${++fixture.request}` });
  if (token !== null) headers.set('authorization', `Bearer ${token}`);
  if (body !== undefined) headers.set('content-type', 'application/json');
  const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text(); return { status: response.status, text, json: text ? JSON.parse(text) : null };
}

async function setup(fixture) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const first = await ensureAccessControl(connection); const second = await ensureAccessControl(connection);
    assert.deepEqual([first.permissionCount, first.assignedPermissionCount, second.permissionCount, second.assignedPermissionCount], [45, 45, 45, 45]);
    assert.equal(ACCESS_CONTROL_PERMISSIONS.length, 45);
    const [roles] = await connection.execute('SELECT CAST(role_id AS CHAR) AS id, is_active AS isActive FROM roles WHERE role_code = ?', [SYSTEM_ADMIN_ROLE.code]);
    assert.equal(roles.length, 1); assert.equal(roles[0].isActive, 1); fixture.systemRoleId = roles[0].id;
    const [mappings] = await connection.execute('SELECT COUNT(*) AS count FROM role_permissions WHERE role_id = ?', [fixture.systemRoleId]); assert.equal(mappings[0].count, '45');
    fixture.branchIds = [];
    for (const [suffix, code] of [['SOURCE', 'S'], ['DEST', 'D'], ['OTHER', 'O']]) {
      await connection.execute(`INSERT INTO branches (branch_code, branch_name, address_line_1, city, country_code, currency_code, timezone, status) VALUES (?, ?, '1 Phase 9 Street', 'Lagos', 'NG', 'NGN', 'Africa/Lagos', 'ACTIVE')`, [`TEST_P9_${code}_${fixture.token.slice(0, 8)}`, `${fixture.prefix} ${suffix}`]);
      fixture.branchIds.push(await lastId(connection));
    }
    [fixture.sourceBranchId, fixture.destinationBranchId, fixture.otherBranchId] = fixture.branchIds;
    fixture.employeeIds = [];
    for (const name of ['creator', 'approver']) {
      await connection.execute(`INSERT INTO employees (employee_number, first_name, last_name, hire_date, employment_status) VALUES (?, 'Phase9', ?, CURRENT_DATE(), 'ACTIVE')`, [`TEST_P9_${name}_${fixture.token}`, name]);
      const employeeId = await lastId(connection); fixture.employeeIds.push(employeeId); fixture[`${name}EmployeeId`] = employeeId;
      for (const branchId of [fixture.sourceBranchId, fixture.destinationBranchId]) await connection.execute(`INSERT INTO employee_branch_assignments (employee_id, branch_id, job_title, started_on, is_primary) VALUES (?, ?, 'Phase 9 Test', CURRENT_DATE(), ?)`, [employeeId, branchId, branchId === fixture.sourceBranchId ? 1 : 0]);
    }
    await connection.execute('INSERT INTO roles (role_code, role_name, is_active) VALUES (?, ?, 1)', [`TEST_P9_NONE_${fixture.token}`, `${fixture.prefix} no access`]); fixture.noneRoleId = await lastId(connection);
    const hash = await bcrypt.hash(`Phase9-${fixture.token}-Password!`, Number(process.env.BCRYPT_ROUNDS)); fixture.userIds = []; fixture.tokens = {};
    for (const [name, employeeId, roleId, mustChange] of [
      ['creator', fixture.creatorEmployeeId, fixture.systemRoleId, 0], ['approver', fixture.approverEmployeeId, fixture.systemRoleId, 0], ['system', null, fixture.systemRoleId, 0], ['none', null, fixture.noneRoleId, 0], ['must', null, fixture.systemRoleId, 1],
    ]) {
      await connection.execute(`INSERT INTO users (employee_id, username, email, password_hash, is_active, must_change_password) VALUES (?, ?, ?, ?, 1, ?)`, [employeeId, `test_p9.${name}.${fixture.token.toLowerCase()}`, `test_p9.${name}.${fixture.token.toLowerCase()}@example.invalid`, hash, mustChange]);
      const id = await lastId(connection); fixture.userIds.push(id); fixture[`${name}UserId`] = id; await connection.execute('INSERT INTO user_roles (user_id, role_id, branch_id) VALUES (?, ?, NULL)', [id, roleId]); fixture.tokens[name] = signAccessToken(id).accessToken;
    }
    await connection.execute('INSERT INTO units_of_measure (unit_code, unit_name, symbol, allows_fraction) VALUES (?, ?, ?, 0)', [`TEST_P9_U_${fixture.token}`, `${fixture.prefix} unit`, `t9${fixture.token}`]); fixture.unitId = await lastId(connection);
    await connection.execute('INSERT INTO categories (category_code, category_name, is_active) VALUES (?, ?, 1)', [`TEST_P9_C_${fixture.token}`, `${fixture.prefix} category`]); fixture.categoryId = await lastId(connection);
    await connection.execute(`INSERT INTO products (category_id, product_code, product_name, status) VALUES (?, ?, ?, 'ACTIVE')`, [fixture.categoryId, `TEST_P9_P_${fixture.token}`, `${fixture.prefix} product`]); fixture.productId = await lastId(connection); fixture.variantIds = []; fixture.packageIds = [];
    for (const [key, mode] of [['plain', 'NONE'], ['lot', 'REQUIRED'], ['race', 'NONE']]) {
      await connection.execute(`INSERT INTO product_variants (product_id, unit_of_measure_id, sku, variant_name, lot_tracking_mode, default_selling_price, status) VALUES (?, ?, ?, ?, ?, '10.0000', 'ACTIVE')`, [fixture.productId, fixture.unitId, `TEST_P9_${key}_${fixture.token}`, `${fixture.prefix} ${key}`, mode]);
      const id = await lastId(connection); fixture.variantIds.push(id); fixture[`${key}VariantId`] = id;
      await connection.execute(`INSERT INTO product_packages (product_variant_id, package_unit_of_measure_id, package_code, package_name, conversion_to_base_quantity, is_base_unit, is_purchasable, is_sellable, status) VALUES (?, ?, 'TEST_P9_BASE', ?, '1.000000', 1, 1, 1, 'ACTIVE')`, [id, fixture.unitId, `${fixture.prefix} base unit`]); fixture.packageIds.push(await lastId(connection));
    }
    await connection.execute(`INSERT INTO branch_inventory (branch_id, product_variant_id, quantity_on_hand) VALUES (?, ?, '20.000'), (?, ?, '10.000'), (?, ?, '5.000')`, [fixture.sourceBranchId, fixture.plainVariantId, fixture.sourceBranchId, fixture.lotVariantId, fixture.sourceBranchId, fixture.raceVariantId]);
    await connection.execute(`INSERT INTO inventory_lots (product_variant_id, lot_number, expires_on, status, created_by_employee_id) VALUES (?, ?, '2031-12-31', 'ACTIVE', ?)`, [fixture.lotVariantId, `${fixture.prefix}-LOT`, fixture.creatorEmployeeId]); fixture.lotId = await lastId(connection);
    await connection.execute(`INSERT INTO branch_lot_inventory (branch_id, inventory_lot_id, quantity_on_hand, status) VALUES (?, ?, '10.000', 'AVAILABLE')`, [fixture.sourceBranchId, fixture.lotId]);
    await connection.commit(); fixture.setup = true; fixture.purchaseOrderIds = [];
    fixture.goodsReceiptIds = []; fixture.supplierIds = [];
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}

async function cleanup(fixture) {
  if (!fixture.setup) return;
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    const [transactions] = await c.execute(`SELECT CAST(inventory_transaction_id AS CHAR) AS id FROM inventory_transactions WHERE branch_id IN (${placeholders(fixture.branchIds)})`, fixture.branchIds); const transactionIds = transactions.map((row) => row.id);
    await c.execute(`DELETE FROM audit_logs WHERE request_id LIKE ? OR branch_id IN (${placeholders(fixture.branchIds)})`, [`${fixture.prefix}%`, ...fixture.branchIds]);
    if (fixture.goodsReceiptIds.length) {
      await c.execute(`DELETE gril FROM goods_receipt_item_lots gril INNER JOIN goods_receipt_items gri ON gri.goods_receipt_item_id = gril.goods_receipt_item_id WHERE gri.goods_receipt_id IN (${placeholders(fixture.goodsReceiptIds)})`, fixture.goodsReceiptIds);
      await c.execute(`DELETE FROM goods_receipt_items WHERE goods_receipt_id IN (${placeholders(fixture.goodsReceiptIds)})`, fixture.goodsReceiptIds);
      await c.execute(`DELETE FROM goods_receipts WHERE goods_receipt_id IN (${placeholders(fixture.goodsReceiptIds)})`, fixture.goodsReceiptIds);
    }
    if (fixture.purchaseOrderIds.length) {
      await c.execute(`DELETE FROM purchase_order_items WHERE purchase_order_id IN (${placeholders(fixture.purchaseOrderIds)})`, fixture.purchaseOrderIds);
      await c.execute(`DELETE FROM purchase_orders WHERE purchase_order_id IN (${placeholders(fixture.purchaseOrderIds)})`, fixture.purchaseOrderIds);
    }
    await c.execute(`DELETE stil FROM stock_transfer_item_lots stil INNER JOIN stock_transfer_items sti ON sti.stock_transfer_item_id = stil.stock_transfer_item_id INNER JOIN stock_transfers st ON st.stock_transfer_id = sti.stock_transfer_id WHERE st.source_branch_id IN (${placeholders(fixture.branchIds)}) OR st.destination_branch_id IN (${placeholders(fixture.branchIds)})`, [...fixture.branchIds, ...fixture.branchIds]);
    await c.execute(`DELETE sti FROM stock_transfer_items sti INNER JOIN stock_transfers st ON st.stock_transfer_id = sti.stock_transfer_id WHERE st.source_branch_id IN (${placeholders(fixture.branchIds)}) OR st.destination_branch_id IN (${placeholders(fixture.branchIds)})`, [...fixture.branchIds, ...fixture.branchIds]);
    await c.execute(`DELETE FROM stock_transfers WHERE source_branch_id IN (${placeholders(fixture.branchIds)}) OR destination_branch_id IN (${placeholders(fixture.branchIds)})`, [...fixture.branchIds, ...fixture.branchIds]);
    await c.execute(`DELETE scp FROM stock_count_participants scp INNER JOIN stock_counts sc ON sc.stock_count_id = scp.stock_count_id WHERE sc.branch_id IN (${placeholders(fixture.branchIds)})`, fixture.branchIds);
    await c.execute(`DELETE sci FROM stock_count_items sci INNER JOIN stock_counts sc ON sc.stock_count_id = sci.stock_count_id WHERE sc.branch_id IN (${placeholders(fixture.branchIds)})`, fixture.branchIds);
    await c.execute(`DELETE FROM stock_counts WHERE branch_id IN (${placeholders(fixture.branchIds)})`, fixture.branchIds);
    await c.execute(`DELETE iail FROM inventory_adjustment_item_lots iail INNER JOIN inventory_adjustment_items iai ON iai.inventory_adjustment_item_id = iail.inventory_adjustment_item_id INNER JOIN inventory_adjustments ia ON ia.inventory_adjustment_id = iai.inventory_adjustment_id WHERE ia.branch_id IN (${placeholders(fixture.branchIds)})`, fixture.branchIds);
    await c.execute(`DELETE iai FROM inventory_adjustment_items iai INNER JOIN inventory_adjustments ia ON ia.inventory_adjustment_id = iai.inventory_adjustment_id WHERE ia.branch_id IN (${placeholders(fixture.branchIds)})`, fixture.branchIds);
    await c.execute(`DELETE FROM inventory_adjustments WHERE branch_id IN (${placeholders(fixture.branchIds)})`, fixture.branchIds);
    if (transactionIds.length) { await c.execute(`DELETE itla FROM inventory_transaction_lot_allocations itla INNER JOIN inventory_transaction_items iti ON iti.inventory_transaction_item_id = itla.inventory_transaction_item_id WHERE iti.inventory_transaction_id IN (${placeholders(transactionIds)})`, transactionIds); await c.execute(`DELETE FROM inventory_transaction_items WHERE inventory_transaction_id IN (${placeholders(transactionIds)})`, transactionIds); await c.execute(`DELETE FROM inventory_transactions WHERE inventory_transaction_id IN (${placeholders(transactionIds)})`, transactionIds); }
    await c.execute(`DELETE FROM branch_lot_inventory WHERE branch_id IN (${placeholders(fixture.branchIds)})`, fixture.branchIds); await c.execute(`DELETE FROM branch_inventory WHERE branch_id IN (${placeholders(fixture.branchIds)})`, fixture.branchIds); await c.execute('DELETE FROM inventory_lots WHERE inventory_lot_id = ?', [fixture.lotId]);
    if (fixture.supplierIds.length) await c.execute(`DELETE FROM suppliers WHERE supplier_id IN (${placeholders(fixture.supplierIds)})`, fixture.supplierIds);
    await c.execute(`DELETE FROM product_packages WHERE product_package_id IN (${placeholders(fixture.packageIds)})`, fixture.packageIds); await c.execute('DELETE FROM product_variants WHERE product_id = ?', [fixture.productId]); await c.execute('DELETE FROM products WHERE product_id = ?', [fixture.productId]); await c.execute('DELETE FROM categories WHERE category_id = ?', [fixture.categoryId]); await c.execute('DELETE FROM units_of_measure WHERE unit_of_measure_id = ?', [fixture.unitId]);
    await c.execute(`DELETE FROM users WHERE user_id IN (${placeholders(fixture.userIds)})`, fixture.userIds); await c.execute('DELETE FROM roles WHERE role_id = ?', [fixture.noneRoleId]); await c.execute(`DELETE FROM employee_branch_assignments WHERE employee_id IN (${placeholders(fixture.employeeIds)})`, fixture.employeeIds); await c.execute(`DELETE FROM employees WHERE employee_id IN (${placeholders(fixture.employeeIds)})`, fixture.employeeIds); await c.execute(`DELETE FROM branches WHERE branch_id IN (${placeholders(fixture.branchIds)})`, fixture.branchIds);
    await c.commit();
  } catch (error) { await c.rollback(); throw error; } finally { c.release(); }
}

const routeMatrix = [
  ['GET', 'inventory-adjustments'], ['POST', 'inventory-adjustments'], ['GET', 'inventory-adjustments/1'], ['PATCH', 'inventory-adjustments/1'], ['POST', 'inventory-adjustments/1/items'], ['PATCH', 'inventory-adjustments/1/items/1'], ['DELETE', 'inventory-adjustments/1/items/1'], ['POST', 'inventory-adjustments/1/approve'], ['POST', 'inventory-adjustments/1/post'], ['POST', 'inventory-adjustments/1/cancel'], ['GET', 'inventory-adjustments/1/ledger'],
  ['GET', 'stock-counts'], ['POST', 'stock-counts'], ['GET', 'stock-counts/1'], ['PATCH', 'stock-counts/1'], ['POST', 'stock-counts/1/participants'], ['DELETE', 'stock-counts/1/participants/1'], ['POST', 'stock-counts/1/items'], ['PATCH', 'stock-counts/1/items/1'], ['DELETE', 'stock-counts/1/items/1'], ['POST', 'stock-counts/1/start'], ['POST', 'stock-counts/1/complete'], ['POST', 'stock-counts/1/post'], ['POST', 'stock-counts/1/cancel'], ['GET', 'stock-counts/1/variance'], ['GET', 'stock-counts/1/ledger'],
  ['GET', 'stock-transfers'], ['POST', 'stock-transfers'], ['GET', 'stock-transfers/1'], ['PATCH', 'stock-transfers/1'], ['POST', 'stock-transfers/1/items'], ['PATCH', 'stock-transfers/1/items/1'], ['DELETE', 'stock-transfers/1/items/1'], ['POST', 'stock-transfers/1/request'], ['POST', 'stock-transfers/1/approve'], ['POST', 'stock-transfers/1/dispatch'], ['POST', 'stock-transfers/1/receive'], ['POST', 'stock-transfers/1/cancel'],
];

async function createAdjustment(f, base, quantity, token = f.tokens.creator, variantId = f.plainVariantId, lots = []) {
  let r = await send(f, base, `/api/admin/branches/${f.sourceBranchId}/inventory-adjustments`, { method: 'POST', token, body: { adjustmentType: 'OTHER', reason: `${f.prefix} controlled correction` } }); status(r, 201); const id = r.json.data.inventoryAdjustment.inventoryAdjustmentId;
  r = await send(f, base, `/api/admin/branches/${f.sourceBranchId}/inventory-adjustments/${id}/items`, { method: 'POST', token, body: { productVariantId: variantId, quantityChange: quantity, lotAllocations: lots } }); status(r, 201); return id;
}
async function approveAdjustment(f, base, id) { status(await send(f, base, `/api/admin/branches/${f.sourceBranchId}/inventory-adjustments/${id}/approve`, { method: 'POST', token: f.tokens.approver, body: {} }), 200); }

async function createApprovedTransfer(f, base, variantId, quantity, lotAllocations = []) {
  const root = `/api/admin/branches/${f.sourceBranchId}/stock-transfers`;
  let response = await send(f, base, root, { method: 'POST', body: {
    destinationBranchId: f.destinationBranchId, notes: `${f.prefix} concurrency transfer`,
  } });
  status(response, 201);
  const transferId = response.json.data.stockTransfer.stockTransferId;
  response = await send(f, base, `${root}/${transferId}/items`, { method: 'POST', body: {
    productVariantId: variantId, quantityRequested: quantity, lotAllocations,
  } });
  status(response, 201);
  const itemId = response.json.data.item.stockTransferItemId;
  status(await send(f, base, `${root}/${transferId}/request`, { method: 'POST', body: {} }), 200);
  status(await send(f, base, `${root}/${transferId}/approve`, {
    method: 'POST', token: f.tokens.approver, body: {},
  }), 200);
  return { transferId, itemId };
}

async function createReceiptPrerequisite(f) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      `INSERT INTO suppliers (supplier_code, supplier_name, status)
       VALUES (?, ?, 'ACTIVE')`,
      [`TEST_P9_S_${f.token}`, `${f.prefix} concurrency supplier`],
    );
    const supplierId = await lastId(connection);
    await connection.execute(
      `INSERT INTO purchase_orders (
         purchase_order_number, branch_id, supplier_id, status, ordered_at,
         created_by_employee_id, approved_by_employee_id, approved_at,
         currency_code, subtotal_amount, total_amount, notes
       ) VALUES (?, ?, ?, 'APPROVED', UTC_TIMESTAMP(6), ?, ?, UTC_TIMESTAMP(6),
         'NGN', '2.00', '2.00', ?)`,
      [`TEST-P9-PO-${f.token}`, f.sourceBranchId, supplierId,
        f.creatorEmployeeId, f.approverEmployeeId, `${f.prefix} race receipt`],
    );
    const purchaseOrderId = await lastId(connection);
    await connection.execute(
      `INSERT INTO purchase_order_items (
         purchase_order_id, line_number, product_variant_id, product_package_id,
         item_description, ordered_package_quantity, package_conversion_factor,
         ordered_quantity, unit_cost, discount_amount, tax_rate_percent,
         tax_amount, line_total
       ) VALUES (?, 1, ?, ?, ?, '2.000', '1.000000', '2.000',
         '1.0000', '0.00', '0.0000', '0.00', '2.00')`,
      [purchaseOrderId, f.plainVariantId, f.packageIds[0], `${f.prefix} race item`],
    );
    const orderItemId = await lastId(connection);
    await connection.execute(
      `INSERT INTO goods_receipts (
         goods_receipt_number, purchase_order_id, branch_id, supplier_id,
         status, received_at, received_by_employee_id, notes
       ) VALUES (?, ?, ?, ?, 'DRAFT', UTC_TIMESTAMP(6), ?, ?)`,
      [`TEST-P9-GR-${f.token}`, purchaseOrderId, f.sourceBranchId, supplierId,
        f.creatorEmployeeId, `${f.prefix} race receipt`],
    );
    const goodsReceiptId = await lastId(connection);
    await connection.execute(
      `INSERT INTO goods_receipt_items (
         goods_receipt_id, purchase_order_id, purchase_order_item_id,
         product_variant_id, line_number, package_quantity_accepted,
         package_quantity_rejected, package_conversion_factor,
         quantity_accepted, quantity_rejected, actual_unit_cost,
         discount_amount, tax_amount, line_total
       ) VALUES (?, ?, ?, ?, 1, '2.000', '0.000', '1.000000',
         '2.000', '0.000', '1.0000', '0.00', '0.00', '2.00')`,
      [goodsReceiptId, purchaseOrderId, orderItemId, f.plainVariantId],
    );
    await connection.commit();
    f.supplierIds.push(supplierId); f.purchaseOrderIds.push(purchaseOrderId);
    f.goodsReceiptIds.push(goodsReceiptId);
    return goodsReceiptId;
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}

async function snapshotNonPhase9Data(f) {
  const result = {};
  const variantMarks = placeholders(f.variantIds);
  const packageMarks = placeholders(f.packageIds);
  const queries = [
    ['products', 'SELECT * FROM products WHERE product_id = ?', [f.productId]],
    ['variants', `SELECT * FROM product_variants WHERE product_variant_id IN (${variantMarks}) ORDER BY product_variant_id`, f.variantIds],
    ['packages', `SELECT * FROM product_packages WHERE product_package_id IN (${packageMarks}) ORDER BY product_package_id`, f.packageIds],
    ['barcodes', `SELECT * FROM product_barcodes WHERE product_variant_id IN (${variantMarks}) ORDER BY barcode_id`, f.variantIds],
    ['variantPrices', `SELECT * FROM branch_variant_prices WHERE product_variant_id IN (${variantMarks}) ORDER BY branch_id, product_variant_id`, f.variantIds],
    ['packagePrices', `SELECT * FROM branch_package_prices WHERE product_package_id IN (${packageMarks}) ORDER BY branch_id, product_package_id`, f.packageIds],
  ];
  if (f.supplierIds.length) {
    const supplierMarks = placeholders(f.supplierIds);
    queries.push(
      ['suppliers', `SELECT * FROM suppliers WHERE supplier_id IN (${supplierMarks}) ORDER BY supplier_id`, f.supplierIds],
      ['supplierProducts', `SELECT sp.* FROM supplier_products sp WHERE sp.supplier_id IN (${supplierMarks}) ORDER BY sp.supplier_id, sp.product_variant_id`, f.supplierIds],
      ['supplierPackages', `SELECT spp.* FROM supplier_product_packages spp WHERE spp.supplier_id IN (${supplierMarks}) ORDER BY spp.supplier_id, spp.product_package_id`, f.supplierIds],
    );
  }
  if (f.purchaseOrderIds.length) {
    const orderMarks = placeholders(f.purchaseOrderIds);
    queries.push(
      ['purchaseOrders', `SELECT * FROM purchase_orders WHERE purchase_order_id IN (${orderMarks}) ORDER BY purchase_order_id`, f.purchaseOrderIds],
      ['purchaseOrderItems', `SELECT * FROM purchase_order_items WHERE purchase_order_id IN (${orderMarks}) ORDER BY purchase_order_item_id`, f.purchaseOrderIds],
    );
  }
  if (f.goodsReceiptIds.length) {
    const receiptMarks = placeholders(f.goodsReceiptIds);
    queries.push(
      ['goodsReceipts', `SELECT * FROM goods_receipts WHERE goods_receipt_id IN (${receiptMarks}) ORDER BY goods_receipt_id`, f.goodsReceiptIds],
      ['goodsReceiptItems', `SELECT * FROM goods_receipt_items WHERE goods_receipt_id IN (${receiptMarks}) ORDER BY goods_receipt_item_id`, f.goodsReceiptIds],
      ['goodsReceiptLots', `SELECT gril.* FROM goods_receipt_item_lots gril INNER JOIN goods_receipt_items gri ON gri.goods_receipt_item_id = gril.goods_receipt_item_id WHERE gri.goods_receipt_id IN (${receiptMarks}) ORDER BY gril.goods_receipt_item_lot_id`, f.goodsReceiptIds],
    );
  }
  for (const [name, sql, values] of queries) {
    const [rows] = await pool.execute(sql, values);
    result[name] = rows;
  }
  return result;
}

async function replaceFixturePermissions(f, permissionCodes) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute('DELETE FROM role_permissions WHERE role_id = ?', [f.noneRoleId]);
    if (permissionCodes.length) {
      const marks = placeholders(permissionCodes);
      await connection.execute(
        `INSERT INTO role_permissions (role_id, permission_id)
         SELECT ?, permission_id FROM permissions WHERE permission_code IN (${marks})`,
        [f.noneRoleId, ...permissionCodes],
      );
    }
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}

async function replaceFixtureUserRole(f, userId, roleId, branchId = null) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute('DELETE FROM user_roles WHERE user_id = ?', [userId]);
    await connection.execute(
      'INSERT INTO user_roles (user_id, role_id, branch_id) VALUES (?, ?, ?)',
      [userId, roleId, branchId],
    );
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}

test('Phase 9 stock adjustments, counts, and transfers', { timeout: TIMEOUT }, async (t) => {
  const fixture = { token: randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase(), request: 0, setup: false }; fixture.prefix = `TEST_P9_${fixture.token}`;
  let server;
  try {
    await setup(fixture); server = await startServer(); const base = `http://127.0.0.1:${server.address().port}`; const root = `/api/admin/branches/${fixture.sourceBranchId}`;

    await t.test('defines exactly 38 unique Phase 9 routes with no aliases', async () => {
      assert.equal(routeMatrix.length, 38); assert.equal(new Set(routeMatrix.map(([m, p]) => `${m} ${p}`)).size, 38);
      let definitions = 0; for (const file of ['adjustment.routes.js', 'count.routes.js', 'transfer.routes.js']) { const source = await readFile(new URL(`../src/routes/admin/inventoryOperations/${file}`, import.meta.url), 'utf8'); definitions += [...source.matchAll(/router\.(?:get|post|patch|delete)\(/g)].length; } assert.equal(definitions, 38);
      for (const [method, path] of routeMatrix) {
        const body = ['POST', 'PATCH'].includes(method) ? {} : undefined;
        status(await send(fixture, base, `${root}/${path}`, { method, token: null, body }), 401);
        status(await send(fixture, base, `${root}/${path}`, { method, token: fixture.tokens.must, body }), 403);
        status(await send(fixture, base, `${root}/${path}`, { method, token: fixture.tokens.none, body }), 403);
      }
    });

    await t.test('isolates every Phase 9 permission and branch scope across the route matrix', async () => {
      const families = [
        {
          routes: routeMatrix.slice(0, 11), read: 'inventory_adjustments.read',
          manage: 'inventory_adjustments.manage',
          unrelated: [
            ['inventory.read', 'inventory.manage'],
            ['stock_counts.read', 'stock_counts.manage'],
            ['stock_transfers.read', 'stock_transfers.manage'],
          ],
        },
        {
          routes: routeMatrix.slice(11, 26), read: 'stock_counts.read',
          manage: 'stock_counts.manage',
          unrelated: [
            ['inventory.read', 'inventory.manage'],
            ['inventory_adjustments.read', 'inventory_adjustments.manage'],
            ['stock_transfers.read', 'stock_transfers.manage'],
          ],
        },
        {
          routes: routeMatrix.slice(26), read: 'stock_transfers.read',
          manage: 'stock_transfers.manage',
          unrelated: [
            ['inventory.read', 'inventory.manage'],
            ['inventory_adjustments.read', 'inventory_adjustments.manage'],
            ['stock_counts.read', 'stock_counts.manage'],
          ],
        },
      ];
      const exercise = async (routes, token, expected, predicate = null) => {
        for (const [method, path] of routes) {
          const response = await send(fixture, base, `${root}/${path}`, {
            method, token, body: ['POST', 'PATCH'].includes(method) ? {} : undefined,
          });
          if (predicate) assert(predicate(response.status), response.text);
          else status(response, expected);
        }
      };
      try {
        for (const family of families) {
          for (const grants of family.unrelated) {
            await replaceFixturePermissions(fixture, grants);
            await exercise(family.routes, fixture.tokens.none, 403);
          }

          await replaceFixturePermissions(fixture, [family.read, family.manage]);
          await replaceFixtureUserRole(
            fixture, fixture.noneUserId, fixture.noneRoleId, fixture.otherBranchId,
          );
          await exercise(family.routes, fixture.tokens.none, 403);
          await replaceFixtureUserRole(fixture, fixture.noneUserId, fixture.noneRoleId);

          await replaceFixturePermissions(fixture, [family.read]);
          await exercise(family.routes.filter(([method]) => method === 'GET'),
            fixture.tokens.none, null, (code) => code === 200 || code === 404);
          await exercise(family.routes.filter(([method]) => method !== 'GET'),
            fixture.tokens.none, 403);

          await replaceFixturePermissions(fixture, [family.manage]);
          await replaceFixtureUserRole(fixture, fixture.creatorUserId, fixture.noneRoleId);
          await exercise(family.routes.filter(([method]) => method === 'GET'),
            fixture.tokens.creator, 403);
          await exercise(family.routes.filter(([method]) => method !== 'GET'),
            fixture.tokens.creator, null,
            (code) => [200, 201, 400, 404, 409].includes(code));
          await replaceFixtureUserRole(fixture, fixture.creatorUserId, fixture.systemRoleId);
        }

        for (const [path, body] of [
          ['inventory-adjustments', { adjustmentType: 'OTHER', reason: 'Unlinked actor check' }],
          ['stock-counts', { countType: 'SPOT' }],
          ['stock-transfers', { destinationBranchId: fixture.destinationBranchId }],
        ]) {
          status(await send(fixture, base, `${root}/${path}`, { token: fixture.tokens.system }), 200);
          status(await send(fixture, base, `${root}/${path}`, {
            method: 'POST', token: fixture.tokens.system, body,
          }), 403);
        }
      } finally {
        await replaceFixtureUserRole(fixture, fixture.creatorUserId, fixture.systemRoleId);
        await replaceFixtureUserRole(fixture, fixture.noneUserId, fixture.noneRoleId);
        await replaceFixturePermissions(fixture, []);
      }
    });

    await t.test('enforces password, permission, and operational-employee gates', async () => {
      status(await send(fixture, base, `${root}/inventory-adjustments`, { token: fixture.tokens.must }), 403);
      status(await send(fixture, base, `${root}/stock-counts`, { token: fixture.tokens.none }), 403);
      status(await send(fixture, base, `${root}/stock-transfers`, { token: fixture.tokens.system }), 200);
      status(await send(fixture, base, `${root}/inventory-adjustments`, { method: 'POST', token: fixture.tokens.system, body: { adjustmentType: 'DAMAGE', reason: 'Cannot act without employee' } }), 403);
    });

    await t.test('enforces BIGINT, exact-decimal, and server-owned-field boundaries', async () => {
      const unsignedMax = '18446744073709551615';
      status(await send(fixture, base, '/api/admin/branches/not-an-id/inventory-adjustments'), 400);
      status(await send(fixture, base, `/api/admin/branches/${unsignedMax}/inventory-adjustments`), 404);
      status(await send(fixture, base, `${root}/inventory-adjustments/not-an-id`), 400);
      status(await send(fixture, base, `${root}/inventory-adjustments/${unsignedMax}`), 404);
      status(await send(fixture, base, `${root}/stock-counts/${unsignedMax}`), 404);
      status(await send(fixture, base, `${root}/stock-transfers/${unsignedMax}`), 404);
      status(await send(fixture, base, `${root}/inventory-adjustments?limit=101`), 400);

      status(await send(fixture, base, `${root}/inventory-adjustments`, {
        method: 'POST', body: { adjustmentType: 'DAMAGE', reason: 'Forbidden field', status: 'POSTED' },
      }), 400);
      status(await send(fixture, base, `${root}/inventory-adjustments`, {
        method: 'POST', body: { adjustmentType: 'DAMAGE', reason: 'x'.repeat(1001) },
      }), 400);
      status(await send(fixture, base, `${root}/stock-counts`, {
        method: 'POST', body: { countType: 'SPOT', status: 'POSTED' },
      }), 400);
      status(await send(fixture, base, `${root}/stock-transfers`, {
        method: 'POST', body: { destinationBranchId: fixture.sourceBranchId },
      }), 409);

      const response = await send(fixture, base, `${root}/inventory-adjustments`, {
        method: 'POST', body: { adjustmentType: 'OTHER', reason: `${fixture.prefix} validation boundary` },
      });
      status(response, 201);
      const adjustmentId = response.json.data.inventoryAdjustment.inventoryAdjustmentId;
      const itemUrl = `${root}/inventory-adjustments/${adjustmentId}/items`;
      for (const quantityChange of [0, '0.000', '1e3', '1000000000000.000']) {
        status(await send(fixture, base, itemUrl, {
          method: 'POST', body: { productVariantId: fixture.plainVariantId, quantityChange },
        }), 400);
      }
      status(await send(fixture, base, itemUrl, {
        method: 'POST', body: { productVariantId: fixture.plainVariantId, quantityChange: '1.500' },
      }), 409);
      const exact = await send(fixture, base, itemUrl, {
        method: 'POST', body: {
          productVariantId: fixture.plainVariantId,
          quantityChange: '999999999999.000',
          unitCost: '999999999999999.9999',
        },
      });
      status(exact, 201);
      assert.equal(exact.json.data.item.quantityChange, '999999999999.000');
      assert.equal(exact.json.data.item.unitCost, '999999999999999.9999');
    });

    await t.test('posts signed adjustments atomically and exposes ledger evidence', async () => {
      const id = await createAdjustment(fixture, base, '-2.000');
      status(await send(fixture, base, `${root}/inventory-adjustments/${id}/approve`, { method: 'POST', body: {} }), 409);
      await approveAdjustment(fixture, base, id);
      const posted = await send(fixture, base, `${root}/inventory-adjustments/${id}/post`, { method: 'POST', body: {} }); status(posted, 200);
      status(await send(fixture, base, `${root}/inventory-adjustments/${id}/post`, { method: 'POST', body: {} }), 409);
      const ledger = await send(fixture, base, `${root}/inventory-adjustments/${id}/ledger`); status(ledger, 200); assert.equal(ledger.json.data.inventoryTransaction.transactionType, 'ADJUSTMENT');
      const [rows] = await pool.execute(`SELECT bi.quantity_on_hand AS stock, iti.quantity_change AS movement FROM branch_inventory bi INNER JOIN inventory_adjustments ia ON ia.branch_id = bi.branch_id INNER JOIN inventory_transaction_items iti ON iti.inventory_transaction_id = ia.inventory_transaction_id AND iti.product_variant_id = bi.product_variant_id WHERE ia.inventory_adjustment_id = ? AND bi.product_variant_id = ?`, [id, fixture.plainVariantId]); assert.deepEqual(rows[0], { stock: '18.000', movement: '-2.000' });
      status(await send(fixture, base, `${root}/inventory-adjustments/${id}`, { method: 'PATCH', body: { reason: 'immutable' } }), 409);
    });

    await t.test('enforces lot policy and updates required-lot projections exactly', async () => {
      const id = await createAdjustment(fixture, base, '-2.000', fixture.tokens.creator, fixture.lotVariantId, [{ inventoryLotId: fixture.lotId, quantityChange: '-2.000' }]); await approveAdjustment(fixture, base, id); status(await send(fixture, base, `${root}/inventory-adjustments/${id}/post`, { method: 'POST', body: {} }), 200);
      const [rows] = await pool.execute(`SELECT bi.quantity_on_hand AS total, bli.quantity_on_hand AS lot FROM branch_inventory bi INNER JOIN branch_lot_inventory bli ON bli.branch_id = bi.branch_id WHERE bi.branch_id = ? AND bi.product_variant_id = ? AND bli.inventory_lot_id = ?`, [fixture.sourceBranchId, fixture.lotVariantId, fixture.lotId]); assert.deepEqual(rows[0], { total: '8.000', lot: '8.000' });
      const bad = await send(fixture, base, `${root}/inventory-adjustments`, { method: 'POST', body: { adjustmentType: 'BAD', reason: 'bad' } }); status(bad, 400);
    });

    await t.test('captures, counts, completes, and posts an exact count correction', async () => {
      let r = await send(fixture, base, `${root}/stock-counts`, { method: 'POST', body: { countType: 'SPOT', notes: 'Plain SKU count' } }); status(r, 201); const id = r.json.data.stockCount.stockCountId;
      r = await send(fixture, base, `${root}/stock-counts/${id}/items`, { method: 'POST', body: { productVariantId: fixture.plainVariantId } }); status(r, 201); const itemId = r.json.data.item.stockCountItemId;
      status(await send(fixture, base, `${root}/stock-counts/${id}/start`, { method: 'POST', body: {} }), 200);
      status(await send(fixture, base, `${root}/stock-counts/${id}/items/${itemId}`, { method: 'PATCH', body: { countedQuantity: '17.000', varianceReason: 'One unit missing' } }), 200);
      status(await send(fixture, base, `${root}/stock-counts/${id}/complete`, { method: 'POST', body: {} }), 200);
      status(await send(fixture, base, `${root}/stock-counts/${id}/post`, { method: 'POST', token: fixture.tokens.approver, body: {} }), 200);
      const variance = await send(fixture, base, `${root}/stock-counts/${id}/variance`); status(variance, 200); assert.equal(variance.json.data.items[0].systemQuantity, '18.000'); assert.equal(variance.json.data.items[0].varianceQuantity, '-1.000');
      const [rows] = await pool.execute('SELECT quantity_on_hand AS quantity FROM branch_inventory WHERE branch_id = ? AND product_variant_id = ?', [fixture.sourceBranchId, fixture.plainVariantId]); assert.equal(rows[0].quantity, '17.000');
    });

    await t.test('rejects a stale count after an intervening stock movement', async () => {
      let r = await send(fixture, base, `${root}/stock-counts`, { method: 'POST', body: { countType: 'SPOT' } }); const countId = r.json.data.stockCount.stockCountId; r = await send(fixture, base, `${root}/stock-counts/${countId}/items`, { method: 'POST', body: { productVariantId: fixture.plainVariantId } }); const itemId = r.json.data.item.stockCountItemId;
      status(await send(fixture, base, `${root}/stock-counts/${countId}/start`, { method: 'POST', body: {} }), 200); status(await send(fixture, base, `${root}/stock-counts/${countId}/items/${itemId}`, { method: 'PATCH', body: { countedQuantity: '17.000' } }), 200); status(await send(fixture, base, `${root}/stock-counts/${countId}/complete`, { method: 'POST', body: {} }), 200);
      const adjustmentId = await createAdjustment(fixture, base, '1.000'); await approveAdjustment(fixture, base, adjustmentId); status(await send(fixture, base, `${root}/inventory-adjustments/${adjustmentId}/post`, { method: 'POST', body: {} }), 200);
      status(await send(fixture, base, `${root}/stock-counts/${countId}/post`, { method: 'POST', token: fixture.tokens.approver, body: {} }), 409);
    });

    await t.test('dispatches and receives a partial lot-preserving transfer', async () => {
      let r = await send(fixture, base, `${root}/stock-transfers`, { method: 'POST', body: { destinationBranchId: fixture.destinationBranchId, notes: 'Required lot transfer' } }); status(r, 201); const id = r.json.data.stockTransfer.stockTransferId;
      r = await send(fixture, base, `${root}/stock-transfers/${id}/items`, { method: 'POST', body: { productVariantId: fixture.lotVariantId, quantityRequested: '3.000', lotAllocations: [{ inventoryLotId: fixture.lotId, quantityRequested: '3.000' }] } }); status(r, 201); const itemId = r.json.data.item.stockTransferItemId;
      status(await send(fixture, base, `${root}/stock-transfers/${id}/request`, { method: 'POST', body: {} }), 200); status(await send(fixture, base, `${root}/stock-transfers/${id}/approve`, { method: 'POST', token: fixture.tokens.approver, body: {} }), 200);
      status(await send(fixture, base, `${root}/stock-transfers/${id}/dispatch`, { method: 'POST', body: { items: [{ stockTransferItemId: itemId, quantityDispatched: '3.000', lots: [{ inventoryLotId: fixture.lotId, quantityDispatched: '3.000' }] }] } }), 200);
      status(await send(fixture, base, `${root}/stock-transfers/${id}/dispatch`, { method: 'POST', body: { items: [{ stockTransferItemId: itemId, quantityDispatched: '3.000', lots: [{ inventoryLotId: fixture.lotId, quantityDispatched: '3.000' }] }] } }), 409);
      const destinationRoot = `/api/admin/branches/${fixture.destinationBranchId}`;
      status(await send(fixture, base, `${root}/stock-transfers/${id}/receive`, { method: 'POST', body: { items: [{ stockTransferItemId: itemId, quantityReceived: '2.000', lots: [{ inventoryLotId: fixture.lotId, quantityReceived: '2.000' }] }] } }), 404);
      r = await send(fixture, base, `${destinationRoot}/stock-transfers/${id}/receive`, { method: 'POST', token: fixture.tokens.approver, body: { items: [{ stockTransferItemId: itemId, quantityReceived: '2.000', lots: [{ inventoryLotId: fixture.lotId, quantityReceived: '2.000' }] }] } }); status(r, 200); assert.equal(r.json.data.stockTransfer.status, 'RECEIVED'); assert.equal(r.json.data.items[0].quantityInTransit, '1.000'); assert.equal(r.json.data.sourceLedger.transactionType, 'TRANSFER_OUT'); assert.equal(r.json.data.destinationLedger.transactionType, 'TRANSFER_IN');
      const [rows] = await pool.execute(`SELECT CAST(branch_id AS CHAR) AS branchId, quantity_on_hand AS quantity FROM branch_inventory WHERE product_variant_id = ? AND branch_id IN (?, ?) ORDER BY branch_id`, [fixture.lotVariantId, fixture.sourceBranchId, fixture.destinationBranchId]); const byBranch = Object.fromEntries(rows.map((row) => [row.branchId, row.quantity])); assert.equal(byBranch[fixture.sourceBranchId], '5.000'); assert.equal(byBranch[fixture.destinationBranchId], '2.000');
      const [lots] = await pool.execute('SELECT CAST(branch_id AS CHAR) AS branchId, quantity_on_hand AS quantity FROM branch_lot_inventory WHERE inventory_lot_id = ? ORDER BY branch_id', [fixture.lotId]); const lotByBranch = Object.fromEntries(lots.map((row) => [row.branchId, row.quantity])); assert.equal(lotByBranch[fixture.sourceBranchId], '5.000'); assert.equal(lotByBranch[fixture.destinationBranchId], '2.000');
      status(await send(fixture, base, `/api/admin/branches/${fixture.otherBranchId}/stock-transfers/${id}`, { token: fixture.tokens.system }), 404); status(await send(fixture, base, `${root}/stock-transfers/${id}/cancel`, { method: 'POST', body: {} }), 409);
    });

    await t.test('serializes competing negative adjustments without negative stock', async () => {
      const ids = [await createAdjustment(fixture, base, '-15.000'), await createAdjustment(fixture, base, '-15.000')]; for (const id of ids) await approveAdjustment(fixture, base, id);
      const results = await Promise.all(ids.map((id) => send(fixture, base, `${root}/inventory-adjustments/${id}/post`, { method: 'POST', body: {} }))); assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
      const [rows] = await pool.execute('SELECT quantity_on_hand AS quantity FROM branch_inventory WHERE branch_id = ? AND product_variant_id = ?', [fixture.sourceBranchId, fixture.plainVariantId]); assert.equal(rows[0].quantity, '3.000');
    });

    await t.test('serializes a Phase 7 receipt against a negative adjustment', async () => {
      const receiptId = await createReceiptPrerequisite(fixture);
      const adjustmentId = await createAdjustment(fixture, base, '-1.000');
      await approveAdjustment(fixture, base, adjustmentId);
      const [receipt, adjustment] = await Promise.all([
        send(fixture, base, `${root}/goods-receipts/${receiptId}/post`, {
          method: 'POST', body: {},
        }),
        send(fixture, base, `${root}/inventory-adjustments/${adjustmentId}/post`, {
          method: 'POST', body: {},
        }),
      ]);
      status(receipt, 200); status(adjustment, 200);
      const [rows] = await pool.execute(
        'SELECT quantity_on_hand AS quantity FROM branch_inventory WHERE branch_id = ? AND product_variant_id = ?',
        [fixture.sourceBranchId, fixture.plainVariantId],
      );
      assert.equal(rows[0].quantity, '4.000');
    });

    await t.test('preserves reorder settings during an adjustment race', async () => {
      const adjustmentId = await createAdjustment(fixture, base, '2.000');
      await approveAdjustment(fixture, base, adjustmentId);
      const [posted, configured] = await Promise.all([
        send(fixture, base, `${root}/inventory-adjustments/${adjustmentId}/post`, {
          method: 'POST', body: {},
        }),
        send(fixture, base, `${root}/inventory/variants/${fixture.plainVariantId}/settings`, {
          method: 'PUT', body: { reorderLevel: '7.000', reorderQuantity: '9.000' },
        }),
      ]);
      status(posted, 200); status(configured, 200);
      const [rows] = await pool.execute(
        `SELECT quantity_on_hand AS quantity, reorder_level AS reorderLevel,
           reorder_quantity AS reorderQuantity FROM branch_inventory
         WHERE branch_id = ? AND product_variant_id = ?`,
        [fixture.sourceBranchId, fixture.plainVariantId],
      );
      assert.deepEqual(rows[0], {
        quantity: '6.000', reorderLevel: '7.000', reorderQuantity: '9.000',
      });
    });

    await t.test('preserves quantity and stricter branch-lot state during a race', async () => {
      const adjustmentId = await createAdjustment(
        fixture, base, '-1.000', fixture.tokens.creator, fixture.lotVariantId,
        [{ inventoryLotId: fixture.lotId, quantityChange: '-1.000' }],
      );
      await approveAdjustment(fixture, base, adjustmentId);
      const [posted, blocked] = await Promise.all([
        send(fixture, base, `${root}/inventory-adjustments/${adjustmentId}/post`, {
          method: 'POST', body: {},
        }),
        send(fixture, base, `${root}/inventory/lots/${fixture.lotId}/status`, {
          method: 'PATCH', body: { status: 'BLOCKED' },
        }),
      ]);
      status(posted, 200); status(blocked, 200);
      const [rows] = await pool.execute(
        `SELECT quantity_on_hand AS quantity, status FROM branch_lot_inventory
         WHERE branch_id = ? AND inventory_lot_id = ?`,
        [fixture.sourceBranchId, fixture.lotId],
      );
      assert.deepEqual(rows[0], { quantity: '4.000', status: 'BLOCKED' });
    });

    await t.test('serializes two transfer dispatches and a transfer-adjustment race', async () => {
      const first = await createApprovedTransfer(fixture, base, fixture.raceVariantId, '4.000');
      const second = await createApprovedTransfer(fixture, base, fixture.raceVariantId, '4.000');
      const dispatch = ({ transferId, itemId }) => send(
        fixture, base, `${root}/stock-transfers/${transferId}/dispatch`, {
          method: 'POST', body: { items: [{ stockTransferItemId: itemId, quantityDispatched: '4.000', lots: [] }] },
        },
      );
      const results = await Promise.all([dispatch(first), dispatch(second)]);
      assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
      let [rows] = await pool.execute(
        'SELECT quantity_on_hand AS quantity FROM branch_inventory WHERE branch_id = ? AND product_variant_id = ?',
        [fixture.sourceBranchId, fixture.raceVariantId],
      );
      assert.equal(rows[0].quantity, '1.000');

      const replenish = await createAdjustment(fixture, base, '5.000', fixture.tokens.creator, fixture.raceVariantId);
      await approveAdjustment(fixture, base, replenish);
      status(await send(fixture, base, `${root}/inventory-adjustments/${replenish}/post`, { method: 'POST', body: {} }), 200);
      const transfer = await createApprovedTransfer(fixture, base, fixture.raceVariantId, '4.000');
      const reduction = await createAdjustment(fixture, base, '-4.000', fixture.tokens.creator, fixture.raceVariantId);
      await approveAdjustment(fixture, base, reduction);
      const raced = await Promise.all([
        dispatch(transfer),
        send(fixture, base, `${root}/inventory-adjustments/${reduction}/post`, { method: 'POST', body: {} }),
      ]);
      assert.deepEqual(raced.map((result) => result.status).sort(), [200, 409]);
      [rows] = await pool.execute(
        'SELECT quantity_on_hand AS quantity FROM branch_inventory WHERE branch_id = ? AND product_variant_id = ?',
        [fixture.sourceBranchId, fixture.raceVariantId],
      );
      assert.equal(rows[0].quantity, '2.000');
    });

    await t.test('preserves destination settings and lot state during receive races', async () => {
      const plain = await createApprovedTransfer(fixture, base, fixture.plainVariantId, '2.000');
      status(await send(fixture, base, `${root}/stock-transfers/${plain.transferId}/dispatch`, {
        method: 'POST', body: { items: [{ stockTransferItemId: plain.itemId, quantityDispatched: '2.000', lots: [] }] },
      }), 200);
      const destinationRoot = `/api/admin/branches/${fixture.destinationBranchId}`;
      const [received, configured] = await Promise.all([
        send(fixture, base, `${destinationRoot}/stock-transfers/${plain.transferId}/receive`, {
          method: 'POST', body: { items: [{ stockTransferItemId: plain.itemId, quantityReceived: '2.000', lots: [] }] },
        }),
        send(fixture, base, `${destinationRoot}/inventory/variants/${fixture.plainVariantId}/settings`, {
          method: 'PUT', body: { reorderLevel: '4.000', reorderQuantity: '8.000' },
        }),
      ]);
      status(received, 200); status(configured, 200);
      let [rows] = await pool.execute(
        `SELECT quantity_on_hand AS quantity, reorder_level AS reorderLevel,
           reorder_quantity AS reorderQuantity FROM branch_inventory
         WHERE branch_id = ? AND product_variant_id = ?`,
        [fixture.destinationBranchId, fixture.plainVariantId],
      );
      assert.deepEqual(rows[0], {
        quantity: '2.000', reorderLevel: '4.000', reorderQuantity: '8.000',
      });

      status(await send(fixture, base, `${root}/inventory/lots/${fixture.lotId}/status`, {
        method: 'PATCH', body: { status: 'AVAILABLE' },
      }), 200);
      const lotTransfer = await createApprovedTransfer(
        fixture, base, fixture.lotVariantId, '2.000',
        [{ inventoryLotId: fixture.lotId, quantityRequested: '2.000' }],
      );
      status(await send(fixture, base, `${root}/stock-transfers/${lotTransfer.transferId}/dispatch`, {
        method: 'POST', body: { items: [{ stockTransferItemId: lotTransfer.itemId,
          quantityDispatched: '2.000', lots: [{ inventoryLotId: fixture.lotId,
            quantityDispatched: '2.000' }] }] },
      }), 200);
      const [lotReceived, lotBlocked] = await Promise.all([
        send(fixture, base, `${destinationRoot}/stock-transfers/${lotTransfer.transferId}/receive`, {
          method: 'POST', body: { items: [{ stockTransferItemId: lotTransfer.itemId,
            quantityReceived: '2.000', lots: [{ inventoryLotId: fixture.lotId,
              quantityReceived: '2.000' }] }] },
        }),
        send(fixture, base, `${destinationRoot}/inventory/lots/${fixture.lotId}/status`, {
          method: 'PATCH', body: { status: 'BLOCKED' },
        }),
      ]);
      status(lotReceived, 200); status(lotBlocked, 200);
      [rows] = await pool.execute(
        `SELECT quantity_on_hand AS quantity, status FROM branch_lot_inventory
         WHERE branch_id = ? AND inventory_lot_id = ?`,
        [fixture.destinationBranchId, fixture.lotId],
      );
      assert.deepEqual(rows[0], { quantity: '4.000', status: 'BLOCKED' });
    });

    await t.test('does not mutate catalog, pricing, supplier, or purchasing history', async () => {
      const before = await snapshotNonPhase9Data(fixture);
      const adjustmentId = await createAdjustment(fixture, base, '1.000');
      await approveAdjustment(fixture, base, adjustmentId);
      status(await send(fixture, base, `${root}/inventory-adjustments/${adjustmentId}/post`, {
        method: 'POST', body: {},
      }), 200);
      assert.deepEqual(await snapshotNonPhase9Data(fixture), before);
    });

    await t.test('keeps ledgers append-only, audits committed writes, and exposes no generic write API', async () => {
      const [audit] = await pool.execute(`SELECT action_type AS actionType, COUNT(*) AS count FROM audit_logs WHERE request_id LIKE ? GROUP BY action_type`, [`${fixture.prefix}%`]); const actions = new Set(audit.map((row) => row.actionType)); for (const expected of ['INVENTORY_ADJUSTMENT_POSTED', 'STOCK_COUNT_POSTED', 'STOCK_TRANSFER_DISPATCHED', 'STOCK_TRANSFER_RECEIVED']) assert(actions.has(expected));
      for (const [method, path] of [['POST', `${root}/inventory/transactions`], ['PATCH', `${root}/inventory/transactions/1`], ['DELETE', `${root}/inventory/transactions/1`], ['PATCH', `${root}/inventory/variants/${fixture.plainVariantId}`], ['DELETE', `${root}/inventory-adjustments/1`], ['DELETE', `${root}/stock-counts/1`], ['DELETE', `${root}/stock-transfers/1`]]) status(await send(fixture, base, path, { method }), 404);
    });
  } finally {
    await stopServer(server); await cleanup(fixture);
    const [left] = await pool.execute(`SELECT COUNT(*) AS count FROM branches WHERE branch_name LIKE 'TEST_P9_%'`); assert.equal(left[0].count, '0');
    await pool.end();
  }
});
