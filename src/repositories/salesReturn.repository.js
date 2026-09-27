import { randomUUID } from 'node:crypto';

import pool from '../config/database.js';
import {
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
  validateMovementPolicy,
  withInventoryTransaction,
} from './inventoryMovement.repository.js';
import { countAsSafeNumber, getLastInsertId } from './productCatalog.repository.js';
import { selectUtcNow } from './purchasing.repository.js';
import { selectSale, selectSaleItems } from './sale.repository.js';
import {
  deriveBaseQuantity,
  formatScaledDecimal,
  isWholeQuantity,
  parseScaledDecimal,
} from '../utils/salesDecimal.js';
import { formatQuantity, quantityToScaled } from '../utils/inventoryQuantity.js';

const RETURN_COLUMNS = `
  CAST(sr.sales_return_id AS CHAR) AS salesReturnId,
  sr.return_number AS returnNumber,
  CAST(sr.original_sale_id AS CHAR) AS originalSaleId,
  CAST(sr.branch_id AS CHAR) AS branchId,
  CAST(sr.customer_id AS CHAR) AS customerId,
  CAST(sr.processed_by_employee_id AS CHAR) AS processedByEmployeeId,
  CAST(sr.approved_by_employee_id AS CHAR) AS approvedByEmployeeId,
  CAST(sr.cancelled_by_employee_id AS CHAR) AS cancelledByEmployeeId,
  CAST(sr.inventory_transaction_id AS CHAR) AS inventoryTransactionId,
  sr.approval_required AS approvalRequired,
  sr.status,
  DATE_FORMAT(sr.requested_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS requestedAt,
  DATE_FORMAT(sr.approved_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS approvedAt,
  DATE_FORMAT(sr.completed_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS completedAt,
  DATE_FORMAT(sr.cancelled_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS cancelledAt,
  sr.refund_total_amount AS refundTotalAmount,
  sr.notes,
  DATE_FORMAT(sr.created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS createdAt,
  DATE_FORMAT(sr.updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS updatedAt
`;

const ITEM_COLUMNS = `
  CAST(sri.sales_return_item_id AS CHAR) AS salesReturnItemId,
  CAST(sri.sales_return_id AS CHAR) AS salesReturnId,
  CAST(sri.original_sale_id AS CHAR) AS originalSaleId,
  CAST(sri.original_sale_item_id AS CHAR) AS originalSaleItemId,
  sri.line_number AS lineNumber,
  CAST(sri.product_variant_id AS CHAR) AS productVariantId,
  CAST(sri.product_package_id AS CHAR) AS productPackageId,
  CAST(sri.inventory_lot_id AS CHAR) AS inventoryLotId,
  CAST(sri.return_reason_id AS CHAR) AS returnReasonId,
  sri.item_description AS itemDescription,
  sri.sku_snapshot AS skuSnapshot,
  sri.package_name_snapshot AS packageNameSnapshot,
  sri.quantity_returned AS quantityReturned,
  sri.package_conversion_factor AS packageConversionFactor,
  sri.base_quantity_returned AS baseQuantityReturned,
  sri.item_condition AS itemCondition,
  sri.is_restockable AS isRestockable,
  sri.refund_amount AS refundAmount,
  sri.notes,
  si.unit_cost AS originalUnitCost,
  DATE_FORMAT(sri.created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS createdAt,
  DATE_FORMAT(sri.updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS updatedAt
`;

const REFUND_COLUMNS = `
  CAST(sp.sale_payment_id AS CHAR) AS salePaymentId,
  sp.payment_number AS paymentNumber,
  CAST(sp.sale_id AS CHAR) AS saleId,
  CAST(sp.sales_return_id AS CHAR) AS salesReturnId,
  CAST(sp.payment_method_id AS CHAR) AS paymentMethodId,
  CAST(sp.processed_by_employee_id AS CHAR) AS processedByEmployeeId,
  sp.payment_type AS paymentType,
  sp.status,
  sp.amount,
  sp.currency_code AS currencyCode,
  sp.external_reference AS externalReference,
  DATE_FORMAT(sp.paid_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS paidAt,
  sp.notes,
  DATE_FORMAT(sp.created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS createdAt,
  DATE_FORMAT(sp.updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS updatedAt
`;

function generateReturnNumber() {
  return `RET-${randomUUID().replaceAll('-', '').toUpperCase()}`;
}

function isReturnNumberCollision(error) {
  return (error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062) &&
    `${error?.message ?? ''} ${error?.sqlMessage ?? ''}`.includes(
      'uq_sales_returns_number',
    );
}

function normalizeReturn(row) {
  return row ? { ...row, approvalRequired: Boolean(Number(row.approvalRequired)) } : null;
}

function normalizeItem(row) {
  return row ? { ...row, isRestockable: Boolean(Number(row.isRestockable)) } : null;
}

