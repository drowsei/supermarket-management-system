import pool from '../config/database.js';
import { countAsSafeNumber, getLastInsertId } from './productCatalog.repository.js';
import { generateDocumentNumber, selectUtcNow } from './purchasing.repository.js';
import {
  abortOperation, applyBranchMovements, applyLotMovements, assertLotConsistency,
  createLedger, insertAuditLog, lockBranchInventory, lockBranchLots,
  lockCatalogRoots, lockGlobalLots, lockTransferOperationalContext,
  preReadVariants, validateMovementPolicy, withInventoryTransaction,
} from './inventoryMovement.repository.js';
import { compareQuantities, negateQuantity } from '../utils/inventoryQuantity.js';

const HEADER = `CAST(st.stock_transfer_id AS CHAR) AS stockTransferId,
 st.transfer_number AS transferNumber,
 CAST(st.source_branch_id AS CHAR) AS sourceBranchId,
 CAST(st.destination_branch_id AS CHAR) AS destinationBranchId,
 sb.branch_code AS sourceBranchCode, sb.branch_name AS sourceBranchName,
 db.branch_code AS destinationBranchCode, db.branch_name AS destinationBranchName,
 st.status, CAST(st.requested_by_employee_id AS CHAR) AS requestedByEmployeeId,
 CAST(st.approved_by_employee_id AS CHAR) AS approvedByEmployeeId,
 CAST(st.dispatched_by_employee_id AS CHAR) AS dispatchedByEmployeeId,
 CAST(st.received_by_employee_id AS CHAR) AS receivedByEmployeeId,
 CAST(st.cancelled_by_employee_id AS CHAR) AS cancelledByEmployeeId,
 CAST(st.source_inventory_transaction_id AS CHAR) AS sourceInventoryTransactionId,
 CAST(st.destination_inventory_transaction_id AS CHAR) AS destinationInventoryTransactionId,
 DATE_FORMAT(st.requested_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS requestedAt,
 DATE_FORMAT(st.approved_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS approvedAt,
 DATE_FORMAT(st.dispatched_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS dispatchedAt,
 DATE_FORMAT(st.received_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS receivedAt,
 DATE_FORMAT(st.cancelled_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS cancelledAt,
 st.notes, DATE_FORMAT(st.created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS createdAt,
 DATE_FORMAT(st.updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS updatedAt`;

async function selectTransfer(executor, branchId, transferId) {
  const [headers] = await executor.execute(
    `SELECT ${HEADER} FROM stock_transfers st
     INNER JOIN branches sb ON sb.branch_id = st.source_branch_id
     INNER JOIN branches db ON db.branch_id = st.destination_branch_id
     WHERE st.stock_transfer_id = ? AND (st.source_branch_id = ? OR st.destination_branch_id = ?)`,
    [transferId, branchId, branchId],
  );
  if (!headers[0]) return null;
  const [items] = await executor.execute(
    `SELECT CAST(sti.stock_transfer_item_id AS CHAR) AS stockTransferItemId,
       CAST(sti.product_variant_id AS CHAR) AS productVariantId,
       sti.line_number AS lineNumber, sti.quantity_requested AS quantityRequested,
       sti.quantity_dispatched AS quantityDispatched, sti.quantity_received AS quantityReceived,
       (sti.quantity_dispatched - sti.quantity_received) AS quantityInTransit,
       sti.notes, pv.sku, pv.variant_name AS variantName,
       pv.lot_tracking_mode AS lotTrackingMode, p.product_name AS productName
     FROM stock_transfer_items sti
     INNER JOIN product_variants pv ON pv.product_variant_id = sti.product_variant_id
     INNER JOIN products p ON p.product_id = pv.product_id
     WHERE sti.stock_transfer_id = ? ORDER BY sti.line_number, sti.stock_transfer_item_id`, [transferId],
  );
  const [lots] = await executor.execute(
    `SELECT CAST(stil.stock_transfer_item_lot_id AS CHAR) AS stockTransferItemLotId,
       CAST(stil.stock_transfer_item_id AS CHAR) AS stockTransferItemId,
       CAST(stil.inventory_lot_id AS CHAR) AS inventoryLotId,
       stil.quantity_requested AS quantityRequested,
       stil.quantity_dispatched AS quantityDispatched,
       stil.quantity_received AS quantityReceived,
       (stil.quantity_dispatched - stil.quantity_received) AS quantityInTransit,
       il.lot_number AS lotNumber, DATE_FORMAT(il.expires_on, '%Y-%m-%d') AS expiresOn,
       il.status AS lotStatus
     FROM stock_transfer_item_lots stil
     INNER JOIN stock_transfer_items sti ON sti.stock_transfer_item_id = stil.stock_transfer_item_id
     INNER JOIN inventory_lots il ON il.inventory_lot_id = stil.inventory_lot_id
     WHERE sti.stock_transfer_id = ? ORDER BY sti.line_number, stil.stock_transfer_item_lot_id`, [transferId],
  );
  const grouped = new Map(items.map((item) => [item.stockTransferItemId, []]));
  lots.forEach((lot) => grouped.get(lot.stockTransferItemId)?.push(lot));
  const ledger = async (id, expectedBranchId) => {
    if (!id) return null;
    const [rows] = await executor.execute(`SELECT CAST(inventory_transaction_id AS CHAR) AS inventoryTransactionId, transaction_number AS transactionNumber, transaction_type AS transactionType, CAST(branch_id AS CHAR) AS branchId, DATE_FORMAT(occurred_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS occurredAt FROM inventory_transactions WHERE inventory_transaction_id = ? AND branch_id = ?`, [id, expectedBranchId]);
    return rows[0] ?? null;
  };
  return { stockTransfer: headers[0], items: items.map((item) => ({ ...item, lotAllocations: grouped.get(item.stockTransferItemId) })), sourceLedger: await ledger(headers[0].sourceInventoryTransactionId, headers[0].sourceBranchId), destinationLedger: await ledger(headers[0].destinationInventoryTransactionId, headers[0].destinationBranchId) };
}

