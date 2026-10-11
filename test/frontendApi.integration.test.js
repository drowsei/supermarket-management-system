import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';

import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const [
  { default: app },
  { pool },
  { SYSTEM_ADMIN_ROLE },
  { signAccessToken },
] = await Promise.all([
  import('../src/app.js'),
  import('../src/config/database.js'),
  import('../src/config/accessControl.js'),
  import('../src/utils/jwt.js'),
]);

import {
  adjustmentConfig,
  branchConfig,
  catalogConfigs,
  countConfig,
  customerConfig,
  employeeConfig,
  goodsReceiptConfig,
  inventoryConfig,
  packagePriceConfig,
  paymentMethodConfig,
  permissionConfig,
  posRegisterConfig,
  productConfig,
  purchaseOrderConfig,
  saleConfig,
  supplierConfig,
  tillConfig,
  transactionConfig,
  transferConfig,
  userConfig,
  variantConfig,
  variantPriceConfig,
} from '../public/js/contracts.js';
import { createActionWorkflow } from '../public/js/components/actionWorkflow.js';
import {
  extractResourceRecord,
  resourceActionVisible,
  resourceUpdateAllowed,
  shouldRefreshAfterActionFailure,
} from '../public/js/components/resourcePage.js';
import { selectorOption } from '../public/js/components/entitySelector.js';
import { variantWorkspaceSelector } from '../public/js/pages/products.js';
import { completedReturnSelector } from '../public/js/pages/returns.js';
import { openTillSelector } from '../public/js/pages/sales.js';

const fixture = {
  branchId: null,
  userId: null,
  token: null,
  server: null,
  baseUrl: null,
};

function lastId(connection) {
  return connection.execute('SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id')
    .then(([rows]) => rows[0].id);
}

async function request(path) {
  const response = await fetch(`${fixture.baseUrl}${path}`, {
    headers: {
      authorization: `Bearer ${fixture.token}`,
      'user-agent': 'TEST_PHASE17_FRONTEND_API/1.0',
    },
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null, text };
}

before(async () => {
  const token = randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [roles] = await connection.execute(
      `SELECT CAST(role_id AS CHAR) AS roleId
       FROM roles
       WHERE role_code = ? AND is_active = 1
       LIMIT 1`,
      [SYSTEM_ADMIN_ROLE.code],
    );
    assert.ok(roles[0]?.roleId, 'SYSTEM_ADMIN role must exist before Phase 17 tests');

    await connection.execute(
      `INSERT INTO branches (
         branch_code, branch_name, address_line_1, city,
         country_code, currency_code, timezone, status
       ) VALUES (?, ?, '1 Integration Street', 'Lagos', 'NG', 'NGN', 'Africa/Lagos', 'ACTIVE')`,
      [`P17_${token}`, `TEST_P17 Branch ${token}`],
    );
    fixture.branchId = await lastId(connection);

    await connection.execute(
      `INSERT INTO users (
         username, email, password_hash, is_active, must_change_password
       ) VALUES (?, ?, 'TEST_P17_NOT_USED_FOR_LOGIN', 1, 0)`,
      [`test_p17_${token.toLowerCase()}`, `test_p17_${token.toLowerCase()}@example.invalid`],
    );
    fixture.userId = await lastId(connection);
    await connection.execute(
      'INSERT INTO user_roles (user_id, role_id, branch_id) VALUES (?, ?, NULL)',
      [fixture.userId, roles[0].roleId],
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  fixture.token = signAccessToken(fixture.userId).accessToken;
  fixture.server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    fixture.server.once('listening', resolve);
    fixture.server.once('error', reject);
  });
  fixture.baseUrl = `http://127.0.0.1:${fixture.server.address().port}`;
});

