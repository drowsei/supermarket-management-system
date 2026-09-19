import pool from '../config/database.js';
import { countAsSafeNumber, getLastInsertId } from './productCatalog.repository.js';
import { generateDocumentNumber, lockOperationalContext, selectUtcNow } from './purchasing.repository.js';
import {
  applyBranchMovements,
  applyLotMovements,
  abortOperation,
  assertLotConsistency,
  createLedger,
  insertAuditLog,
  lockBranchInventory,
  lockBranchLots,
  lockCatalogRoots,
  lockGlobalLots,
  preReadVariants,
  validateMovementPolicy,
  withInventoryTransaction,
} from './inventoryMovement.repository.js';

const HEADER_COLUMNS = `
  CAST(ia.inventory_adjustment_id AS CHAR) AS inventoryAdjustmentId,
  ia.adjustment_number AS adjustmentNumber,
  CAST(ia.branch_id AS CHAR) AS branchId,
  ia.adjustment_type AS adjustmentType, ia.status, ia.reason,
  CAST(ia.created_by_employee_id AS CHAR) AS createdByEmployeeId,
  CAST(ia.approved_by_employee_id AS CHAR) AS approvedByEmployeeId,
  CAST(ia.cancelled_by_employee_id AS CHAR) AS cancelledByEmployeeId,
  CAST(ia.inventory_transaction_id AS CHAR) AS inventoryTransactionId,
  DATE_FORMAT(ia.adjusted_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS adjustedAt,
  DATE_FORMAT(ia.approved_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS approvedAt,
  DATE_FORMAT(ia.posted_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS postedAt,
  DATE_FORMAT(ia.cancelled_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS cancelledAt,
  DATE_FORMAT(ia.created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS createdAt,
  DATE_FORMAT(ia.updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS updatedAt`;

function adjustmentWhere(branchId, filters) {
  const predicates = ['ia.branch_id = ?'];
  const params = [branchId];
  if (filters.search) {
    predicates.push('(LOCATE(?, ia.adjustment_number) > 0 OR LOCATE(?, ia.reason) > 0)');
    params.push(filters.search, filters.search);
  }
  for (const [field, column] of [
    ['status', 'ia.status'], ['adjustmentType', 'ia.adjustment_type'],
    ['createdByEmployeeId', 'ia.created_by_employee_id'],
    ['approvedByEmployeeId', 'ia.approved_by_employee_id'],
  ]) {
    if (filters[field]) { predicates.push(`${column} = ?`); params.push(filters[field]); }
  }
  if (filters.from) { predicates.push('ia.created_at >= ?'); params.push(`${filters.from} 00:00:00`); }
  if (filters.to) {
    predicates.push(filters.to === '9999-12-31'
      ? 'ia.created_at <= ?' : 'ia.created_at < DATE_ADD(?, INTERVAL 1 DAY)');
    params.push(filters.to === '9999-12-31'
      ? '9999-12-31 23:59:59.999999' : `${filters.to} 00:00:00`);
  }
  return { where: `WHERE ${predicates.join(' AND ')}`, params };
}

async function listAdjustments(branchId, filters) {
  const { where, params } = adjustmentWhere(branchId, filters);
  const [counts] = await pool.execute(
    `SELECT CAST(COUNT(*) AS CHAR) AS totalItems FROM inventory_adjustments ia ${where}`,
    params,
  );
  const [rows] = await pool.execute(
    `SELECT ${HEADER_COLUMNS},
       (SELECT COUNT(*) FROM inventory_adjustment_items iai
        WHERE iai.inventory_adjustment_id = ia.inventory_adjustment_id) AS itemCount
     FROM inventory_adjustments ia ${where}
     ORDER BY ia.created_at DESC, ia.inventory_adjustment_id DESC LIMIT ? OFFSET ?`,
    [...params, filters.limit, filters.offset],
  );
  return { items: rows, totalItems: countAsSafeNumber(counts[0].totalItems, 'adjustment') };
}