function returnSnapshot(value) {
  return {
    salesReturnId: value.salesReturnId,
    returnNumber: value.returnNumber,
    originalSaleId: value.originalSaleId,
    branchId: value.branchId,
    customerId: value.customerId,
    processedByEmployeeId: value.processedByEmployeeId,
    approvedByEmployeeId: value.approvedByEmployeeId,
    cancelledByEmployeeId: value.cancelledByEmployeeId,
    inventoryTransactionId: value.inventoryTransactionId,
    approvalRequired: value.approvalRequired,
    status: value.status,
    requestedAt: value.requestedAt,
    approvedAt: value.approvedAt,
    completedAt: value.completedAt,
    cancelledAt: value.cancelledAt,
    refundTotalAmount: value.refundTotalAmount,
    notes: value.notes,
  };
}

function itemSnapshot(value) {
  return {
    salesReturnItemId: value.salesReturnItemId,
    salesReturnId: value.salesReturnId,
    originalSaleItemId: value.originalSaleItemId,
    lineNumber: value.lineNumber,
    productVariantId: value.productVariantId,
    productPackageId: value.productPackageId,
    inventoryLotId: value.inventoryLotId,
    returnReasonId: value.returnReasonId,
    itemDescription: value.itemDescription,
    skuSnapshot: value.skuSnapshot,
    packageNameSnapshot: value.packageNameSnapshot,
    quantityReturned: value.quantityReturned,
    packageConversionFactor: value.packageConversionFactor,
    baseQuantityReturned: value.baseQuantityReturned,
    itemCondition: value.itemCondition,
    isRestockable: value.isRestockable,
    refundAmount: value.refundAmount,
    originalUnitCost: value.originalUnitCost,
    notes: value.notes,
  };
}

function refundSummary(rows, returnTotal) {
  let completed = 0n;
  let pending = 0n;
  for (const row of rows) {
    if (row.paymentType !== 'REFUND') continue;
    const amount = parseScaledDecimal(row.amount, 2);
    if (row.status === 'COMPLETED') completed += amount;
    if (row.status === 'PENDING') pending += amount;
  }
  const total = parseScaledDecimal(returnTotal, 2);
  const active = completed + pending;
  return {
    returnTotal: formatScaledDecimal(total, 2),
    completedRefundAmount: formatScaledDecimal(completed, 2),
    pendingRefundAmount: formatScaledDecimal(pending, 2),
    activeRefundAmount: formatScaledDecimal(active, 2),
    outstandingRefundAmount: formatScaledDecimal(total - completed, 2),
    isFullyRefunded: completed === total,
  };
}