after(async () => {
  if (fixture.server?.listening) {
    await new Promise((resolve, reject) => fixture.server.close((error) =>
      (error ? reject(error) : resolve())));
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    if (fixture.userId) await connection.execute('DELETE FROM users WHERE user_id = ?', [fixture.userId]);
    if (fixture.branchId) await connection.execute('DELETE FROM branches WHERE branch_id = ?', [fixture.branchId]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }
});

test('frontend list contracts reach live API routes with supported queries and envelopes', async () => {
  const branchId = fixture.branchId;
  const paths = [
    branchConfig.listPath,
    employeeConfig.listPath,
    userConfig.listPath,
    permissionConfig.listPath,
    ...catalogConfigs.map((config) => config.listPath),
    productConfig.listPath,
    supplierConfig.listPath,
    customerConfig.listPath,
    paymentMethodConfig.listPath,
    variantPriceConfig.listPath({ branchId }),
    packagePriceConfig.listPath({ branchId }),
    inventoryConfig.listPath({ branchId }),
    transactionConfig.listPath({ branchId }),
    posRegisterConfig.listPath({ branchId }),
    tillConfig.listPath({ branchId }),
    purchaseOrderConfig.listPath({ branchId }),
    goodsReceiptConfig.listPath({ branchId }),
    adjustmentConfig.listPath({ branchId }),
    countConfig.listPath({ branchId }),
    transferConfig.listPath({ branchId }),
    saleConfig.listPath({ branchId }),
  ];

  for (const path of paths) {
    const result = await request(`${path}?page=1&limit=1`);
    assert.equal(result.status, 200, `${path}: ${result.text}`);
    assert.equal(result.json?.success, true, path);
    assert.ok(Array.isArray(result.json?.data?.items), path);
    assert.equal(typeof result.json?.data?.pagination, 'object', path);
  }

  const rejectedSearch = await request(`${tillConfig.listPath({ branchId })}?search=test`);
  assert.equal(rejectedSearch.status, 400);
  assert.equal(rejectedSearch.json.message, 'Request contains unsupported fields');
  assert.equal(tillConfig.search, false);
});

test('explicit response mappings unwrap entity records and reject contract drift', () => {
  const branch = { branchId: '18446744073709551615', branchName: 'GRA' };
  assert.equal(branchConfig.detailKey, 'branch');
  assert.deepEqual(extractResourceRecord({ branch }, branchConfig.detailKey), branch);
  assert.deepEqual(extractResourceRecord({ stockCount: branch, items: [] }, false), {
    stockCount: branch,
    items: [],
  });
  assert.throws(
    () => extractResourceRecord({ wrong: branch }, 'branch'),
    /expected branch record/,
  );
  assert.equal(inventoryConfig.editKey, 'branchInventory');
  assert.equal(purchaseOrderConfig.editKey, 'purchaseOrder');
  assert.equal(countConfig.editKey, 'stockCount');
});

test('product variant workspace consumes the API productVariantId exactly', () => {
  const productId = '18446744073709551615';
  const productVariantId = '18446744073709551614';
  const definition = variantWorkspaceSelector(productId);
  const option = selectorOption({
    productVariantId,
    variantName: 'Peak Milk 400g',
    sku: 'PEAK-400G-TIN',
  }, definition.remote);

  assert.equal(definition.remote.valueKey, 'productVariantId');
  assert.equal(option.value, productVariantId);
  assert.equal(typeof option.value, 'string');
  assert.equal(
    variantConfig.detailPath({ item: { productVariantId } }),
    `/api/admin/catalog/variants/${productVariantId}`,
  );
});

test('edit visibility matches mutable lifecycle states', () => {
  const branchId = '18446744073709551615';
  assert.equal(resourceUpdateAllowed(employeeConfig, { employmentStatus: 'ACTIVE' }), true);
  assert.equal(resourceUpdateAllowed(employeeConfig, { employmentStatus: 'TERMINATED' }), false);
  for (const config of [purchaseOrderConfig, goodsReceiptConfig, adjustmentConfig, countConfig]) {
    assert.equal(resourceUpdateAllowed(config, { status: 'DRAFT' }, branchId), true);
    assert.equal(resourceUpdateAllowed(config, { status: 'POSTED' }, branchId), false);
  }
  assert.equal(resourceUpdateAllowed(saleConfig, { status: 'OPEN' }, branchId), true);
  assert.equal(resourceUpdateAllowed(saleConfig, { status: 'COMPLETED' }, branchId), false);
  const post = countConfig.actions.find((action) => action.label === 'Post');
  assert.deepEqual(post.statuses, ['COUNTED']);
});

test('stock-transfer actions respect exact source and destination branch context', () => {
  const sourceBranchId = '18446744073709551615';
  const destinationBranchId = '18446744073709551614';
  const item = { sourceBranchId, destinationBranchId, status: 'REQUESTED' };
  const approve = transferConfig.actions.find((action) => action.label === 'Approve');
  const receive = transferConfig.actions.find((action) => action.label === 'Receive');

  assert.equal(resourceActionVisible(approve, item, sourceBranchId), true);
  assert.equal(resourceActionVisible(approve, item, destinationBranchId), false);
  assert.equal(resourceUpdateAllowed(
    transferConfig,
    { ...item, status: 'DRAFT' },
    sourceBranchId,
  ), true);
  assert.equal(resourceUpdateAllowed(
    transferConfig,
    { ...item, status: 'DRAFT' },
    destinationBranchId,
  ), false);
  assert.equal(resourceActionVisible(
    receive,
    { ...item, status: 'IN_TRANSIT' },
    sourceBranchId,
  ), false);
  assert.equal(resourceActionVisible(
    receive,
    { ...item, status: 'IN_TRANSIT' },
    destinationBranchId,
  ), true);
});

test('stale lifecycle failures trigger a refresh without broad retries', () => {
  assert.equal(shouldRefreshAfterActionFailure({}, { status: 409 }), true);
  assert.equal(shouldRefreshAfterActionFailure({}, { status: 404 }), true);
  assert.equal(shouldRefreshAfterActionFailure({}, { status: 400 }), false);
  assert.equal(shouldRefreshAfterActionFailure({ refreshOnFailure: true }, { status: 400 }), true);
});

test('action payloads preserve BIGINT and decimal strings exactly', async () => {
  const values = {
    productVariantId: '18446744073709551615',
    quantity: '999999999999.123',
    amount: '999999999999.99',
  };
  const workflow = createActionWorkflow(values);
  let received;
  const outcome = await workflow.confirm(async (body) => {
    received = body;
    return { success: true };
  });
  assert.equal(outcome.submitted, true);
  assert.deepEqual(received, values);
  assert.equal(typeof received.productVariantId, 'string');
  assert.equal(typeof received.quantity, 'string');
  assert.equal(typeof received.amount, 'string');
});

test('bounded non-searchable selectors use the API maximum page size', () => {
  assert.equal(openTillSelector('18446744073709551615').remote.limit, 100);
  assert.equal(
    completedReturnSelector('18446744073709551615', '18446744073709551614').remote.limit,
    100,
  );
});
