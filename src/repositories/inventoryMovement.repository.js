import { insertAuditLog } from './audit.repository.js';
import {
  getLastInsertId,
  lockRowsByIds,
  uniqueSortedIds,
  withCatalogTransaction,
} from './productCatalog.repository.js';
import { generateDocumentNumber } from './purchasing.repository.js';
import {
  addQuantities,
  compareQuantities,
  isWholeQuantity,
  quantityToScaled,
} from '../utils/inventoryQuantity.js';

function key(branchId, id) {
  return `${branchId}:${id}`;
}

function abortOperation(outcome) {
  const error = new Error('Inventory operation rolled back');
  error.inventoryOperationOutcome = outcome;
  throw error;
}

async function withInventoryTransaction(work) {
  try {
    return await withCatalogTransaction(work);
  } catch (error) {
    if (error?.inventoryOperationOutcome) {
      return { outcome: error.inventoryOperationOutcome };
    }
    throw error;
  }
}

async function preReadVariants(pool, variantIds) {
  const ids = uniqueSortedIds(variantIds);
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const [rows] = await pool.execute(
    `SELECT CAST(pv.product_variant_id AS CHAR) AS productVariantId,
       CAST(pv.product_id AS CHAR) AS productId
     FROM product_variants pv
     WHERE pv.product_variant_id IN (${placeholders})
     ORDER BY pv.product_variant_id`,
    ids,
  );
  return rows;
}

async function lockCatalogRoots(connection, references) {
  const products = await lockRowsByIds(connection, {
    table: 'products', idColumn: 'product_id',
    ids: references.map((entry) => entry.productId),
    selectColumns: 'CAST(product_id AS CHAR) AS productId, status',
  });
  const variants = await lockRowsByIds(connection, {
    table: 'product_variants', idColumn: 'product_variant_id',
    ids: references.map((entry) => entry.productVariantId),
    selectColumns: `CAST(product_variant_id AS CHAR) AS productVariantId,
      CAST(product_id AS CHAR) AS productId, status,
      is_fractional AS isFractional, lot_tracking_mode AS lotTrackingMode,
      requires_expiry_date AS requiresExpiryDate`,
  });
  const variantIds = uniqueSortedIds(references.map((entry) => entry.productVariantId));
  if (variantIds.length) {
    const placeholders = variantIds.map(() => '?').join(', ');
    await connection.execute(
      `SELECT product_package_id FROM product_packages
       WHERE product_variant_id IN (${placeholders})
       ORDER BY product_variant_id, product_package_id FOR UPDATE`,
      variantIds,
    );
  }
  if (products.length !== new Set(references.map((entry) => entry.productId)).size ||
      variants.length !== variantIds.length) return null;
  const productMap = new Map(products.map((row) => [row.productId, row]));
  if (variants.some((variant) =>
    !productMap.has(variant.productId) ||
    !references.some((entry) => entry.productVariantId === variant.productVariantId &&
      entry.productId === variant.productId))) return null;
  return new Map(variants.map((variant) => [variant.productVariantId, variant]));
}

async function lockTransferOperationalContext(
  connection, operationBranchId, branchIds, actorEmployeeId,
) {
  if (!actorEmployeeId) return { outcome: 'actor_required' };
  const [employees] = await connection.execute(
    `SELECT CAST(employee_id AS CHAR) AS employeeId, employment_status AS status
     FROM employees WHERE employee_id = ? FOR UPDATE`,
    [actorEmployeeId],
  );
  if (!employees[0] || employees[0].status !== 'ACTIVE') return { outcome: 'actor_not_active' };
  const sortedBranchIds = uniqueSortedIds(branchIds);
  const placeholders = sortedBranchIds.map(() => '?').join(', ');
  const [branches] = await connection.execute(
    `SELECT CAST(branch_id AS CHAR) AS branchId, status, currency_code AS currencyCode
     FROM branches WHERE branch_id IN (${placeholders}) ORDER BY branch_id FOR UPDATE`,
    sortedBranchIds,
  );
  if (branches.length !== sortedBranchIds.length) return { outcome: 'branch_not_found' };
  if (branches.some((branch) => branch.status !== 'ACTIVE')) return { outcome: 'branch_not_active' };
  const [assignments] = await connection.execute(
    `SELECT assignment_id FROM employee_branch_assignments
     WHERE employee_id = ? AND branch_id = ?
       AND started_on <= CURRENT_DATE()
       AND (ended_on IS NULL OR ended_on >= CURRENT_DATE())
     ORDER BY assignment_id LIMIT 1 FOR UPDATE`,
    [actorEmployeeId, operationBranchId],
  );
  if (!assignments.length) return { outcome: 'actor_not_assigned' };
  return { outcome: 'valid', employee: employees[0], branches };
}