async function selectSalesReturn(
  executor,
  branchId,
  saleId,
  salesReturnId,
  { forUpdate = false } = {},
) {
  const [rows] = await executor.execute(
    `SELECT ${RETURN_COLUMNS}
     FROM sales_returns sr
     WHERE sr.branch_id = ? AND sr.original_sale_id = ?
       AND sr.sales_return_id = ?
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [branchId, saleId, salesReturnId],
  );
  return normalizeReturn(rows[0] ?? null);
}

async function selectReturnItems(executor, salesReturnId, { forUpdate = false } = {}) {
  const [rows] = await executor.execute(
    `SELECT ${ITEM_COLUMNS}
     FROM sales_return_items sri
     LEFT JOIN sale_items si ON si.sale_item_id = sri.original_sale_item_id
     WHERE sri.sales_return_id = ?
     ORDER BY sri.line_number, sri.sales_return_item_id${forUpdate ? ' FOR UPDATE' : ''}`,
    [salesReturnId],
  );
  return rows.map(normalizeItem);
}

async function selectReturnRefunds(executor, saleId, salesReturnId, { forUpdate = false } = {}) {
  const [rows] = await executor.execute(
    `SELECT ${REFUND_COLUMNS}
     FROM sale_payments sp
     WHERE sp.sale_id = ? AND sp.sales_return_id = ?
       AND sp.payment_type = 'REFUND'
     ORDER BY sp.created_at, sp.sale_payment_id${forUpdate ? ' FOR UPDATE' : ''}`,
    [saleId, salesReturnId],
  );
  return rows;
}

async function selectReturnDetail(executor, branchId, saleId, salesReturnId) {
  const salesReturn = await selectSalesReturn(
    executor, branchId, saleId, salesReturnId,
  );
  if (!salesReturn) return null;
  const [items, refunds] = await Promise.all([
    selectReturnItems(executor, salesReturnId),
    selectReturnRefunds(executor, saleId, salesReturnId),
  ]);
  return {
    ...salesReturn,
    items,
    refunds,
    refundSummary: refundSummary(refunds, salesReturn.refundTotalAmount),
  };
}

function addDateRange(predicates, parameters, { from, to }) {
  if (from) {
    predicates.push('sr.created_at >= ?');
    parameters.push(`${from} 00:00:00`);
  }
  if (to) {
    if (to === '9999-12-31') {
      predicates.push('sr.created_at <= ?');
      parameters.push('9999-12-31 23:59:59.999999');
    } else {
      predicates.push('sr.created_at < DATE_ADD(?, INTERVAL 1 DAY)');
      parameters.push(`${to} 00:00:00`);
    }
  }
}

async function listSalesReturnRecords(branchId, saleId, filters) {
  const sale = await selectSale(pool, branchId, saleId);
  if (!sale) return { outcome: 'sale_not_found' };
  const predicates = ['sr.branch_id = ?', 'sr.original_sale_id = ?'];
  const parameters = [branchId, saleId];
  if (filters.status !== null) {
    predicates.push('sr.status = ?');
    parameters.push(filters.status);
  }
  addDateRange(predicates, parameters, filters);
  const where = `WHERE ${predicates.join(' AND ')}`;
  const [countRows] = await pool.execute(
    `SELECT CAST(COUNT(*) AS CHAR) AS totalItems FROM sales_returns sr ${where}`,
    parameters,
  );
  const [rows] = await pool.execute(
    `SELECT ${RETURN_COLUMNS}
     FROM sales_returns sr ${where}
     ORDER BY sr.created_at DESC, sr.sales_return_id DESC
     LIMIT ? OFFSET ?`,
    [...parameters, filters.limit, filters.offset],
  );
  return {
    outcome: 'found',
    items: rows.map(normalizeReturn),
    totalItems: countAsSafeNumber(countRows[0].totalItems, 'sales return'),
  };
}

async function findSalesReturn(branchId, saleId, salesReturnId) {
  const sale = await selectSale(pool, branchId, saleId);
  if (!sale) return { outcome: 'sale_not_found' };
  const detail = await selectReturnDetail(pool, branchId, saleId, salesReturnId);
  return detail ? { outcome: 'found', salesReturn: detail } : { outcome: 'return_not_found' };
}

async function preReadReturnVariants(branchId, saleId, salesReturnId) {
  const [rows] = await pool.execute(
    `SELECT DISTINCT CAST(pv.product_variant_id AS CHAR) AS productVariantId,
       CAST(pv.product_id AS CHAR) AS productId
     FROM sales_return_items sri
     JOIN sales_returns sr ON sr.sales_return_id = sri.sales_return_id
     JOIN product_variants pv ON pv.product_variant_id = sri.product_variant_id
     WHERE sr.branch_id = ? AND sr.original_sale_id = ?
       AND sr.sales_return_id = ?
     ORDER BY productVariantId`,
    [branchId, saleId, salesReturnId],
  );
  return rows;
}

async function lockReturnFamily(connection, branchId, saleId) {
  const sale = await selectSale(connection, branchId, saleId, { forUpdate: true });
  if (!sale) return { outcome: 'sale_not_found' };
  const saleItems = await selectSaleItems(connection, saleId, { forUpdate: true });
  const saleItemIds = saleItems.map((item) => item.saleItemId);
  let saleItemLots = [];
  if (saleItemIds.length) {
    const placeholders = saleItemIds.map(() => '?').join(', ');
    [saleItemLots] = await connection.execute(
      `SELECT CAST(sil.sale_item_lot_id AS CHAR) AS saleItemLotId,
         CAST(sil.sale_item_id AS CHAR) AS saleItemId,
         CAST(sil.inventory_lot_id AS CHAR) AS inventoryLotId,
         CAST(sil.product_variant_id AS CHAR) AS productVariantId,
         sil.base_quantity_allocated AS baseQuantityAllocated
       FROM sale_item_lots sil
       WHERE sil.sale_item_id IN (${placeholders})
       ORDER BY sil.sale_item_id, sil.sale_item_lot_id FOR UPDATE`,
      saleItemIds,
    );
  }
  const [returnRows] = await connection.execute(
    `SELECT ${RETURN_COLUMNS}
     FROM sales_returns sr WHERE sr.original_sale_id = ?
     ORDER BY sr.sales_return_id FOR UPDATE`,
    [saleId],
  );
  const returns = returnRows.map(normalizeReturn);
  const returnIds = returns.map((row) => row.salesReturnId);
  let returnItems = [];
  if (returnIds.length) {
    const placeholders = returnIds.map(() => '?').join(', ');
    const [rows] = await connection.execute(
      `SELECT ${ITEM_COLUMNS}
       FROM sales_return_items sri
       LEFT JOIN sale_items si ON si.sale_item_id = sri.original_sale_item_id
       WHERE sri.sales_return_id IN (${placeholders})
       ORDER BY sri.sales_return_id, sri.sales_return_item_id FOR UPDATE`,
      returnIds,
    );
    returnItems = rows.map(normalizeItem);
  }
  return { outcome: 'valid', sale, saleItems, saleItemLots, returns, returnItems };
}

function findLockedReturn(family, branchId, salesReturnId) {
  const value = family.returns.find(
    (row) => row.salesReturnId === salesReturnId && row.branchId === branchId,
  );
  return value ?? null;
}

function roundHalfUp(numerator, denominator) {
  return (numerator + denominator / 2n) / denominator;
}

function allocatedRefund(original, quantity, otherItems) {
  const sold = parseScaledDecimal(original.quantity, 3);
  const requested = parseScaledDecimal(quantity, 3);
  let priorQuantity = 0n;
  let priorAmount = 0n;
  for (const item of otherItems) {
    priorQuantity += parseScaledDecimal(item.quantityReturned, 3);
    priorAmount += parseScaledDecimal(item.refundAmount, 2);
  }
  const cumulativeQuantity = priorQuantity + requested;
  if (cumulativeQuantity > sold) return { outcome: 'return_quantity_exceeded' };
  const originalTotal = parseScaledDecimal(original.lineTotal, 2);
  const target = cumulativeQuantity === sold
    ? originalTotal
    : roundHalfUp(originalTotal * cumulativeQuantity, sold);
  if (target < priorAmount) return { outcome: 'return_value_conflict' };
  return {
    outcome: 'calculated',
    refundAmount: formatScaledDecimal(target - priorAmount, 2),
  };
}

function activeOtherItems(family, originalSaleItemId, excludedId = null) {
  const activeReturnIds = new Set(
    family.returns.filter((row) => row.status !== 'CANCELLED')
      .map((row) => row.salesReturnId),
  );
  return family.returnItems.filter(
    (item) => activeReturnIds.has(item.salesReturnId) &&
      item.originalSaleItemId === originalSaleItemId &&
      item.salesReturnItemId !== excludedId,
  );
}

async function selectReturnReason(connection, returnReasonId) {
  const [rows] = await connection.execute(
    `SELECT CAST(return_reason_id AS CHAR) AS returnReasonId,
       requires_approval AS requiresApproval, is_active AS isActive
     FROM return_reasons WHERE return_reason_id = ? LIMIT 1 FOR UPDATE`,
    [returnReasonId],
  );
  return rows[0] ?? null;
}

async function recalculateReturnHeader(connection, salesReturnId) {
  const [rows] = await connection.execute(
    `SELECT COALESCE(SUM(sri.refund_amount), 0.00) AS refundTotalAmount,
       COALESCE(MAX(rr.requires_approval), 0) AS approvalRequired
     FROM sales_return_items sri
     JOIN return_reasons rr ON rr.return_reason_id = sri.return_reason_id
     WHERE sri.sales_return_id = ?`,
    [salesReturnId],
  );
  await connection.execute(
    `UPDATE sales_returns SET refund_total_amount = ?, approval_required = ?
     WHERE sales_return_id = ?`,
    [rows[0].refundTotalAmount, rows[0].approvalRequired, salesReturnId],
  );
}

async function createSalesReturnRecord(branchId, saleId, values, auditContext) {
  return withInventoryTransaction(async (connection) => {
    const context = await lockTransferOperationalContext(
      connection, branchId, [branchId], auditContext?.actorEmployeeId,
    );
    if (context.outcome !== 'valid') return context;
    const family = await lockReturnFamily(connection, branchId, saleId);
    if (family.outcome !== 'valid') return family;
    if (family.sale.status !== 'COMPLETED') return { outcome: 'sale_not_returnable' };
    const requestedAt = await selectUtcNow(connection);
    let salesReturnId = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await connection.execute(
          `INSERT INTO sales_returns (
             return_number, original_sale_id, branch_id, customer_id,
             processed_by_employee_id, status, requested_at, notes
           ) VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?)`,
          [generateReturnNumber(), saleId, branchId, family.sale.customerId,
            auditContext.actorEmployeeId, requestedAt, values.notes],
        );
        salesReturnId = await getLastInsertId(connection);
        break;
      } catch (error) {
        if (isReturnNumberCollision(error)) continue;
        throw error;
      }
    }
    if (salesReturnId === null) return { outcome: 'return_number_conflict' };
    const salesReturn = await selectSalesReturn(
      connection, branchId, saleId, salesReturnId,
    );
    await insertAuditLog(connection, {
      auditContext, branchId, actionType: 'SALES_RETURN_CREATED',
      entityType: 'sales_returns', entityRecordId: salesReturnId,
      beforeValues: null, afterValues: returnSnapshot(salesReturn),
      notes: 'Draft sales return created through the returns API.',
    });
    return { outcome: 'created', salesReturn: { ...salesReturn, items: [], refunds: [], refundSummary: refundSummary([], '0.00') } };
  });
}

async function createSalesReturnItemRecord(
  branchId, saleId, salesReturnId, values, auditContext,
) {
  return withInventoryTransaction(async (connection) => {
    const context = await lockTransferOperationalContext(
      connection, branchId, [branchId], auditContext?.actorEmployeeId,
    );
    if (context.outcome !== 'valid') return context;
    const family = await lockReturnFamily(connection, branchId, saleId);
    if (family.outcome !== 'valid') return family;
    if (family.sale.status !== 'COMPLETED') return { outcome: 'sale_not_returnable' };
    const salesReturn = findLockedReturn(family, branchId, salesReturnId);
    if (!salesReturn) return { outcome: 'return_not_found' };
    if (salesReturn.status !== 'DRAFT') return { outcome: 'return_not_editable' };
    const original = family.saleItems.find(
      (item) => item.saleItemId === values.originalSaleItemId,
    );
    if (!original) return { outcome: 'sale_item_not_found' };
    if (family.returnItems.some((item) => item.salesReturnId === salesReturnId &&
      item.originalSaleItemId === original.saleItemId)) {
      return { outcome: 'return_item_conflict' };
    }
    const [variantRows] = await connection.execute(
      `SELECT is_fractional AS isFractional
       FROM product_variants WHERE product_variant_id = ? LIMIT 1 FOR UPDATE`,
      [original.productVariantId],
    );
    if (!variantRows[0]) return { outcome: 'concurrent_change' };
    const reason = await selectReturnReason(connection, values.returnReasonId);
    if (!reason) return { outcome: 'return_reason_not_found' };
    if (!Number(reason.isActive)) return { outcome: 'return_reason_inactive' };
    const base = deriveBaseQuantity(
      values.quantityReturned, original.packageConversionFactor,
    );
    if (base.outcome !== 'calculated') return base;
    if (!Number(variantRows[0].isFractional) && !isWholeQuantity(base.baseQuantity)) {
      return { outcome: 'fractional_quantity' };
    }
    const money = allocatedRefund(
      original,
      values.quantityReturned,
      activeOtherItems(family, original.saleItemId),
    );
    if (money.outcome !== 'calculated') return money;
    const [lineRows] = await connection.execute(
      `SELECT COALESCE(MAX(line_number), 0) AS maximumLine
       FROM sales_return_items WHERE sales_return_id = ?`,
      [salesReturnId],
    );
    const lineNumber = Number(lineRows[0].maximumLine) + 1;
    if (lineNumber > 65535) return { outcome: 'line_number_overflow' };
    await connection.execute(
      `INSERT INTO sales_return_items (
         sales_return_id, original_sale_id, original_sale_item_id, line_number,
         product_variant_id, product_package_id, return_reason_id,
         item_description, sku_snapshot, package_name_snapshot,
         quantity_returned, package_conversion_factor, base_quantity_returned,
         item_condition, is_restockable, refund_amount, notes
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [salesReturnId, saleId, original.saleItemId, lineNumber,
        original.productVariantId, original.productPackageId, values.returnReasonId,
        original.itemDescription, original.skuSnapshot, original.packageNameSnapshot,
        values.quantityReturned, original.packageConversionFactor,
        base.baseQuantity, values.itemCondition, values.isRestockable ?? false,
        money.refundAmount, values.notes ?? null],
    );
    const salesReturnItemId = await getLastInsertId(connection);
    await recalculateReturnHeader(connection, salesReturnId);
    const [item] = await selectReturnItems(connection, salesReturnId);
    const created = (await selectReturnItems(connection, salesReturnId)).find(
      (row) => row.salesReturnItemId === salesReturnItemId,
    ) ?? item;
    await insertAuditLog(connection, {
      auditContext, branchId, actionType: 'SALES_RETURN_ITEM_CREATED',
      entityType: 'sales_return_items', entityRecordId: salesReturnItemId,
      beforeValues: null, afterValues: itemSnapshot(created),
      notes: 'Sales return item created from immutable sale item snapshots.',
    });
    return {
      outcome: 'created', item: created,
      salesReturn: await selectReturnDetail(connection, branchId, saleId, salesReturnId),
    };
  });
}

