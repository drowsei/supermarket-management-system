import { insertAuditLog } from './audit.repository.js';
import { countAsSafeNumber, getLastInsertId } from './productCatalog.repository.js';
import {
  generateDocumentNumber,
  lockOperationalContext,
  pool,
  selectUtcNow,
  withPurchasingTransaction,
} from './purchasing.repository.js';
import {
  calculateReceiptLine,
  compareDecimals,
  deriveBaseQuantity,
  isWholeBaseQuantity,
  sumDecimals,
} from '../utils/purchasingDecimal.js';
import { toIsoString } from '../utils/record.js';

const GOODS_RECEIPT_COLUMNS = `
  CAST(gr.goods_receipt_id AS CHAR) AS goodsReceiptId,
  gr.goods_receipt_number AS goodsReceiptNumber,
  CAST(gr.purchase_order_id AS CHAR) AS purchaseOrderId,
  CAST(gr.branch_id AS CHAR) AS branchId,
  CAST(gr.supplier_id AS CHAR) AS supplierId,
  CAST(gr.inventory_transaction_id AS CHAR) AS inventoryTransactionId,
  gr.status,
  gr.supplier_delivery_note AS supplierDeliveryNote,
  gr.supplier_invoice_number AS supplierInvoiceNumber,
  DATE_FORMAT(gr.received_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS receivedAt,
  DATE_FORMAT(gr.posted_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS postedAt,
  CAST(gr.received_by_employee_id AS CHAR) AS receivedByEmployeeId,
  gr.notes,
  gr.created_at AS createdAt,
  gr.updated_at AS updatedAt,
  po.purchase_order_number AS purchaseOrderNumber,
  s.supplier_code AS supplierCode,
  s.supplier_name AS supplierName
`;

const GOODS_RECEIPT_ITEM_COLUMNS = `
  CAST(gri.goods_receipt_item_id AS CHAR) AS goodsReceiptItemId,
  CAST(gri.goods_receipt_id AS CHAR) AS goodsReceiptId,
  CAST(gri.purchase_order_id AS CHAR) AS purchaseOrderId,
  CAST(gri.purchase_order_item_id AS CHAR) AS purchaseOrderItemId,
  CAST(gri.product_variant_id AS CHAR) AS productVariantId,
  gri.line_number AS lineNumber,
  gri.package_quantity_accepted AS packageQuantityAccepted,
  gri.package_quantity_rejected AS packageQuantityRejected,
  gri.package_conversion_factor AS packageConversionFactor,
  gri.quantity_accepted AS quantityAccepted,
  gri.quantity_rejected AS quantityRejected,
  gri.actual_unit_cost AS actualUnitCost,
  gri.discount_amount AS discountAmount,
  gri.tax_amount AS taxAmount,
  gri.line_total AS lineTotal,
  gri.created_at AS createdAt,
  gri.updated_at AS updatedAt
`;