async function selectAdjustment(executor, branchId, adjustmentId) {
  const [headers] = await executor.execute(
    `SELECT ${HEADER_COLUMNS} FROM inventory_adjustments ia
     WHERE ia.branch_id = ? AND ia.inventory_adjustment_id = ? LIMIT 1`,
    [branchId, adjustmentId],
  );
  if (!headers[0]) return null;
  const [items] = await executor.execute(
    `SELECT CAST(iai.inventory_adjustment_item_id AS CHAR) AS inventoryAdjustmentItemId,
       CAST(iai.inventory_adjustment_id AS CHAR) AS inventoryAdjustmentId,
       iai.line_number AS lineNumber,
       CAST(iai.product_variant_id AS CHAR) AS productVariantId,
       iai.quantity_change AS quantityChange, iai.unit_cost AS unitCost,
       iai.reason, pv.sku, pv.variant_name AS variantName,
       pv.lot_tracking_mode AS lotTrackingMode, p.product_name AS productName,
       DATE_FORMAT(iai.created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS createdAt,
       DATE_FORMAT(iai.updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS updatedAt
     FROM inventory_adjustment_items iai
     INNER JOIN product_variants pv ON pv.product_variant_id = iai.product_variant_id
     INNER JOIN products p ON p.product_id = pv.product_id
     WHERE iai.inventory_adjustment_id = ?
     ORDER BY iai.line_number, iai.inventory_adjustment_item_id`,
    [adjustmentId],
  );
  const [lots] = await executor.execute(
    `SELECT CAST(iail.inventory_adjustment_item_lot_id AS CHAR) AS inventoryAdjustmentItemLotId,
       CAST(iail.inventory_adjustment_item_id AS CHAR) AS inventoryAdjustmentItemId,
       CAST(iail.inventory_lot_id AS CHAR) AS inventoryLotId,
       CAST(iail.product_variant_id AS CHAR) AS productVariantId,
       iail.quantity_change AS quantityChange, iail.unit_cost AS unitCost,
       il.lot_number AS lotNumber, DATE_FORMAT(il.expires_on, '%Y-%m-%d') AS expiresOn,
       il.status AS lotStatus
     FROM inventory_adjustment_item_lots iail
     INNER JOIN inventory_adjustment_items iai
       ON iai.inventory_adjustment_item_id = iail.inventory_adjustment_item_id
     INNER JOIN inventory_lots il ON il.inventory_lot_id = iail.inventory_lot_id
     WHERE iai.inventory_adjustment_id = ?
     ORDER BY iai.line_number, iail.inventory_adjustment_item_lot_id`,
    [adjustmentId],
  );
  const grouped = new Map(items.map((item) => [item.inventoryAdjustmentItemId, []]));
  lots.forEach((lot) => grouped.get(lot.inventoryAdjustmentItemId)?.push(lot));
  return {
    inventoryAdjustment: headers[0],
    items: items.map((item) => ({ ...item, lotAllocations: grouped.get(item.inventoryAdjustmentItemId) })),
  };
}

function adjustmentSnapshot(detail) {
  if (!detail) return null;
  return {
    inventoryAdjustmentId: detail.inventoryAdjustment.inventoryAdjustmentId,
    branchId: detail.inventoryAdjustment.branchId,
    adjustmentType: detail.inventoryAdjustment.adjustmentType,
    status: detail.inventoryAdjustment.status,
    reason: detail.inventoryAdjustment.reason,
    inventoryTransactionId: detail.inventoryAdjustment.inventoryTransactionId,
    items: detail.items.map((item) => ({
      inventoryAdjustmentItemId: item.inventoryAdjustmentItemId,
      productVariantId: item.productVariantId,
      quantityChange: item.quantityChange,
      unitCost: item.unitCost,
      reason: item.reason,
      lotAllocations: item.lotAllocations.map((lot) => ({
        inventoryLotId: lot.inventoryLotId,
        quantityChange: lot.quantityChange,
        unitCost: lot.unitCost,
      })),
    })),
  };
}

