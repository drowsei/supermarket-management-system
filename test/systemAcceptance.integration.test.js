import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import bcrypt from 'bcrypt';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const [{ default: app }, { pool }] = await Promise.all([
  import('../src/app.js'),
  import('../src/config/database.js'),
]);

const placeholders = (ids) => ids.map(() => '?').join(', ');

async function lastId(connection) {
  const [rows] = await connection.execute('SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id');
  return rows[0].id;
}

async function setup(fixture) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [roles] = await connection.execute(
      "SELECT CAST(role_id AS CHAR) AS id FROM roles WHERE role_code = 'SYSTEM_ADMIN' AND is_active = 1",
    );
    assert.equal(roles.length, 1, 'Acceptance requires the existing canonical role');
    fixture.branchIds = [];
    for (const suffix of ['A', 'B']) {
      await connection.execute(
        `INSERT INTO branches (branch_code, branch_name, address_line_1, city,
           country_code, currency_code, timezone, status)
         VALUES (?, ?, '18 Acceptance Street', 'Lagos', 'NG', 'NGN', 'Africa/Lagos', 'ACTIVE')`,
        [`P18${suffix}_${fixture.token}`, `${fixture.prefix} Branch ${suffix}`],
      );
      fixture.branchIds.push(await lastId(connection));
    }
    [fixture.branchId, fixture.otherBranchId] = fixture.branchIds;
    await connection.execute(
      `INSERT INTO employees (employee_number, first_name, last_name, phone,
         hire_date, employment_status) VALUES (?, 'Acceptance', ?, '08000000018',
         '2020-01-01', 'ACTIVE')`,
      [`P18E_${fixture.token}`, fixture.prefix],
    );
    fixture.employeeId = await lastId(connection);
    await connection.execute(
      `INSERT INTO employee_branch_assignments (employee_id, branch_id, job_title,
         started_on, is_primary) VALUES (?, ?, 'Acceptance cashier', '2020-01-01', 1)`,
      [fixture.employeeId, fixture.branchId],
    );
    fixture.username = `p18.${fixture.token.toLowerCase()}`;
    fixture.password = `Acceptance-${fixture.token}-Only!`;
    const hash = await bcrypt.hash(fixture.password, Number(process.env.BCRYPT_ROUNDS));
    await connection.execute(
      `INSERT INTO users (employee_id, username, email, password_hash,
         is_active, must_change_password) VALUES (?, ?, ?, ?, 1, 0)`,
      [fixture.employeeId, fixture.username, `${fixture.username}@example.invalid`, hash],
    );
    fixture.userId = await lastId(connection);
    await connection.execute('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)',
      [fixture.userId, roles[0].id]);
    await connection.execute(
      'INSERT INTO categories (category_code, category_name, is_active) VALUES (?, ?, 1)',
      [`P18C_${fixture.token}`, `${fixture.prefix} Category`],
    );
    fixture.categoryId = await lastId(connection);
    await connection.execute(
      `INSERT INTO units_of_measure (unit_code, unit_name, symbol, allows_fraction)
       VALUES (?, ?, 'ea', 0)`,
      [`P18U_${fixture.token}`, `${fixture.prefix} Each`],
    );
    fixture.unitId = await lastId(connection);
    await connection.execute(
      `INSERT INTO return_reasons (reason_code, reason_name, default_restockable,
         requires_approval, is_active) VALUES (?, ?, 1, 0, 1)`,
      [`P18R_${fixture.token}`, `${fixture.prefix} Unopened return`],
    );
    fixture.returnReasonId = await lastId(connection);
    await connection.commit();
    fixture.ready = true;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function cleanup(fixture) {
  if (!fixture.ready || fixture.cleaned) return;
  const connection = await pool.getConnection();
  const del = async (table, column, ids) => {
    const present = ids.filter((id) => id !== undefined);
    if (present.length) await connection.execute(
      `DELETE FROM ${table} WHERE ${column} IN (${placeholders(present)})`, present,
    );
  };
  try {
    await connection.beginTransaction();
    // Recover IDs even if a committed HTTP response failed a later assertion.
    for (const [property, table, column, markerColumn, marker] of [
      ['productId', 'products', 'product_id', 'product_code', fixture.prefix],
      ['variantId', 'product_variants', 'product_variant_id', 'sku', `${fixture.prefix}_SKU`],
      ['supplierId', 'suppliers', 'supplier_id', 'supplier_code', fixture.prefix],
      ['customerId', 'customers', 'customer_id', 'last_name', fixture.prefix],
    ]) {
      const [rows] = await connection.execute(
        `SELECT CAST(${column} AS CHAR) AS id FROM ${table} WHERE ${markerColumn} = ?`, [marker],
      );
      assert.ok(rows.length <= 1);
      if (rows.length) fixture[property] = rows[0].id;
    }
    const [methods] = await connection.execute(
      `SELECT CAST(payment_method_id AS CHAR) AS id FROM payment_methods WHERE method_code IN (?, ?)`,
      [`P18_CASH_${fixture.token}`, `P18_CARD_${fixture.token}`],
    );
    fixture.methodIds = methods.map(({ id }) => id);
    await connection.execute('DELETE FROM audit_logs WHERE user_id = ?', [fixture.userId]);
    const [transactions] = await connection.execute(
      'SELECT CAST(inventory_transaction_id AS CHAR) AS id FROM inventory_transactions WHERE branch_id = ?',
      [fixture.branchId],
    );
    const [saleItems] = await connection.execute(
      `SELECT CAST(si.sale_item_id AS CHAR) AS id FROM sale_items si
       JOIN sales s ON s.sale_id = si.sale_id WHERE s.branch_id = ?`, [fixture.branchId],
    );
    await connection.execute(
      `DELETE sp FROM sale_payments sp JOIN sales s ON s.sale_id = sp.sale_id
       WHERE s.branch_id = ?`, [fixture.branchId],
    );
    await connection.execute(
      `DELETE sri FROM sales_return_items sri JOIN sales_returns sr
       ON sr.sales_return_id = sri.sales_return_id WHERE sr.branch_id = ?`, [fixture.branchId],
    );
    await del('sales_returns', 'branch_id', [fixture.branchId]);
    await del('sale_item_lots', 'sale_item_id', saleItems.map(({ id }) => id));
    await del('sale_items', 'sale_item_id', saleItems.map(({ id }) => id));
    await del('sales', 'branch_id', [fixture.branchId]);
    await connection.execute(
      `DELETE gril FROM goods_receipt_item_lots gril JOIN goods_receipt_items gri
         ON gri.goods_receipt_item_id = gril.goods_receipt_item_id
       JOIN goods_receipts gr ON gr.goods_receipt_id = gri.goods_receipt_id
       WHERE gr.branch_id = ?`, [fixture.branchId],
    );
    await connection.execute(
      `DELETE gri FROM goods_receipt_items gri JOIN goods_receipts gr
       ON gr.goods_receipt_id = gri.goods_receipt_id WHERE gr.branch_id = ?`, [fixture.branchId],
    );
    await del('goods_receipts', 'branch_id', [fixture.branchId]);
    for (const { id } of transactions) {
      await connection.execute(
        `DELETE itla FROM inventory_transaction_lot_allocations itla
         JOIN inventory_transaction_items iti
           ON iti.inventory_transaction_item_id = itla.inventory_transaction_item_id
         WHERE iti.inventory_transaction_id = ?`, [id],
      );
    }
    await del('inventory_transaction_items', 'inventory_transaction_id', transactions.map(({ id }) => id));
    await del('inventory_transactions', 'inventory_transaction_id', transactions.map(({ id }) => id));
    await del('branch_lot_inventory', 'branch_id', fixture.branchIds);
    await del('branch_inventory', 'branch_id', fixture.branchIds);
    await del('inventory_lots', 'product_variant_id', [fixture.variantId]);
    await connection.execute(
      `DELETE poi FROM purchase_order_items poi JOIN purchase_orders po
       ON po.purchase_order_id = poi.purchase_order_id WHERE po.branch_id = ?`, [fixture.branchId],
    );
    await del('purchase_orders', 'branch_id', [fixture.branchId]);
    await del('supplier_product_packages', 'supplier_id', [fixture.supplierId]);
    await del('supplier_products', 'supplier_id', [fixture.supplierId]);
    await del('suppliers', 'supplier_id', [fixture.supplierId]);
    await del('branch_variant_prices', 'branch_id', fixture.branchIds);
    await del('product_barcodes', 'product_variant_id', [fixture.variantId]);
    await del('product_packages', 'product_variant_id', [fixture.variantId]);
    await del('product_variants', 'product_id', [fixture.productId]);
    await del('products', 'product_id', [fixture.productId]);
    await del('customers', 'customer_id', [fixture.customerId]);
    await del('payment_methods', 'payment_method_id', fixture.methodIds ?? []);
    await del('till_sessions', 'branch_id', fixture.branchIds);
    await del('pos_registers', 'branch_id', fixture.branchIds);
    await del('return_reasons', 'return_reason_id', [fixture.returnReasonId]);
    await del('categories', 'category_id', [fixture.categoryId]);
    await del('units_of_measure', 'unit_of_measure_id', [fixture.unitId]);
    await del('user_roles', 'user_id', [fixture.userId]);
    await del('users', 'user_id', [fixture.userId]);
    await del('employee_branch_assignments', 'employee_id', [fixture.employeeId]);
    await del('employees', 'employee_id', [fixture.employeeId]);
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

test('Phase 18 same-fixture system acceptance', { timeout: 120_000 }, async (t) => {
  const token = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
  const fixture = { token, prefix: `TEST_P18_${token}`, requests: 0 };
  let server;
  let baseUrl;
  const step = async (name, operation) => {
    let failure;
    await t.test(name, async () => {
      try { await operation(); } catch (error) { failure = error; throw error; }
    });
    if (failure) throw new Error(`Acceptance prerequisite failed: ${name}`, { cause: failure });
  };
  const request = async (path, { method = 'GET', body, expected = 200, authenticated = true } = {}) => {
    const requestId = `${fixture.prefix}_${++fixture.requests}`;
    const headers = { 'x-request-id': requestId, 'user-agent': 'TEST_PHASE18_ACCEPTANCE/1.0' };
    if (authenticated && fixture.accessToken) headers.authorization = `Bearer ${fixture.accessToken}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${baseUrl}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json();
    assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(json)}`);
    assert.equal(json.success, expected < 400);
    if (expected >= 400) assert.doesNotMatch(JSON.stringify(json), /sqlMessage|sqlState|DB_PASSWORD|"stack"|ER_/);
    return { data: json.data, requestId };
  };
  const create = async (path, body) => (await request(path, { method: 'POST', body, expected: 201 })).data;
  const action = async (path, body = {}, expected = 200) => (await request(path, { method: 'POST', body, expected })).data;
  const assertStock = async (quantity, version) => {
    const [rows] = await pool.execute(
      `SELECT bi.quantity_on_hand AS quantity, bi.version_number AS version,
         bli.quantity_on_hand AS lotQuantity
       FROM branch_inventory bi JOIN inventory_lots il ON il.product_variant_id = bi.product_variant_id
       JOIN branch_lot_inventory bli ON bli.inventory_lot_id = il.inventory_lot_id
         AND bli.branch_id = bi.branch_id WHERE bi.branch_id = ? AND bi.product_variant_id = ?`,
      [fixture.branchId, fixture.variantId],
    );
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], { quantity, version, lotQuantity: quantity });
  };
  try {
    await setup(fixture);
    server = await new Promise((resolve, reject) => {
      const http = app.listen(0, '127.0.0.1');
      http.once('listening', () => resolve(http));
      http.once('error', reject);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    const branch = `/api/admin/branches/${fixture.branchId}`;
    const catalog = '/api/admin/catalog';
    let orderId;
    let orderItemId;
    let receiptId;
    let receiptItemId;
    let saleId;
    let saleItemId;
    let returnId;

    await step('authenticates through HTTP and preserves the separate employee branch gate', async () => {
      await request('/api/auth/me', { authenticated: false, expected: 401 });
      const login = await request('/api/auth/login', { method: 'POST', authenticated: false,
        body: { identifier: fixture.username, password: fixture.password } });
      fixture.accessToken = login.data.accessToken;
      assert.equal(typeof fixture.accessToken, 'string');
      await request('/api/auth/me');
      await request(`${branch}/inventory`);
      await request(`/api/admin/branches/${fixture.otherBranchId}/inventory`, { expected: 403 });
      await request(`${branch}/inventory`);
    });

    await step('creates catalog, supplier and branch pricing without creating stock', async () => {
      const product = await create(`${catalog}/products`, {
        categoryId: fixture.categoryId, productCode: fixture.prefix, productName: `${fixture.prefix} Milk`,
      });
      fixture.productId = product.product.productId;
      const variant = await create(`${catalog}/products/${fixture.productId}/variants`, {
        unitOfMeasureId: fixture.unitId, sku: `${fixture.prefix}_SKU`, variantName: 'Bottle',
        defaultSellingPrice: '12.0000', lotTrackingMode: 'REQUIRED', requiresExpiryDate: true,
        basePackage: { packageCode: 'BASE', packageName: 'Bottle' },
      });
      fixture.variantId = variant.productVariant.productVariantId;
      const packages = (await request(`${catalog}/variants/${fixture.variantId}/packages`)).data.items;
      fixture.basePackageId = packages.find((item) => item.isBaseUnit).productPackageId;
      const carton = await create(`${catalog}/variants/${fixture.variantId}/packages`, {
        packageUnitOfMeasureId: fixture.unitId, packageCode: 'CARTON6', packageName: 'Six bottles',
        conversionToBaseQuantity: '6.000000',
      });
      fixture.cartonId = carton.productPackage.productPackageId;
      fixture.barcode = `${fixture.prefix}_BARCODE`;
      await create(`${catalog}/variants/${fixture.variantId}/barcodes`, {
        productPackageId: fixture.basePackageId, barcode: fixture.barcode, barcodeType: 'OTHER', isPrimary: true,
      });
      await request(`${branch}/prices/variants/${fixture.variantId}`, { method: 'PUT', body: {
        sellingPrice: '10.0000', effectiveFrom: '2020-01-01T00:00:00.000000Z', isActive: true,
      } });
      const supplier = await create('/api/admin/suppliers', {
        supplierCode: fixture.prefix, supplierName: `${fixture.prefix} Supplier`,
      });
      fixture.supplierId = supplier.supplier.supplierId;
      const mapping = await create(`/api/admin/suppliers/${fixture.supplierId}/products`, {
        productVariantId: fixture.variantId,
      });
      await create(`/api/admin/suppliers/${fixture.supplierId}/products/${mapping.supplierProduct.supplierProductId}/packages`, {
        productPackageId: fixture.cartonId,
      });
      const [rows] = await pool.execute('SELECT COUNT(*) AS count FROM branch_inventory WHERE product_variant_id = ?', [fixture.variantId]);
      assert.equal(rows[0].count, '0');
      for (const id of [fixture.productId, fixture.variantId, fixture.basePackageId, fixture.cartonId, fixture.supplierId]) {
        assert.equal(typeof id, 'string');
        assert.match(id, /^[1-9]\d*$/);
      }
    });

    await step('orders cartons and rolls back receiving without required lot evidence', async () => {
      const order = await create(`${branch}/purchase-orders`, {
        supplierId: fixture.supplierId, shippingAmount: '0.00', notes: fixture.prefix,
      });
      orderId = order.purchaseOrder.purchaseOrderId;
      const line = await create(`${branch}/purchase-orders/${orderId}/items`, {
        productVariantId: fixture.variantId, productPackageId: fixture.cartonId,
        orderedPackageQuantity: '2.000', unitCost: '2.0000', discountAmount: '0.00', taxRatePercent: '0.0000',
      });
      orderItemId = line.item.purchaseOrderItemId;
      assert.equal(line.item.orderedQuantity, '12.000');
      await action(`${branch}/purchase-orders/${orderId}/submit`);
      await action(`${branch}/purchase-orders/${orderId}/approve`);
      const receipt = await create(`${branch}/goods-receipts`, { purchaseOrderId: orderId, notes: fixture.prefix });
      receiptId = receipt.goodsReceipt.goodsReceiptId;
      const received = await create(`${branch}/goods-receipts/${receiptId}/items`, {
        purchaseOrderItemId: orderItemId, packageQuantityAccepted: '2.000',
        packageQuantityRejected: '0.000', actualUnitCost: '2.0000',
      });
      receiptItemId = received.item.goodsReceiptItemId;
      assert.equal(received.item.quantityAccepted, '12.000');
      const failure = await request(`${branch}/goods-receipts/${receiptId}/post`, { method: 'POST', body: {}, expected: 409 });
      const [rows] = await pool.execute(
        `SELECT (SELECT COUNT(*) FROM branch_inventory WHERE branch_id = ?) AS stock,
           (SELECT COUNT(*) FROM inventory_transactions WHERE branch_id = ?) AS ledger,
           (SELECT COUNT(*) FROM audit_logs WHERE request_id = ?) AS audits`,
        [fixture.branchId, fixture.branchId, failure.requestId],
      );
      assert.deepEqual(rows[0], { stock: '0', ledger: '0', audits: '0' });
      const state = (await request(`${branch}/goods-receipts/${receiptId}`)).data.goodsReceipt;
      assert.equal(state.status, 'DRAFT');
      assert.equal(state.inventoryTransactionId, null);
    });

    await step('posts received stock and one lot with exact conversion, cost and provenance', async () => {
      const expiresOn = new Date(Date.now() + 366 * 86400000).toISOString().slice(0, 10);
      await action(`${branch}/goods-receipts/${receiptId}/post`, {
        lotAllocations: [{ goodsReceiptItemId: receiptItemId, lots: [{
          lotNumber: `${fixture.prefix}_LOT`, expiresOn, quantityReceived: '12.000',
        }] }],
      });
      await assertStock('12.000', 0);
      await action(`${branch}/goods-receipts/${receiptId}/post`, {}, 409);
      await assertStock('12.000', 0);
      const [rows] = await pool.execute(
        `SELECT CAST(gril.inventory_lot_id AS CHAR) AS lotId, gril.quantity_received AS quantity,
           iti.quantity_change AS movement, iti.unit_cost AS cost
         FROM goods_receipt_item_lots gril JOIN goods_receipts gr ON gr.goods_receipt_id = ?
         JOIN inventory_transaction_items iti ON iti.inventory_transaction_id = gr.inventory_transaction_id
         WHERE gril.goods_receipt_item_id = ?`, [receiptId, receiptItemId],
      );
      fixture.lotId = rows[0].lotId;
      assert.deepEqual([rows[0].quantity, rows[0].movement, rows[0].cost], ['12.000', '12.000', '2.0000']);
      const order = (await request(`${branch}/purchase-orders/${orderId}`)).data.purchaseOrder;
      assert.equal(order.status, 'RECEIVED');
    });

    await step('opens a till and creates a customer sale using barcode and branch price', async () => {
      const customer = await create('/api/admin/customers', {
        customerType: 'INDIVIDUAL', firstName: 'Acceptance', lastName: fixture.prefix,
      });
      fixture.customerId = customer.customer.customerId;
      const register = await create(`${branch}/pos-registers`, {
        registerCode: `P18_${fixture.token}`, registerName: `${fixture.prefix} Register`,
      });
      const opened = await create(`${branch}/pos-registers/${register.posRegister.posRegisterId}/till-sessions`, {
        cashierEmployeeId: fixture.employeeId, openingCashAmount: '100.00', notes: fixture.prefix,
      });
      fixture.tillId = opened.tillSession.tillSessionId;
      fixture.methodIds = [];
      for (const type of ['CASH', 'CARD']) {
        const method = await create('/api/admin/payment-methods', {
          methodCode: `P18_${type}_${fixture.token}`, methodName: `${fixture.prefix} ${type}`,
          methodType: type, requiresReference: false,
        });
        fixture.methodIds.push(method.paymentMethod.paymentMethodId);
      }
      const sale = await create(`${branch}/till-sessions/${fixture.tillId}/sales`, {
        customerId: fixture.customerId, notes: fixture.prefix,
      });
      saleId = sale.sale.saleId;
      const item = await create(`${branch}/sales/${saleId}/items`, { barcode: fixture.barcode, quantity: '3.000' });
      saleItemId = item.item.saleItemId;
      assert.equal(item.item.productVariantId, fixture.variantId);
      assert.equal(item.item.baseQuantity, '3.000');
      assert.equal(item.sale.totalAmount, '30.00');
      await action(`${branch}/sales/${saleId}/complete`, {}, 409);
      await assertStock('12.000', 0);
    });

    await step('settles split tender and serializes duplicate checkout against the received lot', async () => {
      for (const [index, amount] of ['20.00', '10.00'].entries()) {
        const payment = await create(`${branch}/sales/${saleId}/payments`, {
          paymentMethodId: fixture.methodIds[index], amount,
        });
        await action(`${branch}/sales/${saleId}/payments/${payment.payment.salePaymentId}/complete`);
      }
      const completions = await Promise.all([0, 1].map(async () => {
        const response = await fetch(`${baseUrl}${branch}/sales/${saleId}/complete`, {
          method: 'POST', headers: { authorization: `Bearer ${fixture.accessToken}`,
            'content-type': 'application/json', 'x-request-id': `${fixture.prefix}_${++fixture.requests}` },
          body: '{}',
        });
        return { status: response.status, json: await response.json() };
      }));
      assert.deepEqual(completions.map(({ status }) => status).sort(), [200, 409]);
      assert.equal(completions.find(({ status }) => status === 200).json.data.sale.status, 'COMPLETED');
      await assertStock('9.000', 1);
      const [rows] = await pool.execute(
        `SELECT CAST(inventory_lot_id AS CHAR) AS lotId, base_quantity_allocated AS quantity
         FROM sale_item_lots WHERE sale_item_id = ?`, [saleItemId],
      );
      assert.deepEqual(rows, [{ lotId: fixture.lotId, quantity: '3.000' }]);
      await request(`${branch}/sales/${saleId}/items/${saleItemId}`, {
        method: 'PATCH', body: { quantity: '2.000' }, expected: 409,
      });
    });

    await step('restores the original lot and refunds immutable sale money after a current price change', async () => {
      await request(`${branch}/prices/variants/${fixture.variantId}`, { method: 'PUT', body: {
        sellingPrice: '99.0000', effectiveFrom: '2020-01-01T00:00:00.000000Z', isActive: true,
      } });
      const returned = await create(`${branch}/sales/${saleId}/returns`, { notes: fixture.prefix });
      returnId = returned.salesReturn.salesReturnId;
      await create(`${branch}/sales/${saleId}/returns/${returnId}/items`, {
        originalSaleItemId: saleItemId, returnReasonId: fixture.returnReasonId,
        quantityReturned: '1.000', itemCondition: 'UNOPENED', isRestockable: true,
      });
      const completed = await action(`${branch}/sales/${saleId}/returns/${returnId}/complete`);
      assert.equal(completed.salesReturn.refundTotalAmount, '10.00');
      await assertStock('10.000', 2);
      await action(`${branch}/sales/${saleId}/returns/${returnId}/complete`, {}, 409);
      const refundRoot = `${branch}/sales/${saleId}/returns/${returnId}/refunds`;
      const refund = await create(refundRoot, { paymentMethodId: fixture.methodIds[0], amount: '10.00' });
      await action(`${refundRoot}/${refund.payment.salePaymentId}/complete`);
      await request(refundRoot, { method: 'POST', body: { paymentMethodId: fixture.methodIds[0], amount: '0.01' }, expected: 409 });
      const summary = (await request(refundRoot)).data.summary;
      assert.equal(summary.completedRefundAmount, '10.00');
      assert.equal(summary.outstandingRefundAmount, '0.00');
      const [ledger] = await pool.execute(
        `SELECT it.transaction_type AS type, iti.quantity_change AS quantity, iti.unit_cost AS cost
         FROM inventory_transactions it JOIN inventory_transaction_items iti
           ON iti.inventory_transaction_id = it.inventory_transaction_id
         WHERE it.branch_id = ? ORDER BY it.inventory_transaction_id`, [fixture.branchId],
      );
      assert.deepEqual(ledger, [
        { type: 'PURCHASE_RECEIPT', quantity: '12.000', cost: '2.0000' },
        { type: 'SALE', quantity: '-3.000', cost: '2.0000' },
        { type: 'CUSTOMER_RETURN', quantity: '1.000', cost: '2.0000' },
      ]);
    });

    await step('reconciles reports and closes the same till without report writes', async () => {
      const from = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const to = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const report = `${branch}/reports`;
      const range = `from=${from}&to=${to}`;
      const [before] = await pool.execute('SELECT COUNT(*) AS count FROM audit_logs WHERE user_id = ?', [fixture.userId]);
      const overview = (await request(`${report}/overview?${range}`)).data;
      assert.deepEqual([overview.grossSalesAmount, overview.returnedMerchandiseAmount,
        overview.completedRefundAmount, overview.netSalesAmount], ['30.00', '10.00', '10.00', '20.00']);
      const payments = (await request(`${report}/payments?${range}`)).data.summary;
      assert.deepEqual([payments.completedPaymentAmount, payments.completedRefundAmount, payments.netTenderAmount], ['30.00', '10.00', '20.00']);
      const purchasing = (await request(`${report}/purchasing?${range}`)).data;
      assert.equal(purchasing.receiptPeriod.actualReceivedCostAmount, '24.00');
      const inventory = (await request(`${report}/inventory?productVariantId=${fixture.variantId}`)).data.items[0];
      assert.deepEqual([inventory.quantityOnHand, inventory.currentWeightedAverageUnitCost,
        inventory.currentValuationAmount], ['10.000', '2.0000', '20.00']);
      const customers = (await request(`${report}/customers?${range}`)).data.items;
      assert.equal(customers.length, 1);
      assert.equal(customers[0].customerId, fixture.customerId);
      assert.equal(customers[0].grossSalesAmount, '30.00');
      const tills = (await request(`${report}/tills?${range}`)).data.items;
      assert.equal(tills[0].calculatedExpectedCashAmount, '110.00');
      const trend = (await request(`${report}/sales/trend?${range}&groupBy=day`)).data.items;
      assert.equal(trend.filter((day) => day.grossSalesAmount === '30.00').length, 1);
      assert.equal(trend.filter((day) => day.completedRefundAmount === '10.00').length, 1);
      const movements = (await request(`${report}/inventory/movements?${range}`)).data.items;
      assert.deepEqual(movements.map((item) => [item.transactionType, item.quantityChange,
        item.extendedCostAmount]).sort(), [
        ['CUSTOMER_RETURN', '1.000', '2.00'],
        ['PURCHASE_RECEIPT', '12.000', '24.00'],
        ['SALE', '-3.000', '-6.00'],
      ]);
      const [after] = await pool.execute('SELECT COUNT(*) AS count FROM audit_logs WHERE user_id = ?', [fixture.userId]);
      assert.equal(after[0].count, before[0].count);
      const closed = await action(`${branch}/till-sessions/${fixture.tillId}/close`, { actualClosingCashAmount: '110.00' });
      assert.equal(closed.tillSession.status, 'CLOSED');
      assert.equal(closed.tillSession.expectedClosingCashAmount, '110.00');
      assert.equal(closed.tillSession.cashDifferenceAmount, '0.00');
      await assertStock('10.000', 2);
    });

    await step('removes only this acceptance fixture with foreign keys still enforced', async () => {
      await cleanup(fixture);
      const [rows] = await pool.execute(
        `SELECT (SELECT COUNT(*) FROM branches WHERE branch_id IN (?, ?)) AS branches,
           (SELECT COUNT(*) FROM users WHERE user_id = ?) AS users,
           (SELECT COUNT(*) FROM employees WHERE employee_id = ?) AS employees,
           (SELECT COUNT(*) FROM products WHERE product_id = ?) AS products,
           (SELECT COUNT(*) FROM suppliers WHERE supplier_id = ?) AS suppliers,
           (SELECT COUNT(*) FROM inventory_transactions WHERE branch_id = ?) AS ledger,
           (SELECT COUNT(*) FROM sales WHERE branch_id = ?) AS sales,
           (SELECT COUNT(*) FROM audit_logs WHERE request_id LIKE ?) AS audits,
           @@FOREIGN_KEY_CHECKS AS foreignKeys`,
        [...fixture.branchIds, fixture.userId, fixture.employeeId, fixture.productId,
          fixture.supplierId, fixture.branchId, fixture.branchId, `${fixture.prefix}%`],
      );
      assert.deepEqual({ ...rows[0], foreignKeys: String(rows[0].foreignKeys) }, {
        branches: '0', users: '0', employees: '0', products: '0',
        suppliers: '0', ledger: '0', sales: '0', audits: '0', foreignKeys: '1',
      });
    });
  } finally {
    try {
      await cleanup(fixture);
    } finally {
      if (server?.listening) await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      await pool.end();
    }
  }
});