async function updateSalesReturnItemRecord(
  branchId, saleId, salesReturnId, salesReturnItemId, changes, auditContext,
) {
  return withInventoryTransaction(async (connection) => {
    const context = await lockTransferOperationalContext(
      connection, branchId, [branchId], auditContext?.actorEmployeeId,
    );
    if (context.outcome !== 'valid') return context;
    const family = await lockReturnFamily(connection, branchId, saleId);
    if (family.outcome !== 'valid') return family;
    const salesReturn = findLockedReturn(family, branchId, salesReturnId);
    if (!salesReturn) return { outcome: 'return_not_found' };
    if (salesReturn.status !== 'DRAFT') return { outcome: 'return_not_editable' };
    const item = family.returnItems.find(
      (row) => row.salesReturnId === salesReturnId &&
        row.salesReturnItemId === salesReturnItemId,
    );
    if (!item) return { outcome: 'return_item_not_found' };
    const original = family.saleItems.find(
      (row) => row.saleItemId === item.originalSaleItemId,
    );
    if (!original) return { outcome: 'sale_item_not_found' };
    const effective = { ...item, ...changes };
    if (effective.isRestockable && ['DAMAGED', 'EXPIRED'].includes(effective.itemCondition)) {
      return { outcome: 'invalid_restockable_condition' };
    }
    const [variantRows] = await connection.execute(
      `SELECT is_fractional AS isFractional FROM product_variants
       WHERE product_variant_id = ? LIMIT 1 FOR UPDATE`,
      [item.productVariantId],
    );
    if (!variantRows[0]) return { outcome: 'concurrent_change' };
    const reason = await selectReturnReason(connection, effective.returnReasonId);
    if (!reason) return { outcome: 'return_reason_not_found' };
    if (Object.hasOwn(changes, 'returnReasonId') && !Number(reason.isActive)) {
      return { outcome: 'return_reason_inactive' };
    }
    const base = deriveBaseQuantity(
      effective.quantityReturned, original.packageConversionFactor,
    );
    if (base.outcome !== 'calculated') return base;
    if (!Number(variantRows[0].isFractional) && !isWholeQuantity(base.baseQuantity)) {
      return { outcome: 'fractional_quantity' };
    }
    const money = allocatedRefund(
      original,
      effective.quantityReturned,
      activeOtherItems(family, original.saleItemId, salesReturnItemId),
    );
    if (money.outcome !== 'calculated') return money;
    const changed = Object.keys(changes).filter(
      (field) => item[field] !== effective[field],
    );
    if (!changed.length) return { outcome: 'unchanged', item };
    await connection.execute(
      `UPDATE sales_return_items SET return_reason_id = ?, quantity_returned = ?,
         base_quantity_returned = ?, item_condition = ?, is_restockable = ?,
         refund_amount = ?, notes = ? WHERE sales_return_item_id = ?`,
      [effective.returnReasonId, effective.quantityReturned, base.baseQuantity,
        effective.itemCondition, effective.isRestockable, money.refundAmount,
        effective.notes, salesReturnItemId],
    );
    await recalculateReturnHeader(connection, salesReturnId);
    const updated = (await selectReturnItems(connection, salesReturnId)).find(
      (row) => row.salesReturnItemId === salesReturnItemId,
    );
    await insertAuditLog(connection, {
      auditContext, branchId, actionType: 'SALES_RETURN_ITEM_UPDATED',
      entityType: 'sales_return_items', entityRecordId: salesReturnItemId,
      beforeValues: itemSnapshot(item), afterValues: itemSnapshot(updated),
      notes: 'Draft sales return item updated.',
    });
    return { outcome: 'updated', item: updated };
  });
}