async function createAdjustment(branchId, values, auditContext) {
  return withInventoryTransaction(async (connection) => {
    const actor = await lockOperationalContext(connection, branchId, auditContext.actorEmployeeId);
    if (actor.outcome !== 'valid') return actor;
    await connection.execute(
      `INSERT INTO inventory_adjustments (
         adjustment_number, branch_id, adjustment_type, status,
         reason, created_by_employee_id
       ) VALUES (?, ?, ?, 'DRAFT', ?, ?)`,
      [generateDocumentNumber('ADJ'), branchId, values.adjustmentType,
        values.reason, auditContext.actorEmployeeId],
    );
    const id = await getLastInsertId(connection);
    const detail = await selectAdjustment(connection, branchId, id);
    await insertAuditLog(connection, {
      auditContext, branchId, actionType: 'INVENTORY_ADJUSTMENT_CREATED',
      entityType: 'inventory_adjustments', entityRecordId: id,
      beforeValues: null, afterValues: adjustmentSnapshot(detail),
    });
    return { outcome: 'created', detail };
  });
}

async function updateAdjustment(branchId, adjustmentId, changes, auditContext) {
  return withInventoryTransaction(async (connection) => {
    const actor = await lockOperationalContext(connection, branchId, auditContext.actorEmployeeId);
    if (actor.outcome !== 'valid') return actor;
    const [rows] = await connection.execute(
      `SELECT adjustment_type AS adjustmentType, reason, status
       FROM inventory_adjustments WHERE branch_id = ? AND inventory_adjustment_id = ?
       FOR UPDATE`, [branchId, adjustmentId],
    );
    if (!rows[0]) return { outcome: 'not_found' };
    if (rows[0].status !== 'DRAFT') return { outcome: 'not_draft' };
    const next = { ...rows[0], ...changes };
    if (next.adjustmentType === rows[0].adjustmentType && next.reason === rows[0].reason) {
      return { outcome: 'unchanged', detail: await selectAdjustment(connection, branchId, adjustmentId) };
    }
    const before = await selectAdjustment(connection, branchId, adjustmentId);
    await connection.execute(
      `UPDATE inventory_adjustments SET adjustment_type = ?, reason = ?
       WHERE inventory_adjustment_id = ?`,
      [next.adjustmentType, next.reason, adjustmentId],
    );
    const detail = await selectAdjustment(connection, branchId, adjustmentId);
    await insertAuditLog(connection, {
      auditContext, branchId, actionType: 'INVENTORY_ADJUSTMENT_UPDATED',
      entityType: 'inventory_adjustments', entityRecordId: adjustmentId,
      beforeValues: adjustmentSnapshot(before), afterValues: adjustmentSnapshot(detail),
    });
    return { outcome: 'updated', detail };
  });
}

async function lockDraftAdjustment(connection, branchId, adjustmentId) {
  const [rows] = await connection.execute(
    `SELECT status FROM inventory_adjustments
     WHERE branch_id = ? AND inventory_adjustment_id = ? FOR UPDATE`,
    [branchId, adjustmentId],
  );
  if (!rows[0]) return 'not_found';
  return rows[0].status === 'DRAFT' ? null : 'not_draft';
}

async function replaceItemLots(
  connection, itemId, variantId, allocations, itemQuantity, policies,
) {
  const lotIds = allocations.map((lot) => lot.inventoryLotId);
  const lots = await lockGlobalLots(connection, lotIds);
  if (lots.length !== new Set(lotIds).size) return 'lot_not_found';
  const lotMap = new Map(lots.map((lot) => [lot.inventoryLotId, lot]));
  if (lots.some((lot) => lot.productVariantId !== variantId)) return 'lot_variant_mismatch';
  const movement = { productVariantId: variantId, quantityChange: itemQuantity, lots: allocations };
  const error = validateMovementPolicy(movement, policies.get(variantId));
  if (error) return error;
  for (const lot of allocations) {
    const identity = lotMap.get(lot.inventoryLotId);
    if (lot.quantityChange[0] !== '-' && ['RECALLED', 'CLOSED'].includes(identity.status)) {
      return 'unsafe_lot';
    }
  }
  await connection.execute(
    'DELETE FROM inventory_adjustment_item_lots WHERE inventory_adjustment_item_id = ?',
    [itemId],
  );
  for (const lot of allocations) {
    await connection.execute(
      `INSERT INTO inventory_adjustment_item_lots (
         inventory_adjustment_item_id, inventory_lot_id, product_variant_id,
         quantity_change, unit_cost
       ) VALUES (?, ?, ?, ?, ?)`,
      [itemId, lot.inventoryLotId, variantId, lot.quantityChange, lot.unitCost],
    );
  }
  return null;
}