async function lockGlobalLots(connection, lotIds) {
  return lockRowsByIds(connection, {
    table: 'inventory_lots', idColumn: 'inventory_lot_id', ids: lotIds,
    selectColumns: `CAST(inventory_lot_id AS CHAR) AS inventoryLotId,
      CAST(product_variant_id AS CHAR) AS productVariantId,
      lot_number AS lotNumber, status,
      DATE_FORMAT(expires_on, '%Y-%m-%d') AS expiresOn,
      expires_on < UTC_DATE() AS isExpired`,
  });
}

async function lockBranchInventory(connection, branchIds, variantIds) {
  const result = new Map();
  const variants = uniqueSortedIds(variantIds);
  if (!variants.length) return result;
  const placeholders = variants.map(() => '?').join(', ');
  for (const branchId of uniqueSortedIds(branchIds)) {
    const [rows] = await connection.execute(
      `SELECT CAST(branch_id AS CHAR) AS branchId,
         CAST(product_variant_id AS CHAR) AS productVariantId,
         quantity_on_hand AS quantityOnHand, reorder_level AS reorderLevel,
         reorder_quantity AS reorderQuantity, version_number AS versionNumber
       FROM branch_inventory WHERE branch_id = ?
         AND product_variant_id IN (${placeholders})
       ORDER BY product_variant_id FOR UPDATE`,
      [branchId, ...variants],
    );
    rows.forEach((row) => result.set(key(branchId, row.productVariantId), row));
  }
  return result;
}

async function lockBranchLots(connection, branchIds, lotIds) {
  const result = new Map();
  const lots = uniqueSortedIds(lotIds);
  if (!lots.length) return result;
  const placeholders = lots.map(() => '?').join(', ');
  for (const branchId of uniqueSortedIds(branchIds)) {
    const [rows] = await connection.execute(
      `SELECT CAST(branch_id AS CHAR) AS branchId,
         CAST(inventory_lot_id AS CHAR) AS inventoryLotId,
         quantity_on_hand AS quantityOnHand, status,
         version_number AS versionNumber
       FROM branch_lot_inventory WHERE branch_id = ?
         AND inventory_lot_id IN (${placeholders})
       ORDER BY inventory_lot_id FOR UPDATE`,
      [branchId, ...lots],
    );
    rows.forEach((row) => result.set(key(branchId, row.inventoryLotId), row));
  }
  return result;
}

function aggregateMovements(movements, idField) {
  const result = new Map();
  for (const movement of movements) {
    const id = movement[idField];
    result.set(id, addQuantities(result.get(id) ?? '0.000', movement.quantityChange));
  }
  return result;
}

