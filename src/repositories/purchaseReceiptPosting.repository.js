import { insertAuditLog } from './audit.repository.js';
import {
  getLastInsertId,
  lockRowsByIds,
  uniqueSortedIds,
} from './productCatalog.repository.js';
import {
  generateDocumentNumber,
  lockOperationalContext,
  pool,
  selectUtcNow,
  withPurchasingTransaction,
} from './purchasing.repository.js';
import {
  compareDecimals,
  sumDecimals,
} from '../utils/purchasingDecimal.js';
import {
  receiptSnapshot,
  selectGoodsReceipt,
} from './goodsReceipt.repository.js';

async function preReadPosting(branchId, goodsReceiptId) {
  const [receiptRows] = await pool.execute(
    `SELECT CAST(gr.purchase_order_id AS CHAR) AS purchaseOrderId
     FROM goods_receipts gr
     WHERE gr.branch_id = ? AND gr.goods_receipt_id = ? LIMIT 1`,
    [branchId, goodsReceiptId],
  );
  if (!receiptRows[0]) return null;
  const [itemRows] = await pool.execute(
    `SELECT DISTINCT
       CAST(gri.product_variant_id AS CHAR) AS productVariantId,
       CAST(pv.product_id AS CHAR) AS productId
     FROM goods_receipt_items gri
     INNER JOIN product_variants pv ON pv.product_variant_id = gri.product_variant_id
     WHERE gri.goods_receipt_id = ?
     ORDER BY productVariantId`,
    [goodsReceiptId],
  );
  return { purchaseOrderId: receiptRows[0].purchaseOrderId, items: itemRows };
}

async function lockCatalogRoots(connection, preRead) {
  const products = await lockRowsByIds(connection, {
    table: 'products', idColumn: 'product_id',
    ids: preRead.items.map((item) => item.productId),
    selectColumns: 'CAST(product_id AS CHAR) AS productId',
  });
  const variants = await lockRowsByIds(connection, {
    table: 'product_variants', idColumn: 'product_variant_id',
    ids: preRead.items.map((item) => item.productVariantId),
    selectColumns: `CAST(product_variant_id AS CHAR) AS productVariantId,
      CAST(product_id AS CHAR) AS productId,
      lot_tracking_mode AS lotTrackingMode,
      requires_expiry_date AS requiresExpiryDate`,
  });
  const variantIds = uniqueSortedIds(preRead.items.map((item) => item.productVariantId));
  if (variantIds.length) {
    const placeholders = variantIds.map(() => '?').join(', ');
    await connection.execute(
      `SELECT product_package_id FROM product_packages
       WHERE product_variant_id IN (${placeholders})
       ORDER BY product_variant_id, product_package_id FOR UPDATE`,
      variantIds,
    );
  }
  return { products, variants };
}

