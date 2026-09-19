import pool from '../config/database.js';
import { countAsSafeNumber, getLastInsertId } from './productCatalog.repository.js';
import { generateDocumentNumber, lockOperationalContext, selectUtcNow } from './purchasing.repository.js';
import {
  abortOperation, applyBranchMovements, applyLotMovements, assertLotConsistency,
  createLedger, insertAuditLog, lockBranchInventory, lockBranchLots,
  lockCatalogRoots, lockGlobalLots, preReadVariants, validateMovementPolicy,
  withInventoryTransaction,
} from './inventoryMovement.repository.js';
import { addQuantities, compareQuantities, negateQuantity } from '../utils/inventoryQuantity.js';

const HEADER = `CAST(sc.stock_count_id AS CHAR) AS stockCountId,
  sc.count_number AS countNumber, CAST(sc.branch_id AS CHAR) AS branchId,
  sc.count_type AS countType, sc.status,
  CAST(sc.created_by_employee_id AS CHAR) AS createdByEmployeeId,
  CAST(sc.approved_by_employee_id AS CHAR) AS approvedByEmployeeId,
  CAST(sc.posted_by_employee_id AS CHAR) AS postedByEmployeeId,
  CAST(sc.cancelled_by_employee_id AS CHAR) AS cancelledByEmployeeId,
  CAST(sc.inventory_adjustment_id AS CHAR) AS inventoryAdjustmentId,
  DATE_FORMAT(sc.started_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS startedAt,
  DATE_FORMAT(sc.completed_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS completedAt,
  DATE_FORMAT(sc.approved_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS approvedAt,
  DATE_FORMAT(sc.posted_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS postedAt,
  DATE_FORMAT(sc.cancelled_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS cancelledAt,
  sc.notes, DATE_FORMAT(sc.created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS createdAt,
  DATE_FORMAT(sc.updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS updatedAt`;

async function selectCount(executor, branchId, countId) {
  const [headers] = await executor.execute(
    `SELECT ${HEADER} FROM stock_counts sc WHERE sc.branch_id = ? AND sc.stock_count_id = ?`,
    [branchId, countId],
  );
  if (!headers[0]) return null;
  const [participants] = await executor.execute(
    `SELECT CAST(scp.employee_id AS CHAR) AS employeeId, scp.participant_role AS participantRole,
       e.employee_number AS employeeNumber, e.first_name AS firstName, e.last_name AS lastName,
       DATE_FORMAT(scp.assigned_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS assignedAt
     FROM stock_count_participants scp INNER JOIN employees e ON e.employee_id = scp.employee_id
     WHERE scp.stock_count_id = ? ORDER BY scp.employee_id`, [countId],
  );
  const [items] = await executor.execute(
    `SELECT CAST(sci.stock_count_item_id AS CHAR) AS stockCountItemId,
       CAST(sci.product_variant_id AS CHAR) AS productVariantId,
       CAST(sci.inventory_lot_id AS CHAR) AS inventoryLotId, sci.line_number AS lineNumber,
       sci.system_quantity AS systemQuantity, sci.counted_quantity AS countedQuantity,
       sci.variance_quantity AS varianceQuantity,
       CAST(sci.counted_by_employee_id AS CHAR) AS countedByEmployeeId,
       DATE_FORMAT(sci.counted_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS countedAt,
       sci.variance_reason AS varianceReason, sci.notes, pv.sku,
       pv.variant_name AS variantName, pv.lot_tracking_mode AS lotTrackingMode,
       p.product_name AS productName, il.lot_number AS lotNumber
     FROM stock_count_items sci
     INNER JOIN product_variants pv ON pv.product_variant_id = sci.product_variant_id
     INNER JOIN products p ON p.product_id = pv.product_id
     LEFT JOIN inventory_lots il ON il.inventory_lot_id = sci.inventory_lot_id
     WHERE sci.stock_count_id = ? ORDER BY sci.line_number, sci.stock_count_item_id`, [countId],
  );
  let reconciliation = null;
  if (headers[0].inventoryAdjustmentId) {
    const [rows] = await executor.execute(
      `SELECT ia.adjustment_number AS adjustmentNumber, ia.status,
         CAST(ia.inventory_transaction_id AS CHAR) AS inventoryTransactionId,
         it.transaction_number AS transactionNumber
       FROM inventory_adjustments ia LEFT JOIN inventory_transactions it
         ON it.inventory_transaction_id = ia.inventory_transaction_id
       WHERE ia.inventory_adjustment_id = ?`, [headers[0].inventoryAdjustmentId],
    );
    reconciliation = rows[0] ?? null;
  }
  return { stockCount: headers[0], participants, items, reconciliation };
}