function normalizeGoodsReceipt(row) {
  if (!row) return null;
  return {
    ...row,
    inventoryTransactionId: row.inventoryTransactionId ?? null,
    supplierDeliveryNote: row.supplierDeliveryNote ?? null,
    supplierInvoiceNumber: row.supplierInvoiceNumber ?? null,
    receivedAt: row.receivedAt ?? null,
    postedAt: row.postedAt ?? null,
    notes: row.notes ?? null,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

function normalizeGoodsReceiptItem(row) {
  if (!row) return null;
  return {
    ...row,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

function receiptSnapshot(receipt) {
  const { purchaseOrderNumber, supplierCode, supplierName, createdAt, updatedAt, ...snapshot } = receipt;
  return snapshot;
}

function itemSnapshot(item) {
  const { createdAt, updatedAt, ...snapshot } = item;
  return snapshot;
}

async function selectGoodsReceipt(executor, branchId, goodsReceiptId, forUpdate = false) {
  const [rows] = await executor.execute(
    `SELECT ${GOODS_RECEIPT_COLUMNS}
     FROM goods_receipts gr
     INNER JOIN purchase_orders po ON po.purchase_order_id = gr.purchase_order_id
     INNER JOIN suppliers s ON s.supplier_id = gr.supplier_id
     WHERE gr.branch_id = ? AND gr.goods_receipt_id = ?
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [branchId, goodsReceiptId],
  );
  return normalizeGoodsReceipt(rows[0]);
}

async function selectGoodsReceiptItem(
  executor, branchId, goodsReceiptId, goodsReceiptItemId, forUpdate = false,
) {
  const [rows] = await executor.execute(
    `SELECT ${GOODS_RECEIPT_ITEM_COLUMNS}
     FROM goods_receipt_items gri
     INNER JOIN goods_receipts gr ON gr.goods_receipt_id = gri.goods_receipt_id
     WHERE gr.branch_id = ? AND gri.goods_receipt_id = ?
       AND gri.goods_receipt_item_id = ?
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [branchId, goodsReceiptId, goodsReceiptItemId],
  );
  return normalizeGoodsReceiptItem(rows[0]);
}

async function selectReceiptItems(executor, goodsReceiptId, forUpdate = false) {
  const [rows] = await executor.execute(
    `SELECT ${GOODS_RECEIPT_ITEM_COLUMNS}
     FROM goods_receipt_items gri
     WHERE gri.goods_receipt_id = ?
     ORDER BY gri.line_number, gri.goods_receipt_item_id${forUpdate ? ' FOR UPDATE' : ''}`,
    [goodsReceiptId],
  );
  return rows.map(normalizeGoodsReceiptItem);
}

async function selectReceiptLots(executor, goodsReceiptId) {
  const [rows] = await executor.execute(
    `SELECT
       CAST(gril.goods_receipt_item_lot_id AS CHAR) AS goodsReceiptItemLotId,
       CAST(gril.goods_receipt_item_id AS CHAR) AS goodsReceiptItemId,
       CAST(gril.inventory_lot_id AS CHAR) AS inventoryLotId,
       CAST(gril.product_variant_id AS CHAR) AS productVariantId,
       il.lot_number AS lotNumber,
       DATE_FORMAT(il.manufactured_on, '%Y-%m-%d') AS manufacturedOn,
       DATE_FORMAT(il.expires_on, '%Y-%m-%d') AS expiresOn,
       il.status AS lotStatus,
       gril.quantity_received AS quantityReceived,
       gril.unit_cost AS unitCost
     FROM goods_receipt_item_lots gril
     INNER JOIN inventory_lots il ON il.inventory_lot_id = gril.inventory_lot_id
     INNER JOIN goods_receipt_items gri
       ON gri.goods_receipt_item_id = gril.goods_receipt_item_id
     WHERE gri.goods_receipt_id = ?
     ORDER BY gri.line_number, gril.goods_receipt_item_lot_id`,
    [goodsReceiptId],
  );
  return rows.map((row) => ({
    ...row,
    manufacturedOn: row.manufacturedOn ?? null,
    expiresOn: row.expiresOn ?? null,
    unitCost: row.unitCost ?? null,
  }));
}

async function listGoodsReceipts(branchId, filters) {
  const predicates = ['gr.branch_id = ?'];
  const parameters = [branchId];
  if (filters.search) {
    predicates.push(`LOCATE(?, CONCAT_WS(' ', gr.goods_receipt_number,
      gr.supplier_delivery_note, gr.supplier_invoice_number,
      po.purchase_order_number, s.supplier_code, s.supplier_name)) > 0`);
    parameters.push(filters.search);
  }
  for (const [value, column] of [
    [filters.status, 'gr.status'],
    [filters.purchaseOrderId, 'gr.purchase_order_id'],
    [filters.supplierId, 'gr.supplier_id'],
    [filters.receivedByEmployeeId, 'gr.received_by_employee_id'],
  ]) {
    if (value !== null) {
      predicates.push(`${column} = ?`);
      parameters.push(value);
    }
  }
  if (filters.from) {
    predicates.push('gr.received_at >= ?');
    parameters.push(filters.from);
  }
  if (filters.to) {
    predicates.push('gr.received_at < DATE_ADD(?, INTERVAL 1 DAY)');
    parameters.push(filters.to);
  }
  const where = `WHERE ${predicates.join(' AND ')}`;
  const [countRows] = await pool.execute(
    `SELECT CAST(COUNT(*) AS CHAR) AS totalItems
     FROM goods_receipts gr
     INNER JOIN purchase_orders po ON po.purchase_order_id = gr.purchase_order_id
     INNER JOIN suppliers s ON s.supplier_id = gr.supplier_id ${where}`,
    parameters,
  );
  const [rows] = await pool.execute(
    `SELECT ${GOODS_RECEIPT_COLUMNS}
     FROM goods_receipts gr
     INNER JOIN purchase_orders po ON po.purchase_order_id = gr.purchase_order_id
     INNER JOIN suppliers s ON s.supplier_id = gr.supplier_id
     ${where}
     ORDER BY gr.created_at DESC, gr.goods_receipt_id DESC
     LIMIT ? OFFSET ?`,
    [...parameters, filters.limit, filters.offset],
  );
  return {
    items: rows.map(normalizeGoodsReceipt),
    totalItems: countAsSafeNumber(countRows[0].totalItems, 'goods receipt'),
  };
}

async function findGoodsReceipt(branchId, goodsReceiptId) {
  const goodsReceipt = await selectGoodsReceipt(pool, branchId, goodsReceiptId);
  if (!goodsReceipt) return null;
  return {
    goodsReceipt,
    items: await selectReceiptItems(pool, goodsReceiptId),
    lotAllocations:
      goodsReceipt.status === 'POSTED'
        ? await selectReceiptLots(pool, goodsReceiptId)
        : [],
  };
}

async function operational(connection, branchId, auditContext) {
  return lockOperationalContext(connection, branchId, auditContext?.actorEmployeeId);
}

async function createGoodsReceipt(branchId, values, auditContext) {
  return withPurchasingTransaction(async (connection) => {
    const context = await operational(connection, branchId, auditContext);
    if (context.outcome !== 'valid') return context;
    const [orderRows] = await connection.execute(
      `SELECT
         CAST(purchase_order_id AS CHAR) AS purchaseOrderId,
         CAST(supplier_id AS CHAR) AS supplierId, status
       FROM purchase_orders
       WHERE branch_id = ? AND purchase_order_id = ?
       LIMIT 1 FOR UPDATE`,
      [branchId, values.purchaseOrderId],
    );
    const order = orderRows[0];
    if (!order) return { outcome: 'purchase_order_not_found' };
    if (!['APPROVED', 'PARTIALLY_RECEIVED'].includes(order.status)) {
      return { outcome: 'purchase_order_not_receivable' };
    }
    const receivedAt = await selectUtcNow(connection);
    await connection.execute(
      `INSERT INTO goods_receipts (
         goods_receipt_number, purchase_order_id, branch_id, supplier_id,
         status, supplier_delivery_note, supplier_invoice_number, received_at,
         received_by_employee_id, notes
       ) VALUES (?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?)`,
      [
        generateDocumentNumber('GR'), values.purchaseOrderId, branchId,
        order.supplierId, values.supplierDeliveryNote,
        values.supplierInvoiceNumber, receivedAt, auditContext.actorEmployeeId,
        values.notes,
      ],
    );
    const goodsReceiptId = await getLastInsertId(connection);
    const goodsReceipt = await selectGoodsReceipt(connection, branchId, goodsReceiptId);
    await insertAuditLog(connection, {
      auditContext, branchId,
      actionType: 'GOODS_RECEIPT_CREATED', entityType: 'goods_receipts',
      entityRecordId: goodsReceiptId, beforeValues: null,
      afterValues: receiptSnapshot(goodsReceipt),
      notes: 'Goods receipt draft created.',
    });
    return { outcome: 'created', goodsReceipt };
  });
}

const RECEIPT_UPDATE_COLUMNS = Object.freeze({
  supplierDeliveryNote: 'supplier_delivery_note',
  supplierInvoiceNumber: 'supplier_invoice_number',
  notes: 'notes',
});

async function updateGoodsReceipt(branchId, goodsReceiptId, changes, auditContext) {
  return withPurchasingTransaction(async (connection) => {
    const context = await operational(connection, branchId, auditContext);
    if (context.outcome !== 'valid') return context;
    const current = await selectGoodsReceipt(connection, branchId, goodsReceiptId, true);
    if (!current) return { outcome: 'not_found' };
    if (current.status !== 'DRAFT') return { outcome: 'not_draft' };
    const changed = Object.entries(changes).filter(
      ([field, value]) => current[field] !== value,
    );
    if (!changed.length) return { outcome: 'unchanged', goodsReceipt: current };
    await connection.execute(
      `UPDATE goods_receipts SET ${changed.map(([field]) => `${RECEIPT_UPDATE_COLUMNS[field]} = ?`).join(', ')}
       WHERE goods_receipt_id = ?`,
      [...changed.map(([, value]) => value), goodsReceiptId],
    );
    const goodsReceipt = await selectGoodsReceipt(connection, branchId, goodsReceiptId);
    await insertAuditLog(connection, {
      auditContext, branchId,
      actionType: 'GOODS_RECEIPT_UPDATED', entityType: 'goods_receipts',
      entityRecordId: goodsReceiptId,
      beforeValues: receiptSnapshot(current), afterValues: receiptSnapshot(goodsReceipt),
      notes: 'Goods receipt draft header updated.',
    });
    return { outcome: 'updated', goodsReceipt };
  });
}

async function preReadReceipt(branchId, goodsReceiptId) {
  const [rows] = await pool.execute(
    `SELECT CAST(purchase_order_id AS CHAR) AS purchaseOrderId
     FROM goods_receipts WHERE branch_id = ? AND goods_receipt_id = ? LIMIT 1`,
    [branchId, goodsReceiptId],
  );
  return rows[0] ?? null;
}

async function lockReceiptDocument(connection, branchId, goodsReceiptId, purchaseOrderId) {
  const [orderRows] = await connection.execute(
    `SELECT status FROM purchase_orders
     WHERE branch_id = ? AND purchase_order_id = ? LIMIT 1 FOR UPDATE`,
    [branchId, purchaseOrderId],
  );
  if (!orderRows[0]) return { outcome: 'not_found' };
  await connection.execute(
    `SELECT purchase_order_item_id FROM purchase_order_items
     WHERE purchase_order_id = ? ORDER BY purchase_order_item_id FOR UPDATE`,
    [purchaseOrderId],
  );
  const [receiptRows] = await connection.execute(
    `SELECT CAST(goods_receipt_id AS CHAR) AS goodsReceiptId, status
     FROM goods_receipts WHERE purchase_order_id = ?
     ORDER BY goods_receipt_id FOR UPDATE`,
    [purchaseOrderId],
  );
  const receipt = receiptRows.find((row) => row.goodsReceiptId === goodsReceiptId);
  if (!receipt) return { outcome: 'not_found' };
  if (receipt.status !== 'DRAFT') return { outcome: 'not_draft' };
  if (!['APPROVED', 'PARTIALLY_RECEIVED'].includes(orderRows[0].status)) {
    return { outcome: 'purchase_order_not_receivable' };
  }
  const [itemRows] = await connection.execute(
    `SELECT goods_receipt_item_id FROM goods_receipt_items
     WHERE purchase_order_id = ? ORDER BY goods_receipt_item_id FOR UPDATE`,
    [purchaseOrderId],
  );
  return { outcome: 'valid' };
}

async function selectPurchaseOrderItemForReceipt(connection, purchaseOrderId, purchaseOrderItemId) {
  const [rows] = await connection.execute(
    `SELECT
       CAST(poi.purchase_order_item_id AS CHAR) AS purchaseOrderItemId,
       CAST(poi.product_variant_id AS CHAR) AS productVariantId,
       poi.package_conversion_factor AS packageConversionFactor,
       poi.ordered_quantity AS orderedQuantity,
       pv.is_fractional AS isFractional
     FROM purchase_order_items poi
     INNER JOIN product_variants pv ON pv.product_variant_id = poi.product_variant_id
     WHERE poi.purchase_order_id = ? AND poi.purchase_order_item_id = ?
     LIMIT 1`,
    [purchaseOrderId, purchaseOrderItemId],
  );
  return rows[0] ?? null;
}

async function postedAccepted(connection, purchaseOrderItemId) {
  const [rows] = await connection.execute(
    `SELECT COALESCE(SUM(gri.quantity_accepted), 0.000) AS acceptedQuantity
     FROM goods_receipt_items gri
     INNER JOIN goods_receipts gr ON gr.goods_receipt_id = gri.goods_receipt_id
     WHERE gri.purchase_order_item_id = ? AND gr.status = 'POSTED'`,
    [purchaseOrderItemId],
  );
  return rows[0].acceptedQuantity;
}

function deriveReceiptValues(values, conversionFactor) {
  const quantityAccepted = deriveBaseQuantity(
    values.packageQuantityAccepted, conversionFactor,
  );
  const quantityRejected = deriveBaseQuantity(
    values.packageQuantityRejected, conversionFactor,
  );
  const calculation = calculateReceiptLine({ ...values, quantityAccepted });
  return { quantityAccepted, quantityRejected, ...calculation };
}

function validateReceiptQuantities(values, derived, orderItem, alreadyAccepted) {
  if (
    compareDecimals(values.packageQuantityAccepted, '0.000', 3) === 0 &&
    compareDecimals(values.packageQuantityRejected, '0.000', 3) === 0
  ) return 'zero_quantities';
  if (!orderItem.isFractional && (
    !isWholeBaseQuantity(derived.quantityAccepted) ||
    !isWholeBaseQuantity(derived.quantityRejected)
  )) return 'fractional_quantity';
  const projected = sumDecimals([alreadyAccepted, derived.quantityAccepted], 3);
  if (compareDecimals(projected, orderItem.orderedQuantity, 3) > 0) {
    return 'over_received';
  }
  return null;
}

async function createGoodsReceiptItem(
  branchId, goodsReceiptId, values, auditContext,
) {
  const preRead = await preReadReceipt(branchId, goodsReceiptId);
  if (!preRead) return { outcome: 'not_found' };
  return withPurchasingTransaction(async (connection) => {
    const context = await operational(connection, branchId, auditContext);
    if (context.outcome !== 'valid') return context;
    const locked = await lockReceiptDocument(
      connection, branchId, goodsReceiptId, preRead.purchaseOrderId,
    );
    if (locked.outcome !== 'valid') return locked;
    const orderItem = await selectPurchaseOrderItemForReceipt(
      connection, preRead.purchaseOrderId, values.purchaseOrderItemId,
    );
    if (!orderItem) return { outcome: 'purchase_order_item_not_found' };
    const derived = deriveReceiptValues(values, orderItem.packageConversionFactor);
    if (derived.outcome !== 'calculated') return derived;
    const invalid = validateReceiptQuantities(
      values, derived, orderItem, await postedAccepted(connection, values.purchaseOrderItemId),
    );
    if (invalid) return { outcome: invalid };
    const [lineRows] = await connection.execute(
      `SELECT COALESCE(MAX(line_number), 0) + 1 AS lineNumber
       FROM goods_receipt_items WHERE goods_receipt_id = ?`,
      [goodsReceiptId],
    );
    if (lineRows[0].lineNumber > 65_535) return { outcome: 'too_many_items' };
    await connection.execute(
      `INSERT INTO goods_receipt_items (
         goods_receipt_id, purchase_order_id, purchase_order_item_id,
         product_variant_id, line_number, package_quantity_accepted,
         package_quantity_rejected, package_conversion_factor,
         quantity_accepted, quantity_rejected, actual_unit_cost,
         discount_amount, tax_amount, line_total
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        goodsReceiptId, preRead.purchaseOrderId, values.purchaseOrderItemId,
        orderItem.productVariantId, lineRows[0].lineNumber,
        values.packageQuantityAccepted, values.packageQuantityRejected,
        orderItem.packageConversionFactor, derived.quantityAccepted,
        derived.quantityRejected, values.actualUnitCost, values.discountAmount,
        values.taxAmount, derived.lineTotal,
      ],
    );
    const itemId = await getLastInsertId(connection);
    const item = await selectGoodsReceiptItem(
      connection, branchId, goodsReceiptId, itemId,
    );
    await insertAuditLog(connection, {
      auditContext, branchId,
      actionType: 'GOODS_RECEIPT_ITEM_CREATED', entityType: 'goods_receipt_items',
      entityRecordId: itemId, beforeValues: null, afterValues: itemSnapshot(item),
      notes: 'Goods receipt draft item created.',
    });
    return { outcome: 'created', item };
  });
}

async function preReadReceiptItem(branchId, goodsReceiptId, goodsReceiptItemId) {
  const [rows] = await pool.execute(
    `SELECT CAST(gr.purchase_order_id AS CHAR) AS purchaseOrderId,
       CAST(gri.purchase_order_item_id AS CHAR) AS purchaseOrderItemId
     FROM goods_receipt_items gri
     INNER JOIN goods_receipts gr ON gr.goods_receipt_id = gri.goods_receipt_id
     WHERE gr.branch_id = ? AND gri.goods_receipt_id = ?
       AND gri.goods_receipt_item_id = ? LIMIT 1`,
    [branchId, goodsReceiptId, goodsReceiptItemId],
  );
  return rows[0] ?? null;
}

async function updateGoodsReceiptItem(
  branchId, goodsReceiptId, goodsReceiptItemId, changes, auditContext,
) {
  const preRead = await preReadReceiptItem(branchId, goodsReceiptId, goodsReceiptItemId);
  if (!preRead) return { outcome: 'item_not_found' };
  return withPurchasingTransaction(async (connection) => {
    const context = await operational(connection, branchId, auditContext);
    if (context.outcome !== 'valid') return context;
    const locked = await lockReceiptDocument(
      connection, branchId, goodsReceiptId, preRead.purchaseOrderId,
    );
    if (locked.outcome !== 'valid') return locked;
    const orderItem = await selectPurchaseOrderItemForReceipt(
      connection, preRead.purchaseOrderId, preRead.purchaseOrderItemId,
    );
    if (!orderItem) return { outcome: 'purchase_order_item_not_found' };
    const current = await selectGoodsReceiptItem(
      connection, branchId, goodsReceiptId, goodsReceiptItemId, true,
    );
    if (!current) return { outcome: 'item_not_found' };
    const projected = { ...current, ...changes };
    const derived = deriveReceiptValues(projected, current.packageConversionFactor);
    if (derived.outcome !== 'calculated') return derived;
    const invalid = validateReceiptQuantities(
      projected, derived, orderItem, await postedAccepted(connection, preRead.purchaseOrderItemId),
    );
    if (invalid) return { outcome: invalid };
    const finalValues = {
      packageQuantityAccepted: projected.packageQuantityAccepted,
      packageQuantityRejected: projected.packageQuantityRejected,
      quantityAccepted: derived.quantityAccepted,
      quantityRejected: derived.quantityRejected,
      actualUnitCost: projected.actualUnitCost,
      discountAmount: projected.discountAmount,
      taxAmount: projected.taxAmount,
      lineTotal: derived.lineTotal,
    };
    if (Object.entries(finalValues).every(([field, value]) => current[field] === value)) {
      return { outcome: 'unchanged', item: current };
    }
    await connection.execute(
      `UPDATE goods_receipt_items SET
         package_quantity_accepted = ?, package_quantity_rejected = ?,
         quantity_accepted = ?, quantity_rejected = ?, actual_unit_cost = ?,
         discount_amount = ?, tax_amount = ?, line_total = ?
       WHERE goods_receipt_item_id = ?`,
      [
        finalValues.packageQuantityAccepted, finalValues.packageQuantityRejected,
        finalValues.quantityAccepted, finalValues.quantityRejected,
        finalValues.actualUnitCost, finalValues.discountAmount,
        finalValues.taxAmount, finalValues.lineTotal, goodsReceiptItemId,
      ],
    );
    const item = await selectGoodsReceiptItem(
      connection, branchId, goodsReceiptId, goodsReceiptItemId,
    );
    await insertAuditLog(connection, {
      auditContext, branchId,
      actionType: 'GOODS_RECEIPT_ITEM_UPDATED', entityType: 'goods_receipt_items',
      entityRecordId: goodsReceiptItemId,
      beforeValues: itemSnapshot(current), afterValues: itemSnapshot(item),
      notes: 'Goods receipt draft item updated.',
    });
    return { outcome: 'updated', item };
  });
}

async function deleteGoodsReceiptItem(
  branchId, goodsReceiptId, goodsReceiptItemId, auditContext,
) {
  const preRead = await preReadReceiptItem(branchId, goodsReceiptId, goodsReceiptItemId);
  if (!preRead) return { outcome: 'item_not_found' };
  return withPurchasingTransaction(async (connection) => {
    const context = await operational(connection, branchId, auditContext);
    if (context.outcome !== 'valid') return context;
    const locked = await lockReceiptDocument(
      connection, branchId, goodsReceiptId, preRead.purchaseOrderId,
    );
    if (locked.outcome !== 'valid') return locked;
    const item = await selectGoodsReceiptItem(
      connection, branchId, goodsReceiptId, goodsReceiptItemId, true,
    );
    if (!item) return { outcome: 'item_not_found' };
    await connection.execute(
      'DELETE FROM goods_receipt_items WHERE goods_receipt_item_id = ?',
      [goodsReceiptItemId],
    );
    await insertAuditLog(connection, {
      auditContext, branchId,
      actionType: 'GOODS_RECEIPT_ITEM_DELETED', entityType: 'goods_receipt_items',
      entityRecordId: goodsReceiptItemId,
      beforeValues: itemSnapshot(item), afterValues: null,
      notes: 'Goods receipt draft item deleted.',
    });
    return { outcome: 'deleted', item };
  });
}

async function cancelGoodsReceipt(branchId, goodsReceiptId, auditContext) {
  return withPurchasingTransaction(async (connection) => {
    const context = await operational(connection, branchId, auditContext);
    if (context.outcome !== 'valid') return context;
    const current = await selectGoodsReceipt(connection, branchId, goodsReceiptId, true);
    if (!current) return { outcome: 'not_found' };
    if (current.status !== 'DRAFT') return { outcome: 'invalid_transition' };
    await connection.execute(
      "UPDATE goods_receipts SET status = 'CANCELLED' WHERE goods_receipt_id = ?",
      [goodsReceiptId],
    );
    const goodsReceipt = await selectGoodsReceipt(connection, branchId, goodsReceiptId);
    await insertAuditLog(connection, {
      auditContext, branchId,
      actionType: 'GOODS_RECEIPT_CANCELLED', entityType: 'goods_receipts',
      entityRecordId: goodsReceiptId,
      beforeValues: receiptSnapshot(current), afterValues: receiptSnapshot(goodsReceipt),
      notes: 'Goods receipt cancelled without posting stock.',
    });
    return { outcome: 'cancelled', goodsReceipt };
  });
}

export {
  GOODS_RECEIPT_ITEM_COLUMNS,
  createGoodsReceipt,
  createGoodsReceiptItem,
  deleteGoodsReceiptItem,
  findGoodsReceipt,
  itemSnapshot,
  listGoodsReceipts,
  normalizeGoodsReceiptItem,
  receiptSnapshot,
  selectGoodsReceipt,
  selectGoodsReceiptItem,
  selectReceiptItems,
  updateGoodsReceipt,
  updateGoodsReceiptItem,
  cancelGoodsReceipt,
};