async function deleteSalesReturnItemRecord(
  branchId, saleId, salesReturnId, salesReturnItemId, auditContext,
) {
  return withInventoryTransaction(async (connection) => {
    const context = await lockTransferOperationalContext(
      connection, branchId, [branchId], auditContext?.actorEmployeeId,
    );
    if (context.outcome !== 'valid') return context;
    const family = await lockReturnFamily(connection, branchId, saleId);
    if (family.outcome !== 'valid') return family;
    const salesReturn = findLockedReturn(family, branchId, salesReturnId);
    if (!salesReturn) return { outcome: 'return_not_found' };
    if (salesReturn.status !== 'DRAFT') return { outcome: 'return_not_editable' };
    const item = family.returnItems.find(
      (row) => row.salesReturnId === salesReturnId &&
        row.salesReturnItemId === salesReturnItemId,
    );
    if (!item) return { outcome: 'return_item_not_found' };
    await connection.execute(
      'DELETE FROM sales_return_items WHERE sales_return_item_id = ?',
      [salesReturnItemId],
    );
    await recalculateReturnHeader(connection, salesReturnId);
    await insertAuditLog(connection, {
      auditContext, branchId, actionType: 'SALES_RETURN_ITEM_DELETED',
      entityType: 'sales_return_items', entityRecordId: salesReturnItemId,
      beforeValues: itemSnapshot(item), afterValues: null,
      notes: 'Draft sales return item deleted.',
    });
    return { outcome: 'deleted', item };
  });
}