async function createAdjustmentItem(branchId, adjustmentId, values, auditContext) {
  const refs = await preReadVariants(pool, [values.productVariantId]);
  if (!refs.length) return { outcome: 'variant_not_found' };
  return withInventoryTransaction(async (connection) => {
    const actor = await lockOperationalContext(connection, branchId, auditContext.actorEmployeeId);
    if (actor.outcome !== 'valid') return actor;
    const policies = await lockCatalogRoots(connection, refs);
    if (!policies) return { outcome: 'concurrent_change' };
    const policy = policies.get(values.productVariantId);
    if (policy.status !== 'ACTIVE') return { outcome: 'variant_inactive' };
    const documentError = await lockDraftAdjustment(connection, branchId, adjustmentId);
    if (documentError) return { outcome: documentError };
    const movementError = validateMovementPolicy({
      productVariantId: values.productVariantId,
      quantityChange: values.quantityChange, lots: values.lotAllocations,
    }, policy);
    if (movementError) return { outcome: movementError };
    const [lineRows] = await connection.execute(
      `SELECT COALESCE(MAX(line_number), 0) + 1 AS lineNumber
       FROM inventory_adjustment_items WHERE inventory_adjustment_id = ?`,
      [adjustmentId],
    );
    await connection.execute(
      `INSERT INTO inventory_adjustment_items (
         inventory_adjustment_id, line_number, product_variant_id,
         quantity_change, unit_cost, reason
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      [adjustmentId, lineRows[0].lineNumber, values.productVariantId,
        values.quantityChange, values.unitCost, values.reason],
    );
    const itemId = await getLastInsertId(connection);
    const lotError = await replaceItemLots(
      connection, itemId, values.productVariantId, values.lotAllocations,
      values.quantityChange, policies,
    );
    if (lotError) abortOperation(lotError);
    const detail = await selectAdjustment(connection, branchId, adjustmentId);
    const item = detail.items.find((entry) => entry.inventoryAdjustmentItemId === itemId);
    await insertAuditLog(connection, {
      auditContext, branchId, actionType: 'INVENTORY_ADJUSTMENT_ITEM_CREATED',
      entityType: 'inventory_adjustment_items', entityRecordId: itemId,
      beforeValues: null, afterValues: item,
    });
    return { outcome: 'created', item };
  });
}

async function preReadAdjustmentItem(branchId, adjustmentId, itemId) {
  const [rows] = await pool.execute(
    `SELECT CAST(iai.product_variant_id AS CHAR) AS productVariantId,
       CAST(pv.product_id AS CHAR) AS productId
     FROM inventory_adjustment_items iai
     INNER JOIN inventory_adjustments ia ON ia.inventory_adjustment_id = iai.inventory_adjustment_id
     INNER JOIN product_variants pv ON pv.product_variant_id = iai.product_variant_id
     WHERE ia.branch_id = ? AND ia.inventory_adjustment_id = ?
       AND iai.inventory_adjustment_item_id = ?`,
    [branchId, adjustmentId, itemId],
  );
  return rows[0] ?? null;
}

async function updateAdjustmentItem(branchId, adjustmentId, itemId, changes, auditContext) {
  const ref = await preReadAdjustmentItem(branchId, adjustmentId, itemId);
  if (!ref) return { outcome: 'item_not_found' };
  return withInventoryTransaction(async (connection) => {
    const actor = await lockOperationalContext(connection, branchId, auditContext.actorEmployeeId);
    if (actor.outcome !== 'valid') return actor;
    const policies = await lockCatalogRoots(connection, [ref]);
    if (!policies) return { outcome: 'concurrent_change' };
    const documentError = await lockDraftAdjustment(connection, branchId, adjustmentId);
    if (documentError) return { outcome: documentError };
    const [rows] = await connection.execute(
      `SELECT quantity_change AS quantityChange, unit_cost AS unitCost, reason
       FROM inventory_adjustment_items
       WHERE inventory_adjustment_id = ? AND inventory_adjustment_item_id = ? FOR UPDATE`,
      [adjustmentId, itemId],
    );
    if (!rows[0]) return { outcome: 'item_not_found' };
    const beforeDetail = await selectAdjustment(connection, branchId, adjustmentId);
    const before = beforeDetail.items.find((entry) => entry.inventoryAdjustmentItemId === itemId);
    const next = { ...rows[0], ...changes };
    const currentLots = changes.lotAllocations ?? before.lotAllocations.map((lot) => ({
      inventoryLotId: lot.inventoryLotId,
      quantityChange: lot.quantityChange,
      unitCost: lot.unitCost,
    }));
    const movementError = validateMovementPolicy({
      productVariantId: ref.productVariantId,
      quantityChange: next.quantityChange, lots: currentLots,
    }, policies.get(ref.productVariantId));
    if (movementError) return { outcome: movementError };
    const comparable = JSON.stringify({
      quantityChange: next.quantityChange, unitCost: next.unitCost,
      reason: next.reason, lots: currentLots,
    });
    const original = JSON.stringify({
      quantityChange: before.quantityChange, unitCost: before.unitCost,
      reason: before.reason,
      lots: before.lotAllocations.map((lot) => ({
        inventoryLotId: lot.inventoryLotId,
        quantityChange: lot.quantityChange, unitCost: lot.unitCost,
      })),
    });
    if (comparable === original) return { outcome: 'unchanged', item: before };
    await connection.execute(
      `UPDATE inventory_adjustment_items
       SET quantity_change = ?, unit_cost = ?, reason = ?
       WHERE inventory_adjustment_item_id = ?`,
      [next.quantityChange, next.unitCost, next.reason, itemId],
    );
    if (changes.lotAllocations !== undefined) {
      const lotError = await replaceItemLots(
        connection, itemId, ref.productVariantId, currentLots, next.quantityChange, policies,
      );
      if (lotError) abortOperation(lotError);
    }
    const detail = await selectAdjustment(connection, branchId, adjustmentId);
    const item = detail.items.find((entry) => entry.inventoryAdjustmentItemId === itemId);
    await insertAuditLog(connection, {
      auditContext, branchId, actionType: 'INVENTORY_ADJUSTMENT_ITEM_UPDATED',
      entityType: 'inventory_adjustment_items', entityRecordId: itemId,
      beforeValues: before, afterValues: item,
    });
    return { outcome: 'updated', item };
  });
}

async function deleteAdjustmentItem(branchId, adjustmentId, itemId, auditContext) {
  return withInventoryTransaction(async (connection) => {
    const actor = await lockOperationalContext(connection, branchId, auditContext.actorEmployeeId);
    if (actor.outcome !== 'valid') return actor;
    const error = await lockDraftAdjustment(connection, branchId, adjustmentId);
    if (error) return { outcome: error };
    const detail = await selectAdjustment(connection, branchId, adjustmentId);
    const item = detail.items.find((entry) => entry.inventoryAdjustmentItemId === itemId);
    if (!item) return { outcome: 'item_not_found' };
    await connection.execute(
      'DELETE FROM inventory_adjustment_item_lots WHERE inventory_adjustment_item_id = ?', [itemId],
    );
    await connection.execute(
      'DELETE FROM inventory_adjustment_items WHERE inventory_adjustment_item_id = ?', [itemId],
    );
    await insertAuditLog(connection, {
      auditContext, branchId, actionType: 'INVENTORY_ADJUSTMENT_ITEM_DELETED',
      entityType: 'inventory_adjustment_items', entityRecordId: itemId,
      beforeValues: item, afterValues: null,
    });
    return { outcome: 'deleted', item };
  });
}

async function preReadAdjustment(branchId, adjustmentId) {
  const [rows] = await pool.execute(
    `SELECT CAST(iai.product_variant_id AS CHAR) AS productVariantId,
       CAST(pv.product_id AS CHAR) AS productId,
       CAST(iail.inventory_lot_id AS CHAR) AS inventoryLotId
     FROM inventory_adjustments ia
     LEFT JOIN inventory_adjustment_items iai
       ON iai.inventory_adjustment_id = ia.inventory_adjustment_id
     LEFT JOIN product_variants pv ON pv.product_variant_id = iai.product_variant_id
     LEFT JOIN inventory_adjustment_item_lots iail
       ON iail.inventory_adjustment_item_id = iai.inventory_adjustment_item_id
     WHERE ia.branch_id = ? AND ia.inventory_adjustment_id = ?
     ORDER BY iai.product_variant_id, iail.inventory_lot_id`,
    [branchId, adjustmentId],
  );
  if (!rows.length) return null;
  return {
    references: [...new Map(rows.filter((row) => row.productVariantId)
      .map((row) => [row.productVariantId, {
        productVariantId: row.productVariantId, productId: row.productId,
      }])).values()],
    lotIds: [...new Set(rows.map((row) => row.inventoryLotId).filter(Boolean))],
  };
}

async function lockAdjustmentDocument(connection, branchId, adjustmentId) {
  const [headers] = await connection.execute(
    `SELECT status, CAST(created_by_employee_id AS CHAR) AS createdByEmployeeId,
       adjustment_number AS adjustmentNumber
     FROM inventory_adjustments WHERE branch_id = ? AND inventory_adjustment_id = ? FOR UPDATE`,
    [branchId, adjustmentId],
  );
  if (!headers[0]) return null;
  const [items] = await connection.execute(
    `SELECT CAST(inventory_adjustment_item_id AS CHAR) AS inventoryAdjustmentItemId,
       line_number AS lineNumber, CAST(product_variant_id AS CHAR) AS productVariantId,
       quantity_change AS quantityChange, unit_cost AS unitCost
     FROM inventory_adjustment_items WHERE inventory_adjustment_id = ?
     ORDER BY inventory_adjustment_item_id FOR UPDATE`,
    [adjustmentId],
  );
  const [lots] = await connection.execute(
    `SELECT CAST(iail.inventory_adjustment_item_id AS CHAR) AS inventoryAdjustmentItemId,
       CAST(iail.inventory_lot_id AS CHAR) AS inventoryLotId,
       CAST(iail.product_variant_id AS CHAR) AS productVariantId,
       iail.quantity_change AS quantityChange, iail.unit_cost AS unitCost
     FROM inventory_adjustment_item_lots iail
     INNER JOIN inventory_adjustment_items iai
       ON iai.inventory_adjustment_item_id = iail.inventory_adjustment_item_id
     WHERE iai.inventory_adjustment_id = ?
     ORDER BY iail.inventory_adjustment_item_lot_id FOR UPDATE`,
    [adjustmentId],
  );
  const grouped = new Map(items.map((item) => [item.inventoryAdjustmentItemId, []]));
  lots.forEach((lot) => grouped.get(lot.inventoryAdjustmentItemId)?.push(lot));
  return {
    ...headers[0],
    items: items.map((item) => ({ ...item, lots: grouped.get(item.inventoryAdjustmentItemId) })),
  };
}

async function approveAdjustment(branchId, adjustmentId, auditContext) {
  const preRead = await preReadAdjustment(branchId, adjustmentId);
  if (!preRead) return { outcome: 'not_found' };
  return withInventoryTransaction(async (connection) => {
    const actor = await lockOperationalContext(connection, branchId, auditContext.actorEmployeeId);
    if (actor.outcome !== 'valid') return actor;
    const policies = await lockCatalogRoots(connection, preRead.references);
    if (!policies && preRead.references.length) return { outcome: 'concurrent_change' };
    const document = await lockAdjustmentDocument(connection, branchId, adjustmentId);
    if (!document) return { outcome: 'not_found' };
    if (document.status !== 'DRAFT') return { outcome: 'not_draft' };
    if (!document.items.length) return { outcome: 'empty_document' };
    if (document.createdByEmployeeId === auditContext.actorEmployeeId) {
      return { outcome: 'self_approval' };
    }
    const lots = await lockGlobalLots(connection, preRead.lotIds);
    if (lots.length !== preRead.lotIds.length) return { outcome: 'lot_not_found' };
    for (const item of document.items) {
      if (policies.get(item.productVariantId)?.status !== 'ACTIVE') {
        return { outcome: 'variant_inactive' };
      }
      const error = validateMovementPolicy(item, policies.get(item.productVariantId));
      if (error) return { outcome: error };
      if (item.lots.some((lot) =>
        lots.find((entry) => entry.inventoryLotId === lot.inventoryLotId)?.productVariantId
          !== item.productVariantId)) return { outcome: 'lot_variant_mismatch' };
    }
    const before = await selectAdjustment(connection, branchId, adjustmentId);
    const now = await selectUtcNow(connection);
    await connection.execute(
      `UPDATE inventory_adjustments SET status = 'APPROVED', adjusted_at = ?,
         approved_at = ?, approved_by_employee_id = ?
       WHERE inventory_adjustment_id = ?`,
      [now, now, auditContext.actorEmployeeId, adjustmentId],
    );
    const detail = await selectAdjustment(connection, branchId, adjustmentId);
    await insertAuditLog(connection, {
      auditContext, branchId, actionType: 'INVENTORY_ADJUSTMENT_APPROVED',
      entityType: 'inventory_adjustments', entityRecordId: adjustmentId,
      beforeValues: adjustmentSnapshot(before), afterValues: adjustmentSnapshot(detail),
    });
    return { outcome: 'approved', detail };
  });
}

async function postAdjustment(branchId, adjustmentId, auditContext) {
  const preRead = await preReadAdjustment(branchId, adjustmentId);
  if (!preRead) return { outcome: 'not_found' };
  return withInventoryTransaction(async (connection) => {
    const actor = await lockOperationalContext(connection, branchId, auditContext.actorEmployeeId);
    if (actor.outcome !== 'valid') return actor;
    const policies = await lockCatalogRoots(connection, preRead.references);
    if (!policies && preRead.references.length) return { outcome: 'concurrent_change' };
    const document = await lockAdjustmentDocument(connection, branchId, adjustmentId);
    if (!document) return { outcome: 'not_found' };
    if (document.status !== 'APPROVED') {
      return { outcome: document.status === 'POSTED' ? 'already_posted' : 'not_approved' };
    }
    if (!document.items.length) return { outcome: 'empty_document' };
    const globalLots = await lockGlobalLots(connection, preRead.lotIds);
    if (globalLots.length !== preRead.lotIds.length) return { outcome: 'lot_not_found' };
    const lotMap = new Map(globalLots.map((lot) => [lot.inventoryLotId, lot]));
    for (const item of document.items) {
      if (policies.get(item.productVariantId)?.status !== 'ACTIVE') {
        return { outcome: 'variant_inactive' };
      }
      const error = validateMovementPolicy(item, policies.get(item.productVariantId));
      if (error) return { outcome: error };
      for (const lot of item.lots) {
        if (lotMap.get(lot.inventoryLotId)?.productVariantId !== item.productVariantId) {
          return { outcome: 'lot_variant_mismatch' };
        }
      }
    }
    const variantIds = document.items.map((item) => item.productVariantId);
    const branchRows = await lockBranchInventory(connection, [branchId], variantIds);
    const branchLotRows = await lockBranchLots(connection, [branchId], preRead.lotIds);
    const before = await selectAdjustment(connection, branchId, adjustmentId);
    const branchResult = await applyBranchMovements(connection, branchId, document.items, branchRows);
    if (branchResult.outcome !== 'applied') abortOperation(branchResult.outcome);
    const lotMovements = document.items.flatMap((item) => item.lots);
    const lotResult = await applyLotMovements(
      connection, branchId, lotMovements, branchLotRows, globalLots,
    );
    if (lotResult.outcome !== 'applied') abortOperation(lotResult.outcome);
    const consistency = await assertLotConsistency(connection, branchId, policies, variantIds);
    if (consistency.outcome !== 'valid') abortOperation(consistency.outcome);
    const transactionId = await createLedger(connection, {
      branchId, transactionType: 'ADJUSTMENT', actorEmployeeId: auditContext.actorEmployeeId,
      notes: `Inventory adjustment ${document.adjustmentNumber}`, movements: document.items,
    });
    const now = await selectUtcNow(connection);
    await connection.execute(
      `UPDATE inventory_adjustments SET status = 'POSTED', posted_at = ?,
         inventory_transaction_id = ? WHERE inventory_adjustment_id = ?`,
      [now, transactionId, adjustmentId],
    );
    const detail = await selectAdjustment(connection, branchId, adjustmentId);
    await insertAuditLog(connection, {
      auditContext, branchId, actionType: 'INVENTORY_ADJUSTMENT_POSTED',
      entityType: 'inventory_adjustments', entityRecordId: adjustmentId,
      beforeValues: adjustmentSnapshot(before), afterValues: adjustmentSnapshot(detail),
      notes: 'Adjustment and ADJUSTMENT inventory ledger posted atomically.',
    });
    return { outcome: 'posted', detail, inventoryTransactionId: transactionId };
  });
}

async function cancelAdjustment(branchId, adjustmentId, auditContext) {
  return withInventoryTransaction(async (connection) => {
    const actor = await lockOperationalContext(connection, branchId, auditContext.actorEmployeeId);
    if (actor.outcome !== 'valid') return actor;
    const [rows] = await connection.execute(
      `SELECT status FROM inventory_adjustments
       WHERE branch_id = ? AND inventory_adjustment_id = ? FOR UPDATE`,
      [branchId, adjustmentId],
    );
    if (!rows[0]) return { outcome: 'not_found' };
    if (!['DRAFT', 'APPROVED'].includes(rows[0].status)) return { outcome: 'not_cancellable' };
    const before = await selectAdjustment(connection, branchId, adjustmentId);
    const now = await selectUtcNow(connection);
    await connection.execute(
      `UPDATE inventory_adjustments SET status = 'CANCELLED', cancelled_at = ?,
         cancelled_by_employee_id = ? WHERE inventory_adjustment_id = ?`,
      [now, auditContext.actorEmployeeId, adjustmentId],
    );
    const detail = await selectAdjustment(connection, branchId, adjustmentId);
    await insertAuditLog(connection, {
      auditContext, branchId, actionType: 'INVENTORY_ADJUSTMENT_CANCELLED',
      entityType: 'inventory_adjustments', entityRecordId: adjustmentId,
      beforeValues: adjustmentSnapshot(before), afterValues: adjustmentSnapshot(detail),
    });
    return { outcome: 'cancelled', detail };
  });
}

async function findAdjustment(branchId, adjustmentId) {
  return selectAdjustment(pool, branchId, adjustmentId);
}

async function findAdjustmentLedger(branchId, adjustmentId) {
  const detail = await selectAdjustment(pool, branchId, adjustmentId);
  if (!detail) return null;
  if (!detail.inventoryAdjustment.inventoryTransactionId) {
    return { inventoryAdjustment: detail.inventoryAdjustment, inventoryTransaction: null };
  }
  const [rows] = await pool.execute(
    `SELECT CAST(inventory_transaction_id AS CHAR) AS inventoryTransactionId,
       transaction_number AS transactionNumber, transaction_type AS transactionType,
       DATE_FORMAT(occurred_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS occurredAt
     FROM inventory_transactions WHERE branch_id = ? AND inventory_transaction_id = ?`,
    [branchId, detail.inventoryAdjustment.inventoryTransactionId],
  );
  return { inventoryAdjustment: detail.inventoryAdjustment, inventoryTransaction: rows[0] ?? null };
}

export {
  approveAdjustment,
  cancelAdjustment,
  createAdjustment,
  createAdjustmentItem,
  deleteAdjustmentItem,
  findAdjustment,
  findAdjustmentLedger,
  listAdjustments,
  postAdjustment,
  updateAdjustment,
  updateAdjustmentItem,
};