async function lockDocuments(connection, branchId, goodsReceiptId, preRead) {
  const [orderRows] = await connection.execute(
    `SELECT status FROM purchase_orders
     WHERE branch_id = ? AND purchase_order_id = ? LIMIT 1 FOR UPDATE`,
    [branchId, preRead.purchaseOrderId],
  );
  if (!orderRows[0]) return { outcome: 'not_found' };

  const [orderItemRows] = await connection.execute(
    `SELECT
       CAST(purchase_order_item_id AS CHAR) AS purchaseOrderItemId,
       CAST(product_variant_id AS CHAR) AS productVariantId,
       ordered_quantity AS orderedQuantity
     FROM purchase_order_items
     WHERE purchase_order_id = ?
     ORDER BY purchase_order_item_id FOR UPDATE`,
    [preRead.purchaseOrderId],
  );
  const [receiptRows] = await connection.execute(
    `SELECT CAST(goods_receipt_id AS CHAR) AS goodsReceiptId, status
     FROM goods_receipts WHERE purchase_order_id = ?
     ORDER BY goods_receipt_id FOR UPDATE`,
    [preRead.purchaseOrderId],
  );
  const receiptState = receiptRows.find((row) => row.goodsReceiptId === goodsReceiptId);
  if (!receiptState) return { outcome: 'not_found' };
  if (receiptState.status !== 'DRAFT') {
    return { outcome: receiptState.status === 'POSTED' ? 'already_posted' : 'not_draft' };
  }
  if (!['APPROVED', 'PARTIALLY_RECEIVED'].includes(orderRows[0].status)) {
    return { outcome: 'purchase_order_not_receivable' };
  }
  const [receiptItemRows] = await connection.execute(
    `SELECT
       CAST(gri.goods_receipt_item_id AS CHAR) AS goodsReceiptItemId,
       CAST(gri.goods_receipt_id AS CHAR) AS goodsReceiptId,
       CAST(gri.purchase_order_item_id AS CHAR) AS purchaseOrderItemId,
       CAST(gri.product_variant_id AS CHAR) AS productVariantId,
       gri.line_number AS lineNumber,
       gri.quantity_accepted AS quantityAccepted,
       gri.quantity_rejected AS quantityRejected,
       gri.actual_unit_cost AS actualUnitCost
     FROM goods_receipt_items gri
     WHERE gri.purchase_order_id = ?
     ORDER BY gri.goods_receipt_item_id FOR UPDATE`,
    [preRead.purchaseOrderId],
  );
  return {
    outcome: 'valid',
    orderItems: orderItemRows,
    receiptItems: receiptItemRows.filter((item) => item.goodsReceiptId === goodsReceiptId),
    allReceiptItems: receiptItemRows,
    receiptStates: new Map(receiptRows.map((row) => [row.goodsReceiptId, row.status])),
  };
}

function validateReceiptLimits(documents) {
  const orderItems = new Map(
    documents.orderItems.map((item) => [item.purchaseOrderItemId, item]),
  );
  let acceptedLineCount = 0;
  for (const receiptItem of documents.receiptItems) {
    const orderItem = orderItems.get(receiptItem.purchaseOrderItemId);
    if (!orderItem || orderItem.productVariantId !== receiptItem.productVariantId) {
      return 'purchase_order_item_not_found';
    }
    if (compareDecimals(receiptItem.quantityAccepted, '0.000', 3) > 0) {
      acceptedLineCount += 1;
    }
    const priorPosted = documents.allReceiptItems
      .filter(
        (item) =>
          item.purchaseOrderItemId === receiptItem.purchaseOrderItemId &&
          documents.receiptStates.get(item.goodsReceiptId) === 'POSTED',
      )
      .map((item) => item.quantityAccepted);
    const total = sumDecimals([...priorPosted, receiptItem.quantityAccepted], 3);
    if (compareDecimals(total, orderItem.orderedQuantity, 3) > 0) {
      return 'over_received';
    }
  }
  if (documents.receiptItems.length === 0) return 'empty_receipt';
  if (acceptedLineCount === 0) return 'no_accepted_stock';
  return null;
}

function makeVariantPolicies(preRead, catalog) {
  if (
    catalog.products.length !== new Set(preRead.items.map((item) => item.productId)).size ||
    catalog.variants.length !== preRead.items.length
  ) return null;
  return new Map(
    catalog.variants.map((variant) => [variant.productVariantId, variant]),
  );
}