function snapshot(detail) {
  if (!detail) return null;
  return { ...detail.stockCount,
    participants: detail.participants.map(({ employeeId, participantRole }) => ({ employeeId, participantRole })),
    items: detail.items.map((item) => ({ stockCountItemId: item.stockCountItemId,
      productVariantId: item.productVariantId, inventoryLotId: item.inventoryLotId,
      systemQuantity: item.systemQuantity, countedQuantity: item.countedQuantity,
      varianceQuantity: item.varianceQuantity, varianceReason: item.varianceReason })) };
}

function listWhere(branchId, filters) {
  const predicates = ['sc.branch_id = ?']; const params = [branchId];
  if (filters.search) { predicates.push('(LOCATE(?, sc.count_number) > 0 OR LOCATE(?, COALESCE(sc.notes, \'\')) > 0)'); params.push(filters.search, filters.search); }
  for (const [field, column] of [['status', 'sc.status'], ['countType', 'sc.count_type'], ['createdByEmployeeId', 'sc.created_by_employee_id'], ['approvedByEmployeeId', 'sc.approved_by_employee_id']]) {
    if (filters[field]) { predicates.push(`${column} = ?`); params.push(filters[field]); }
  }
  if (filters.from) { predicates.push('sc.created_at >= ?'); params.push(`${filters.from} 00:00:00`); }
  if (filters.to) { predicates.push(filters.to === '9999-12-31' ? 'sc.created_at <= ?' : 'sc.created_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(filters.to === '9999-12-31' ? '9999-12-31 23:59:59.999999' : `${filters.to} 00:00:00`); }
  return { sql: `WHERE ${predicates.join(' AND ')}`, params };
}

async function listCounts(branchId, filters) {
  const where = listWhere(branchId, filters);
  const [count] = await pool.execute(`SELECT CAST(COUNT(*) AS CHAR) AS totalItems FROM stock_counts sc ${where.sql}`, where.params);
  const [items] = await pool.execute(
    `SELECT ${HEADER}, (SELECT COUNT(*) FROM stock_count_items sci WHERE sci.stock_count_id = sc.stock_count_id) AS itemCount
     FROM stock_counts sc ${where.sql} ORDER BY sc.created_at DESC, sc.stock_count_id DESC LIMIT ? OFFSET ?`,
    [...where.params, filters.limit, filters.offset],
  );
  return { items, totalItems: countAsSafeNumber(count[0].totalItems, 'stock count') };
}

async function createCount(branchId, values, auditContext) {
  return withInventoryTransaction(async (connection) => {
    const actor = await lockOperationalContext(connection, branchId, auditContext.actorEmployeeId);
    if (actor.outcome !== 'valid') return actor;
    await connection.execute(
      `INSERT INTO stock_counts (count_number, branch_id, count_type, status, created_by_employee_id, notes)
       VALUES (?, ?, ?, 'DRAFT', ?, ?)`,
      [generateDocumentNumber('CNT'), branchId, values.countType, auditContext.actorEmployeeId, values.notes],
    );
    const id = await getLastInsertId(connection); const detail = await selectCount(connection, branchId, id);
    await insertAuditLog(connection, { auditContext, branchId, actionType: 'STOCK_COUNT_CREATED', entityType: 'stock_counts', entityRecordId: id, beforeValues: null, afterValues: snapshot(detail) });
    return { outcome: 'created', detail };
  });
}

async function lockCountHeader(connection, branchId, countId) {
  const [rows] = await connection.execute(
    `SELECT status, CAST(created_by_employee_id AS CHAR) AS createdByEmployeeId, count_number AS countNumber
     FROM stock_counts WHERE branch_id = ? AND stock_count_id = ? FOR UPDATE`, [branchId, countId],
  );
  return rows[0] ?? null;
}

async function updateCount(branchId, countId, changes, auditContext) {
  return withInventoryTransaction(async (connection) => {
    const actor = await lockOperationalContext(connection, branchId, auditContext.actorEmployeeId); if (actor.outcome !== 'valid') return actor;
    const header = await lockCountHeader(connection, branchId, countId); if (!header) return { outcome: 'not_found' }; if (header.status !== 'DRAFT') return { outcome: 'not_draft' };
    const before = await selectCount(connection, branchId, countId); const next = { countType: before.stockCount.countType, notes: before.stockCount.notes, ...changes };
    if (next.countType === before.stockCount.countType && next.notes === before.stockCount.notes) return { outcome: 'unchanged', detail: before };
    await connection.execute('UPDATE stock_counts SET count_type = ?, notes = ? WHERE stock_count_id = ?', [next.countType, next.notes, countId]);
    const detail = await selectCount(connection, branchId, countId);
    await insertAuditLog(connection, { auditContext, branchId, actionType: 'STOCK_COUNT_UPDATED', entityType: 'stock_counts', entityRecordId: countId, beforeValues: snapshot(before), afterValues: snapshot(detail) });
    return { outcome: 'updated', detail };
  });
}

async function addParticipant(branchId, countId, values, auditContext) {
  return withInventoryTransaction(async (connection) => {
    const actor = await lockOperationalContext(connection, branchId, auditContext.actorEmployeeId); if (actor.outcome !== 'valid') return actor;
    const header = await lockCountHeader(connection, branchId, countId); if (!header) return { outcome: 'not_found' }; if (header.status !== 'DRAFT') return { outcome: 'not_draft' };
    const [employees] = await connection.execute(`SELECT employment_status AS status FROM employees WHERE employee_id = ?`, [values.employeeId]);
    if (!employees[0]) return { outcome: 'participant_not_found' }; if (employees[0].status !== 'ACTIVE') return { outcome: 'participant_inactive' };
    const [assigned] = await connection.execute(`SELECT assignment_id FROM employee_branch_assignments WHERE employee_id = ? AND branch_id = ? AND started_on <= CURRENT_DATE() AND (ended_on IS NULL OR ended_on >= CURRENT_DATE()) LIMIT 1`, [values.employeeId, branchId]);
    if (!assigned.length) return { outcome: 'participant_not_assigned' };
    await connection.execute('INSERT INTO stock_count_participants (stock_count_id, employee_id, participant_role) VALUES (?, ?, ?)', [countId, values.employeeId, values.participantRole]);
    const detail = await selectCount(connection, branchId, countId); const participant = detail.participants.find((entry) => entry.employeeId === values.employeeId);
    await insertAuditLog(connection, { auditContext, branchId, actionType: 'STOCK_COUNT_PARTICIPANT_ADDED', entityType: 'stock_count_participants', entityRecordId: `${countId}:${values.employeeId}`, beforeValues: null, afterValues: participant });
    return { outcome: 'created', participant };
  });
}

async function removeParticipant(branchId, countId, employeeId, auditContext) {
  return withInventoryTransaction(async (connection) => {
    const actor = await lockOperationalContext(connection, branchId, auditContext.actorEmployeeId); if (actor.outcome !== 'valid') return actor;
    const header = await lockCountHeader(connection, branchId, countId); if (!header) return { outcome: 'not_found' }; if (header.status !== 'DRAFT') return { outcome: 'not_draft' };
    const before = await selectCount(connection, branchId, countId); const participant = before.participants.find((entry) => entry.employeeId === employeeId); if (!participant) return { outcome: 'participant_not_found' };
    await connection.execute('DELETE FROM stock_count_participants WHERE stock_count_id = ? AND employee_id = ?', [countId, employeeId]);
    await insertAuditLog(connection, { auditContext, branchId, actionType: 'STOCK_COUNT_PARTICIPANT_REMOVED', entityType: 'stock_count_participants', entityRecordId: `${countId}:${employeeId}`, beforeValues: participant, afterValues: null });
    return { outcome: 'deleted' };
  });
}

async function createCountItem(branchId, countId, values, auditContext) {
  const refs = await preReadVariants(pool, [values.productVariantId]); if (!refs.length) return { outcome: 'variant_not_found' };
  return withInventoryTransaction(async (connection) => {
    const actor = await lockOperationalContext(connection, branchId, auditContext.actorEmployeeId); if (actor.outcome !== 'valid') return actor;
    const policies = await lockCatalogRoots(connection, refs); const policy = policies?.get(values.productVariantId); if (!policy) return { outcome: 'concurrent_change' }; if (policy.status !== 'ACTIVE') return { outcome: 'variant_inactive' };
    const header = await lockCountHeader(connection, branchId, countId); if (!header) return { outcome: 'not_found' }; if (header.status !== 'DRAFT') return { outcome: 'not_draft' };
    if (policy.lotTrackingMode === 'NONE' && values.inventoryLotId) return { outcome: 'lots_not_allowed' };
    if (policy.lotTrackingMode === 'REQUIRED' && !values.inventoryLotId) return { outcome: 'lots_required' };
    let systemQuantity = '0.000';
    if (values.inventoryLotId) {
      const lots = await lockGlobalLots(connection, [values.inventoryLotId]); if (!lots.length) return { outcome: 'lot_not_found' }; if (lots[0].productVariantId !== values.productVariantId) return { outcome: 'lot_variant_mismatch' };
      const rows = await lockBranchLots(connection, [branchId], [values.inventoryLotId]); systemQuantity = rows.get(`${branchId}:${values.inventoryLotId}`)?.quantityOnHand ?? '0.000';
    } else {
      const rows = await lockBranchInventory(connection, [branchId], [values.productVariantId]); systemQuantity = rows.get(`${branchId}:${values.productVariantId}`)?.quantityOnHand ?? '0.000';
    }
    const [line] = await connection.execute('SELECT COALESCE(MAX(line_number), 0) + 1 AS lineNumber FROM stock_count_items WHERE stock_count_id = ?', [countId]);
    await connection.execute(`INSERT INTO stock_count_items (stock_count_id, line_number, product_variant_id, inventory_lot_id, system_quantity, notes) VALUES (?, ?, ?, ?, ?, ?)`, [countId, line[0].lineNumber, values.productVariantId, values.inventoryLotId, systemQuantity, values.notes]);
    const id = await getLastInsertId(connection); const detail = await selectCount(connection, branchId, countId); const item = detail.items.find((entry) => entry.stockCountItemId === id);
    await insertAuditLog(connection, { auditContext, branchId, actionType: 'STOCK_COUNT_ITEM_CREATED', entityType: 'stock_count_items', entityRecordId: id, beforeValues: null, afterValues: item });
    return { outcome: 'created', item };
  });
}

async function preReadCountItem(branchId, countId, itemId) {
  const [rows] = await pool.execute(
    `SELECT CAST(sci.product_variant_id AS CHAR) AS productVariantId,
       CAST(pv.product_id AS CHAR) AS productId
     FROM stock_count_items sci
     INNER JOIN stock_counts sc ON sc.stock_count_id = sci.stock_count_id
     INNER JOIN product_variants pv ON pv.product_variant_id = sci.product_variant_id
     WHERE sc.branch_id = ? AND sc.stock_count_id = ? AND sci.stock_count_item_id = ?`,
    [branchId, countId, itemId],
  );
  return rows[0] ?? null;
}

async function patchCountItem(branchId, countId, itemId, changes, auditContext) {
  const reference = await preReadCountItem(branchId, countId, itemId);
  if (!reference) return { outcome: 'item_not_found' };
  return withInventoryTransaction(async (connection) => {
    const actor = await lockOperationalContext(connection, branchId, auditContext.actorEmployeeId); if (actor.outcome !== 'valid') return actor;
    const policies = await lockCatalogRoots(connection, [reference]);
    if (!policies) return { outcome: 'concurrent_change' };
    const header = await lockCountHeader(connection, branchId, countId); if (!header) return { outcome: 'not_found' };
    if (!['DRAFT', 'IN_PROGRESS'].includes(header.status)) return { outcome: 'not_countable' };
    const beforeDetail = await selectCount(connection, branchId, countId); const before = beforeDetail.items.find((entry) => entry.stockCountItemId === itemId); if (!before) return { outcome: 'item_not_found' };
    if (header.status === 'DRAFT' &&
        (changes.countedQuantity !== undefined || changes.varianceReason !== undefined)) {
      return { outcome: 'not_started' };
    }
    if (header.status === 'IN_PROGRESS' && changes.notes !== undefined) return { outcome: 'identity_frozen' };
    const next = { countedQuantity: before.countedQuantity, varianceReason: before.varianceReason, notes: before.notes, ...changes };
    if (next.countedQuantity !== null && compareQuantities(next.countedQuantity, before.systemQuantity) !== 0 && !next.varianceReason) return { outcome: 'variance_reason_required' };
    if (next.countedQuantity !== null && !policies.get(before.productVariantId).isFractional && !next.countedQuantity.endsWith('.000')) return { outcome: 'fractional_quantity' };
    if (next.countedQuantity === before.countedQuantity && next.varianceReason === before.varianceReason && next.notes === before.notes) return { outcome: 'unchanged', item: before };
    const now = await selectUtcNow(connection);
    await connection.execute(`UPDATE stock_count_items SET counted_quantity = ?, variance_reason = ?, notes = ?, counted_by_employee_id = ?, counted_at = ? WHERE stock_count_item_id = ?`, [next.countedQuantity, next.varianceReason, next.notes, next.countedQuantity === null ? null : auditContext.actorEmployeeId, next.countedQuantity === null ? null : now, itemId]);
    const detail = await selectCount(connection, branchId, countId); const item = detail.items.find((entry) => entry.stockCountItemId === itemId);
    await insertAuditLog(connection, { auditContext, branchId, actionType: 'STOCK_COUNT_ITEM_UPDATED', entityType: 'stock_count_items', entityRecordId: itemId, beforeValues: before, afterValues: item });
    return { outcome: 'updated', item };
  });
}

async function deleteCountItem(branchId, countId, itemId, auditContext) {
  return withInventoryTransaction(async (connection) => {
    const actor = await lockOperationalContext(connection, branchId, auditContext.actorEmployeeId); if (actor.outcome !== 'valid') return actor;
    const header = await lockCountHeader(connection, branchId, countId); if (!header) return { outcome: 'not_found' }; if (header.status !== 'DRAFT') return { outcome: 'not_draft' };
    const detail = await selectCount(connection, branchId, countId); const item = detail.items.find((entry) => entry.stockCountItemId === itemId); if (!item) return { outcome: 'item_not_found' };
    await connection.execute('DELETE FROM stock_count_items WHERE stock_count_item_id = ?', [itemId]);
    await insertAuditLog(connection, { auditContext, branchId, actionType: 'STOCK_COUNT_ITEM_DELETED', entityType: 'stock_count_items', entityRecordId: itemId, beforeValues: item, afterValues: null });
    return { outcome: 'deleted' };
  });
}

async function preReadCount(branchId, countId) {
  const [rows] = await pool.execute(`SELECT CAST(sci.product_variant_id AS CHAR) AS productVariantId, CAST(pv.product_id AS CHAR) AS productId, CAST(sci.inventory_lot_id AS CHAR) AS inventoryLotId FROM stock_counts sc LEFT JOIN stock_count_items sci ON sci.stock_count_id = sc.stock_count_id LEFT JOIN product_variants pv ON pv.product_variant_id = sci.product_variant_id WHERE sc.branch_id = ? AND sc.stock_count_id = ? ORDER BY sci.product_variant_id, sci.inventory_lot_id`, [branchId, countId]);
  if (!rows.length) return null;
  return { references: [...new Map(rows.filter((row) => row.productVariantId).map((row) => [row.productVariantId, { productVariantId: row.productVariantId, productId: row.productId }])).values()], lotIds: [...new Set(rows.map((row) => row.inventoryLotId).filter(Boolean))] };
}

function currentScopeQuantities(branchId, items, branchRows, lotRows) {
  const tracked = new Map();
  for (const item of items) if (item.inventoryLotId) tracked.set(item.productVariantId, addQuantities(tracked.get(item.productVariantId) ?? '0.000', lotRows.get(`${branchId}:${item.inventoryLotId}`)?.quantityOnHand ?? '0.000'));
  const result = new Map();
  for (const item of items) {
    const value = item.inventoryLotId
      ? lotRows.get(`${branchId}:${item.inventoryLotId}`)?.quantityOnHand ?? '0.000'
      : addQuantities(branchRows.get(`${branchId}:${item.productVariantId}`)?.quantityOnHand ?? '0.000', negateQuantity(tracked.get(item.productVariantId) ?? '0.000'));
    result.set(item.stockCountItemId, value);
  }
  return result;
}

async function startCount(branchId, countId, auditContext) {
  const pre = await preReadCount(branchId, countId); if (!pre) return { outcome: 'not_found' };
  return withInventoryTransaction(async (connection) => {
    const actor = await lockOperationalContext(connection, branchId, auditContext.actorEmployeeId); if (actor.outcome !== 'valid') return actor;
    const policies = await lockCatalogRoots(connection, pre.references); if (!policies && pre.references.length) return { outcome: 'concurrent_change' };
    const header = await lockCountHeader(connection, branchId, countId); if (!header) return { outcome: 'not_found' }; if (header.status !== 'DRAFT') return { outcome: 'not_draft' };
    const before = await selectCount(connection, branchId, countId); if (!before.items.length) return { outcome: 'empty_count' };
    const globalLots = await lockGlobalLots(connection, pre.lotIds); if (globalLots.length !== pre.lotIds.length) return { outcome: 'lot_not_found' };
    const lotMap = new Map(globalLots.map((lot) => [lot.inventoryLotId, lot]));
    for (const item of before.items) { const policy = policies.get(item.productVariantId); if (!policy || policy.status !== 'ACTIVE') return { outcome: 'variant_inactive' }; if (policy.lotTrackingMode === 'NONE' && item.inventoryLotId) return { outcome: 'lots_not_allowed' }; if (policy.lotTrackingMode === 'REQUIRED' && !item.inventoryLotId) return { outcome: 'lots_required' }; if (item.inventoryLotId && lotMap.get(item.inventoryLotId)?.productVariantId !== item.productVariantId) return { outcome: 'lot_variant_mismatch' }; }
    const variantIds = before.items.map((item) => item.productVariantId); const branchRows = await lockBranchInventory(connection, [branchId], variantIds); const lotRows = await lockBranchLots(connection, [branchId], pre.lotIds);
    for (const variantId of new Set(variantIds)) if (policies.get(variantId).lotTrackingMode === 'REQUIRED') {
      const selected = before.items.filter((item) => item.productVariantId === variantId).map((item) => item.inventoryLotId).filter(Boolean).sort();
      const [actual] = await connection.execute(`SELECT CAST(bli.inventory_lot_id AS CHAR) AS inventoryLotId FROM branch_lot_inventory bli INNER JOIN inventory_lots il ON il.inventory_lot_id = bli.inventory_lot_id WHERE bli.branch_id = ? AND il.product_variant_id = ? AND bli.quantity_on_hand > 0 ORDER BY bli.inventory_lot_id FOR UPDATE`, [branchId, variantId]);
      if (selected.join(',') !== actual.map((row) => row.inventoryLotId).join(',')) return { outcome: 'incomplete_lot_scope' };
      const lotTotal = selected.reduce(
        (total, lotId) => addQuantities(
          total, lotRows.get(`${branchId}:${lotId}`)?.quantityOnHand ?? '0.000',
        ),
        '0.000',
      );
      if (compareQuantities(
        branchRows.get(`${branchId}:${variantId}`)?.quantityOnHand ?? '0.000', lotTotal,
      ) !== 0) return { outcome: 'lot_consistency' };
    }
    const current = currentScopeQuantities(branchId, before.items, branchRows, lotRows); for (const item of before.items) await connection.execute(`UPDATE stock_count_items SET system_quantity = ?, counted_quantity = NULL, counted_by_employee_id = NULL, counted_at = NULL, variance_reason = NULL WHERE stock_count_item_id = ?`, [current.get(item.stockCountItemId), item.stockCountItemId]);
    const now = await selectUtcNow(connection); await connection.execute(`UPDATE stock_counts SET status = 'IN_PROGRESS', started_at = ? WHERE stock_count_id = ?`, [now, countId]);
    const detail = await selectCount(connection, branchId, countId); await insertAuditLog(connection, { auditContext, branchId, actionType: 'STOCK_COUNT_STARTED', entityType: 'stock_counts', entityRecordId: countId, beforeValues: snapshot(before), afterValues: snapshot(detail) });
    return { outcome: 'started', detail };
  });
}

async function completeCount(branchId, countId, auditContext) {
  return withInventoryTransaction(async (connection) => {
    const actor = await lockOperationalContext(connection, branchId, auditContext.actorEmployeeId); if (actor.outcome !== 'valid') return actor;
    const header = await lockCountHeader(connection, branchId, countId); if (!header) return { outcome: 'not_found' }; if (header.status !== 'IN_PROGRESS') return { outcome: 'not_in_progress' };
    const before = await selectCount(connection, branchId, countId); if (before.items.some((item) => item.countedQuantity === null)) return { outcome: 'uncounted_items' };
    const now = await selectUtcNow(connection); await connection.execute(`UPDATE stock_counts SET status = 'COUNTED', completed_at = ? WHERE stock_count_id = ?`, [now, countId]);
    const detail = await selectCount(connection, branchId, countId); await insertAuditLog(connection, { auditContext, branchId, actionType: 'STOCK_COUNT_COMPLETED', entityType: 'stock_counts', entityRecordId: countId, beforeValues: snapshot(before), afterValues: snapshot(detail) });
    return { outcome: 'completed', detail };
  });
}

async function postCount(branchId, countId, auditContext) {
  const pre = await preReadCount(branchId, countId); if (!pre) return { outcome: 'not_found' };
  return withInventoryTransaction(async (connection) => {
    const actor = await lockOperationalContext(connection, branchId, auditContext.actorEmployeeId); if (actor.outcome !== 'valid') return actor;
    const policies = await lockCatalogRoots(connection, pre.references); if (!policies && pre.references.length) return { outcome: 'concurrent_change' };
    const header = await lockCountHeader(connection, branchId, countId); if (!header) return { outcome: 'not_found' }; if (header.status !== 'COUNTED') return { outcome: header.status === 'POSTED' ? 'already_posted' : 'not_counted' }; if (header.createdByEmployeeId === auditContext.actorEmployeeId) return { outcome: 'self_approval' };
    const before = await selectCount(connection, branchId, countId); const globalLots = await lockGlobalLots(connection, pre.lotIds); if (globalLots.length !== pre.lotIds.length) return { outcome: 'lot_not_found' };
    const variantIds = before.items.map((item) => item.productVariantId); const branchRows = await lockBranchInventory(connection, [branchId], variantIds); const lotRows = await lockBranchLots(connection, [branchId], pre.lotIds); const current = currentScopeQuantities(branchId, before.items, branchRows, lotRows);
    if (before.items.some((item) => compareQuantities(current.get(item.stockCountItemId), item.systemQuantity) !== 0)) return { outcome: 'stale_count' };
    const byVariant = new Map();
    for (const item of before.items) { if (item.varianceQuantity === '0.000') continue; const movement = byVariant.get(item.productVariantId) ?? { productVariantId: item.productVariantId, quantityChange: '0.000', unitCost: null, lots: [] }; movement.quantityChange = addQuantities(movement.quantityChange, item.varianceQuantity); if (item.inventoryLotId) movement.lots.push({ inventoryLotId: item.inventoryLotId, productVariantId: item.productVariantId, quantityChange: item.varianceQuantity, unitCost: null }); byVariant.set(item.productVariantId, movement); }
    if (before.items.some((item) => policies.get(item.productVariantId)?.status !== 'ACTIVE')) {
      return { outcome: 'variant_inactive' };
    }
    const movements = [...byVariant.values()]; if (movements.some((movement) => movement.quantityChange === '0.000' && movement.lots.length)) return { outcome: 'lot_reconciliation_unrepresentable' };
    for (const movement of movements) { const error = validateMovementPolicy(movement, policies.get(movement.productVariantId)); if (error) return { outcome: error }; }
    const startingConsistency = await assertLotConsistency(
      connection, branchId, policies, variantIds,
    );
    if (startingConsistency.outcome !== 'valid') return startingConsistency;
    let adjustmentId = null;
    if (movements.length) {
      const now = await selectUtcNow(connection); await connection.execute(`INSERT INTO inventory_adjustments (adjustment_number, branch_id, adjustment_type, status, reason, created_by_employee_id, approved_by_employee_id, adjusted_at, approved_at) VALUES (?, ?, 'COUNT_CORRECTION', 'APPROVED', ?, ?, ?, ?, ?)`, [generateDocumentNumber('ADJ'), branchId, `Stock count ${header.countNumber} reconciliation`, header.createdByEmployeeId, auditContext.actorEmployeeId, now, now]); adjustmentId = await getLastInsertId(connection);
      let line = 0; for (const movement of movements) { line += 1; await connection.execute(`INSERT INTO inventory_adjustment_items (inventory_adjustment_id, line_number, product_variant_id, quantity_change, unit_cost, reason) VALUES (?, ?, ?, ?, NULL, ?)`, [adjustmentId, line, movement.productVariantId, movement.quantityChange, `Stock count ${header.countNumber} variance`]); const itemId = await getLastInsertId(connection); for (const lot of movement.lots) await connection.execute(`INSERT INTO inventory_adjustment_item_lots (inventory_adjustment_item_id, inventory_lot_id, product_variant_id, quantity_change, unit_cost) VALUES (?, ?, ?, ?, NULL)`, [itemId, lot.inventoryLotId, lot.productVariantId, lot.quantityChange]); }
      const branchResult = await applyBranchMovements(connection, branchId, movements, branchRows); if (branchResult.outcome !== 'applied') abortOperation(branchResult.outcome); const lotResult = await applyLotMovements(connection, branchId, movements.flatMap((movement) => movement.lots), lotRows, globalLots); if (lotResult.outcome !== 'applied') abortOperation(lotResult.outcome); const consistency = await assertLotConsistency(connection, branchId, policies, variantIds); if (consistency.outcome !== 'valid') abortOperation(consistency.outcome);
      const transactionId = await createLedger(connection, { branchId, transactionType: 'ADJUSTMENT', actorEmployeeId: auditContext.actorEmployeeId, notes: `Stock count ${header.countNumber} reconciliation`, movements });
      await connection.execute(`UPDATE inventory_adjustments SET status = 'POSTED', posted_at = ?, inventory_transaction_id = ? WHERE inventory_adjustment_id = ?`, [now, transactionId, adjustmentId]);
    }
    const now = await selectUtcNow(connection); await connection.execute(`UPDATE stock_counts SET status = 'POSTED', approved_by_employee_id = ?, posted_by_employee_id = ?, approved_at = ?, posted_at = ?, inventory_adjustment_id = ? WHERE stock_count_id = ?`, [auditContext.actorEmployeeId, auditContext.actorEmployeeId, now, now, adjustmentId, countId]);
    const detail = await selectCount(connection, branchId, countId); await insertAuditLog(connection, { auditContext, branchId, actionType: 'STOCK_COUNT_POSTED', entityType: 'stock_counts', entityRecordId: countId, beforeValues: snapshot(before), afterValues: snapshot(detail), notes: movements.length ? 'Count correction adjustment and ledger posted atomically.' : 'Zero-variance count finalized without a ledger entry.' });
    return { outcome: 'posted', detail };
  });
}

async function cancelCount(branchId, countId, auditContext) {
  return withInventoryTransaction(async (connection) => {
    const actor = await lockOperationalContext(connection, branchId, auditContext.actorEmployeeId); if (actor.outcome !== 'valid') return actor;
    const header = await lockCountHeader(connection, branchId, countId); if (!header) return { outcome: 'not_found' }; if (!['DRAFT', 'IN_PROGRESS', 'COUNTED', 'APPROVED'].includes(header.status)) return { outcome: 'not_cancellable' };
    const before = await selectCount(connection, branchId, countId); const now = await selectUtcNow(connection); await connection.execute(`UPDATE stock_counts SET status = 'CANCELLED', cancelled_by_employee_id = ?, cancelled_at = ? WHERE stock_count_id = ?`, [auditContext.actorEmployeeId, now, countId]); const detail = await selectCount(connection, branchId, countId);
    await insertAuditLog(connection, { auditContext, branchId, actionType: 'STOCK_COUNT_CANCELLED', entityType: 'stock_counts', entityRecordId: countId, beforeValues: snapshot(before), afterValues: snapshot(detail) }); return { outcome: 'cancelled', detail };
  });
}

async function findCount(branchId, countId) { return selectCount(pool, branchId, countId); }
async function findCountVariance(branchId, countId) { const detail = await selectCount(pool, branchId, countId); return detail && { stockCount: detail.stockCount, items: detail.items.map(({ stockCountItemId, productVariantId, inventoryLotId, systemQuantity, countedQuantity, varianceQuantity, varianceReason, sku, variantName, productName, lotNumber }) => ({ stockCountItemId, productVariantId, inventoryLotId, systemQuantity, countedQuantity, varianceQuantity, varianceReason, sku, variantName, productName, lotNumber })) }; }
async function findCountLedger(branchId, countId) { const detail = await selectCount(pool, branchId, countId); return detail && { stockCount: detail.stockCount, reconciliation: detail.reconciliation }; }

export { addParticipant, cancelCount, completeCount, createCount, createCountItem, deleteCountItem, findCount, findCountLedger, findCountVariance, listCounts, patchCountItem, postCount, removeParticipant, startCount, updateCount };
