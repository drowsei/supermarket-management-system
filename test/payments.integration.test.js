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
const placeholders = (values) => values.map(() => '?').join(', ');

function fixtureDefinition() {
  const token = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
  return {
    token,
    lower: token.toLowerCase(),
    prefix: `TEST_P13_${token}`,
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
  const token = Object.hasOwn(options, 'token')
    ? options.token
    : fixture.tokens.actor;
  if (token) headers.set('authorization', `Bearer ${token}`);
  headers.set('user-agent', 'TEST_PHASE13_PAYMENTS/1.0');
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
      'DB_PASSWORD', 'uq_sale_payments', 'uq_payment_methods',
    ]) assert.equal(result.text.includes(forbidden), false);
  }
}

function branchRoot(fixture, branchId = fixture.branchAId) {
  return `/api/admin/branches/${branchId}`;
}

function paymentRoot(fixture, saleId, branchId = fixture.branchAId) {
  return `${branchRoot(fixture, branchId)}/sales/${saleId}/payments`;
}

async function insertEmployee(connection, fixture, name, branchId) {
  await connection.execute(
    `INSERT INTO employees (
       employee_number, first_name, last_name, hire_date, employment_status
     ) VALUES (?, 'Phase13', ?, '2020-01-01', 'ACTIVE')`,
    [`P13E_${name}_${fixture.token}`, name],
  );
  const employeeId = await lastId(connection);
  fixture.employeeIds.push(employeeId);
  fixture.employeeByName[name] = employeeId;
  if (branchId) {
    await connection.execute(
      `INSERT INTO employee_branch_assignments (
         employee_id, branch_id, job_title, started_on, is_primary
       ) VALUES (?, ?, 'Phase 13 Test', '2020-01-01', 0)`,
      [employeeId, branchId],
    );
  }
  return employeeId;
}