function validateAllocationShape(documents, allocations, policies) {
  const itemMap = new Map(documents.receiptItems.map((item) => [item.goodsReceiptItemId, item]));
  const allocationMap = new Map(allocations.map((entry) => [entry.goodsReceiptItemId, entry.lots]));
  for (const itemId of allocationMap.keys()) {
    if (!itemMap.has(itemId)) return { outcome: 'allocation_item_not_found' };
  }
  for (const item of documents.receiptItems) {
    const policy = policies.get(item.productVariantId);
    if (!policy) return { outcome: 'concurrent_change' };
    const lots = allocationMap.get(item.goodsReceiptItemId);
    const hasAcceptedStock =
      compareDecimals(item.quantityAccepted, '0.000', 3) > 0;
    if (!hasAcceptedStock && lots) {
      return { outcome: 'lot_quantity_mismatch' };
    }
    if (policy.lotTrackingMode === 'NONE' && lots) {
      return { outcome: 'lots_not_allowed' };
    }
    if (hasAcceptedStock && policy.lotTrackingMode === 'REQUIRED' && !lots) {
      return { outcome: 'lots_required' };
    }
    if (lots) {
      const allocated = sumDecimals(lots.map((lot) => lot.quantityReceived), 3);
      if (allocated !== item.quantityAccepted) {
        return { outcome: 'lot_quantity_mismatch' };
      }
    }
  }
  return { outcome: 'valid', allocationMap };
}

function lotBusinessKey(variantId, lotNumber) {
  return `${variantId}\u0000${lotNumber}`;
}

async function resolveLots(connection, documents, allocationMap, policies, actorEmployeeId) {
  const requestedExistingIds = [];
  const requestedNumbers = [];
  const itemById = new Map(documents.receiptItems.map((item) => [item.goodsReceiptItemId, item]));
  for (const [itemId, lots] of allocationMap) {
    const item = itemById.get(itemId);
    for (const lot of lots) {
      if (lot.inventoryLotId) requestedExistingIds.push(lot.inventoryLotId);
      else requestedNumbers.push({ productVariantId: item.productVariantId, lotNumber: lot.lotNumber });
    }
  }
  const lockedById = await lockRowsByIds(connection, {
    table: 'inventory_lots', idColumn: 'inventory_lot_id', ids: requestedExistingIds,
    selectColumns: `CAST(inventory_lot_id AS CHAR) AS inventoryLotId,
      CAST(product_variant_id AS CHAR) AS productVariantId, lot_number AS lotNumber,
      DATE_FORMAT(manufactured_on, '%Y-%m-%d') AS manufacturedOn,
      DATE_FORMAT(expires_on, '%Y-%m-%d') AS expiresOn, status`,
  });
  const byId = new Map(lockedById.map((lot) => [lot.inventoryLotId, lot]));
  const byKey = new Map();
  requestedNumbers.sort((left, right) => {
    const variantCompare = BigInt(left.productVariantId) < BigInt(right.productVariantId) ? -1 : BigInt(left.productVariantId) > BigInt(right.productVariantId) ? 1 : 0;
    return variantCompare || (left.lotNumber < right.lotNumber ? -1 : left.lotNumber > right.lotNumber ? 1 : 0);
  });
  for (const request of requestedNumbers) {
    const key = lotBusinessKey(request.productVariantId, request.lotNumber);
    if (byKey.has(key)) continue;
    const item = [...allocationMap.entries()]
      .flatMap(([itemId, lots]) => lots.map((lot) => ({ itemId, lot })))
      .find(({ itemId, lot }) => lot.lotNumber === request.lotNumber &&
        itemById.get(itemId).productVariantId === request.productVariantId);
    const policy = policies.get(request.productVariantId);
    if (policy.requiresExpiryDate && item.lot.expiresOn === null) {
      return { outcome: 'expiry_required' };
    }
    await connection.execute(
      `INSERT INTO inventory_lots (
         product_variant_id, lot_number, manufactured_on, expires_on,
         status, created_by_employee_id
       ) VALUES (?, ?, ?, ?, 'ACTIVE', ?)
       ON DUPLICATE KEY UPDATE
         inventory_lot_id = LAST_INSERT_ID(inventory_lot_id)`,
      [
        request.productVariantId, request.lotNumber, item.lot.manufacturedOn,
        item.lot.expiresOn, actorEmployeeId,
      ],
    );
    const [rows] = await connection.execute(
      `SELECT CAST(inventory_lot_id AS CHAR) AS inventoryLotId,
         CAST(product_variant_id AS CHAR) AS productVariantId, lot_number AS lotNumber,
         DATE_FORMAT(manufactured_on, '%Y-%m-%d') AS manufacturedOn,
         DATE_FORMAT(expires_on, '%Y-%m-%d') AS expiresOn, status
       FROM inventory_lots
       WHERE product_variant_id = ? AND BINARY lot_number = BINARY ?
       LIMIT 1 FOR UPDATE`,
      [request.productVariantId, request.lotNumber],
    );
    if (
      item.lot.manufacturedOn !== null &&
      item.lot.manufacturedOn !== rows[0].manufacturedOn
    ) return { outcome: 'lot_metadata_conflict' };
    if (item.lot.expiresOn !== null && item.lot.expiresOn !== rows[0].expiresOn) {
      return { outcome: 'lot_metadata_conflict' };
    }
    byKey.set(key, rows[0]);
  }

  const resolvedByItem = new Map();
  for (const [itemId, lots] of allocationMap) {
    const item = itemById.get(itemId);
    const policy = policies.get(item.productVariantId);
    const resolved = [];
    const usedLotIds = new Set();
    for (const request of lots) {
      let lot;
      if (request.inventoryLotId) {
        lot = byId.get(request.inventoryLotId);
        if (!lot) return { outcome: 'lot_not_found' };
        if (lot.productVariantId !== item.productVariantId) {
          return { outcome: 'lot_variant_mismatch' };
        }
      } else {
        const key = lotBusinessKey(item.productVariantId, request.lotNumber);
        lot = byKey.get(key);
        if (lot) {
          if (
            (request.manufacturedOn !== null && request.manufacturedOn !== lot.manufacturedOn) ||
            (request.expiresOn !== null && request.expiresOn !== lot.expiresOn)
          ) return { outcome: 'lot_metadata_conflict' };
        } else {
          return { outcome: 'concurrent_change' };
        }
      }
      if (['RECALLED', 'CLOSED'].includes(lot.status)) {
        return { outcome: 'lot_not_receivable' };
      }
      if (policy.requiresExpiryDate && lot.expiresOn === null) {
        return { outcome: 'expiry_required' };
      }
      if (usedLotIds.has(lot.inventoryLotId)) {
        return { outcome: 'duplicate_lot_allocation' };
      }
      usedLotIds.add(lot.inventoryLotId);
      resolved.push({ ...request, ...lot });
    }
    resolvedByItem.set(itemId, resolved);
  }
  return { outcome: 'resolved', resolvedByItem };
}