async function applyBranchMovements(connection, branchId, movements, lockedRows) {
  const totals = aggregateMovements(movements, 'productVariantId');
  for (const [variantId, quantityChange] of totals) {
    if (quantityChange === '0.000') continue;
    const row = lockedRows.get(key(branchId, variantId));
    if (!row) {
      if (compareQuantities(quantityChange, '0.000') < 0) return { outcome: 'insufficient_stock' };
      await connection.execute(
        `INSERT INTO branch_inventory (
           branch_id, product_variant_id, quantity_on_hand, version_number
         ) VALUES (?, ?, ?, 0)`,
        [branchId, variantId, quantityChange],
      );
      lockedRows.set(key(branchId, variantId), {
        branchId, productVariantId: variantId,
        quantityOnHand: quantityChange, versionNumber: 0,
      });
      continue;
    }
    const next = addQuantities(row.quantityOnHand, quantityChange);
    if (compareQuantities(next, '0.000') < 0) return { outcome: 'insufficient_stock' };
    await connection.execute(
      `UPDATE branch_inventory SET quantity_on_hand = ?,
         version_number = version_number + 1
       WHERE branch_id = ? AND product_variant_id = ?`,
      [next, branchId, variantId],
    );
    row.quantityOnHand = next;
    row.versionNumber += 1;
  }
  return { outcome: 'applied' };
}

function positiveLotStatus(globalLot, priorStatus = null) {
  if (globalLot.status === 'QUARANTINED') return 'QUARANTINED';
  if (globalLot.status !== 'ACTIVE' || Number(globalLot.isExpired) === 1) return 'BLOCKED';
  if (priorStatus === 'QUARANTINED' || priorStatus === 'BLOCKED') return priorStatus;
  return 'AVAILABLE';
}

async function applyLotMovements(
  connection, branchId, movements, lockedRows, globalLots, { outboundStrict = false } = {},
) {
  const totals = aggregateMovements(movements, 'inventoryLotId');
  const lotMap = new Map(globalLots.map((lot) => [lot.inventoryLotId, lot]));
  for (const [lotId, quantityChange] of totals) {
    if (quantityChange === '0.000') continue;
    const lot = lotMap.get(lotId);
    if (!lot) return { outcome: 'lot_not_found' };
    const row = lockedRows.get(key(branchId, lotId));
    const negative = compareQuantities(quantityChange, '0.000') < 0;
    if (negative && !row) return { outcome: 'lot_insufficient_stock' };
    if (negative && outboundStrict &&
        (row.status !== 'AVAILABLE' || lot.status !== 'ACTIVE' || Number(lot.isExpired) === 1)) {
      return { outcome: 'unsafe_lot' };
    }
    if (!negative && ['RECALLED', 'CLOSED'].includes(lot.status)) {
      return { outcome: 'unsafe_lot' };
    }
    if (!row) {
      await connection.execute(
        `INSERT INTO branch_lot_inventory (
           branch_id, inventory_lot_id, quantity_on_hand, status, version_number
         ) VALUES (?, ?, ?, ?, 0)`,
        [branchId, lotId, quantityChange, positiveLotStatus(lot)],
      );
      lockedRows.set(key(branchId, lotId), {
        branchId, inventoryLotId: lotId, quantityOnHand: quantityChange,
        status: positiveLotStatus(lot), versionNumber: 0,
      });
      continue;
    }
    const next = addQuantities(row.quantityOnHand, quantityChange);
    if (compareQuantities(next, '0.000') < 0) return { outcome: 'lot_insufficient_stock' };
    const status = next === '0.000'
      ? 'DEPLETED'
      : negative ? row.status : positiveLotStatus(lot, row.status);
    await connection.execute(
      `UPDATE branch_lot_inventory SET quantity_on_hand = ?, status = ?,
         version_number = version_number + 1
       WHERE branch_id = ? AND inventory_lot_id = ?`,
      [next, status, branchId, lotId],
    );
    row.quantityOnHand = next;
    row.status = status;
    row.versionNumber += 1;
  }
  return { outcome: 'applied' };
}