function snapshot(detail) { return detail && { ...detail.stockTransfer, items: detail.items.map((item) => ({ stockTransferItemId: item.stockTransferItemId, productVariantId: item.productVariantId, quantityRequested: item.quantityRequested, quantityDispatched: item.quantityDispatched, quantityReceived: item.quantityReceived, lotAllocations: item.lotAllocations.map((lot) => ({ inventoryLotId: lot.inventoryLotId, quantityRequested: lot.quantityRequested, quantityDispatched: lot.quantityDispatched, quantityReceived: lot.quantityReceived })) })) }; }

function listWhere(branchId, filters) {
  const predicates = ['(st.source_branch_id = ? OR st.destination_branch_id = ?)']; const params = [branchId, branchId];
  if (filters.search) { predicates.push('(LOCATE(?, st.transfer_number) > 0 OR LOCATE(?, COALESCE(st.notes, \'\')) > 0)'); params.push(filters.search, filters.search); }
  if (filters.status) { predicates.push('st.status = ?'); params.push(filters.status); }
  if (filters.direction === 'OUTGOING') predicates.push('st.source_branch_id = ?'), params.push(branchId);
  if (filters.direction === 'INCOMING') predicates.push('st.destination_branch_id = ?'), params.push(branchId);
  if (filters.counterpartyBranchId) { predicates.push('((st.source_branch_id = ? AND st.destination_branch_id = ?) OR (st.destination_branch_id = ? AND st.source_branch_id = ?))'); params.push(branchId, filters.counterpartyBranchId, branchId, filters.counterpartyBranchId); }
  if (filters.requestedByEmployeeId) { predicates.push('st.requested_by_employee_id = ?'); params.push(filters.requestedByEmployeeId); }
  if (filters.from) { predicates.push('st.created_at >= ?'); params.push(`${filters.from} 00:00:00`); }
  if (filters.to) { predicates.push(filters.to === '9999-12-31' ? 'st.created_at <= ?' : 'st.created_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(filters.to === '9999-12-31' ? '9999-12-31 23:59:59.999999' : `${filters.to} 00:00:00`); }
  return { sql: `WHERE ${predicates.join(' AND ')}`, params };
}

async function listTransfers(branchId, filters) {
  const where = listWhere(branchId, filters); const [count] = await pool.execute(`SELECT CAST(COUNT(*) AS CHAR) AS totalItems FROM stock_transfers st ${where.sql}`, where.params);
  const [items] = await pool.execute(`SELECT ${HEADER}, (SELECT COUNT(*) FROM stock_transfer_items sti WHERE sti.stock_transfer_id = st.stock_transfer_id) AS itemCount FROM stock_transfers st INNER JOIN branches sb ON sb.branch_id = st.source_branch_id INNER JOIN branches db ON db.branch_id = st.destination_branch_id ${where.sql} ORDER BY st.created_at DESC, st.stock_transfer_id DESC LIMIT ? OFFSET ?`, [...where.params, filters.limit, filters.offset]);
  return { items, totalItems: countAsSafeNumber(count[0].totalItems, 'stock transfer') };
}

async function preReadTransfer(branchId, transferId) {
  const [rows] = await pool.execute(`SELECT CAST(st.source_branch_id AS CHAR) AS sourceBranchId, CAST(st.destination_branch_id AS CHAR) AS destinationBranchId, CAST(sti.product_variant_id AS CHAR) AS productVariantId, CAST(pv.product_id AS CHAR) AS productId, CAST(stil.inventory_lot_id AS CHAR) AS inventoryLotId FROM stock_transfers st LEFT JOIN stock_transfer_items sti ON sti.stock_transfer_id = st.stock_transfer_id LEFT JOIN product_variants pv ON pv.product_variant_id = sti.product_variant_id LEFT JOIN stock_transfer_item_lots stil ON stil.stock_transfer_item_id = sti.stock_transfer_item_id WHERE st.stock_transfer_id = ? AND (st.source_branch_id = ? OR st.destination_branch_id = ?) ORDER BY sti.product_variant_id, stil.inventory_lot_id`, [transferId, branchId, branchId]);
  if (!rows.length) return null;
  return { sourceBranchId: rows[0].sourceBranchId, destinationBranchId: rows[0].destinationBranchId, references: [...new Map(rows.filter((row) => row.productVariantId).map((row) => [row.productVariantId, { productVariantId: row.productVariantId, productId: row.productId }])).values()], lotIds: [...new Set(rows.map((row) => row.inventoryLotId).filter(Boolean))] };
}

async function lockTransfer(connection, transferId) {
  const [headers] = await connection.execute(`SELECT status, transfer_number AS transferNumber, CAST(source_branch_id AS CHAR) AS sourceBranchId, CAST(destination_branch_id AS CHAR) AS destinationBranchId FROM stock_transfers WHERE stock_transfer_id = ? FOR UPDATE`, [transferId]); if (!headers[0]) return null;
  const [items] = await connection.execute(`SELECT CAST(stock_transfer_item_id AS CHAR) AS stockTransferItemId, CAST(product_variant_id AS CHAR) AS productVariantId, quantity_requested AS quantityRequested, quantity_dispatched AS quantityDispatched, quantity_received AS quantityReceived FROM stock_transfer_items WHERE stock_transfer_id = ? ORDER BY stock_transfer_item_id FOR UPDATE`, [transferId]);
  const [lots] = await connection.execute(`SELECT CAST(stil.stock_transfer_item_id AS CHAR) AS stockTransferItemId, CAST(stil.inventory_lot_id AS CHAR) AS inventoryLotId, CAST(stil.product_variant_id AS CHAR) AS productVariantId, stil.quantity_requested AS quantityRequested, stil.quantity_dispatched AS quantityDispatched, stil.quantity_received AS quantityReceived FROM stock_transfer_item_lots stil INNER JOIN stock_transfer_items sti ON sti.stock_transfer_item_id = stil.stock_transfer_item_id WHERE sti.stock_transfer_id = ? ORDER BY stil.stock_transfer_item_lot_id FOR UPDATE`, [transferId]);
  const grouped = new Map(items.map((item) => [item.stockTransferItemId, []])); lots.forEach((lot) => grouped.get(lot.stockTransferItemId)?.push(lot)); return { ...headers[0], items: items.map((item) => ({ ...item, lots: grouped.get(item.stockTransferItemId) })) };
}

async function createTransfer(sourceBranchId, values, auditContext) {
  if (sourceBranchId === values.destinationBranchId) return { outcome: 'same_branch' };
  return withInventoryTransaction(async (connection) => {
    const actor = await lockTransferOperationalContext(connection, sourceBranchId, [sourceBranchId, values.destinationBranchId], auditContext.actorEmployeeId); if (actor.outcome !== 'valid') return actor;
    await connection.execute(`INSERT INTO stock_transfers (transfer_number, source_branch_id, destination_branch_id, status, requested_by_employee_id, notes) VALUES (?, ?, ?, 'DRAFT', ?, ?)`, [generateDocumentNumber('TRF'), sourceBranchId, values.destinationBranchId, auditContext.actorEmployeeId, values.notes]); const id = await getLastInsertId(connection); const detail = await selectTransfer(connection, sourceBranchId, id);
    await insertAuditLog(connection, { auditContext, branchId: sourceBranchId, actionType: 'STOCK_TRANSFER_CREATED', entityType: 'stock_transfers', entityRecordId: id, beforeValues: null, afterValues: snapshot(detail) }); return { outcome: 'created', detail };
  });
}

async function updateTransfer(branchId, transferId, changes, auditContext) {
  const pre = await preReadTransfer(branchId, transferId); if (!pre || pre.sourceBranchId !== branchId) return { outcome: 'not_found' }; const destination = changes.destinationBranchId ?? pre.destinationBranchId; if (destination === branchId) return { outcome: 'same_branch' };
  return withInventoryTransaction(async (connection) => {
    const actor = await lockTransferOperationalContext(connection, branchId, [branchId, pre.destinationBranchId, destination], auditContext.actorEmployeeId); if (actor.outcome !== 'valid') return actor;
    const document = await lockTransfer(connection, transferId); if (!document || document.sourceBranchId !== branchId) return { outcome: 'not_found' }; if (document.status !== 'DRAFT') return { outcome: 'not_draft' };
    const before = await selectTransfer(connection, branchId, transferId); const next = { destinationBranchId: before.stockTransfer.destinationBranchId, notes: before.stockTransfer.notes, ...changes }; if (next.destinationBranchId === before.stockTransfer.destinationBranchId && next.notes === before.stockTransfer.notes) return { outcome: 'unchanged', detail: before };
    await connection.execute('UPDATE stock_transfers SET destination_branch_id = ?, notes = ? WHERE stock_transfer_id = ?', [next.destinationBranchId, next.notes, transferId]); const detail = await selectTransfer(connection, branchId, transferId);
    await insertAuditLog(connection, { auditContext, branchId, actionType: 'STOCK_TRANSFER_UPDATED', entityType: 'stock_transfers', entityRecordId: transferId, beforeValues: snapshot(before), afterValues: snapshot(detail) }); return { outcome: 'updated', detail };
  });
}

async function replaceRequestedLots(connection, itemId, variantId, quantity, allocations, policy) {
  const lots = await lockGlobalLots(connection, allocations.map((lot) => lot.inventoryLotId)); if (lots.length !== allocations.length) return 'lot_not_found'; if (lots.some((lot) => lot.productVariantId !== variantId)) return 'lot_variant_mismatch';
  const movement = { productVariantId: variantId, quantityChange: quantity, lots: allocations.map((lot) => ({ inventoryLotId: lot.inventoryLotId, quantityChange: lot.quantityRequested })) }; const error = validateMovementPolicy(movement, policy); if (error) return error;
  await connection.execute('DELETE FROM stock_transfer_item_lots WHERE stock_transfer_item_id = ?', [itemId]); for (const lot of allocations) await connection.execute(`INSERT INTO stock_transfer_item_lots (stock_transfer_item_id, inventory_lot_id, product_variant_id, quantity_requested) VALUES (?, ?, ?, ?)`, [itemId, lot.inventoryLotId, variantId, lot.quantityRequested]); return null;
}

async function createTransferItem(branchId, transferId, values, auditContext) {
  const pre = await preReadTransfer(branchId, transferId); if (!pre || pre.sourceBranchId !== branchId) return { outcome: 'not_found' }; const refs = await preReadVariants(pool, [values.productVariantId]); if (!refs.length) return { outcome: 'variant_not_found' };
  return withInventoryTransaction(async (connection) => {
    const actor = await lockTransferOperationalContext(connection, branchId, [pre.sourceBranchId, pre.destinationBranchId], auditContext.actorEmployeeId); if (actor.outcome !== 'valid') return actor; const policies = await lockCatalogRoots(connection, refs); const policy = policies?.get(values.productVariantId); if (!policy) return { outcome: 'concurrent_change' }; if (policy.status !== 'ACTIVE') return { outcome: 'variant_inactive' };
    const document = await lockTransfer(connection, transferId); if (!document || document.sourceBranchId !== branchId) return { outcome: 'not_found' }; if (document.status !== 'DRAFT') return { outcome: 'not_draft' };
    const error = validateMovementPolicy({ productVariantId: values.productVariantId, quantityChange: values.quantityRequested, lots: values.lotAllocations.map((lot) => ({ quantityChange: lot.quantityRequested })) }, policy); if (error) return { outcome: error };
    const [line] = await connection.execute('SELECT COALESCE(MAX(line_number), 0) + 1 AS lineNumber FROM stock_transfer_items WHERE stock_transfer_id = ?', [transferId]); await connection.execute(`INSERT INTO stock_transfer_items (stock_transfer_id, line_number, product_variant_id, quantity_requested, notes) VALUES (?, ?, ?, ?, ?)`, [transferId, line[0].lineNumber, values.productVariantId, values.quantityRequested, values.notes]); const itemId = await getLastInsertId(connection);
    const lotError = await replaceRequestedLots(connection, itemId, values.productVariantId, values.quantityRequested, values.lotAllocations, policy); if (lotError) abortOperation(lotError);
    const detail = await selectTransfer(connection, branchId, transferId); const item = detail.items.find((entry) => entry.stockTransferItemId === itemId); await insertAuditLog(connection, { auditContext, branchId, actionType: 'STOCK_TRANSFER_ITEM_CREATED', entityType: 'stock_transfer_items', entityRecordId: itemId, beforeValues: null, afterValues: item }); return { outcome: 'created', item };
  });
}

async function updateTransferItem(branchId, transferId, itemId, changes, auditContext) {
  const pre = await preReadTransfer(branchId, transferId); if (!pre || pre.sourceBranchId !== branchId) return { outcome: 'not_found' }; const old = await selectTransfer(pool, branchId, transferId); const itemRef = old?.items.find((item) => item.stockTransferItemId === itemId); if (!itemRef) return { outcome: 'item_not_found' }; const refs = await preReadVariants(pool, [itemRef.productVariantId]);
  return withInventoryTransaction(async (connection) => {
    const actor = await lockTransferOperationalContext(connection, branchId, [pre.sourceBranchId, pre.destinationBranchId], auditContext.actorEmployeeId); if (actor.outcome !== 'valid') return actor; const policies = await lockCatalogRoots(connection, refs); if (!policies) return { outcome: 'concurrent_change' }; const document = await lockTransfer(connection, transferId); if (!document || document.sourceBranchId !== branchId) return { outcome: 'not_found' }; if (document.status !== 'DRAFT') return { outcome: 'not_draft' }; const locked = document.items.find((item) => item.stockTransferItemId === itemId); if (!locked) return { outcome: 'item_not_found' };
    const beforeDetail = await selectTransfer(connection, branchId, transferId); const before = beforeDetail.items.find((item) => item.stockTransferItemId === itemId); const next = { quantityRequested: before.quantityRequested, notes: before.notes, ...changes }; const allocations = changes.lotAllocations ?? before.lotAllocations.map((lot) => ({ inventoryLotId: lot.inventoryLotId, quantityRequested: lot.quantityRequested })); const movementError = validateMovementPolicy({ productVariantId: before.productVariantId, quantityChange: next.quantityRequested, lots: allocations.map((lot) => ({ quantityChange: lot.quantityRequested })) }, policies.get(before.productVariantId)); if (movementError) return { outcome: movementError };
    if (JSON.stringify({ q: next.quantityRequested, n: next.notes, l: allocations }) === JSON.stringify({ q: before.quantityRequested, n: before.notes, l: before.lotAllocations.map((lot) => ({ inventoryLotId: lot.inventoryLotId, quantityRequested: lot.quantityRequested })) })) return { outcome: 'unchanged', item: before };
    await connection.execute('UPDATE stock_transfer_items SET quantity_requested = ?, notes = ? WHERE stock_transfer_item_id = ?', [next.quantityRequested, next.notes, itemId]); if (changes.lotAllocations !== undefined) { const lotError = await replaceRequestedLots(connection, itemId, before.productVariantId, next.quantityRequested, allocations, policies.get(before.productVariantId)); if (lotError) abortOperation(lotError); }
    const detail = await selectTransfer(connection, branchId, transferId); const item = detail.items.find((entry) => entry.stockTransferItemId === itemId); await insertAuditLog(connection, { auditContext, branchId, actionType: 'STOCK_TRANSFER_ITEM_UPDATED', entityType: 'stock_transfer_items', entityRecordId: itemId, beforeValues: before, afterValues: item }); return { outcome: 'updated', item };
  });
}

async function deleteTransferItem(branchId, transferId, itemId, auditContext) {
  const pre = await preReadTransfer(branchId, transferId); if (!pre || pre.sourceBranchId !== branchId) return { outcome: 'not_found' };
  return withInventoryTransaction(async (connection) => { const actor = await lockTransferOperationalContext(connection, branchId, [pre.sourceBranchId, pre.destinationBranchId], auditContext.actorEmployeeId); if (actor.outcome !== 'valid') return actor; const document = await lockTransfer(connection, transferId); if (!document || document.sourceBranchId !== branchId) return { outcome: 'not_found' }; if (document.status !== 'DRAFT') return { outcome: 'not_draft' }; const before = await selectTransfer(connection, branchId, transferId); const item = before.items.find((entry) => entry.stockTransferItemId === itemId); if (!item) return { outcome: 'item_not_found' }; await connection.execute('DELETE FROM stock_transfer_item_lots WHERE stock_transfer_item_id = ?', [itemId]); await connection.execute('DELETE FROM stock_transfer_items WHERE stock_transfer_item_id = ?', [itemId]); await insertAuditLog(connection, { auditContext, branchId, actionType: 'STOCK_TRANSFER_ITEM_DELETED', entityType: 'stock_transfer_items', entityRecordId: itemId, beforeValues: item, afterValues: null }); return { outcome: 'deleted' }; });
}

async function sourceTransition(branchId, transferId, expected, next, actionType, actorColumn, dateColumn, auditContext) {
  const pre = await preReadTransfer(branchId, transferId); if (!pre || pre.sourceBranchId !== branchId) return { outcome: 'not_found' };
  return withInventoryTransaction(async (connection) => { const actor = await lockTransferOperationalContext(connection, branchId, [pre.sourceBranchId, pre.destinationBranchId], auditContext.actorEmployeeId); if (actor.outcome !== 'valid') return actor; const policies = await lockCatalogRoots(connection, pre.references); if (!policies && pre.references.length) return { outcome: 'concurrent_change' }; const document = await lockTransfer(connection, transferId); if (!document || document.sourceBranchId !== branchId) return { outcome: 'not_found' }; if (document.status !== expected) return { outcome: `not_${expected.toLowerCase()}` }; if (!document.items.length) return { outcome: 'empty_transfer' }; const globalLots = await lockGlobalLots(connection, pre.lotIds); if (globalLots.length !== pre.lotIds.length) return { outcome: 'lot_not_found' }; const lotMap = new Map(globalLots.map((lot) => [lot.inventoryLotId, lot])); for (const item of document.items) { if (policies.get(item.productVariantId)?.status !== 'ACTIVE') return { outcome: 'variant_inactive' }; const error = validateMovementPolicy({ productVariantId: item.productVariantId, quantityChange: item.quantityRequested, lots: item.lots.map((lot) => ({ quantityChange: lot.quantityRequested })) }, policies.get(item.productVariantId)); if (error) return { outcome: error }; if (item.lots.some((lot) => lotMap.get(lot.inventoryLotId)?.productVariantId !== item.productVariantId)) return { outcome: 'lot_variant_mismatch' }; } const before = await selectTransfer(connection, branchId, transferId); const now = await selectUtcNow(connection); await connection.execute(`UPDATE stock_transfers SET status = ?, ${actorColumn} = ?, ${dateColumn} = ? WHERE stock_transfer_id = ?`, [next, auditContext.actorEmployeeId, now, transferId]); const detail = await selectTransfer(connection, branchId, transferId); await insertAuditLog(connection, { auditContext, branchId, actionType, entityType: 'stock_transfers', entityRecordId: transferId, beforeValues: snapshot(before), afterValues: snapshot(detail) }); return { outcome: next.toLowerCase(), detail }; });
}

const requestTransfer = (b, id, a) => sourceTransition(b, id, 'DRAFT', 'REQUESTED', 'STOCK_TRANSFER_REQUESTED', 'requested_by_employee_id', 'requested_at', a);
const approveTransfer = (b, id, a) => sourceTransition(b, id, 'REQUESTED', 'APPROVED', 'STOCK_TRANSFER_APPROVED', 'approved_by_employee_id', 'approved_at', a);

function actionMap(actionItems) { return new Map(actionItems.map((item) => [item.stockTransferItemId, item])); }
function validateActionItems(document, values, quantityField, policyMap) {
  const given = actionMap(values.items); if (given.size !== document.items.length || document.items.some((item) => !given.has(item.stockTransferItemId))) return 'incomplete_action_items';
  for (const item of document.items) { const policy = policyMap.get(item.productVariantId); if (policy?.status !== 'ACTIVE') return 'variant_inactive'; const action = given.get(item.stockTransferItemId); const ceiling = quantityField === 'quantityDispatched' ? item.quantityRequested : item.quantityDispatched; if (compareQuantities(action[quantityField], ceiling) > 0) return 'quantity_exceeds_limit'; const planned = new Map(item.lots.map((lot) => [lot.inventoryLotId, lot])); if (action.lots.some((lot) => !planned.has(lot.inventoryLotId) || compareQuantities(lot[quantityField], planned.get(lot.inventoryLotId)[quantityField === 'quantityDispatched' ? 'quantityRequested' : 'quantityDispatched']) > 0)) return 'invalid_lot_action'; const error = validateMovementPolicy({ productVariantId: item.productVariantId, quantityChange: action[quantityField], lots: action.lots.map((lot) => ({ quantityChange: lot[quantityField] })) }, policy); if (error) return error; }
  return null;
}

async function dispatchTransfer(branchId, transferId, values, auditContext) {
  const pre = await preReadTransfer(branchId, transferId); if (!pre || pre.sourceBranchId !== branchId) return { outcome: 'not_found' };
  return withInventoryTransaction(async (connection) => { const actor = await lockTransferOperationalContext(connection, branchId, [pre.sourceBranchId, pre.destinationBranchId], auditContext.actorEmployeeId); if (actor.outcome !== 'valid') return actor; const policies = await lockCatalogRoots(connection, pre.references); if (!policies && pre.references.length) return { outcome: 'concurrent_change' }; const document = await lockTransfer(connection, transferId); if (!document || document.sourceBranchId !== branchId) return { outcome: 'not_found' }; if (document.status !== 'APPROVED') return { outcome: document.status === 'IN_TRANSIT' || document.status === 'RECEIVED' ? 'already_dispatched' : 'not_approved' }; const actionError = validateActionItems(document, values, 'quantityDispatched', policies); if (actionError) return { outcome: actionError }; const globalLots = await lockGlobalLots(connection, pre.lotIds); if (globalLots.length !== pre.lotIds.length) return { outcome: 'lot_not_found' }; const lotMap = new Map(globalLots.map((lot) => [lot.inventoryLotId, lot])); if (document.items.some((item) => item.lots.some((lot) => lotMap.get(lot.inventoryLotId)?.productVariantId !== item.productVariantId))) return { outcome: 'lot_variant_mismatch' };
    const given = actionMap(values.items); const movements = document.items.map((item) => ({ productVariantId: item.productVariantId, quantityChange: negateQuantity(given.get(item.stockTransferItemId).quantityDispatched), unitCost: null, lots: given.get(item.stockTransferItemId).lots.map((lot) => ({ inventoryLotId: lot.inventoryLotId, productVariantId: item.productVariantId, quantityChange: negateQuantity(lot.quantityDispatched), unitCost: null })) })); const branchRows = await lockBranchInventory(connection, [branchId], document.items.map((item) => item.productVariantId)); const lotRows = await lockBranchLots(connection, [branchId], pre.lotIds); const before = await selectTransfer(connection, branchId, transferId); const branchResult = await applyBranchMovements(connection, branchId, movements, branchRows); if (branchResult.outcome !== 'applied') abortOperation(branchResult.outcome); const lotResult = await applyLotMovements(connection, branchId, movements.flatMap((movement) => movement.lots), lotRows, globalLots, { outboundStrict: true }); if (lotResult.outcome !== 'applied') abortOperation(lotResult.outcome); const consistency = await assertLotConsistency(connection, branchId, policies, document.items.map((item) => item.productVariantId)); if (consistency.outcome !== 'valid') abortOperation(consistency.outcome);
    const transactionId = await createLedger(connection, { branchId, transactionType: 'TRANSFER_OUT', actorEmployeeId: auditContext.actorEmployeeId, notes: `Stock transfer ${document.transferNumber} dispatch`, movements }); for (const item of document.items) { const action = given.get(item.stockTransferItemId); await connection.execute('UPDATE stock_transfer_items SET quantity_dispatched = ? WHERE stock_transfer_item_id = ?', [action.quantityDispatched, item.stockTransferItemId]); for (const lot of action.lots) await connection.execute('UPDATE stock_transfer_item_lots SET quantity_dispatched = ? WHERE stock_transfer_item_id = ? AND inventory_lot_id = ?', [lot.quantityDispatched, item.stockTransferItemId, lot.inventoryLotId]); }
    const now = await selectUtcNow(connection); await connection.execute(`UPDATE stock_transfers SET status = 'IN_TRANSIT', dispatched_by_employee_id = ?, dispatched_at = ?, source_inventory_transaction_id = ? WHERE stock_transfer_id = ?`, [auditContext.actorEmployeeId, now, transactionId, transferId]); const detail = await selectTransfer(connection, branchId, transferId); await insertAuditLog(connection, { auditContext, branchId, actionType: 'STOCK_TRANSFER_DISPATCHED', entityType: 'stock_transfers', entityRecordId: transferId, beforeValues: snapshot(before), afterValues: snapshot(detail) }); return { outcome: 'dispatched', detail };
  });
}

async function receiveTransfer(branchId, transferId, values, auditContext) {
  const pre = await preReadTransfer(branchId, transferId); if (!pre || pre.destinationBranchId !== branchId) return { outcome: 'not_found' };
  return withInventoryTransaction(async (connection) => { const actor = await lockTransferOperationalContext(connection, branchId, [pre.sourceBranchId, pre.destinationBranchId], auditContext.actorEmployeeId); if (actor.outcome !== 'valid') return actor; const policies = await lockCatalogRoots(connection, pre.references); if (!policies && pre.references.length) return { outcome: 'concurrent_change' }; const document = await lockTransfer(connection, transferId); if (!document || document.destinationBranchId !== branchId) return { outcome: 'not_found' }; if (document.status !== 'IN_TRANSIT') return { outcome: document.status === 'RECEIVED' ? 'already_received' : 'not_in_transit' }; const actionError = validateActionItems(document, values, 'quantityReceived', policies); if (actionError) return { outcome: actionError }; const globalLots = await lockGlobalLots(connection, pre.lotIds); if (globalLots.length !== pre.lotIds.length) return { outcome: 'lot_not_found' }; const lotMap = new Map(globalLots.map((lot) => [lot.inventoryLotId, lot])); if (globalLots.some((lot) => ['RECALLED', 'CLOSED'].includes(lot.status)) || document.items.some((item) => item.lots.some((lot) => lotMap.get(lot.inventoryLotId)?.productVariantId !== item.productVariantId))) return { outcome: 'unsafe_lot' };
    const given = actionMap(values.items); const movements = document.items.map((item) => ({ productVariantId: item.productVariantId, quantityChange: given.get(item.stockTransferItemId).quantityReceived, unitCost: null, lots: given.get(item.stockTransferItemId).lots.map((lot) => ({ inventoryLotId: lot.inventoryLotId, productVariantId: item.productVariantId, quantityChange: lot.quantityReceived, unitCost: null })) })); const branchRows = await lockBranchInventory(connection, [branchId], document.items.map((item) => item.productVariantId)); const lotRows = await lockBranchLots(connection, [branchId], pre.lotIds); const before = await selectTransfer(connection, branchId, transferId); const branchResult = await applyBranchMovements(connection, branchId, movements, branchRows); if (branchResult.outcome !== 'applied') abortOperation(branchResult.outcome); const lotResult = await applyLotMovements(connection, branchId, movements.flatMap((movement) => movement.lots), lotRows, globalLots); if (lotResult.outcome !== 'applied') abortOperation(lotResult.outcome); const consistency = await assertLotConsistency(connection, branchId, policies, document.items.map((item) => item.productVariantId)); if (consistency.outcome !== 'valid') abortOperation(consistency.outcome);
    const transactionId = await createLedger(connection, { branchId, transactionType: 'TRANSFER_IN', actorEmployeeId: auditContext.actorEmployeeId, notes: `Stock transfer ${document.transferNumber} receipt`, movements }); for (const item of document.items) { const action = given.get(item.stockTransferItemId); await connection.execute('UPDATE stock_transfer_items SET quantity_received = ? WHERE stock_transfer_item_id = ?', [action.quantityReceived, item.stockTransferItemId]); for (const lot of action.lots) await connection.execute('UPDATE stock_transfer_item_lots SET quantity_received = ? WHERE stock_transfer_item_id = ? AND inventory_lot_id = ?', [lot.quantityReceived, item.stockTransferItemId, lot.inventoryLotId]); }
    const now = await selectUtcNow(connection); await connection.execute(`UPDATE stock_transfers SET status = 'RECEIVED', received_by_employee_id = ?, received_at = ?, destination_inventory_transaction_id = ? WHERE stock_transfer_id = ?`, [auditContext.actorEmployeeId, now, transactionId, transferId]); const detail = await selectTransfer(connection, branchId, transferId); await insertAuditLog(connection, { auditContext, branchId, actionType: 'STOCK_TRANSFER_RECEIVED', entityType: 'stock_transfers', entityRecordId: transferId, beforeValues: snapshot(before), afterValues: snapshot(detail) }); return { outcome: 'received', detail };
  });
}

async function cancelTransfer(branchId, transferId, auditContext) {
  const pre = await preReadTransfer(branchId, transferId); if (!pre || pre.sourceBranchId !== branchId) return { outcome: 'not_found' };
  return withInventoryTransaction(async (connection) => { const actor = await lockTransferOperationalContext(connection, branchId, [pre.sourceBranchId, pre.destinationBranchId], auditContext.actorEmployeeId); if (actor.outcome !== 'valid') return actor; const document = await lockTransfer(connection, transferId); if (!document || document.sourceBranchId !== branchId) return { outcome: 'not_found' }; if (!['DRAFT', 'REQUESTED', 'APPROVED'].includes(document.status)) return { outcome: 'not_cancellable' }; const before = await selectTransfer(connection, branchId, transferId); const now = await selectUtcNow(connection); await connection.execute(`UPDATE stock_transfers SET status = 'CANCELLED', cancelled_by_employee_id = ?, cancelled_at = ? WHERE stock_transfer_id = ?`, [auditContext.actorEmployeeId, now, transferId]); const detail = await selectTransfer(connection, branchId, transferId); await insertAuditLog(connection, { auditContext, branchId, actionType: 'STOCK_TRANSFER_CANCELLED', entityType: 'stock_transfers', entityRecordId: transferId, beforeValues: snapshot(before), afterValues: snapshot(detail) }); return { outcome: 'cancelled', detail }; });
}

const findTransfer = (branchId, transferId) => selectTransfer(pool, branchId, transferId);
export { approveTransfer, cancelTransfer, createTransfer, createTransferItem, deleteTransferItem, dispatchTransfer, findTransfer, listTransfers, receiveTransfer, requestTransfer, updateTransfer, updateTransferItem };