async function lockBranchInventory(connection, branchId, variantIds) {
  if (!variantIds.length) return;
  const placeholders = variantIds.map(() => '?').join(', ');
  await connection.execute(
    `SELECT product_variant_id FROM branch_inventory
     WHERE branch_id = ? AND product_variant_id IN (${placeholders})
     ORDER BY product_variant_id FOR UPDATE`,
    [branchId, ...variantIds],
  );
}

async function lockBranchLots(connection, branchId, lotIds) {
  if (!lotIds.length) return;
  const placeholders = lotIds.map(() => '?').join(', ');
  await connection.execute(
    `SELECT inventory_lot_id FROM branch_lot_inventory
     WHERE branch_id = ? AND inventory_lot_id IN (${placeholders})
     ORDER BY inventory_lot_id FOR UPDATE`,
    [branchId, ...lotIds],
  );
}

async function recalculateOrderStatus(connection, purchaseOrderId) {
  const [rows] = await connection.execute(
    `SELECT poi.ordered_quantity AS orderedQuantity,
       COALESCE(SUM(CASE WHEN gr.status = 'POSTED' THEN gri.quantity_accepted ELSE 0 END), 0.000) AS receivedQuantity
     FROM purchase_order_items poi
     LEFT JOIN goods_receipt_items gri ON gri.purchase_order_item_id = poi.purchase_order_item_id
     LEFT JOIN goods_receipts gr ON gr.goods_receipt_id = gri.goods_receipt_id
     WHERE poi.purchase_order_id = ?
     GROUP BY poi.purchase_order_item_id
     ORDER BY poi.purchase_order_item_id`,
    [purchaseOrderId],
  );
  const any = rows.some((row) => compareDecimals(row.receivedQuantity, '0.000', 3) > 0);
  const all = rows.length > 0 && rows.every(
    (row) => compareDecimals(row.receivedQuantity, row.orderedQuantity, 3) === 0,
  );
  const status = all ? 'RECEIVED' : any ? 'PARTIALLY_RECEIVED' : 'APPROVED';
  await connection.execute(
    'UPDATE purchase_orders SET status = ? WHERE purchase_order_id = ?',
    [status, purchaseOrderId],
  );
  return status;
}