async function lockRefundRowsForSale(connection, saleId) {
  const [rows] = await connection.execute(
    `SELECT ${REFUND_COLUMNS} FROM sale_payments sp
     WHERE sp.sale_id = ? AND sp.payment_type = 'REFUND'
     ORDER BY sp.sale_payment_id FOR UPDATE`,
    [saleId],
  );
  return rows;
}

function validateFamilyQuantities(family) {
  const activeReturnIds = new Set(
    family.returns.filter((row) => row.status !== 'CANCELLED')
      .map((row) => row.salesReturnId),
  );
  for (const original of family.saleItems) {
    const total = family.returnItems
      .filter((item) => activeReturnIds.has(item.salesReturnId) &&
        item.originalSaleItemId === original.saleItemId)
      .reduce((sum, item) => sum + parseScaledDecimal(item.quantityReturned, 3), 0n);
    if (total > parseScaledDecimal(original.quantity, 3)) {
      return 'return_quantity_exceeded';
    }
  }
  return null;
}

async function transitionSalesReturnRecord(
  branchId, saleId, salesReturnId, action, auditContext,
) {
  return withInventoryTransaction(async (connection) => {
    const context = await lockTransferOperationalContext(
      connection, branchId, [branchId], auditContext?.actorEmployeeId,
    );
    if (context.outcome !== 'valid') return context;
    const family = await lockReturnFamily(connection, branchId, saleId);
    if (family.outcome !== 'valid') return family;
    const current = findLockedReturn(family, branchId, salesReturnId);
    if (!current) return { outcome: 'return_not_found' };
    const items = family.returnItems.filter((row) => row.salesReturnId === salesReturnId);
    if (action === 'SUBMITTED') {
      if (current.status !== 'DRAFT') return { outcome: 'return_not_submittable' };
      if (!current.approvalRequired) return { outcome: 'approval_not_required' };
      if (!items.length) return { outcome: 'return_empty' };
      await connection.execute(
        "UPDATE sales_returns SET status = 'PENDING_APPROVAL' WHERE sales_return_id = ?",
        [salesReturnId],
      );
    } else if (action === 'APPROVED') {
      if (current.status !== 'PENDING_APPROVAL') return { outcome: 'return_not_approvable' };
      if (current.processedByEmployeeId === auditContext.actorEmployeeId) {
        return { outcome: 'self_approval' };
      }
      await connection.execute(
        `UPDATE sales_returns SET status = 'APPROVED',
           approved_by_employee_id = ?, approved_at = UTC_TIMESTAMP(6)
         WHERE sales_return_id = ?`,
        [auditContext.actorEmployeeId, salesReturnId],
      );
    } else if (action === 'CANCELLED') {
      if (!['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(current.status)) {
        return { outcome: 'return_not_cancellable' };
      }
      const refunds = await lockRefundRowsForSale(connection, saleId);
      if (refunds.some((row) => row.salesReturnId === salesReturnId &&
        ['PENDING', 'COMPLETED'].includes(row.status))) {
        return { outcome: 'return_refund_active' };
      }
      await connection.execute(
        `UPDATE sales_returns SET status = 'CANCELLED',
           cancelled_by_employee_id = ?, cancelled_at = UTC_TIMESTAMP(6)
         WHERE sales_return_id = ?`,
        [auditContext.actorEmployeeId, salesReturnId],
      );
    } else {
      throw new Error(`Unsupported sales return transition: ${action}`);
    }
    const updated = await selectSalesReturn(connection, branchId, saleId, salesReturnId);
    await insertAuditLog(connection, {
      auditContext, branchId, actionType: `SALES_RETURN_${action}`,
      entityType: 'sales_returns', entityRecordId: salesReturnId,
      beforeValues: returnSnapshot(current), afterValues: returnSnapshot(updated),
      notes: `Sales return ${action.toLowerCase()} through the returns API.`,
    });
    return { outcome: action.toLowerCase(), salesReturn: updated };
  });
}

async function selectPriorLotRestoration(connection, saleId) {
  const [rows] = await connection.execute(
    `SELECT CAST(sri.original_sale_item_id AS CHAR) AS originalSaleItemId,
       CAST(itla.inventory_lot_id AS CHAR) AS inventoryLotId,
       COALESCE(SUM(itla.quantity_change), 0.000) AS quantityRestored
     FROM sales_returns sr
     JOIN sales_return_items sri ON sri.sales_return_id = sr.sales_return_id
     JOIN inventory_transaction_items iti
       ON iti.inventory_transaction_id = sr.inventory_transaction_id
      AND iti.line_number = sri.line_number
      AND iti.product_variant_id = sri.product_variant_id
     JOIN inventory_transaction_lot_allocations itla
       ON itla.inventory_transaction_item_id = iti.inventory_transaction_item_id
      AND itla.product_variant_id = sri.product_variant_id
     WHERE sr.original_sale_id = ? AND sr.status = 'COMPLETED'
     GROUP BY sri.original_sale_item_id, itla.inventory_lot_id
     ORDER BY sri.original_sale_item_id, itla.inventory_lot_id FOR UPDATE`,
    [saleId],
  );
  return new Map(rows.map((row) => [
    `${row.originalSaleItemId}:${row.inventoryLotId}`,
    quantityToScaled(row.quantityRestored),
  ]));
}

function allocateOriginalLots(item, originalLots, prior, policy) {
  let remaining = quantityToScaled(item.baseQuantityReturned);
  const lots = [];
  for (const source of originalLots) {
    if (remaining === 0n) break;
    const cap = quantityToScaled(source.baseQuantityAllocated) -
      (prior.get(`${item.originalSaleItemId}:${source.inventoryLotId}`) ?? 0n);
    if (cap < 0n) return { outcome: 'lot_provenance_conflict' };
    const used = cap < remaining ? cap : remaining;
    if (used > 0n) {
      lots.push({
        inventoryLotId: source.inventoryLotId,
        quantityChange: formatQuantity(used),
        unitCost: item.originalUnitCost,
      });
      remaining -= used;
    }
  }
  if (policy.lotTrackingMode === 'REQUIRED' && remaining !== 0n) {
    return { outcome: 'lot_provenance_conflict' };
  }
  if (policy.lotTrackingMode === 'NONE' && lots.length) {
    return { outcome: 'lot_provenance_conflict' };
  }
  return { outcome: 'allocated', lots };
}

async function completeSalesReturnRecord(
  branchId, saleId, salesReturnId, auditContext,
) {
  const references = await preReadReturnVariants(branchId, saleId, salesReturnId);
  return withInventoryTransaction(async (connection) => {
    const context = await lockTransferOperationalContext(
      connection, branchId, [branchId], auditContext?.actorEmployeeId,
    );
    if (context.outcome !== 'valid') return context;
    const policies = await lockCatalogRoots(connection, references);
    if (!policies && references.length) return { outcome: 'concurrent_change' };
    const family = await lockReturnFamily(connection, branchId, saleId);
    if (family.outcome !== 'valid') return family;
    if (family.sale.status !== 'COMPLETED') return { outcome: 'sale_not_returnable' };
    const current = findLockedReturn(family, branchId, salesReturnId);
    if (!current) return { outcome: 'return_not_found' };
    const canComplete = current.status === 'APPROVED' ||
      (current.status === 'DRAFT' && !current.approvalRequired);
    if (!canComplete) return { outcome: 'return_not_completable' };
    const items = family.returnItems.filter((row) => row.salesReturnId === salesReturnId);
    if (!items.length) return { outcome: 'return_empty' };
    const quantityError = validateFamilyQuantities(family);
    if (quantityError) return { outcome: quantityError };
    if (items.some((item) => item.originalUnitCost === null)) {
      return { outcome: 'original_cost_missing' };
    }
    const prior = await selectPriorLotRestoration(connection, saleId);
    const movements = [];
    for (const item of items.filter((row) => row.isRestockable)) {
      const policy = policies.get(item.productVariantId);
      if (!policy) return { outcome: 'concurrent_change' };
      const originalLots = family.saleItemLots.filter(
        (lot) => lot.saleItemId === item.originalSaleItemId,
      );
      const allocation = allocateOriginalLots(item, originalLots, prior, policy);
      if (allocation.outcome !== 'allocated') return allocation;
      const movement = {
        lineNumber: item.lineNumber,
        productVariantId: item.productVariantId,
        quantityChange: item.baseQuantityReturned,
        unitCost: item.originalUnitCost,
        lots: allocation.lots,
      };
      const policyError = validateMovementPolicy(movement, policy);
      if (policyError) return { outcome: policyError };
      movements.push(movement);
    }
    const lotIds = movements.flatMap((movement) =>
      movement.lots.map((lot) => lot.inventoryLotId));
    const globalLots = await lockGlobalLots(connection, lotIds);
    if (globalLots.length !== new Set(lotIds).size) return { outcome: 'lot_not_found' };
    const globalMap = new Map(globalLots.map((lot) => [lot.inventoryLotId, lot]));
    if (movements.some((movement) => movement.lots.some((lot) =>
      globalMap.get(lot.inventoryLotId)?.productVariantId !== movement.productVariantId))) {
      return { outcome: 'lot_provenance_conflict' };
    }
    const branchInventory = await lockBranchInventory(
      connection, [branchId], movements.map((movement) => movement.productVariantId),
    );
    const branchLots = await lockBranchLots(connection, [branchId], lotIds);
    const inventory = await applyBranchMovements(
      connection, branchId, movements, branchInventory,
    );
    if (inventory.outcome !== 'applied') abortOperation(inventory.outcome);
    const lots = await applyLotMovements(
      connection, branchId,
      movements.flatMap((movement) => movement.lots.map((lot) => ({
        productVariantId: movement.productVariantId,
        inventoryLotId: lot.inventoryLotId,
        quantityChange: lot.quantityChange,
      }))),
      branchLots, globalLots,
    );
    if (lots.outcome !== 'applied') abortOperation(lots.outcome);
    const consistency = await assertLotConsistency(
      connection, branchId, policies,
      movements.map((movement) => movement.productVariantId),
    );
    if (consistency.outcome !== 'valid') abortOperation(consistency.outcome);
    let inventoryTransactionId = null;
    if (movements.length) {
      inventoryTransactionId = await createLedger(connection, {
        branchId, transactionType: 'CUSTOMER_RETURN',
        actorEmployeeId: auditContext.actorEmployeeId,
        notes: `Stock restored by sales return ${current.returnNumber}.`,
        movements,
      });
    }
    for (const item of items) {
      const movement = movements.find((row) => row.lineNumber === item.lineNumber);
      const singleLot = movement?.lots.length === 1 &&
        movement.lots[0].quantityChange === movement.quantityChange
        ? movement.lots[0].inventoryLotId
        : null;
      await connection.execute(
        'UPDATE sales_return_items SET inventory_lot_id = ? WHERE sales_return_item_id = ?',
        [singleLot, item.salesReturnItemId],
      );
    }
    await connection.execute(
      `UPDATE sales_returns SET status = 'COMPLETED', completed_at = UTC_TIMESTAMP(6),
         inventory_transaction_id = ? WHERE sales_return_id = ?`,
      [inventoryTransactionId, salesReturnId],
    );
    const updated = await selectSalesReturn(connection, branchId, saleId, salesReturnId);
    await insertAuditLog(connection, {
      auditContext, branchId, actionType: 'SALES_RETURN_COMPLETED',
      entityType: 'sales_returns', entityRecordId: salesReturnId,
      beforeValues: returnSnapshot(current), afterValues: returnSnapshot(updated),
      notes: 'Sales return completed with atomic inventory restoration.',
    });
    return {
      outcome: 'completed',
      salesReturn: await selectReturnDetail(connection, branchId, saleId, salesReturnId),
    };
  });
}

export {
  REFUND_COLUMNS,
  findSalesReturn,
  createSalesReturnItemRecord,
  createSalesReturnRecord,
  deleteSalesReturnItemRecord,
  listSalesReturnRecords,
  lockRefundRowsForSale,
  lockReturnFamily,
  normalizeReturn,
  refundSummary,
  selectReturnDetail,
  selectReturnRefunds,
  selectSalesReturn,
  transitionSalesReturnRecord,
  completeSalesReturnRecord,
  updateSalesReturnItemRecord,
};
