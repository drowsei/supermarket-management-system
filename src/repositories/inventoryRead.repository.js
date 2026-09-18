import pool from '../config/database.js';
import { countAsSafeNumber } from './productCatalog.repository.js';

function scaledQuantity(value) {
  const match = /^(-?)(\d+)(?:\.(\d{1,3}))?$/.exec(value);
  if (!match) throw new Error('Inventory query returned an invalid quantity');
  const magnitude = BigInt(`${match[2]}${(match[3] ?? '').padEnd(3, '0')}`);
  return match[1] === '-' ? -magnitude : magnitude;
}

function formatQuantity(value) {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(4, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -3)}.${digits.slice(-3)}`;
}

function stockStatus(quantity, level) {
  const onHand = scaledQuantity(quantity);
  if (onHand < 0n) return 'INCONSISTENT';
  if (onHand === 0n) return 'OUT_OF_STOCK';
  const threshold = scaledQuantity(level);
  return threshold > 0n && onHand <= threshold ? 'LOW_STOCK' : 'IN_STOCK';
}

function inventoryConsistency(quantity, tracked, mode) {
  const total = scaledQuantity(quantity);
  const lotTotal = scaledQuantity(tracked);
  const issues = [];
  if (total < 0n) issues.push('NEGATIVE_ON_HAND');
  if (lotTotal < 0n) issues.push('NEGATIVE_TRACKED_LOT_QUANTITY');
  if (lotTotal > total) issues.push('LOT_QUANTITY_EXCEEDS_ON_HAND');
  if (mode === 'NONE' && lotTotal !== 0n) issues.push('UNEXPECTED_LOT_QUANTITY');
  if (mode === 'REQUIRED' && lotTotal !== total) issues.push('REQUIRED_LOT_QUANTITY_MISMATCH');
  return {
    status: issues.length ? 'WARNING' : 'OK',
    trackedLotQuantity: tracked,
    untrackedQuantity: formatQuantity(total - lotTotal),
    issues,
  };
}

const LOT_TOTALS = `
  LEFT JOIN (
    SELECT bli.branch_id, il.product_variant_id,
      SUM(bli.quantity_on_hand) AS tracked_lot_quantity
    FROM branch_lot_inventory bli
    INNER JOIN inventory_lots il ON il.inventory_lot_id = bli.inventory_lot_id
    WHERE bli.branch_id = ?
    GROUP BY bli.branch_id, il.product_variant_id
  ) lot_totals ON lot_totals.branch_id = bi.branch_id
    AND lot_totals.product_variant_id = bi.product_variant_id`;

const INVENTORY_BASE_FROM = `
  FROM branch_inventory bi
  INNER JOIN product_variants pv ON pv.product_variant_id = bi.product_variant_id
  INNER JOIN products p ON p.product_id = pv.product_id
  INNER JOIN units_of_measure u ON u.unit_of_measure_id = pv.unit_of_measure_id`;

const INVENTORY_FROM = `${INVENTORY_BASE_FROM} ${LOT_TOTALS}`;

const INVENTORY_COLUMNS = `
  CAST(bi.branch_id AS CHAR) AS branchId,
  CAST(bi.product_variant_id AS CHAR) AS productVariantId,
  CAST(p.category_id AS CHAR) AS categoryId,
  CAST(p.brand_id AS CHAR) AS brandId,
  p.product_code AS productCode, p.product_name AS productName,
  pv.sku, pv.variant_name AS variantName,
  pv.lot_tracking_mode AS lotTrackingMode,
  pv.requires_expiry_date AS requiresExpiryDate,
  pv.is_fractional AS isFractional,
  u.unit_code AS unitCode, u.unit_name AS unitName, u.symbol AS unitSymbol,
  bi.quantity_on_hand AS quantityOnHand,
  bi.reorder_level AS reorderLevel,
  bi.reorder_quantity AS reorderQuantity,
  COALESCE(lot_totals.tracked_lot_quantity, 0.000) AS trackedLotQuantity,
  bi.version_number AS versionNumber,
  DATE_FORMAT(bi.last_counted_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS lastCountedAt,
  DATE_FORMAT(bi.created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS createdAt,
  DATE_FORMAT(bi.updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS updatedAt`;

function normalizeInventory(row) {
  const consistency = inventoryConsistency(
    row.quantityOnHand, row.trackedLotQuantity, row.lotTrackingMode,
  );
  return {
    ...row,
    requiresExpiryDate: Boolean(row.requiresExpiryDate),
    isFractional: Boolean(row.isFractional),
    stockStatus: stockStatus(row.quantityOnHand, row.reorderLevel),
    untrackedQuantity: consistency.untrackedQuantity,
    consistency,
  };
}

function inventoryFilters(branchId, filters) {
  const predicates = ['bi.branch_id = ?'];
  const params = [branchId];
  if (filters.search) {
    predicates.push(`(
      LOCATE(?, pv.sku) > 0 OR LOCATE(?, p.product_code) > 0
      OR LOCATE(?, p.product_name) > 0 OR LOCATE(?, pv.variant_name) > 0
    )`);
    params.push(...Array(4).fill(filters.search));
  }
  if (filters.productVariantId) {
    predicates.push('bi.product_variant_id = ?');
    params.push(filters.productVariantId);
  }
  if (filters.categoryId) {
    predicates.push('p.category_id = ?');
    params.push(filters.categoryId);
  }
  if (filters.brandId) {
    predicates.push('p.brand_id = ?');
    params.push(filters.brandId);
  }
  if (filters.lotTrackingMode) {
    predicates.push('pv.lot_tracking_mode = ?');
    params.push(filters.lotTrackingMode);
  }
  if (filters.stockStatus === 'OUT_OF_STOCK') {
    predicates.push('bi.quantity_on_hand = 0.000');
  } else if (filters.stockStatus === 'LOW_STOCK') {
    predicates.push(`bi.quantity_on_hand > 0.000 AND bi.reorder_level > 0.000
      AND bi.quantity_on_hand <= bi.reorder_level`);
  } else if (filters.stockStatus === 'IN_STOCK') {
    predicates.push(`bi.quantity_on_hand > 0.000 AND
      (bi.reorder_level = 0.000 OR bi.quantity_on_hand > bi.reorder_level)`);
  }
  return { where: `WHERE ${predicates.join(' AND ')}`, params };
}

async function listInventory(branchId, filters) {
  const { where, params } = inventoryFilters(branchId, filters);
  const [countRows] = await pool.execute(
    `SELECT CAST(COUNT(*) AS CHAR) AS totalItems ${INVENTORY_BASE_FROM} ${where}`,
    params,
  );
  const [rows] = await pool.execute(
    `SELECT ${INVENTORY_COLUMNS} ${INVENTORY_FROM} ${where}
     ORDER BY bi.product_variant_id LIMIT ? OFFSET ?`,
    [branchId, ...params, filters.limit, filters.offset],
  );
  return {
    items: rows.map(normalizeInventory),
    totalItems: countAsSafeNumber(countRows[0].totalItems, 'inventory'),
  };
}

async function selectInventory(executor, branchId, variantId) {
  const [rows] = await executor.execute(
    `SELECT ${INVENTORY_COLUMNS} ${INVENTORY_FROM}
     WHERE bi.branch_id = ? AND bi.product_variant_id = ? LIMIT 1`,
    [branchId, branchId, variantId],
  );
  return rows[0] ? normalizeInventory(rows[0]) : null;
}

const LOT_FROM = `
  FROM branch_lot_inventory bli
  INNER JOIN inventory_lots il ON il.inventory_lot_id = bli.inventory_lot_id
  INNER JOIN product_variants pv ON pv.product_variant_id = il.product_variant_id
  INNER JOIN products p ON p.product_id = pv.product_id`;

const LOT_COLUMNS = `
  CAST(bli.branch_id AS CHAR) AS branchId,
  CAST(il.inventory_lot_id AS CHAR) AS inventoryLotId,
  CAST(il.product_variant_id AS CHAR) AS productVariantId,
  il.lot_number AS lotNumber,
  DATE_FORMAT(il.manufactured_on, '%Y-%m-%d') AS manufacturedOn,
  DATE_FORMAT(il.expires_on, '%Y-%m-%d') AS expiresOn,
  il.status AS lotStatus,
  bli.status AS branchLotStatus,
  bli.quantity_on_hand AS quantityOnHand,
  bli.version_number AS versionNumber,
  pv.sku, pv.variant_name AS variantName,
  pv.lot_tracking_mode AS lotTrackingMode,
  p.product_code AS productCode, p.product_name AS productName,
  CASE WHEN il.expires_on IS NULL THEN 'NO_EXPIRY'
       WHEN il.expires_on < UTC_DATE() THEN 'EXPIRED'
       ELSE 'VALID' END AS expiryState,
  DATE_FORMAT(bli.created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS createdAt,
  DATE_FORMAT(bli.updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS updatedAt`;

function normalizeLot(row) {
  const issues = [];
  if (scaledQuantity(row.quantityOnHand) < 0n) issues.push('NEGATIVE_LOT_QUANTITY');
  if (row.branchLotStatus === 'DEPLETED' && scaledQuantity(row.quantityOnHand) !== 0n) {
    issues.push('DEPLETED_WITH_STOCK');
  }
  if (row.branchLotStatus === 'AVAILABLE' &&
      (scaledQuantity(row.quantityOnHand) === 0n ||
       row.lotStatus !== 'ACTIVE' || row.expiryState === 'EXPIRED')) {
    issues.push('UNSAFE_AVAILABLE_STATE');
  }
  return { ...row, consistency: { status: issues.length ? 'WARNING' : 'OK', issues } };
}

function lotFilters(branchId, filters) {
  const predicates = ['bli.branch_id = ?'];
  const params = [branchId];
  if (filters.search) {
    predicates.push(`(
      LOCATE(?, il.lot_number) > 0 OR LOCATE(?, pv.sku) > 0
      OR LOCATE(?, p.product_name) > 0 OR LOCATE(?, pv.variant_name) > 0
    )`);
    params.push(...Array(4).fill(filters.search));
  }
  if (filters.productVariantId) {
    predicates.push('il.product_variant_id = ?');
    params.push(filters.productVariantId);
  }
  if (filters.branchLotStatus) {
    predicates.push('bli.status = ?');
    params.push(filters.branchLotStatus);
  }
  if (filters.lotStatus) {
    predicates.push('il.status = ?');
    params.push(filters.lotStatus);
  }
  if (filters.expiresBefore) {
    predicates.push('il.expires_on <= ?');
    params.push(filters.expiresBefore);
  }
  if (filters.expiresAfter) {
    predicates.push('il.expires_on >= ?');
    params.push(filters.expiresAfter);
  }
  return { where: `WHERE ${predicates.join(' AND ')}`, params };
}

async function listLots(branchId, filters) {
  const { where, params } = lotFilters(branchId, filters);
  const [countRows] = await pool.execute(
    `SELECT CAST(COUNT(*) AS CHAR) AS totalItems ${LOT_FROM} ${where}`,
    params,
  );
  const [rows] = await pool.execute(
    `SELECT ${LOT_COLUMNS} ${LOT_FROM} ${where}
     ORDER BY il.expires_on IS NULL, il.expires_on, il.inventory_lot_id
     LIMIT ? OFFSET ?`,
    [...params, filters.limit, filters.offset],
  );
  return {
    items: rows.map(normalizeLot),
    totalItems: countAsSafeNumber(countRows[0].totalItems, 'branch lot'),
  };
}

async function selectLot(executor, branchId, lotId) {
  const [rows] = await executor.execute(
    `SELECT ${LOT_COLUMNS} ${LOT_FROM}
     WHERE bli.branch_id = ? AND bli.inventory_lot_id = ? LIMIT 1`,
    [branchId, lotId],
  );
  return rows[0] ? normalizeLot(rows[0]) : null;
}

async function listVariantLots(branchId, variantId) {
  const [rows] = await pool.execute(
    `SELECT ${LOT_COLUMNS} ${LOT_FROM}
     WHERE bli.branch_id = ? AND il.product_variant_id = ?
     ORDER BY il.expires_on IS NULL, il.expires_on, il.inventory_lot_id`,
    [branchId, variantId],
  );
  return rows.map(normalizeLot);
}

async function listLotTransactions(branchId, lotId) {
  const [rows] = await pool.execute(
    `SELECT CAST(it.inventory_transaction_id AS CHAR) AS inventoryTransactionId,
       it.transaction_number AS transactionNumber,
       it.transaction_type AS transactionType,
       DATE_FORMAT(it.occurred_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS occurredAt,
       CAST(itla.inventory_transaction_lot_allocation_id AS CHAR) AS allocationId,
       itla.quantity_change AS quantityChange,
       itla.unit_cost AS unitCost
     FROM inventory_transaction_lot_allocations itla
     INNER JOIN inventory_transaction_items iti
       ON iti.inventory_transaction_item_id = itla.inventory_transaction_item_id
     INNER JOIN inventory_transactions it
       ON it.inventory_transaction_id = iti.inventory_transaction_id
     WHERE it.branch_id = ? AND itla.inventory_lot_id = ?
     ORDER BY it.occurred_at DESC, it.inventory_transaction_id DESC,
       itla.inventory_transaction_lot_allocation_id DESC LIMIT 10`,
    [branchId, lotId],
  );
  return rows;
}

const TRANSACTION_COLUMNS = `
  CAST(it.inventory_transaction_id AS CHAR) AS inventoryTransactionId,
  CAST(it.branch_id AS CHAR) AS branchId,
  it.transaction_number AS transactionNumber,
  it.transaction_type AS transactionType,
  CAST(it.reversal_of_transaction_id AS CHAR) AS reversalOfTransactionId,
  DATE_FORMAT(it.occurred_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS occurredAt,
  CAST(it.created_by_employee_id AS CHAR) AS createdByEmployeeId,
  it.notes,
  DATE_FORMAT(it.created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS createdAt`;

function transactionFilters(branchId, filters) {
  const predicates = ['it.branch_id = ?'];
  const params = [branchId];
  if (filters.search) {
    predicates.push('(LOCATE(?, it.transaction_number) > 0 OR LOCATE(?, it.notes) > 0)');
    params.push(filters.search, filters.search);
  }
  if (filters.transactionType) {
    predicates.push('it.transaction_type = ?');
    params.push(filters.transactionType);
  }
  if (filters.productVariantId) {
    predicates.push(`EXISTS (
      SELECT 1 FROM inventory_transaction_items iti
      WHERE iti.inventory_transaction_id = it.inventory_transaction_id
        AND iti.product_variant_id = ?
    )`);
    params.push(filters.productVariantId);
  }
  if (filters.inventoryLotId) {
    predicates.push(`EXISTS (
      SELECT 1 FROM inventory_transaction_items iti
      INNER JOIN inventory_transaction_lot_allocations itla
        ON itla.inventory_transaction_item_id = iti.inventory_transaction_item_id
      WHERE iti.inventory_transaction_id = it.inventory_transaction_id
        AND itla.inventory_lot_id = ?
    )`);
    params.push(filters.inventoryLotId);
  }
  if (filters.createdByEmployeeId) {
    predicates.push('it.created_by_employee_id = ?');
    params.push(filters.createdByEmployeeId);
  }
  if (filters.from) {
    predicates.push('it.occurred_at >= ?');
    params.push(`${filters.from} 00:00:00`);
  }
  if (filters.to) {
    if (filters.to === '9999-12-31') {
      predicates.push('it.occurred_at <= ?');
      params.push('9999-12-31 23:59:59.999999');
    } else {
      predicates.push('it.occurred_at < DATE_ADD(?, INTERVAL 1 DAY)');
      params.push(`${filters.to} 00:00:00`);
    }
  }
  return { where: `WHERE ${predicates.join(' AND ')}`, params };
}

async function listTransactions(branchId, filters) {
  const { where, params } = transactionFilters(branchId, filters);
  const [countRows] = await pool.execute(
    `SELECT CAST(COUNT(*) AS CHAR) AS totalItems
     FROM inventory_transactions it ${where}`,
    params,
  );
  const [rows] = await pool.execute(
    `SELECT ${TRANSACTION_COLUMNS}
     FROM inventory_transactions it ${where}
     ORDER BY it.occurred_at DESC, it.inventory_transaction_id DESC
     LIMIT ? OFFSET ?`,
    [...params, filters.limit, filters.offset],
  );
  return {
    items: rows,
    totalItems: countAsSafeNumber(countRows[0].totalItems, 'inventory transaction'),
  };
}

async function selectTransaction(branchId, transactionId) {
  const [headerRows] = await pool.execute(
    `SELECT ${TRANSACTION_COLUMNS} FROM inventory_transactions it
     WHERE it.branch_id = ? AND it.inventory_transaction_id = ? LIMIT 1`,
    [branchId, transactionId],
  );
  if (!headerRows[0]) return null;
  const [itemRows] = await pool.execute(
    `SELECT CAST(iti.inventory_transaction_item_id AS CHAR) AS inventoryTransactionItemId,
       CAST(iti.inventory_transaction_id AS CHAR) AS inventoryTransactionId,
       iti.line_number AS lineNumber,
       CAST(iti.product_variant_id AS CHAR) AS productVariantId,
       iti.quantity_change AS quantityChange, iti.unit_cost AS unitCost,
       pv.sku, pv.variant_name AS variantName,
       pv.lot_tracking_mode AS lotTrackingMode,
       p.product_name AS productName
     FROM inventory_transaction_items iti
     INNER JOIN product_variants pv ON pv.product_variant_id = iti.product_variant_id
     INNER JOIN products p ON p.product_id = pv.product_id
     WHERE iti.inventory_transaction_id = ?
     ORDER BY iti.line_number, iti.inventory_transaction_item_id`,
    [transactionId],
  );
  const [allocationRows] = await pool.execute(
    `SELECT CAST(itla.inventory_transaction_lot_allocation_id AS CHAR)
         AS inventoryTransactionLotAllocationId,
       CAST(itla.inventory_transaction_item_id AS CHAR) AS inventoryTransactionItemId,
       CAST(itla.inventory_lot_id AS CHAR) AS inventoryLotId,
       CAST(itla.product_variant_id AS CHAR) AS productVariantId,
       itla.quantity_change AS quantityChange, itla.unit_cost AS unitCost,
       il.lot_number AS lotNumber,
       DATE_FORMAT(il.expires_on, '%Y-%m-%d') AS expiresOn
     FROM inventory_transaction_lot_allocations itla
     INNER JOIN inventory_transaction_items iti
       ON iti.inventory_transaction_item_id = itla.inventory_transaction_item_id
     INNER JOIN inventory_lots il ON il.inventory_lot_id = itla.inventory_lot_id
     WHERE iti.inventory_transaction_id = ?
     ORDER BY itla.inventory_transaction_item_id,
       itla.inventory_transaction_lot_allocation_id`,
    [transactionId],
  );
  const byItem = new Map(itemRows.map((item) => [item.inventoryTransactionItemId, []]));
  for (const allocation of allocationRows) {
    byItem.get(allocation.inventoryTransactionItemId)?.push(allocation);
  }
  const items = itemRows.map((item) => {
    const lotAllocations = byItem.get(item.inventoryTransactionItemId);
    const issues = [];
    if (lotAllocations.length &&
        lotAllocations.reduce((total, entry) => total + scaledQuantity(entry.quantityChange), 0n)
          !== scaledQuantity(item.quantityChange)) {
      issues.push('LOT_ALLOCATION_QUANTITY_MISMATCH');
    }
    if (item.lotTrackingMode === 'NONE' && lotAllocations.length) {
      issues.push('UNEXPECTED_LOT_ALLOCATION');
    }
    if (item.lotTrackingMode === 'REQUIRED' && !lotAllocations.length) {
      issues.push('REQUIRED_LOT_ALLOCATION_MISSING');
    }
    return {
      ...item, lotAllocations,
      consistency: { status: issues.length ? 'WARNING' : 'OK', issues },
    };
  });
  return {
    inventoryTransaction: headerRows[0],
    items,
    consistency: {
      status: items.some((item) => item.consistency.status === 'WARNING') ? 'WARNING' : 'OK',
    },
  };
}

export {
  listInventory,
  listLots,
  listLotTransactions,
  listTransactions,
  listVariantLots,
  selectInventory,
  selectLot,
  selectTransaction,
};