async function postPurchaseReceipt(branchId, goodsReceiptId, allocations, auditContext) {
  const preRead = await preReadPosting(branchId, goodsReceiptId);
  if (!preRead) return { outcome: 'not_found' };
  return withPurchasingTransaction(async (connection) => {
    const operational = await lockOperationalContext(
      connection, branchId, auditContext?.actorEmployeeId,
    );
    if (operational.outcome !== 'valid') return operational;
    const catalog = await lockCatalogRoots(connection, preRead);
    const policies = makeVariantPolicies(preRead, catalog);
    if (!policies) return { outcome: 'concurrent_change' };
    const documents = await lockDocuments(
      connection, branchId, goodsReceiptId, preRead,
    );
    if (documents.outcome !== 'valid') return documents;
    const limitError = validateReceiptLimits(documents);
    if (limitError) return { outcome: limitError };
    const allocationValidation = validateAllocationShape(
      documents, allocations, policies,
    );
    if (allocationValidation.outcome !== 'valid') return allocationValidation;
    const lotResult = await resolveLots(
      connection, documents, allocationValidation.allocationMap,
      policies, auditContext.actorEmployeeId,
    );
    if (lotResult.outcome !== 'resolved') return lotResult;

    const receiptBefore = await selectGoodsReceipt(
      connection, branchId, goodsReceiptId,
    );
    await connection.execute(
      `INSERT INTO inventory_transactions (
         branch_id, transaction_number, transaction_type,
         reversal_of_transaction_id, occurred_at, created_by_employee_id, notes
       ) VALUES (?, ?, 'PURCHASE_RECEIPT', NULL, ?, ?, ?)`,
      [
        branchId, generateDocumentNumber('IT'),
        receiptBefore.receivedAt.replace('T', ' ').replace('Z', ''),
        auditContext.actorEmployeeId,
        `Goods receipt ${receiptBefore.goodsReceiptNumber}`,
      ],
    );
    const inventoryTransactionId = await getLastInsertId(connection);
    const acceptedItems = documents.receiptItems.filter(
      (item) => compareDecimals(item.quantityAccepted, '0.000', 3) > 0,
    );
    const transactionItemByReceiptItem = new Map();
    let ledgerLine = 0;
    for (const item of acceptedItems.sort((left, right) => left.lineNumber - right.lineNumber)) {
      ledgerLine += 1;
      await connection.execute(
        `INSERT INTO inventory_transaction_items (
           inventory_transaction_id, line_number, product_variant_id,
           quantity_change, unit_cost
         ) VALUES (?, ?, ?, ?, ?)`,
        [
          inventoryTransactionId, ledgerLine, item.productVariantId,
          item.quantityAccepted, item.actualUnitCost,
        ],
      );
      transactionItemByReceiptItem.set(
        item.goodsReceiptItemId,
        await getLastInsertId(connection),
      );
    }

    const variantIds = uniqueSortedIds(acceptedItems.map((item) => item.productVariantId));
    await lockBranchInventory(connection, branchId, variantIds);
    for (const item of acceptedItems) {
      await connection.execute(
        `INSERT INTO branch_inventory (
           branch_id, product_variant_id, quantity_on_hand, version_number
         ) VALUES (?, ?, ?, 0)
         ON DUPLICATE KEY UPDATE
           quantity_on_hand = quantity_on_hand + VALUES(quantity_on_hand),
           version_number = version_number + 1`,
        [branchId, item.productVariantId, item.quantityAccepted],
      );
    }

    const allResolvedLots = [...lotResult.resolvedByItem.values()].flat();
    const lotIds = uniqueSortedIds(allResolvedLots.map((lot) => lot.inventoryLotId));
    await lockBranchLots(connection, branchId, lotIds);
    const itemById = new Map(documents.receiptItems.map((item) => [item.goodsReceiptItemId, item]));
    for (const [receiptItemId, lots] of lotResult.resolvedByItem) {
      const item = itemById.get(receiptItemId);
      for (const lot of lots) {
        await connection.execute(
          `INSERT INTO goods_receipt_item_lots (
             goods_receipt_item_id, inventory_lot_id, product_variant_id,
             quantity_received, unit_cost
           ) VALUES (?, ?, ?, ?, ?)`,
          [
            receiptItemId, lot.inventoryLotId, item.productVariantId,
            lot.quantityReceived, item.actualUnitCost,
          ],
        );
        await connection.execute(
          `INSERT INTO inventory_transaction_lot_allocations (
             inventory_transaction_item_id, inventory_lot_id,
             product_variant_id, quantity_change, unit_cost
           ) VALUES (?, ?, ?, ?, ?)`,
          [
            transactionItemByReceiptItem.get(receiptItemId),
            lot.inventoryLotId, item.productVariantId,
            lot.quantityReceived, item.actualUnitCost,
          ],
        );
        const desiredStatus = lot.status === 'QUARANTINED' ? 'QUARANTINED' : 'AVAILABLE';
        await connection.execute(
          `INSERT INTO branch_lot_inventory (
             branch_id, inventory_lot_id, quantity_on_hand, status, version_number
           ) VALUES (?, ?, ?, ?, 0)
           ON DUPLICATE KEY UPDATE
             quantity_on_hand = quantity_on_hand + VALUES(quantity_on_hand),
             status = CASE
               WHEN VALUES(status) = 'QUARANTINED' THEN 'QUARANTINED'
               WHEN status IN ('QUARANTINED', 'BLOCKED') THEN status
               WHEN status = 'DEPLETED' THEN VALUES(status)
               ELSE status
             END,
             version_number = version_number + 1`,
          [branchId, lot.inventoryLotId, lot.quantityReceived, desiredStatus],
        );
      }
    }

    const postedAt = await selectUtcNow(connection);
    await connection.execute(
      `UPDATE goods_receipts SET status = 'POSTED',
         inventory_transaction_id = ?, posted_at = ?
       WHERE goods_receipt_id = ?`,
      [inventoryTransactionId, postedAt, goodsReceiptId],
    );
    const purchaseOrderStatus = await recalculateOrderStatus(
      connection, preRead.purchaseOrderId,
    );
    const goodsReceipt = await selectGoodsReceipt(connection, branchId, goodsReceiptId);
    await insertAuditLog(connection, {
      auditContext, branchId,
      actionType: 'GOODS_RECEIPT_POSTED', entityType: 'goods_receipts',
      entityRecordId: goodsReceiptId,
      beforeValues: receiptSnapshot(receiptBefore),
      afterValues: {
        ...receiptSnapshot(goodsReceipt),
        purchaseOrderStatus,
        acceptedItemCount: acceptedItems.length,
      },
      notes: 'Goods receipt and PURCHASE_RECEIPT stock ledger posted atomically.',
    });
    return {
      outcome: 'posted', goodsReceipt, purchaseOrderStatus,
      inventoryTransactionId,
    };
  });
}

export { postPurchaseReceipt };