async function insertPaymentMethod(
  connection,
  fixture,
  name,
  type,
  { requiresReference = false, active = true } = {},
) {
  await connection.execute(
    `INSERT INTO payment_methods (
       method_code, method_name, method_type, requires_reference, is_active
     ) VALUES (?, ?, ?, ?, ?)`,
    [`P13${name.toUpperCase()}_${fixture.token}`, `${fixture.prefix} ${name}`,
      type, requiresReference ? 1 : 0, active ? 1 : 0],
  );
  const id = await lastId(connection);
  fixture.paymentMethodIds.push(id);
  fixture.paymentMethods[name] = id;
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
         ) VALUES (?, ?, '13 Payment Test Street', 'Lagos',
                   'NG', 'NGN', 'Africa/Lagos', 'ACTIVE')`,
        [`P13${suffix}_${fixture.token}`, `${fixture.prefix} Branch ${suffix}`],
      );
      fixture.branchIds.push(await lastId(connection));
    }
    [fixture.branchAId, fixture.branchBId] = fixture.branchIds;

    fixture.employeeIds = [];
    fixture.employeeByName = {};
    await insertEmployee(connection, fixture, 'actor', fixture.branchAId);
    await insertEmployee(connection, fixture, 'cashier', fixture.branchAId);
    await insertEmployee(connection, fixture, 'drawerCashier', fixture.branchAId);
    await insertEmployee(connection, fixture, 'raceCashier', fixture.branchAId);
    await insertEmployee(connection, fixture, 'cardRaceCashier', fixture.branchAId);
    await insertEmployee(connection, fixture, 'reader', fixture.branchAId);
    await insertEmployee(connection, fixture, 'wrong', fixture.branchBId);

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
      none: [],
      methodRead: ['payment_methods.read'],
      methodManage: ['payment_methods.manage'],
      payRead: ['payments.read'],
      payManage: ['payments.read', 'payments.manage'],
      actor: [
        'sales.read', 'sales.manage', 'payments.read', 'payments.manage',
        'till_sessions.read', 'till_sessions.manage',
      ],
    };
    fixture.roleIds = [];
    fixture.roleByName = {};
    for (const [name, codes] of Object.entries(roleDefinitions)) {
      await connection.execute(
        `INSERT INTO roles (role_code, role_name, description, is_active)
         VALUES (?, ?, 'Temporary Phase 13 role', 1)`,
        [`P13_${name.toUpperCase()}_${fixture.token}`, `${fixture.prefix} ${name}`],
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
    const systemRoleId = systemRows[0].roleId;
    const passwordHash = await bcrypt.hash(
      `Phase13-${fixture.token}-Password!`, Number(process.env.BCRYPT_ROUNDS),
    );
    const users = [
      ['admin', null, systemRoleId, null, 0],
      ['must', null, systemRoleId, null, 1],
      ['none', null, fixture.roleByName.none, null, 0],
      ['methodRead', null, fixture.roleByName.methodRead, null, 0],
      ['methodManage', null, fixture.roleByName.methodManage, null, 0],
      ['methodScoped', null, fixture.roleByName.methodManage, fixture.branchAId, 0],
      ['payRead', fixture.employeeByName.reader, fixture.roleByName.payRead, fixture.branchAId, 0],
      ['actor', fixture.employeeByName.actor, fixture.roleByName.actor, fixture.branchAId, 0],
      ['wrongScope', null, fixture.roleByName.payRead, fixture.branchBId, 0],
      ['globalWrong', fixture.employeeByName.wrong, fixture.roleByName.payManage, null, 0],
      ['unlinkedPay', null, fixture.roleByName.payManage, null, 0],
    ];
    fixture.userIds = [];
    fixture.tokens = {};
    for (const [name, employeeId, roleId, scopedBranchId, mustChange] of users) {
      await connection.execute(
        `INSERT INTO users (
           employee_id, username, email, password_hash,
           is_active, must_change_password
         ) VALUES (?, ?, ?, ?, 1, ?)`,
        [employeeId, `p13.${name}.${fixture.lower}`,
          `p13.${name}.${fixture.lower}@example.invalid`, passwordHash, mustChange],
      );
      const userId = await lastId(connection);
      fixture.userIds.push(userId);
      await connection.execute(
        'INSERT INTO user_roles (user_id, role_id, branch_id) VALUES (?, ?, ?)',
        [userId, roleId, scopedBranchId],
      );
      fixture.tokens[name] = signAccessToken(userId).accessToken;
    }

    fixture.registerIds = [];
    fixture.tillIds = [];
    for (const suffix of ['MAIN', 'DRAWER', 'RACE', 'CARD_RACE']) {
      await connection.execute(
        `INSERT INTO pos_registers (
           branch_id, register_code, register_name, status
         ) VALUES (?, ?, ?, 'ACTIVE')`,
        [fixture.branchAId, `P13${suffix}_${fixture.token}`,
          `${fixture.prefix} ${suffix} Register`],
      );
      const registerId = await lastId(connection);
      fixture.registerIds.push(registerId);
      await connection.execute(
        `INSERT INTO till_sessions (
           session_number, branch_id, pos_register_id, cashier_employee_id,
           opened_by_employee_id, status, opened_at, currency_code,
           opening_cash_amount, notes
         ) VALUES (?, ?, ?, ?, ?, 'OPEN', UTC_TIMESTAMP(6), 'NGN', 10.00, ?)`,
        [`P13TS_${suffix}_${fixture.token}`, fixture.branchAId, registerId,
          fixture.employeeByName[
            suffix === 'MAIN'
              ? 'cashier'
              : suffix === 'DRAWER'
                ? 'drawerCashier'
                : suffix === 'RACE' ? 'raceCashier' : 'cardRaceCashier'
          ],
          fixture.employeeByName.actor, fixture.prefix],
      );
      fixture.tillIds.push(await lastId(connection));
    }
    [fixture.mainTillId, fixture.drawerTillId, fixture.raceTillId,
      fixture.cardRaceTillId] = fixture.tillIds;

    fixture.paymentMethodIds = [];
    fixture.paymentMethods = {};
    await insertPaymentMethod(connection, fixture, 'card', 'CARD');
    await insertPaymentMethod(connection, fixture, 'cash', 'CASH');
    await insertPaymentMethod(connection, fixture, 'reference', 'BANK_TRANSFER', {
      requiresReference: true,
    });
    await insertPaymentMethod(connection, fixture, 'inactive', 'OTHER', {
      active: false,
    });

    await connection.execute(
      `INSERT INTO categories (category_code, category_name, is_active)
       VALUES (?, ?, 1)`,
      [`P13CAT_${fixture.token}`, `${fixture.prefix} Category`],
    );
    fixture.categoryId = await lastId(connection);
    await connection.execute(
      `INSERT INTO units_of_measure (
         unit_code, unit_name, symbol, allows_fraction
       ) VALUES (?, ?, 'ea', 0)`,
      [`P13U_${fixture.token}`, `${fixture.prefix} Unit`],
    );
    fixture.unitId = await lastId(connection);
    await connection.execute(
      `INSERT INTO products (
         category_id, product_code, product_name, status
       ) VALUES (?, ?, ?, 'ACTIVE')`,
      [fixture.categoryId, `P13P_${fixture.token}`, `${fixture.prefix} Product`],
    );
    fixture.productId = await lastId(connection);
    await connection.execute(
      `INSERT INTO product_variants (
         product_id, unit_of_measure_id, sku, variant_name,
         is_fractional, lot_tracking_mode, requires_expiry_date,
         default_selling_price, status
       ) VALUES (?, ?, ?, 'Standard', 0, 'NONE', 0, '100.0000', 'ACTIVE')`,
      [fixture.productId, fixture.unitId, `P13SKU_${fixture.token}`],
    );
    fixture.variantId = await lastId(connection);
    await connection.execute(
      `INSERT INTO product_packages (
         product_variant_id, package_unit_of_measure_id, package_code,
         package_name, conversion_to_base_quantity, is_base_unit,
         is_purchasable, is_sellable, status
       ) VALUES (?, ?, 'BASE', 'Each', '1.000000', 1, 1, 1, 'ACTIVE')`,
      [fixture.variantId, fixture.unitId],
    );
    fixture.packageId = await lastId(connection);
    await connection.execute(
      `INSERT INTO inventory_transactions (
         branch_id, transaction_number, transaction_type, occurred_at,
         created_by_employee_id, notes
       ) VALUES (?, ?, 'OPENING_BALANCE', UTC_TIMESTAMP(6), ?, ?)`,
      [fixture.branchAId, `P13IT_${fixture.token}`,
        fixture.employeeByName.actor, fixture.prefix],
    );
    fixture.openingTransactionId = await lastId(connection);
    await connection.execute(
      `INSERT INTO inventory_transaction_items (
         inventory_transaction_id, line_number, product_variant_id,
         quantity_change, unit_cost
       ) VALUES (?, 1, ?, '50.000', '10.0000')`,
      [fixture.openingTransactionId, fixture.variantId],
    );
    await connection.execute(
      `INSERT INTO branch_inventory (
         branch_id, product_variant_id, quantity_on_hand, version_number
       ) VALUES (?, ?, '50.000', 0)`,
      [fixture.branchAId, fixture.variantId],
    );

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
      `DELETE FROM audit_logs WHERE request_id LIKE ?
         OR user_id IN (${placeholders(fixture.userIds)})`,
      [`${fixture.prefix}%`, ...fixture.userIds],
    );
    await connection.execute(
      `DELETE sil FROM sale_item_lots sil
       INNER JOIN sale_items si ON si.sale_item_id = sil.sale_item_id
       INNER JOIN sales s ON s.sale_id = si.sale_id
       WHERE s.branch_id IN (${placeholders(fixture.branchIds)})`,
      fixture.branchIds,
    );
    await connection.execute(
      `DELETE sp FROM sale_payments sp INNER JOIN sales s ON s.sale_id = sp.sale_id
       WHERE s.branch_id IN (${placeholders(fixture.branchIds)})`,
      fixture.branchIds,
    );
    await connection.execute(
      `DELETE si FROM sale_items si INNER JOIN sales s ON s.sale_id = si.sale_id
       WHERE s.branch_id IN (${placeholders(fixture.branchIds)})`,
      fixture.branchIds,
    );
    await connection.execute(
      `DELETE FROM sales WHERE branch_id IN (${placeholders(fixture.branchIds)})`,
      fixture.branchIds,
    );
    await connection.execute(
      `DELETE itla FROM inventory_transaction_lot_allocations itla
       INNER JOIN inventory_transaction_items iti
         ON iti.inventory_transaction_item_id = itla.inventory_transaction_item_id
       INNER JOIN inventory_transactions it
         ON it.inventory_transaction_id = iti.inventory_transaction_id
       WHERE it.branch_id IN (${placeholders(fixture.branchIds)})`,
      fixture.branchIds,
    );
    await connection.execute(
      `DELETE iti FROM inventory_transaction_items iti
       INNER JOIN inventory_transactions it
         ON it.inventory_transaction_id = iti.inventory_transaction_id
       WHERE it.branch_id IN (${placeholders(fixture.branchIds)})`,
      fixture.branchIds,
    );
    await connection.execute(
      `DELETE FROM inventory_transactions
       WHERE branch_id IN (${placeholders(fixture.branchIds)})`,
      fixture.branchIds,
    );
    await connection.execute(
      `DELETE FROM branch_inventory
       WHERE branch_id IN (${placeholders(fixture.branchIds)})`,
      fixture.branchIds,
    );
    await connection.execute(
      'DELETE FROM product_packages WHERE product_variant_id = ?',
      [fixture.variantId],
    );
    await connection.execute(
      'DELETE FROM product_variants WHERE product_variant_id = ?',
      [fixture.variantId],
    );
    await connection.execute('DELETE FROM products WHERE product_id = ?', [fixture.productId]);
    await connection.execute('DELETE FROM categories WHERE category_id = ?', [fixture.categoryId]);
    await connection.execute('DELETE FROM units_of_measure WHERE unit_of_measure_id = ?', [fixture.unitId]);
    await connection.execute(
      `DELETE FROM till_sessions WHERE branch_id IN (${placeholders(fixture.branchIds)})`,
      fixture.branchIds,
    );
    await connection.execute(
      `DELETE FROM pos_registers WHERE branch_id IN (${placeholders(fixture.branchIds)})`,
      fixture.branchIds,
    );
    await connection.execute(
      `DELETE FROM payment_methods
       WHERE method_code LIKE ? OR payment_method_id IN (${placeholders(fixture.paymentMethodIds)})`,
      [`P13%${fixture.token}`, ...fixture.paymentMethodIds],
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
      `DELETE FROM branches WHERE branch_id IN (${placeholders(fixture.branchIds)})`,
      fixture.branchIds,
    );
    await connection.commit();
    const [remaining] = await connection.execute(
      `SELECT
         (SELECT COUNT(*) FROM branches WHERE branch_name LIKE ?) +
         (SELECT COUNT(*) FROM payment_methods WHERE method_name LIKE ?) +
         (SELECT COUNT(*) FROM audit_logs WHERE request_id LIKE ?) +
         (SELECT COUNT(*) FROM sales WHERE notes LIKE ?) AS count`,
      [`${fixture.prefix}%`, `${fixture.prefix}%`,
        `${fixture.prefix}%`, `${fixture.prefix}%`],
    );
    assert.equal(remaining[0].count, '0');
    fixture.cleaned = true;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function createSale(fixture, baseUrl, options = {}) {
  const tillId = options.tillId ?? fixture.mainTillId;
  const created = await send(
    fixture, baseUrl,
    `${branchRoot(fixture)}/till-sessions/${tillId}/sales`,
    { method: 'POST', label: options.label ?? 'SALE_CREATE', body: {} },
  );
  status(created, 201);
  const saleId = created.json.data.sale.saleId;
  const item = await send(
    fixture, baseUrl, `${branchRoot(fixture)}/sales/${saleId}/items`,
    {
      method: 'POST', label: `${options.label ?? 'SALE'}_ITEM`,
      body: {
        productVariantId: fixture.variantId,
        quantity: '1.000',
        discountAmount: options.discountAmount ?? '0.00',
      },
    },
  );
  status(item, 201);
  return { saleId, itemId: item.json.data.item.saleItemId, sale: item.json.data.sale };
}

async function createPayment(
  fixture,
  baseUrl,
  saleId,
  amount,
  options = {},
) {
  return send(
    fixture,
    baseUrl,
    paymentRoot(fixture, saleId, options.branchId),
    {
      method: 'POST',
      token: options.token ?? fixture.tokens.actor,
      label: options.label ?? 'PAYMENT_CREATE',
      body: {
        paymentMethodId: options.paymentMethodId ?? fixture.paymentMethods.card,
        amount,
        ...(Object.hasOwn(options, 'externalReference')
          ? { externalReference: options.externalReference }
          : {}),
        ...(Object.hasOwn(options, 'notes') ? { notes: options.notes } : {}),
      },
    },
  );
}

async function paymentAction(fixture, baseUrl, saleId, paymentId, action, options = {}) {
  return send(
    fixture,
    baseUrl,
    `${paymentRoot(fixture, saleId)}/${paymentId}/${action}`,
    {
      method: 'POST', token: options.token ?? fixture.tokens.actor,
      label: options.label ?? `PAYMENT_${action.toUpperCase()}`,
      body: options.body ?? {},
    },
  );
}

async function completeSale(fixture, baseUrl, saleId, label = 'SALE_COMPLETE') {
  return send(
    fixture, baseUrl, `${branchRoot(fixture)}/sales/${saleId}/complete`,
    { method: 'POST', label, body: {} },
  );
}

test(
  'Phase 13 payments and tender handling integration',
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const fixture = fixtureDefinition();
    let server;
    try {
      await createFixture(fixture);
      server = await startServer();
      const baseUrl = `http://127.0.0.1:${server.address().port}`;

      await t.test('defines exactly four permissions and ten routes', async () => {
        for (const code of [
          'payment_methods.read', 'payment_methods.manage',
          'payments.read', 'payments.manage',
        ]) assert.equal(ACCESS_CONTROL_PERMISSIONS.some((item) => item.code === code), true);
        assert.equal(ACCESS_CONTROL_PERMISSIONS.length, 44);
        const methodRoutes = await readFile(
          new URL('../src/routes/admin/paymentMethod.routes.js', import.meta.url), 'utf8',
        );
        const paymentRoutes = await readFile(
          new URL('../src/routes/admin/sales/payment.routes.js', import.meta.url), 'utf8',
        );
        assert.equal([...methodRoutes.matchAll(/router\.(?:get|post|patch|delete)\(/g)].length, 4);
        assert.equal([...paymentRoutes.matchAll(/router\.(?:get|post|patch|delete)\(/g)].length, 6);
        assert.equal(/refund/i.test(paymentRoutes), false);
      });

      await t.test('enforces global payment-method authorization and strict CRUD contracts', async () => {
        status(await send(fixture, baseUrl, '/api/admin/payment-methods', { token: null }), 401);
        status(await send(fixture, baseUrl, '/api/admin/payment-methods', {
          token: fixture.tokens.must,
        }), 403);
        status(await send(fixture, baseUrl, '/api/admin/payment-methods', {
          token: fixture.tokens.methodScoped,
        }), 403);
        status(await send(fixture, baseUrl, '/api/admin/payment-methods', {
          token: fixture.tokens.methodRead,
        }), 200);
        status(await send(fixture, baseUrl, '/api/admin/payment-methods', {
          method: 'POST', token: fixture.tokens.methodRead,
          body: { methodCode: 'DENIED', methodName: 'Denied', methodType: 'OTHER', requiresReference: false },
        }), 403);
        const created = await send(fixture, baseUrl, '/api/admin/payment-methods', {
          method: 'POST', token: fixture.tokens.methodManage, label: 'METHOD_CREATED',
          body: {
            methodCode: `p13api_${fixture.token}`,
            methodName: `${fixture.prefix} API Method`,
            methodType: 'MOBILE_MONEY',
            requiresReference: true,
          },
        });
        status(created, 201);
        const method = created.json.data.paymentMethod;
        fixture.paymentMethodIds.push(method.paymentMethodId);
        fixture.apiMethodId = method.paymentMethodId;
        const voucher = await send(fixture, baseUrl, '/api/admin/payment-methods', {
          method: 'POST', token: fixture.tokens.methodManage, label: 'METHOD_VOUCHER_CREATED',
          body: {
            methodCode: `P13VOUCHER_${fixture.token}`,
            methodName: `${fixture.prefix} Voucher Method`,
            methodType: 'VOUCHER',
            requiresReference: false,
          },
        });
        status(voucher, 201);
        fixture.paymentMethodIds.push(voucher.json.data.paymentMethod.paymentMethodId);
        assert.deepEqual(
          [method.methodCode, method.methodType, method.requiresReference, method.isActive],
          [`P13API_${fixture.token}`, 'MOBILE_MONEY', true, true],
        );
        assert.match(method.paymentMethodId, /^[1-9]\d*$/);
        status(await send(fixture, baseUrl, `/api/admin/payment-methods/${method.paymentMethodId}`, {
          token: fixture.tokens.methodRead,
        }), 200);
        status(await send(fixture, baseUrl, `/api/admin/payment-methods/${method.paymentMethodId}`, {
          method: 'PATCH', token: fixture.tokens.methodManage,
          body: { methodType: 'CARD' },
        }), 400);
        const noOp = await send(
          fixture, baseUrl, `/api/admin/payment-methods/${method.paymentMethodId}`,
          {
            method: 'PATCH', token: fixture.tokens.methodManage, label: 'METHOD_NOOP',
            body: { isActive: true },
          },
        );
        status(noOp, 200);
        const [noOpAudit] = await pool.execute(
          'SELECT COUNT(*) AS count FROM audit_logs WHERE request_id = ?',
          [noOp.requestId],
        );
        assert.equal(noOpAudit[0].count, '0');
        const updated = await send(
          fixture, baseUrl, `/api/admin/payment-methods/${method.paymentMethodId}`,
          {
            method: 'PATCH', token: fixture.tokens.methodManage, label: 'METHOD_UPDATED',
            body: { methodName: `${fixture.prefix} API Method Updated`, requiresReference: false },
          },
        );
        status(updated, 200);
        assert.equal(updated.json.data.paymentMethod.methodType, 'MOBILE_MONEY');
        status(await send(fixture, baseUrl, '/api/admin/payment-methods', {
          method: 'POST', token: fixture.tokens.methodManage,
          body: {
            methodCode: `P13API_${fixture.token}`,
            methodName: `${fixture.prefix} Duplicate`, methodType: 'OTHER',
            requiresReference: false,
          },
        }), 409);
        status(await send(fixture, baseUrl, '/api/admin/payment-methods', {
          method: 'POST', token: fixture.tokens.methodManage,
          body: {
            methodCode: `P13UNIQUE_${fixture.token}`,
            methodName: `${fixture.prefix} API Method Updated`, methodType: 'OTHER',
            requiresReference: false,
          },
        }), 409);
        const inactive = await send(
          fixture, baseUrl, `/api/admin/payment-methods/${method.paymentMethodId}`,
          {
            method: 'PATCH', token: fixture.tokens.methodManage,
            body: { methodCode: `P13API2_${fixture.token}`, isActive: false },
          },
        );
        status(inactive, 200);
        assert.deepEqual(
          [inactive.json.data.paymentMethod.methodCode,
            inactive.json.data.paymentMethod.isActive,
            inactive.json.data.paymentMethod.methodType],
          [`P13API2_${fixture.token}`, false, 'MOBILE_MONEY'],
        );
        const filtered = await send(
          fixture, baseUrl,
          '/api/admin/payment-methods?methodType=MOBILE_MONEY&isActive=false&requiresReference=false&page=1&limit=1',
          { token: fixture.tokens.methodRead },
        );
        status(filtered, 200);
        assert.equal(filtered.json.data.items[0].paymentMethodId, method.paymentMethodId);
        assert.equal(filtered.json.data.pagination.limit, 1);
        const voucherList = await send(
          fixture, baseUrl,
          '/api/admin/payment-methods?methodType=VOUCHER&search=Voucher&page=1&limit=20',
          { token: fixture.tokens.methodRead },
        );
        status(voucherList, 200);
        assert.equal(voucherList.json.data.items.length, 1);
        status(await send(
          fixture, baseUrl, `/api/admin/payment-methods/${method.paymentMethodId}`,
          {
            method: 'PATCH', token: fixture.tokens.methodManage,
            body: { isActive: true },
          },
        ), 200);
        status(await send(fixture, baseUrl, '/api/admin/payment-methods?unknown=x', {
          token: fixture.tokens.methodRead,
        }), 400);
        status(await send(
          fixture, baseUrl, `/api/admin/payment-methods/${MAX_UNSIGNED_BIGINT}`,
          { token: fixture.tokens.methodRead },
        ), 404);
      });

      await t.test('enforces branch permission scope and the operational employee gate', async () => {
        const sale = await createSale(fixture, baseUrl, { label: 'AUTH_SALE' });
        const root = paymentRoot(fixture, sale.saleId);
        status(await send(fixture, baseUrl, root, { token: null }), 401);
        status(await send(fixture, baseUrl, root, { token: fixture.tokens.payRead }), 200);
        status(await send(fixture, baseUrl, root, {
          method: 'POST', token: fixture.tokens.payRead,
          body: { paymentMethodId: fixture.paymentMethods.card, amount: '10.00' },
        }), 403);
        status(await send(fixture, baseUrl, root, { token: fixture.tokens.wrongScope }), 403);
        status(await send(fixture, baseUrl, root, { token: fixture.tokens.globalWrong }), 403);
        status(await send(fixture, baseUrl, root, { token: fixture.tokens.unlinkedPay }), 200);
        status(await send(fixture, baseUrl, root, {
          method: 'POST', token: fixture.tokens.unlinkedPay,
          body: { paymentMethodId: fixture.paymentMethods.card, amount: '10.00' },
        }), 403);
        status(await send(fixture, baseUrl, root, { token: fixture.tokens.admin }), 200);
        status(await send(fixture, baseUrl, root, {
          method: 'POST', token: fixture.tokens.admin,
          body: { paymentMethodId: fixture.paymentMethods.card, amount: '10.00' },
        }), 403);
        status(await send(
          fixture, baseUrl, paymentRoot(fixture, sale.saleId, fixture.branchBId),
          { token: fixture.tokens.payRead },
        ), 403);
      });

      await t.test('validates exact money, references, method state, uniqueness, and BIGINT IDs', async () => {
        const sale = await createSale(fixture, baseUrl, { label: 'CONTRACT_SALE' });
        status(await createPayment(fixture, baseUrl, sale.saleId, 10), 400);
        status(await createPayment(fixture, baseUrl, sale.saleId, '0.00'), 400);
        status(await createPayment(fixture, baseUrl, sale.saleId, '1e2'), 400);
        status(await createPayment(
          fixture, baseUrl, sale.saleId, '100000000000000000.00',
        ), 400);
        status(await createPayment(fixture, baseUrl, sale.saleId, '1.00', {
          externalReference: 'R'.repeat(151),
        }), 400);
        status(await createPayment(fixture, baseUrl, sale.saleId, '1.00', {
          notes: 'N'.repeat(501),
        }), 400);
        status(await send(fixture, baseUrl, paymentRoot(fixture, sale.saleId), {
          method: 'POST', body: {
            paymentMethodId: fixture.paymentMethods.card,
            amount: '10.00', paymentType: 'REFUND',
          },
        }), 400);
        status(await send(fixture, baseUrl, paymentRoot(fixture, sale.saleId), {
          method: 'POST', body: {
            paymentMethodId: fixture.paymentMethods.card,
            amount: '10.00', unexpected: true,
          },
        }), 400);
        status(await createPayment(fixture, baseUrl, sale.saleId, '10.00', {
          paymentMethodId: MAX_UNSIGNED_BIGINT,
        }), 404);
        status(await createPayment(fixture, baseUrl, sale.saleId, '10.00', {
          paymentMethodId: fixture.paymentMethods.inactive,
        }), 409);
        status(await createPayment(fixture, baseUrl, sale.saleId, '10.00', {
          paymentMethodId: fixture.paymentMethods.reference,
        }), 400);
        status(await createPayment(fixture, baseUrl, sale.saleId, '100.01'), 409);
        const reference = `${fixture.prefix}_REFERENCE_1`;
        const payment = await createPayment(fixture, baseUrl, sale.saleId, '100.00', {
          paymentMethodId: fixture.paymentMethods.reference,
          externalReference: reference,
          notes: 'Processor evidence only',
        });
        status(payment, 201);
        const record = payment.json.data.payment;
        assert.match(record.paymentNumber, /^PAY-[A-F0-9]{32}$/);
        assert.deepEqual(
          [record.paymentType, record.status, record.amount, record.currencyCode,
            record.paidAt, record.processedByEmployeeId],
          ['PAYMENT', 'PENDING', '100.00', 'NGN', null, fixture.employeeByName.actor],
        );
        const secondSale = await createSale(fixture, baseUrl, { label: 'DUPLICATE_REF_SALE' });
        status(await createPayment(fixture, baseUrl, secondSale.saleId, '10.00', {
          paymentMethodId: fixture.paymentMethods.reference,
          externalReference: reference,
        }), 409);
        const optionalReference = await createPayment(
          fixture, baseUrl, secondSale.saleId, '10.00', {
            paymentMethodId: fixture.paymentMethods.card,
            externalReference: reference,
          },
        );
        status(optionalReference, 201);
        assert.equal(optionalReference.json.data.payment.externalReference, reference);
        status(await paymentAction(
          fixture, baseUrl, secondSale.saleId,
          optionalReference.json.data.payment.salePaymentId, 'cancel',
        ), 200);
        status(await send(
          fixture, baseUrl,
          `${paymentRoot(fixture, sale.saleId)}/${MAX_UNSIGNED_BIGINT}`,
        ), 404);
        status(await send(fixture, baseUrl, `${paymentRoot(fixture, sale.saleId)}/0`), 400);
        status(await paymentAction(
          fixture, baseUrl, sale.saleId, record.salePaymentId, 'cancel',
        ), 200);
      });

      await t.test('records paid_at only on completion and permits completion after deactivation', async () => {
        const sale = await createSale(fixture, baseUrl, { label: 'INACTIVE_COMPLETE_SALE' });
        const pending = await createPayment(fixture, baseUrl, sale.saleId, '20.00', {
          paymentMethodId: fixture.apiMethodId,
        });
        status(pending, 201);
        status(await send(
          fixture, baseUrl, `/api/admin/payment-methods/${fixture.apiMethodId}`,
          {
            method: 'PATCH', token: fixture.tokens.methodManage,
            body: { isActive: false },
          },
        ), 200);
        const completed = await paymentAction(
          fixture, baseUrl, sale.saleId,
          pending.json.data.payment.salePaymentId, 'complete',
        );
        status(completed, 200);
        assert.match(completed.json.data.payment.paidAt, /^\d{4}-\d{2}-\d{2}T/);
        status(await send(
          fixture, baseUrl, `/api/admin/payment-methods/${fixture.apiMethodId}`,
          {
            method: 'PATCH', token: fixture.tokens.methodManage,
            body: { isActive: true },
          },
        ), 200);
        const failed = await createPayment(fixture, baseUrl, sale.saleId, '10.00');
        status(failed, 201);
        const failedResult = await paymentAction(
          fixture, baseUrl, sale.saleId,
          failed.json.data.payment.salePaymentId, 'fail',
        );
        status(failedResult, 200);
        assert.equal(failedResult.json.data.payment.paidAt, null);
        const cancelled = await createPayment(fixture, baseUrl, sale.saleId, '10.00');
        status(cancelled, 201);
        const cancelledResult = await paymentAction(
          fixture, baseUrl, sale.saleId,
          cancelled.json.data.payment.salePaymentId, 'cancel',
        );
        status(cancelledResult, 200);
        assert.equal(cancelledResult.json.data.payment.paidAt, null);
      });

      await t.test('supports split tender with stable lists and exact funding summaries', async () => {
        const sale = await createSale(fixture, baseUrl, { label: 'SPLIT_SALE' });
        const first = await createPayment(fixture, baseUrl, sale.saleId, '40.00', {
          label: 'SPLIT_CARD',
        });
        const second = await createPayment(fixture, baseUrl, sale.saleId, '30.00', {
          paymentMethodId: fixture.paymentMethods.cash, label: 'SPLIT_CASH',
        });
        const third = await createPayment(fixture, baseUrl, sale.saleId, '30.00', {
          paymentMethodId: fixture.paymentMethods.reference,
          externalReference: `${fixture.prefix}_SPLIT`, label: 'SPLIT_REFERENCE',
        });
        for (const result of [first, second, third]) status(result, 201);
        status(await createPayment(fixture, baseUrl, sale.saleId, '0.01'), 409);
        const list = await send(fixture, baseUrl, paymentRoot(fixture, sale.saleId));
        status(list, 200);
        assert.deepEqual(list.json.data.summary, {
          completedPaymentAmount: '0.00',
          pendingPaymentAmount: '100.00',
          activePaymentAmount: '100.00',
          outstandingAmount: '100.00',
          isFullyPaid: false,
        });
        assert.deepEqual(
          list.json.data.items.map((item) => item.amount),
          ['40.00', '30.00', '30.00'],
        );
        status(await send(
          fixture, baseUrl, `${paymentRoot(fixture, sale.saleId)}?unknown=x`,
        ), 400);
        for (const result of [first, second, third]) {
          status(await paymentAction(
            fixture, baseUrl, sale.saleId,
            result.json.data.payment.salePaymentId, 'complete',
          ), 200);
        }
        const funded = await send(
          fixture, baseUrl, `${paymentRoot(fixture, sale.saleId)}?status=COMPLETED`,
        );
        status(funded, 200);
        assert.deepEqual(funded.json.data.summary, {
          completedPaymentAmount: '100.00',
          pendingPaymentAmount: '0.00',
          activePaymentAmount: '100.00',
          outstandingAmount: '0.00',
          isFullyPaid: true,
        });
        status(await completeSale(fixture, baseUrl, sale.saleId, 'SPLIT_COMPLETE'), 200);
        status(await createPayment(fixture, baseUrl, sale.saleId, '1.00'), 409);
      });

      await t.test('requires resolved and complete funding before sale completion', async () => {
        const sale = await createSale(fixture, baseUrl, { label: 'FUNDING_SALE' });
        const forty = await createPayment(fixture, baseUrl, sale.saleId, '40.00');
        status(forty, 201);
        status(await completeSale(fixture, baseUrl, sale.saleId, 'PENDING_BLOCK'), 409);
        status(await paymentAction(
          fixture, baseUrl, sale.saleId,
          forty.json.data.payment.salePaymentId, 'complete',
        ), 200);
        status(await completeSale(fixture, baseUrl, sale.saleId, 'INCOMPLETE_BLOCK'), 409);
        const sixty = await createPayment(fixture, baseUrl, sale.saleId, '60.00');
        status(sixty, 201);
        status(await paymentAction(
          fixture, baseUrl, sale.saleId,
          sixty.json.data.payment.salePaymentId, 'complete',
        ), 200);
        status(await completeSale(fixture, baseUrl, sale.saleId, 'FULL_COMPLETE'), 200);
      });

      await t.test('freezes cart and cancellation only while tender is active', async () => {
        const sale = await createSale(fixture, baseUrl, { label: 'FREEZE_SALE' });
        const pending = await createPayment(fixture, baseUrl, sale.saleId, '100.00');
        status(pending, 201);
        status(await send(
          fixture, baseUrl, `${branchRoot(fixture)}/sales/${sale.saleId}`,
          { method: 'PATCH', body: { notes: 'blocked' } },
        ), 409);
        status(await send(
          fixture, baseUrl, `${branchRoot(fixture)}/sales/${sale.saleId}/items`,
          { method: 'POST', body: { productVariantId: fixture.variantId, quantity: '1.000' } },
        ), 409);
        status(await send(
          fixture, baseUrl, `${branchRoot(fixture)}/sales/${sale.saleId}/items/${sale.itemId}`,
          { method: 'PATCH', body: { quantity: '2.000' } },
        ), 409);
        status(await send(
          fixture, baseUrl, `${branchRoot(fixture)}/sales/${sale.saleId}/items/${sale.itemId}`,
          { method: 'DELETE' },
        ), 409);
        status(await send(
          fixture, baseUrl, `${branchRoot(fixture)}/sales/${sale.saleId}/cancel`,
          { method: 'POST', body: {} },
        ), 409);
        status(await paymentAction(
          fixture, baseUrl, sale.saleId,
          pending.json.data.payment.salePaymentId, 'fail',
        ), 200);
        status(await send(
          fixture, baseUrl, `${branchRoot(fixture)}/sales/${sale.saleId}`,
          { method: 'PATCH', body: { notes: 'released after failure' } },
        ), 200);
        const retry = await createPayment(fixture, baseUrl, sale.saleId, '100.00');
        status(retry, 201);
        status(await paymentAction(
          fixture, baseUrl, sale.saleId,
          retry.json.data.payment.salePaymentId, 'cancel',
        ), 200);
        status(await send(
          fixture, baseUrl, `${branchRoot(fixture)}/sales/${sale.saleId}/items/${sale.itemId}`,
          { method: 'PATCH', body: { quantity: '1.000' } },
        ), 200);
        const completed = await createPayment(fixture, baseUrl, sale.saleId, '100.00');
        status(completed, 201);
        status(await paymentAction(
          fixture, baseUrl, sale.saleId,
          completed.json.data.payment.salePaymentId, 'complete',
        ), 200);
        status(await send(
          fixture, baseUrl, `${branchRoot(fixture)}/sales/${sale.saleId}/cancel`,
          { method: 'POST', body: {} },
        ), 409);
      });

      await t.test('allows sale cancellation after failed-only or cancelled-only history', async () => {
        for (const [state, action] of [['FAILED', 'fail'], ['CANCELLED', 'cancel']]) {
          const sale = await createSale(fixture, baseUrl, { label: `${state}_HISTORY_SALE` });
          const payment = await createPayment(fixture, baseUrl, sale.saleId, '100.00');
          status(payment, 201);
          status(await paymentAction(
            fixture, baseUrl, sale.saleId,
            payment.json.data.payment.salePaymentId, action,
          ), 200);
          const cancelled = await send(
            fixture, baseUrl, `${branchRoot(fixture)}/sales/${sale.saleId}/cancel`,
            { method: 'POST', label: `${state}_HISTORY_CANCEL`, body: {} },
          );
          status(cancelled, 200);
          assert.equal(cancelled.json.data.sale.status, 'CANCELLED');
        }
      });

      await t.test('keeps terminal attempts immutable and suppresses losing audits', async () => {
        const sale = await createSale(fixture, baseUrl, { label: 'TERMINAL_SALE' });
        const failed = await createPayment(fixture, baseUrl, sale.saleId, '20.00');
        status(failed, 201);
        const paymentId = failed.json.data.payment.salePaymentId;
        status(await paymentAction(fixture, baseUrl, sale.saleId, paymentId, 'fail'), 200);
        const loser = await paymentAction(
          fixture, baseUrl, sale.saleId, paymentId, 'complete', { label: 'TERMINAL_LOSER' },
        );
        status(loser, 409);
        status(await paymentAction(fixture, baseUrl, sale.saleId, paymentId, 'cancel'), 409);
        const [loserAudit] = await pool.execute(
          'SELECT COUNT(*) AS count FROM audit_logs WHERE request_id = ?',
          [loser.requestId],
        );
        assert.equal(loserAudit[0].count, '0');
        const pending = await createPayment(fixture, baseUrl, sale.saleId, '20.00');
        const pendingId = pending.json.data.payment.salePaymentId;
        status(await paymentAction(fixture, baseUrl, sale.saleId, pendingId, 'complete', {
          body: { unexpected: true },
        }), 400);
        const detail = await send(
          fixture, baseUrl, `${paymentRoot(fixture, sale.saleId)}/${pendingId}`,
        );
        status(detail, 200);
        assert.equal(detail.json.data.payment.status, 'PENDING');
        status(await paymentAction(fixture, baseUrl, sale.saleId, pendingId, 'cancel'), 200);
      });

      await t.test('allows cleanup on suspended or closed tills but never cancelled tills', async () => {
        const sale = await createSale(fixture, baseUrl, { label: 'TILL_STATE_SALE' });
        const first = await createPayment(fixture, baseUrl, sale.saleId, '20.00');
        status(first, 201);
        await pool.execute(
          "UPDATE till_sessions SET status = 'SUSPENDED' WHERE till_session_id = ?",
          [fixture.mainTillId],
        );
        status(await paymentAction(
          fixture, baseUrl, sale.saleId, first.json.data.payment.salePaymentId, 'complete',
        ), 409);
        status(await createPayment(fixture, baseUrl, sale.saleId, '10.00'), 409);
        status(await paymentAction(
          fixture, baseUrl, sale.saleId, first.json.data.payment.salePaymentId, 'fail',
        ), 200);
        await pool.execute(
          "UPDATE till_sessions SET status = 'OPEN' WHERE till_session_id = ?",
          [fixture.mainTillId],
        );
        const second = await createPayment(fixture, baseUrl, sale.saleId, '20.00');
        status(second, 201);
        await pool.execute(
          `UPDATE till_sessions SET status = 'CLOSED',
             closed_at = UTC_TIMESTAMP(6), closed_by_employee_id = ?,
             expected_closing_cash_amount = 0.00,
             actual_closing_cash_amount = 0.00, cash_difference_amount = 0.00
           WHERE till_session_id = ?`,
          [fixture.employeeByName.actor, fixture.mainTillId],
        );
        status(await paymentAction(
          fixture, baseUrl, sale.saleId, second.json.data.payment.salePaymentId, 'cancel',
        ), 200);
        await pool.execute(
          `UPDATE till_sessions SET status = 'OPEN', closed_at = NULL,
             closed_by_employee_id = NULL, expected_closing_cash_amount = NULL,
             actual_closing_cash_amount = NULL, cash_difference_amount = NULL
           WHERE till_session_id = ?`,
          [fixture.mainTillId],
        );
        const third = await createPayment(fixture, baseUrl, sale.saleId, '20.00');
        status(third, 201);
        await pool.execute(
          `UPDATE till_sessions SET status = 'CANCELLED',
             closed_at = UTC_TIMESTAMP(6), closed_by_employee_id = ?,
             expected_closing_cash_amount = NULL,
             actual_closing_cash_amount = NULL, cash_difference_amount = NULL
           WHERE till_session_id = ?`,
          [fixture.employeeByName.actor, fixture.mainTillId],
        );
        status(await paymentAction(
          fixture, baseUrl, sale.saleId, third.json.data.payment.salePaymentId, 'fail',
        ), 409);
        await pool.execute(
          `UPDATE till_sessions SET status = 'OPEN', closed_at = NULL,
             closed_by_employee_id = NULL, expected_closing_cash_amount = NULL,
             actual_closing_cash_amount = NULL, cash_difference_amount = NULL
           WHERE till_session_id = ?`,
          [fixture.mainTillId],
        );
        status(await paymentAction(
          fixture, baseUrl, sale.saleId, third.json.data.payment.salePaymentId, 'fail',
        ), 200);
      });

      await t.test('serializes competing reservations and allows an exact concurrent split', async () => {
        const sale = await createSale(fixture, baseUrl, { label: 'CREATE_RACE_SALE' });
        const competing = await Promise.all([
          createPayment(fixture, baseUrl, sale.saleId, '60.00', { label: 'RACE_60_A' }),
          createPayment(fixture, baseUrl, sale.saleId, '60.00', { label: 'RACE_60_B' }),
        ]);
        assert.deepEqual(competing.map((result) => result.status).sort(), [201, 409]);
        const winner = competing.find((result) => result.status === 201);
        status(await paymentAction(
          fixture, baseUrl, sale.saleId,
          winner.json.data.payment.salePaymentId, 'cancel',
        ), 200);
        const exact = await Promise.all([
          createPayment(fixture, baseUrl, sale.saleId, '40.00', { label: 'RACE_40' }),
          createPayment(fixture, baseUrl, sale.saleId, '60.00', { label: 'RACE_60' }),
        ]);
        assert.deepEqual(exact.map((result) => result.status).sort(), [201, 201]);
        assert.equal(
          new Set(exact.map((result) => result.json.data.payment.paymentNumber)).size,
          2,
        );
        const list = await send(fixture, baseUrl, paymentRoot(fixture, sale.saleId));
        status(list, 200);
        assert.equal(list.json.data.summary.activePaymentAmount, '100.00');
        for (const result of exact) {
          status(await paymentAction(
            fixture, baseUrl, sale.saleId,
            result.json.data.payment.salePaymentId, 'cancel',
          ), 200);
        }
      });

      await t.test('serializes duplicate completion with one state change and audit', async () => {
        const sale = await createSale(fixture, baseUrl, { label: 'COMPLETE_RACE_SALE' });
        const created = await createPayment(fixture, baseUrl, sale.saleId, '100.00');
        status(created, 201);
        const paymentId = created.json.data.payment.salePaymentId;
        const results = await Promise.all([
          paymentAction(fixture, baseUrl, sale.saleId, paymentId, 'complete', {
            label: 'COMPLETE_RACE_A',
          }),
          paymentAction(fixture, baseUrl, sale.saleId, paymentId, 'complete', {
            label: 'COMPLETE_RACE_B',
          }),
        ]);
        assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
        const [audits] = await pool.execute(
          `SELECT COUNT(*) AS count FROM audit_logs
           WHERE entity_type = 'SALE_PAYMENT' AND entity_record_id = ?
             AND action_type = 'SALE_PAYMENT_COMPLETED'`,
          [paymentId],
        );
        assert.equal(audits[0].count, '1');
      });

      await t.test('serializes cash and noncash payment completion against till close', async () => {
        const cases = [
          ['CASH', fixture.raceTillId, fixture.paymentMethods.cash, '110.00'],
          ['CARD', fixture.cardRaceTillId, fixture.paymentMethods.card, '10.00'],
        ];
        for (const [name, tillId, paymentMethodId, completedExpected] of cases) {
          const sale = await createSale(fixture, baseUrl, {
            label: `${name}_CLOSE_RACE_SALE`, tillId,
          });
          const payment = await createPayment(fixture, baseUrl, sale.saleId, '100.00', {
            paymentMethodId, label: `${name}_CLOSE_RACE_PAYMENT`,
          });
          status(payment, 201);
          const paymentId = payment.json.data.payment.salePaymentId;
          const [completion, close] = await Promise.all([
            paymentAction(fixture, baseUrl, sale.saleId, paymentId, 'complete', {
              label: `${name}_CLOSE_RACE_COMPLETE`,
            }),
            send(
              fixture, baseUrl, `${branchRoot(fixture)}/till-sessions/${tillId}/close`,
              {
                method: 'POST', label: `${name}_CLOSE_RACE_CLOSE`,
                body: { actualClosingCashAmount: '10.00' },
              },
            ),
          ]);
          status(close, 200);
          assert.equal([200, 409].includes(completion.status), true, completion.text);
          assert.equal(
            close.json.data.tillSession.expectedClosingCashAmount,
            completion.status === 200 ? completedExpected : '10.00',
          );
          if (completion.status === 409) {
            status(await paymentAction(
              fixture, baseUrl, sale.saleId, paymentId, 'cancel',
              { label: `${name}_CLOSE_RACE_CLEANUP` },
            ), 200);
          }
        }
      });

      await t.test('serializes final payment against sale completion and cancellation', async () => {
        const completionSale = await createSale(fixture, baseUrl, {
          label: 'PAYMENT_VS_SALE_COMPLETE',
        });
        const finalPayment = await createPayment(
          fixture, baseUrl, completionSale.saleId, '100.00',
        );
        const [paymentResult, saleResult] = await Promise.all([
          paymentAction(
            fixture, baseUrl, completionSale.saleId,
            finalPayment.json.data.payment.salePaymentId, 'complete',
            { label: 'PAYMENT_VS_SALE_COMPLETE_PAYMENT' },
          ),
          completeSale(
            fixture, baseUrl, completionSale.saleId,
            'PAYMENT_VS_SALE_COMPLETE_SALE',
          ),
        ]);
        status(paymentResult, 200);
        assert.equal([200, 409].includes(saleResult.status), true, saleResult.text);
        const [completionState] = await pool.execute(
          `SELECT status, CAST(inventory_transaction_id AS CHAR) AS inventoryTransactionId
           FROM sales WHERE sale_id = ?`,
          [completionSale.saleId],
        );
        assert.equal(
          completionState[0].status,
          saleResult.status === 200 ? 'COMPLETED' : 'OPEN',
        );
        if (saleResult.status === 200) {
          assert.match(completionState[0].inventoryTransactionId, /^[1-9]\d*$/);
        } else {
          assert.equal(completionState[0].inventoryTransactionId, null);
        }

        const cancellationSale = await createSale(fixture, baseUrl, {
          label: 'PAYMENT_VS_SALE_CANCEL',
        });
        const pending = await createPayment(
          fixture, baseUrl, cancellationSale.saleId, '100.00',
        );
        const [completed, cancelled] = await Promise.all([
          paymentAction(
            fixture, baseUrl, cancellationSale.saleId,
            pending.json.data.payment.salePaymentId, 'complete',
            { label: 'PAYMENT_VS_CANCEL_PAYMENT' },
          ),
          send(
            fixture, baseUrl,
            `${branchRoot(fixture)}/sales/${cancellationSale.saleId}/cancel`,
            { method: 'POST', label: 'PAYMENT_VS_CANCEL_SALE', body: {} },
          ),
        ]);
        status(completed, 200);
        status(cancelled, 409);
        const [cancelState] = await pool.execute(
          `SELECT s.status AS saleStatus, sp.status AS paymentStatus
           FROM sales s INNER JOIN sale_payments sp ON sp.sale_id = s.sale_id
           WHERE s.sale_id = ? AND sp.sale_payment_id = ?`,
          [cancellationSale.saleId, pending.json.data.payment.salePaymentId],
        );
        assert.deepEqual(cancelState[0], {
          saleStatus: 'OPEN', paymentStatus: 'COMPLETED',
        });
      });

      await t.test('serializes payment creation against method deactivation', async () => {
        status(await send(
          fixture, baseUrl, `/api/admin/payment-methods/${fixture.apiMethodId}`,
          {
            method: 'PATCH', token: fixture.tokens.methodManage,
            body: { isActive: true },
          },
        ), 200);
        const sale = await createSale(fixture, baseUrl, {
          label: 'METHOD_DEACTIVATION_RACE_SALE',
        });
        const [creation, deactivation] = await Promise.all([
          createPayment(fixture, baseUrl, sale.saleId, '100.00', {
            paymentMethodId: fixture.apiMethodId,
            label: 'METHOD_DEACTIVATION_RACE_PAYMENT',
          }),
          send(
            fixture, baseUrl, `/api/admin/payment-methods/${fixture.apiMethodId}`,
            {
              method: 'PATCH', token: fixture.tokens.methodManage,
              label: 'METHOD_DEACTIVATION_RACE_PATCH',
              body: { isActive: false },
            },
          ),
        ]);
        status(deactivation, 200);
        assert.equal([201, 409].includes(creation.status), true, creation.text);
        if (creation.status === 201) {
          status(await paymentAction(
            fixture, baseUrl, sale.saleId,
            creation.json.data.payment.salePaymentId, 'cancel',
          ), 200);
        }
        const detail = await send(
          fixture, baseUrl, `/api/admin/payment-methods/${fixture.apiMethodId}`,
          { token: fixture.tokens.methodRead },
        );
        status(detail, 200);
        assert.equal(detail.json.data.paymentMethod.isActive, false);
        status(await send(
          fixture, baseUrl, `/api/admin/payment-methods/${fixture.apiMethodId}`,
          {
            method: 'PATCH', token: fixture.tokens.methodManage,
            body: { isActive: true },
          },
        ), 200);
      });

      await t.test('completes a zero-total sale without a fake payment', async () => {
        const sale = await createSale(fixture, baseUrl, {
          label: 'ZERO_SALE', discountAmount: '100.00',
        });
        assert.equal(sale.sale.totalAmount, '0.00');
        status(await completeSale(fixture, baseUrl, sale.saleId, 'ZERO_COMPLETE'), 200);
        const [payments] = await pool.execute(
          'SELECT COUNT(*) AS count FROM sale_payments WHERE sale_id = ?',
          [sale.saleId],
        );
        assert.equal(payments[0].count, '0');
      });

      await t.test('reconciles completed cash but excludes card from the till drawer', async () => {
        const cashSale = await createSale(fixture, baseUrl, {
          label: 'DRAWER_CASH_SALE', tillId: fixture.drawerTillId,
        });
        const cash = await createPayment(fixture, baseUrl, cashSale.saleId, '100.00', {
          paymentMethodId: fixture.paymentMethods.cash, label: 'DRAWER_CASH_PAYMENT',
        });
        status(cash, 201);
        status(await paymentAction(
          fixture, baseUrl, cashSale.saleId,
          cash.json.data.payment.salePaymentId, 'complete',
        ), 200);
        status(await completeSale(fixture, baseUrl, cashSale.saleId, 'DRAWER_CASH_COMPLETE'), 200);

        const cardSale = await createSale(fixture, baseUrl, {
          label: 'DRAWER_CARD_SALE', tillId: fixture.drawerTillId,
        });
        const card = await createPayment(fixture, baseUrl, cardSale.saleId, '100.00', {
          paymentMethodId: fixture.paymentMethods.card, label: 'DRAWER_CARD_PAYMENT',
        });
        status(card, 201);
        status(await paymentAction(
          fixture, baseUrl, cardSale.saleId,
          card.json.data.payment.salePaymentId, 'complete',
        ), 200);
        status(await completeSale(fixture, baseUrl, cardSale.saleId, 'DRAWER_CARD_COMPLETE'), 200);

        const closed = await send(
          fixture, baseUrl,
          `${branchRoot(fixture)}/till-sessions/${fixture.drawerTillId}/close`,
          {
            method: 'POST', label: 'DRAWER_CLOSE',
            body: { actualClosingCashAmount: '110.00' },
          },
        );
        status(closed, 200);
        assert.deepEqual(
          [closed.json.data.tillSession.expectedClosingCashAmount,
            closed.json.data.tillSession.actualClosingCashAmount,
            closed.json.data.tillSession.cashDifferenceAmount],
          ['110.00', '110.00', '0.00'],
        );
      });

      await t.test('uses only the six Phase 13 audits and exposes no refund API', async () => {
        const [actions] = await pool.execute(
          `SELECT DISTINCT action_type AS actionType FROM audit_logs
           WHERE request_id LIKE ?
             AND (action_type LIKE 'PAYMENT_METHOD_%'
               OR action_type LIKE 'SALE_PAYMENT_%')
           ORDER BY action_type`,
          [`${fixture.prefix}%`],
        );
        assert.deepEqual(actions.map((row) => row.actionType), [
          'PAYMENT_METHOD_CREATED',
          'PAYMENT_METHOD_UPDATED',
          'SALE_PAYMENT_CANCELLED',
          'SALE_PAYMENT_COMPLETED',
          'SALE_PAYMENT_CREATED',
          'SALE_PAYMENT_FAILED',
        ]);
        status(await send(
          fixture, baseUrl,
          `${branchRoot(fixture)}/sales/1/payments/1/refund`,
          { method: 'POST', body: {} },
        ), 404);
        const [refunds] = await pool.execute(
          `SELECT COUNT(*) AS count FROM sale_payments sp
           INNER JOIN sales s ON s.sale_id = sp.sale_id
           WHERE s.branch_id = ? AND sp.payment_type = 'REFUND'`,
          [fixture.branchAId],
        );
        assert.equal(refunds[0].count, '0');
      });
    } finally {
      const errors = [];
      try { await stopServer(server); } catch (error) { errors.push(error); }
      try { await cleanupFixture(fixture); } catch (error) { errors.push(error); }
      try { await pool.end(); } catch (error) { errors.push(error); }
      if (errors.length > 0) throw new AggregateError(errors, 'Phase 13 cleanup failed');
    }
  },
);