async function assertLotConsistency(connection, branchId, policies, variantIds) {
  const required = uniqueSortedIds(variantIds).filter(
    (id) => policies.get(id)?.lotTrackingMode === 'REQUIRED',
  );
  if (!required.length) return { outcome: 'valid' };
  const placeholders = required.map(() => '?').join(', ');
  const [rows] = await connection.execute(
    `SELECT CAST(bi.product_variant_id AS CHAR) AS productVariantId,
       bi.quantity_on_hand AS totalQuantity,
       COALESCE(SUM(bli.quantity_on_hand), 0.000) AS lotQuantity
     FROM branch_inventory bi
     LEFT JOIN inventory_lots il ON il.product_variant_id = bi.product_variant_id
     LEFT JOIN branch_lot_inventory bli ON bli.inventory_lot_id = il.inventory_lot_id
       AND bli.branch_id = bi.branch_id
     WHERE bi.branch_id = ? AND bi.product_variant_id IN (${placeholders})
     GROUP BY bi.product_variant_id, bi.quantity_on_hand`,
    [branchId, ...required],
  );
  return rows.length === required.length && rows.every(
    (row) => compareQuantities(row.totalQuantity, row.lotQuantity) === 0,
  ) ? { outcome: 'valid' } : { outcome: 'lot_consistency' };
}

async function createLedger(connection, {
  branchId, transactionType, actorEmployeeId, notes, movements,
}) {
  await connection.execute(
    `INSERT INTO inventory_transactions (
       branch_id, transaction_number, transaction_type, occurred_at,
       created_by_employee_id, notes
     ) VALUES (?, ?, ?, UTC_TIMESTAMP(6), ?, ?)`,
    [branchId, generateDocumentNumber('IT'), transactionType, actorEmployeeId, notes],
  );
  const inventoryTransactionId = await getLastInsertId(connection);
  let generatedLineNumber = 0;
  for (const movement of movements) {
    generatedLineNumber += 1;
    await connection.execute(
      `INSERT INTO inventory_transaction_items (
         inventory_transaction_id, line_number, product_variant_id,
         quantity_change, unit_cost
       ) VALUES (?, ?, ?, ?, ?)`,
      [inventoryTransactionId, movement.lineNumber ?? generatedLineNumber,
        movement.productVariantId,
        movement.quantityChange, movement.unitCost ?? null],
    );
    const inventoryTransactionItemId = await getLastInsertId(connection);
    for (const lot of movement.lots ?? []) {
      await connection.execute(
        `INSERT INTO inventory_transaction_lot_allocations (
           inventory_transaction_item_id, inventory_lot_id,
           product_variant_id, quantity_change, unit_cost
         ) VALUES (?, ?, ?, ?, ?)`,
        [inventoryTransactionItemId, lot.inventoryLotId,
          movement.productVariantId, lot.quantityChange, lot.unitCost ?? movement.unitCost ?? null],
      );
    }
  }
  return inventoryTransactionId;
}

function validateMovementPolicy(movement, policy) {
  if (!policy) return 'concurrent_change';
  if (!policy.isFractional && !isWholeQuantity(movement.quantityChange)) return 'fractional_quantity';
  const lots = movement.lots ?? [];
  if (!policy.isFractional && lots.some((lot) => !isWholeQuantity(lot.quantityChange))) {
    return 'fractional_quantity';
  }
  if (policy.lotTrackingMode === 'NONE' && lots.length) return 'lots_not_allowed';
  const sum = lots.reduce((total, lot) => total + quantityToScaled(lot.quantityChange), 0n);
  if (policy.lotTrackingMode === 'REQUIRED' && sum !== quantityToScaled(movement.quantityChange)) {
    return 'lots_required';
  }
  if (policy.lotTrackingMode === 'OPTIONAL' && lots.length > 0 &&
      ((sum < 0n) !== (quantityToScaled(movement.quantityChange) < 0n) ||
       (sum < 0n ? -sum : sum) > (quantityToScaled(movement.quantityChange) < 0n
         ? -quantityToScaled(movement.quantityChange) : quantityToScaled(movement.quantityChange)))) {
    return 'lot_quantity_mismatch';
  }
  return null;
}

export {
  abortOperation,
  applyBranchMovements,
  applyLotMovements,
  assertLotConsistency,
  createLedger,
  insertAuditLog,
  lockBranchInventory,
  lockBranchLots,
  lockCatalogRoots,
  lockGlobalLots,
  lockTransferOperationalContext,
  preReadVariants,
  validateMovementPolicy,
  withInventoryTransaction,
  withCatalogTransaction,
};
