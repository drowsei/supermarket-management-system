import { randomUUID } from 'node:crypto';

import pool from '../config/database.js';
import { multiplyMoneyByConversion } from '../utils/exactDecimal.js';
import {
  calculateSaleHeader,
  calculateSaleLine,
  deriveBaseQuantity,
  formatScaledDecimal,
  isWholeQuantity,
  parseScaledDecimal,
  taxExclusiveUnitPrice,
} from '../utils/salesDecimal.js';
import { insertAuditLog } from './audit.repository.js';
import {
  countAsSafeNumber,
  getLastInsertId,
  lockRowsByIds,
  uniqueSortedIds,
  withCatalogTransaction,
} from './productCatalog.repository.js';
import { selectUtcNow } from './purchasing.repository.js';

const SALE_COLUMNS = `
  CAST(s.sale_id AS CHAR) AS saleId,
  s.sale_number AS saleNumber,
  CAST(s.branch_id AS CHAR) AS branchId,
  CAST(s.pos_register_id AS CHAR) AS posRegisterId,
  CAST(s.till_session_id AS CHAR) AS tillSessionId,
  CAST(s.customer_id AS CHAR) AS customerId,
  CAST(s.cashier_employee_id AS CHAR) AS cashierEmployeeId,
  CAST(s.inventory_transaction_id AS CHAR) AS inventoryTransactionId,
  CAST(s.reversal_inventory_transaction_id AS CHAR) AS reversalInventoryTransactionId,
  s.status,
  DATE_FORMAT(s.sold_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS soldAt,
  DATE_FORMAT(s.cancelled_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS cancelledAt,
  DATE_FORMAT(s.voided_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS voidedAt,
  s.currency_code AS currencyCode,
  s.subtotal_amount AS subtotalAmount,
  s.discount_amount AS discountAmount,
  s.tax_amount AS taxAmount,
  s.total_amount AS totalAmount,
  s.notes,
  DATE_FORMAT(s.created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS createdAt,
  DATE_FORMAT(s.updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS updatedAt
`;

const ITEM_COLUMNS = `
  CAST(si.sale_item_id AS CHAR) AS saleItemId,
  CAST(si.sale_id AS CHAR) AS saleId,
  si.line_number AS lineNumber,
  CAST(si.product_variant_id AS CHAR) AS productVariantId,
  CAST(si.product_package_id AS CHAR) AS productPackageId,
  CAST(si.barcode_id AS CHAR) AS barcodeId,
  si.item_description AS itemDescription,
  si.sku_snapshot AS skuSnapshot,
  si.package_name_snapshot AS packageNameSnapshot,
  si.quantity,
  si.package_conversion_factor AS packageConversionFactor,
  si.base_quantity AS baseQuantity,
  si.unit_price AS unitPrice,
  si.unit_cost AS unitCost,
  si.discount_amount AS discountAmount,
  si.tax_rate_percent AS taxRatePercent,
  si.tax_amount AS taxAmount,
  si.line_total AS lineTotal,
  DATE_FORMAT(si.created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS createdAt,
  DATE_FORMAT(si.updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS updatedAt
`;

function abortSale(outcome) {
  const error = new Error('Sales operation rolled back');
  error.salesOutcome = outcome;
  throw error;
}

async function withSalesTransaction(work) {
  try {
    return await withCatalogTransaction(work);
  } catch (error) {
    if (error?.salesOutcome) return { outcome: error.salesOutcome };
    throw error;
  }
}

function isDuplicateEntry(error) {
  return error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062;
}

function generatedNumberConflict(error, constraintName) {
  return isDuplicateEntry(error) &&
    `${error?.message ?? ''} ${error?.sqlMessage ?? ''}`.includes(constraintName);
}

function generateSaleNumber() {
  return `SALE-${randomUUID().replaceAll('-', '').toUpperCase()}`;
}

function saleSnapshot(sale) {
  return {
    saleId: sale.saleId,
    saleNumber: sale.saleNumber,
    branchId: sale.branchId,
    posRegisterId: sale.posRegisterId,
    tillSessionId: sale.tillSessionId,
    customerId: sale.customerId,
    cashierEmployeeId: sale.cashierEmployeeId,
    inventoryTransactionId: sale.inventoryTransactionId,
    reversalInventoryTransactionId: sale.reversalInventoryTransactionId,
    status: sale.status,
    soldAt: sale.soldAt,
    cancelledAt: sale.cancelledAt,
    voidedAt: sale.voidedAt,
    currencyCode: sale.currencyCode,
    subtotalAmount: sale.subtotalAmount,
    discountAmount: sale.discountAmount,
    taxAmount: sale.taxAmount,
    totalAmount: sale.totalAmount,
    notes: sale.notes,
  };
}

function saleItemSnapshot(item) {
  return {
    saleItemId: item.saleItemId,
    saleId: item.saleId,
    lineNumber: item.lineNumber,
    productVariantId: item.productVariantId,
    productPackageId: item.productPackageId,
    barcodeId: item.barcodeId,
    itemDescription: item.itemDescription,
    skuSnapshot: item.skuSnapshot,
    packageNameSnapshot: item.packageNameSnapshot,
    quantity: item.quantity,
    packageConversionFactor: item.packageConversionFactor,
    baseQuantity: item.baseQuantity,
    unitPrice: item.unitPrice,
    unitCost: item.unitCost,
    discountAmount: item.discountAmount,
    taxRatePercent: item.taxRatePercent,
    taxAmount: item.taxAmount,
    lineTotal: item.lineTotal,
  };
}

function addDateRange(predicates, parameters, column, { from, to }) {
  if (from) {
    predicates.push(`${column} >= ?`);
    parameters.push(`${from} 00:00:00`);
  }
  if (to) {
    if (to === '9999-12-31') {
      predicates.push(`${column} <= ?`);
      parameters.push('9999-12-31 23:59:59.999999');
    } else {
      predicates.push(`${column} < DATE_ADD(?, INTERVAL 1 DAY)`);
      parameters.push(`${to} 00:00:00`);
    }
  }
}

async function selectSale(executor, branchId, saleId, { forUpdate = false } = {}) {
  const [rows] = await executor.execute(
    `SELECT ${SALE_COLUMNS}
     FROM sales s
     WHERE s.branch_id = ? AND s.sale_id = ?
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [branchId, saleId],
  );
  return rows[0] ?? null;
}

async function lockSalePayments(connection, saleId) {
  const [rows] = await connection.execute(
    `SELECT CAST(sp.sale_payment_id AS CHAR) AS salePaymentId,
       CAST(sp.sale_id AS CHAR) AS saleId,
       CAST(sp.sales_return_id AS CHAR) AS salesReturnId,
       sp.payment_number AS paymentNumber,
       CAST(sp.payment_method_id AS CHAR) AS paymentMethodId,
       CAST(sp.processed_by_employee_id AS CHAR) AS processedByEmployeeId,
       sp.payment_type AS paymentType, sp.status, sp.amount,
       sp.currency_code AS currencyCode,
       sp.external_reference AS externalReference,
       DATE_FORMAT(sp.paid_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS paidAt,
       sp.notes
     FROM sale_payments sp
     WHERE sp.sale_id = ?
     ORDER BY sp.sale_payment_id
     FOR UPDATE`,
    [saleId],
  );

  return rows;
}

function analyzeSalePayments(payments, saleTotalAmount) {
  let completed = 0n;
  let pending = 0n;
  let active = 0n;
  let hasPendingPayment = false;
  let hasCompletedPayment = false;
  let hasRefund = false;

  for (const payment of payments) {
    if (payment.paymentType === 'REFUND') {
      hasRefund = true;
      continue;
    }
    if (payment.paymentType !== 'PAYMENT') continue;

    const amount = parseScaledDecimal(payment.amount, 2);
    if (payment.status === 'COMPLETED') {
      completed += amount;
      active += amount;
      hasCompletedPayment = true;
    } else if (payment.status === 'PENDING') {
      pending += amount;
      active += amount;
      hasPendingPayment = true;
    }
  }

  const total = parseScaledDecimal(saleTotalAmount, 2);
  return {
    completed,
    pending,
    active,
    total,
    hasPendingPayment,
    hasCompletedPayment,
    hasActiveTender: hasPendingPayment || hasCompletedPayment,
    hasRefund,
    summary: {
      completedPaymentAmount: formatScaledDecimal(completed, 2),
      pendingPaymentAmount: formatScaledDecimal(pending, 2),
      activePaymentAmount: formatScaledDecimal(active, 2),
      outstandingAmount: formatScaledDecimal(total - completed, 2),
      isFullyPaid: completed === total && !hasPendingPayment,
    },
  };
}

async function selectSaleItems(executor, saleId, { forUpdate = false } = {}) {
  const [rows] = await executor.execute(
    `SELECT ${ITEM_COLUMNS}
     FROM sale_items si
     WHERE si.sale_id = ?
     ORDER BY si.line_number, si.sale_item_id${forUpdate ? ' FOR UPDATE' : ''}`,
    [saleId],
  );
  return rows;
}

async function selectSaleItem(
  executor,
  saleId,
  saleItemId,
  { forUpdate = false } = {},
) {
  const [rows] = await executor.execute(
    `SELECT ${ITEM_COLUMNS}
     FROM sale_items si
     WHERE si.sale_id = ? AND si.sale_item_id = ?
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [saleId, saleItemId],
  );
  return rows[0] ?? null;
}

async function selectSaleDetail(executor, branchId, saleId) {
  const sale = await selectSale(executor, branchId, saleId);
  if (!sale) return null;
  const items = await selectSaleItems(executor, saleId);
  const itemIds = items.map((item) => item.saleItemId);
  const lotsByItem = new Map(itemIds.map((id) => [id, []]));

  if (itemIds.length > 0) {
    const placeholders = itemIds.map(() => '?').join(', ');
    const [lotRows] = await executor.execute(
      `SELECT
         CAST(sil.sale_item_lot_id AS CHAR) AS saleItemLotId,
         CAST(sil.sale_item_id AS CHAR) AS saleItemId,
         CAST(sil.inventory_lot_id AS CHAR) AS inventoryLotId,
         CAST(sil.product_variant_id AS CHAR) AS productVariantId,
         sil.base_quantity_allocated AS baseQuantityAllocated,
         DATE_FORMAT(sil.created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS createdAt,
         DATE_FORMAT(sil.updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS updatedAt
       FROM sale_item_lots sil
       WHERE sil.sale_item_id IN (${placeholders})
       ORDER BY sil.sale_item_id, sil.sale_item_lot_id`,
      itemIds,
    );
    for (const lot of lotRows) lotsByItem.get(lot.saleItemId)?.push(lot);
  }

  return {
    ...sale,
    items: items.map((item) => ({
      ...item,
      lotAllocations: lotsByItem.get(item.saleItemId) ?? [],
    })),
  };
}

async function listSales(branchId, filters) {
  const predicates = ['s.branch_id = ?'];
  const parameters = [branchId];
  if (filters.search) {
    predicates.push('LOCATE(?, s.sale_number) > 0');
    parameters.push(filters.search);
  }
  for (const [value, column] of [
    [filters.status, 's.status'],
    [filters.customerId, 's.customer_id'],
    [filters.cashierEmployeeId, 's.cashier_employee_id'],
    [filters.posRegisterId, 's.pos_register_id'],
    [filters.tillSessionId, 's.till_session_id'],
  ]) {
    if (value !== null) {
      predicates.push(`${column} = ?`);
      parameters.push(value);
    }
  }
  addDateRange(predicates, parameters, 's.created_at', filters);
  const where = `WHERE ${predicates.join(' AND ')}`;
  const [countRows] = await pool.execute(
    `SELECT CAST(COUNT(*) AS CHAR) AS totalItems FROM sales s ${where}`,
    parameters,
  );
  const [rows] = await pool.execute(
    `SELECT ${SALE_COLUMNS}
     FROM sales s ${where}
     ORDER BY s.created_at DESC, s.sale_id DESC
     LIMIT ? OFFSET ?`,
    [...parameters, filters.limit, filters.offset],
  );
  return {
    items: rows,
    totalItems: countAsSafeNumber(countRows[0].totalItems, 'sale'),
  };
}

async function findSale(branchId, saleId) {
  return selectSaleDetail(pool, branchId, saleId);
}

async function preReadTill(branchId, tillSessionId) {
  const [rows] = await pool.execute(
    `SELECT CAST(pos_register_id AS CHAR) AS posRegisterId,
       CAST(cashier_employee_id AS CHAR) AS cashierEmployeeId
     FROM till_sessions
     WHERE branch_id = ? AND till_session_id = ?
     LIMIT 1`,
    [branchId, tillSessionId],
  );
  return rows[0] ?? null;
}

async function preReadSale(branchId, saleId) {
  const [rows] = await pool.execute(
    `SELECT CAST(sale_id AS CHAR) AS saleId,
       CAST(pos_register_id AS CHAR) AS posRegisterId,
       CAST(till_session_id AS CHAR) AS tillSessionId,
       CAST(cashier_employee_id AS CHAR) AS cashierEmployeeId,
       CAST(customer_id AS CHAR) AS customerId
     FROM sales WHERE branch_id = ? AND sale_id = ? LIMIT 1`,
    [branchId, saleId],
  );
  return rows[0] ?? null;
}

async function lockSalesOperationalContext(
  connection,
  branchId,
  actorEmployeeId,
  { cashierEmployeeId = null } = {},
) {
  if (!actorEmployeeId) return { outcome: 'actor_required' };
  const ids = uniqueSortedIds([actorEmployeeId, cashierEmployeeId]);
  const employees = await lockRowsByIds(connection, {
    table: 'employees',
    idColumn: 'employee_id',
    ids,
    selectColumns:
      'CAST(employee_id AS CHAR) AS employeeId, employment_status AS employmentStatus',
  });
  const employeeMap = new Map(employees.map((row) => [row.employeeId, row]));
  const actor = employeeMap.get(actorEmployeeId);
  if (!actor || actor.employmentStatus !== 'ACTIVE') {
    return { outcome: 'actor_not_active' };
  }
  if (cashierEmployeeId) {
    const cashier = employeeMap.get(cashierEmployeeId);
    if (!cashier || cashier.employmentStatus !== 'ACTIVE') {
      return { outcome: 'cashier_not_active' };
    }
  }

  const [branchRows] = await connection.execute(
    `SELECT CAST(branch_id AS CHAR) AS branchId, status,
       currency_code AS currencyCode
     FROM branches WHERE branch_id = ? LIMIT 1 FOR UPDATE`,
    [branchId],
  );
  const branch = branchRows[0];
  if (!branch) return { outcome: 'branch_not_found' };
  if (branch.status !== 'ACTIVE') return { outcome: 'branch_not_active' };

  for (const employeeId of ids) {
    const [assignmentRows] = await connection.execute(
      `SELECT assignment_id FROM employee_branch_assignments
       WHERE employee_id = ? AND branch_id = ?
         AND started_on <= CURRENT_DATE()
         AND (ended_on IS NULL OR ended_on >= CURRENT_DATE())
       ORDER BY assignment_id LIMIT 1 FOR UPDATE`,
      [employeeId, branchId],
    );
    if (assignmentRows.length === 0) {
      return {
        outcome:
          employeeId === actorEmployeeId
            ? 'actor_not_assigned'
            : 'cashier_not_assigned',
      };
    }
  }
  return { outcome: 'valid', branch };
}

async function lockCustomer(connection, customerId) {
  if (customerId === null) return { outcome: 'valid', customer: null };
  const [rows] = await connection.execute(
    `SELECT CAST(customer_id AS CHAR) AS customerId, status
     FROM customers WHERE customer_id = ? LIMIT 1 FOR UPDATE`,
    [customerId],
  );
  if (!rows[0]) return { outcome: 'customer_not_found' };
  if (rows[0].status !== 'ACTIVE') return { outcome: 'customer_not_active' };
  return { outcome: 'valid', customer: rows[0] };
}

async function lockRegisterAndTill(
  connection,
  branchId,
  { posRegisterId, tillSessionId, cashierEmployeeId },
  { requireOpen = true, allowCancellation = false } = {},
) {
  if (!posRegisterId || !tillSessionId || !cashierEmployeeId) {
    return { outcome: 'till_not_found' };
  }
  const [registerRows] = await connection.execute(
    `SELECT CAST(pos_register_id AS CHAR) AS posRegisterId
     FROM pos_registers
     WHERE branch_id = ? AND pos_register_id = ?
     LIMIT 1 FOR UPDATE`,
    [branchId, posRegisterId],
  );
  if (!registerRows[0]) return { outcome: 'till_not_found' };
  const [tillRows] = await connection.execute(
    `SELECT CAST(till_session_id AS CHAR) AS tillSessionId,
       CAST(branch_id AS CHAR) AS branchId,
       CAST(pos_register_id AS CHAR) AS posRegisterId,
       CAST(cashier_employee_id AS CHAR) AS cashierEmployeeId,
       status, currency_code AS currencyCode
     FROM till_sessions
     WHERE till_session_id = ? AND branch_id = ?
       AND pos_register_id = ? AND cashier_employee_id = ?
     LIMIT 1 FOR UPDATE`,
    [tillSessionId, branchId, posRegisterId, cashierEmployeeId],
  );
  const till = tillRows[0];
  if (!till) return { outcome: 'till_not_found' };
  if (allowCancellation && till.status === 'CANCELLED') {
    return { outcome: 'till_cancelled' };
  }
  if (requireOpen && till.status !== 'OPEN') return { outcome: 'till_not_open' };
  return { outcome: 'valid', till };
}

async function createSale(branchId, tillSessionId, values, auditContext) {
  const preRead = await preReadTill(branchId, tillSessionId);
  if (!preRead) return { outcome: 'till_not_found' };

  return withSalesTransaction(async (connection) => {
    const context = await lockSalesOperationalContext(
      connection,
      branchId,
      auditContext?.actorEmployeeId,
      { cashierEmployeeId: preRead.cashierEmployeeId },
    );
    if (context.outcome !== 'valid') return context;

    const customer = await lockCustomer(connection, values.customerId);
    if (customer.outcome !== 'valid') return customer;

    const till = await lockRegisterAndTill(connection, branchId, {
      ...preRead,
      tillSessionId,
    });
    if (till.outcome !== 'valid') return till;
    if (till.till.currencyCode !== context.branch.currencyCode) {
      return { outcome: 'currency_mismatch' };
    }

    let saleId = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await connection.execute(
          `INSERT INTO sales (
             sale_number, branch_id, pos_register_id, till_session_id,
             customer_id, cashier_employee_id, status, currency_code,
             subtotal_amount, discount_amount, tax_amount, total_amount, notes
           ) VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?, 0.00, 0.00, 0.00, 0.00, ?)`,
          [
            generateSaleNumber(),
            branchId,
            preRead.posRegisterId,
            tillSessionId,
            values.customerId,
            preRead.cashierEmployeeId,
            till.till.currencyCode,
            values.notes,
          ],
        );
        saleId = await getLastInsertId(connection);
        break;
      } catch (error) {
        if (generatedNumberConflict(error, 'uq_sales_number')) continue;
        throw error;
      }
    }
    if (saleId === null) return { outcome: 'sale_number_conflict' };

    const sale = await selectSale(connection, branchId, saleId);
    await insertAuditLog(connection, {
      auditContext,
      branchId,
      actionType: 'SALE_CREATED',
      entityType: 'sales',
      entityRecordId: saleId,
      beforeValues: null,
      afterValues: saleSnapshot(sale),
      notes: 'Open sale created through the checkout API.',
    });
    return { outcome: 'created', sale: { ...sale, items: [] } };
  });
}

async function updateSale(branchId, saleId, changes, auditContext) {
  const preRead = await preReadSale(branchId, saleId);
  if (!preRead) return { outcome: 'sale_not_found' };

  return withSalesTransaction(async (connection) => {
    const context = await lockSalesOperationalContext(
      connection,
      branchId,
      auditContext?.actorEmployeeId,
    );
    if (context.outcome !== 'valid') return context;
    const proposedCustomer = Object.hasOwn(changes, 'customerId')
      ? changes.customerId
      : preRead.customerId;
    const customer = await lockCustomer(connection, proposedCustomer);
    if (customer.outcome !== 'valid') return customer;
    const till = await lockRegisterAndTill(connection, branchId, preRead);
    if (till.outcome !== 'valid') return till;
    const current = await selectSale(connection, branchId, saleId, {
      forUpdate: true,
    });
    if (!current) return { outcome: 'sale_not_found' };
    if (
      current.posRegisterId !== preRead.posRegisterId ||
      current.tillSessionId !== preRead.tillSessionId ||
      current.cashierEmployeeId !== preRead.cashierEmployeeId ||
      current.customerId !== preRead.customerId
    ) {
      return { outcome: 'concurrent_change' };
    }
    if (current.status !== 'OPEN') return { outcome: 'sale_not_open' };
    const paymentState = analyzeSalePayments(
      await lockSalePayments(connection, saleId),
      current.totalAmount,
    );
    if (paymentState.hasActiveTender) return { outcome: 'active_tender' };
    if (
      current.currencyCode !== till.till.currencyCode ||
      current.currencyCode !== context.branch.currencyCode
    ) {
      return { outcome: 'currency_mismatch' };
    }
    const effective = { ...current, ...changes };
    const changed = Object.keys(changes).filter(
      (field) => current[field] !== effective[field],
    );
    if (changed.length === 0) {
      return {
        outcome: 'unchanged',
        sale: await selectSaleDetail(connection, branchId, saleId),
      };
    }
    const assignments = changed.map((field) =>
      field === 'customerId' ? 'customer_id = ?' : 'notes = ?',
    );
    await connection.execute(
      `UPDATE sales SET ${assignments.join(', ')} WHERE sale_id = ?`,
      [...changed.map((field) => effective[field]), saleId],
    );
    const sale = await selectSale(connection, branchId, saleId);
    await insertAuditLog(connection, {
      auditContext,
      branchId,
      actionType: 'SALE_UPDATED',
      entityType: 'sales',
      entityRecordId: saleId,
      beforeValues: saleSnapshot(current),
      afterValues: saleSnapshot(sale),
      notes: 'Open sale updated through the checkout API.',
    });
    return {
      outcome: 'updated',
      sale: await selectSaleDetail(connection, branchId, saleId),
    };
  });
}

async function preReadCatalogIdentity(values) {
  if (values.mode === 'BARCODE') {
    const [rows] = await pool.execute(
      `SELECT CAST(pb.barcode_id AS CHAR) AS barcodeId,
         CAST(pb.product_variant_id AS CHAR) AS productVariantId,
         CAST(pb.product_package_id AS CHAR) AS productPackageId,
         CAST(pp.package_unit_of_measure_id AS CHAR) AS packageUnitId,
         CAST(pv.product_id AS CHAR) AS productId,
         CAST(pv.unit_of_measure_id AS CHAR) AS variantUnitId,
         CAST(p.category_id AS CHAR) AS categoryId,
         CAST(p.brand_id AS CHAR) AS brandId,
         CAST(p.tax_rate_id AS CHAR) AS taxRateId
       FROM product_barcodes pb
       INNER JOIN product_variants pv ON pv.product_variant_id = pb.product_variant_id
       INNER JOIN products p ON p.product_id = pv.product_id
       LEFT JOIN product_packages pp
         ON pp.product_package_id = pb.product_package_id
        AND pp.product_variant_id = pb.product_variant_id
       WHERE pb.barcode = ? LIMIT 1`,
      [values.barcode],
    );
    if (!rows[0]) return { outcome: 'barcode_not_found' };
    rows[0].packageUnitId ??= rows[0].variantUnitId;
    return { outcome: 'found', identity: rows[0] };
  }

  const [variantRows] = await pool.execute(
    `SELECT CAST(pv.product_variant_id AS CHAR) AS productVariantId,
       CAST(pv.product_id AS CHAR) AS productId,
       CAST(pv.unit_of_measure_id AS CHAR) AS variantUnitId,
       CAST(p.category_id AS CHAR) AS categoryId,
       CAST(p.brand_id AS CHAR) AS brandId,
       CAST(p.tax_rate_id AS CHAR) AS taxRateId
     FROM product_variants pv
     INNER JOIN products p ON p.product_id = pv.product_id
     WHERE pv.product_variant_id = ? LIMIT 1`,
    [values.productVariantId],
  );
  if (!variantRows[0]) return { outcome: 'variant_not_found' };
  let packageUnitId = variantRows[0].variantUnitId;
  if (values.productPackageId !== null) {
    const [packageRows] = await pool.execute(
      `SELECT CAST(product_variant_id AS CHAR) AS productVariantId,
         CAST(package_unit_of_measure_id AS CHAR) AS packageUnitId
       FROM product_packages WHERE product_package_id = ? LIMIT 1`,
      [values.productPackageId],
    );
    if (!packageRows[0]) return { outcome: 'package_not_found' };
    if (packageRows[0].productVariantId !== values.productVariantId) {
      return { outcome: 'package_not_found' };
    }
    packageUnitId = packageRows[0].packageUnitId;
  }
  return {
    outcome: 'found',
    identity: {
      ...variantRows[0],
      productPackageId: values.productPackageId,
      packageUnitId,
      barcodeId: null,
    },
  };
}

async function lockCatalogReferences(connection, identity) {
  await lockRowsByIds(connection, {
    table: 'categories', idColumn: 'category_id', ids: [identity.categoryId],
    selectColumns: 'category_id',
  });
  await lockRowsByIds(connection, {
    table: 'brands', idColumn: 'brand_id', ids: [identity.brandId],
    selectColumns: 'brand_id',
  });
  const taxes = await lockRowsByIds(connection, {
    table: 'tax_rates', idColumn: 'tax_rate_id', ids: [identity.taxRateId],
    selectColumns: `CAST(tax_rate_id AS CHAR) AS taxRateId,
      rate_percent AS ratePercent, is_inclusive AS isInclusive`,
  });
  const units = await lockRowsByIds(connection, {
    table: 'units_of_measure', idColumn: 'unit_of_measure_id',
    ids: [identity.variantUnitId, identity.packageUnitId],
    selectColumns: `CAST(unit_of_measure_id AS CHAR) AS unitOfMeasureId,
      allows_fraction AS allowsFraction`,
  });
  return {
    tax: identity.taxRateId
      ? taxes.find((row) => row.taxRateId === identity.taxRateId) ?? null
      : null,
    unitMap: new Map(units.map((row) => [row.unitOfMeasureId, row])),
  };
}

async function lockCatalogForItem(connection, identity, values) {
  const references = await lockCatalogReferences(connection, identity);
  const [productRows] = await connection.execute(
    `SELECT CAST(product_id AS CHAR) AS productId, product_name AS productName,
       status, CAST(category_id AS CHAR) AS categoryId,
       CAST(brand_id AS CHAR) AS brandId, CAST(tax_rate_id AS CHAR) AS taxRateId
     FROM products WHERE product_id = ? LIMIT 1 FOR UPDATE`,
    [identity.productId],
  );
  const product = productRows[0];
  if (!product) return { outcome: 'variant_not_found' };
  if (
    product.categoryId !== identity.categoryId ||
    product.brandId !== identity.brandId ||
    product.taxRateId !== identity.taxRateId
  ) return { outcome: 'concurrent_change' };

  const [variantRows] = await connection.execute(
    `SELECT CAST(product_variant_id AS CHAR) AS productVariantId,
       CAST(product_id AS CHAR) AS productId,
       CAST(unit_of_measure_id AS CHAR) AS unitOfMeasureId,
       sku, status, is_fractional AS isFractional,
       lot_tracking_mode AS lotTrackingMode,
       default_selling_price AS defaultSellingPrice
     FROM product_variants
     WHERE product_variant_id = ? AND product_id = ? LIMIT 1 FOR UPDATE`,
    [identity.productVariantId, identity.productId],
  );
  const variant = variantRows[0];
  if (!variant || variant.unitOfMeasureId !== identity.variantUnitId) {
    return { outcome: 'concurrent_change' };
  }

  const [packages] = await connection.execute(
    `SELECT CAST(product_package_id AS CHAR) AS productPackageId,
       CAST(product_variant_id AS CHAR) AS productVariantId,
       CAST(package_unit_of_measure_id AS CHAR) AS packageUnitOfMeasureId,
       package_name AS packageName,
       conversion_to_base_quantity AS conversionToBaseQuantity,
       is_base_unit AS isBaseUnit, is_sellable AS isSellable,
       default_selling_price AS defaultSellingPrice, status
     FROM product_packages WHERE product_variant_id = ?
     ORDER BY product_package_id FOR UPDATE`,
    [identity.productVariantId],
  );

  const [barcodes] = await connection.execute(
    `SELECT CAST(barcode_id AS CHAR) AS barcodeId,
       CAST(product_variant_id AS CHAR) AS productVariantId,
       CAST(product_package_id AS CHAR) AS productPackageId, barcode
     FROM product_barcodes WHERE product_variant_id = ?
     ORDER BY barcode_id FOR UPDATE`,
    [identity.productVariantId],
  );

  let barcode = null;
  let productPackageId = identity.productPackageId;
  if (values.mode === 'BARCODE') {
    barcode = barcodes.find(
      (row) => row.barcodeId === identity.barcodeId && row.barcode === values.barcode,
    );
    if (!barcode) return { outcome: 'barcode_not_found' };
    productPackageId = barcode.productPackageId;
  }
  let productPackage;
  if (productPackageId === null) {
    const bases = packages.filter(
      (row) => Number(row.isBaseUnit) === 1 && row.status === 'ACTIVE',
    );
    if (bases.length !== 1) return { outcome: 'base_package_unavailable' };
    [productPackage] = bases;
  } else {
    productPackage = packages.find((row) => row.productPackageId === productPackageId);
    if (!productPackage) return { outcome: 'package_not_found' };
  }

  if (product.status !== 'ACTIVE') return { outcome: 'product_not_active' };
  if (variant.status !== 'ACTIVE') return { outcome: 'variant_not_active' };
  if (productPackage.status !== 'ACTIVE') return { outcome: 'package_not_active' };
  if (Number(productPackage.isSellable) !== 1) return { outcome: 'package_not_sellable' };

  const packageUnit = references.unitMap.get(productPackage.packageUnitOfMeasureId);
  if (!packageUnit) return { outcome: 'concurrent_change' };
  if (identity.taxRateId && !references.tax) return { outcome: 'concurrent_change' };

  return {
    outcome: 'valid', product, variant, productPackage, packageUnit,
    tax: references.tax, barcode,
  };
}

async function lockPriceRows(connection, branchId, productPackage, variant, utcNow) {
  const [packageRows] = await connection.execute(
    `SELECT selling_price AS sellingPrice,
       effective_from AS effectiveFrom, is_active AS isActive,
       (is_active = 1 AND effective_from <= ?) AS isDue
     FROM branch_package_prices
     WHERE branch_id = ? AND product_package_id = ? LIMIT 1 FOR UPDATE`,
    [utcNow, branchId, productPackage.productPackageId],
  );
  const [variantRows] = await connection.execute(
    `SELECT selling_price AS sellingPrice,
       effective_from AS effectiveFrom, is_active AS isActive,
       (is_active = 1 AND effective_from <= ?) AS isDue
     FROM branch_variant_prices
     WHERE branch_id = ? AND product_variant_id = ? LIMIT 1 FOR UPDATE`,
    [utcNow, branchId, variant.productVariantId],
  );
  return { packagePrice: packageRows[0] ?? null, variantPrice: variantRows[0] ?? null };
}

function due(price) {
  return Boolean(price) && Number(price.isDue) === 1;
}

function resolveShelfPrice(prices, productPackage, variant, utcNow) {
  if (due(prices.packagePrice, utcNow)) return prices.packagePrice.sellingPrice;
  if (productPackage.defaultSellingPrice !== null) {
    return productPackage.defaultSellingPrice;
  }
  const variantPrice = due(prices.variantPrice, utcNow)
    ? prices.variantPrice.sellingPrice
    : variant.defaultSellingPrice;
  return multiplyMoneyByConversion(
    variantPrice,
    productPackage.conversionToBaseQuantity,
  );
}

function validateLineQuantity(values, catalog) {
  const base = deriveBaseQuantity(
    values.quantity,
    catalog.productPackage.conversionToBaseQuantity,
  );
  if (base.outcome !== 'calculated') return base;
  if (Number(catalog.packageUnit.allowsFraction) !== 1 && !isWholeQuantity(values.quantity)) {
    return { outcome: 'fractional_package_quantity' };
  }
  if (Number(catalog.variant.isFractional) !== 1 && !isWholeQuantity(base.baseQuantity)) {
    return { outcome: 'fractional_base_quantity' };
  }
  return base;
}

async function recomputeSaleTotals(connection, saleId) {
  const items = await selectSaleItems(connection, saleId);
  const calculated = calculateSaleHeader(items);
  if (calculated.outcome !== 'calculated') return calculated;
  await connection.execute(
    `UPDATE sales SET subtotal_amount = ?, discount_amount = ?, tax_amount = ?,
       total_amount = ? WHERE sale_id = ?`,
    [calculated.subtotalAmount, calculated.discountAmount,
      calculated.taxAmount, calculated.totalAmount, saleId],
  );
  return { outcome: 'calculated', totals: calculated };
}

async function addSaleItem(branchId, saleId, values, auditContext) {
  const [preRead, catalogRead] = await Promise.all([
    preReadSale(branchId, saleId),
    preReadCatalogIdentity(values),
  ]);
  if (!preRead) return { outcome: 'sale_not_found' };
  if (catalogRead.outcome !== 'found') return catalogRead;

  return withSalesTransaction(async (connection) => {
    const context = await lockSalesOperationalContext(
      connection, branchId, auditContext?.actorEmployeeId,
    );
    if (context.outcome !== 'valid') return context;
    const catalog = await lockCatalogForItem(connection, catalogRead.identity, values);
    if (catalog.outcome !== 'valid') return catalog;
    const utcNow = await selectUtcNow(connection);
    const prices = await lockPriceRows(
      connection, branchId, catalog.productPackage, catalog.variant, utcNow,
    );
    const till = await lockRegisterAndTill(connection, branchId, preRead);
    if (till.outcome !== 'valid') return till;
    const sale = await selectSale(connection, branchId, saleId, { forUpdate: true });
    if (!sale) return { outcome: 'sale_not_found' };
    if (
      sale.posRegisterId !== preRead.posRegisterId ||
      sale.tillSessionId !== preRead.tillSessionId ||
      sale.cashierEmployeeId !== preRead.cashierEmployeeId
    ) return { outcome: 'concurrent_change' };
    if (sale.status !== 'OPEN') return { outcome: 'sale_not_open' };
    const paymentState = analyzeSalePayments(
      await lockSalePayments(connection, saleId),
      sale.totalAmount,
    );
    if (paymentState.hasActiveTender) return { outcome: 'active_tender' };
    if (
      sale.currencyCode !== till.till.currencyCode ||
      sale.currencyCode !== context.branch.currencyCode
    ) return { outcome: 'currency_mismatch' };

    const base = validateLineQuantity(values, catalog);
    if (base.outcome !== 'calculated') return base;
    const shelfPrice = resolveShelfPrice(
      prices, catalog.productPackage, catalog.variant, utcNow,
    );
    const taxRatePercent = catalog.tax?.ratePercent ?? '0.0000';
    const unitPrice = catalog.tax && Number(catalog.tax.isInclusive) === 1
      ? taxExclusiveUnitPrice(shelfPrice, taxRatePercent)
      : shelfPrice;
    const calculated = calculateSaleLine({
      quantity: values.quantity,
      unitPrice,
      discountAmount: values.discountAmount,
      taxRatePercent,
    });
    if (calculated.outcome !== 'calculated') return calculated;

    const [lineRows] = await connection.execute(
      `SELECT COALESCE(MAX(line_number), 0) AS maximumLine
       FROM sale_items WHERE sale_id = ?`,
      [saleId],
    );
    const lineNumber = Number(lineRows[0].maximumLine) + 1;
    if (lineNumber > 65535) return { outcome: 'line_number_overflow' };
    await connection.execute(
      `INSERT INTO sale_items (
         sale_id, line_number, product_variant_id, product_package_id,
         barcode_id, item_description, sku_snapshot, package_name_snapshot,
         quantity, package_conversion_factor, base_quantity, unit_price,
         unit_cost, discount_amount, tax_rate_percent, tax_amount, line_total
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      [
        saleId, lineNumber, catalog.variant.productVariantId,
        catalog.productPackage.productPackageId, catalog.barcode?.barcodeId ?? null,
        catalog.product.productName, catalog.variant.sku,
        catalog.productPackage.packageName, values.quantity,
        catalog.productPackage.conversionToBaseQuantity, base.baseQuantity,
        unitPrice, values.discountAmount, taxRatePercent,
        calculated.taxAmount, calculated.lineTotal,
      ],
    );
    const saleItemId = await getLastInsertId(connection);
    const item = await selectSaleItem(connection, saleId, saleItemId);
    const totals = await recomputeSaleTotals(connection, saleId);
    if (totals.outcome !== 'calculated') abortSale(totals.outcome);
    await insertAuditLog(connection, {
      auditContext, branchId, actionType: 'SALE_ITEM_CREATED',
      entityType: 'sale_items', entityRecordId: saleItemId,
      beforeValues: null, afterValues: saleItemSnapshot(item),
      notes: 'Sale item created through the checkout API.',
    });
    return {
      outcome: 'created', item,
      sale: await selectSaleDetail(connection, branchId, saleId),
    };
  });
}

async function preReadSaleItem(branchId, saleId, saleItemId) {
  const [rows] = await pool.execute(
    `SELECT CAST(s.sale_id AS CHAR) AS saleId,
       CAST(s.pos_register_id AS CHAR) AS posRegisterId,
       CAST(s.till_session_id AS CHAR) AS tillSessionId,
       CAST(s.cashier_employee_id AS CHAR) AS cashierEmployeeId,
       CAST(si.sale_item_id AS CHAR) AS saleItemId,
       CAST(si.product_package_id AS CHAR) AS productPackageId,
       CAST(si.product_variant_id AS CHAR) AS productVariantId,
       CAST(pv.product_id AS CHAR) AS productId,
       CAST(pv.unit_of_measure_id AS CHAR) AS variantUnitId,
       CAST(pp.package_unit_of_measure_id AS CHAR) AS packageUnitId,
       CAST(p.category_id AS CHAR) AS categoryId,
       CAST(p.brand_id AS CHAR) AS brandId,
       CAST(p.tax_rate_id AS CHAR) AS taxRateId
     FROM sales s
     LEFT JOIN sale_items si ON si.sale_id = s.sale_id AND si.sale_item_id = ?
     LEFT JOIN product_variants pv ON pv.product_variant_id = si.product_variant_id
     LEFT JOIN products p ON p.product_id = pv.product_id
     LEFT JOIN product_packages pp
       ON pp.product_package_id = si.product_package_id
      AND pp.product_variant_id = si.product_variant_id
     WHERE s.branch_id = ? AND s.sale_id = ? LIMIT 1`,
    [saleItemId, branchId, saleId],
  );
  return rows[0] ?? null;
}

async function updateSaleItem(branchId, saleId, saleItemId, changes, auditContext) {
  const preRead = await preReadSaleItem(branchId, saleId, saleItemId);
  if (!preRead) return { outcome: 'sale_not_found' };
  if (!preRead.saleItemId) return { outcome: 'item_not_found' };

  return withSalesTransaction(async (connection) => {
    const context = await lockSalesOperationalContext(
      connection, branchId, auditContext?.actorEmployeeId,
    );
    if (context.outcome !== 'valid') return context;
    const catalog = await lockCatalogForItem(connection, preRead, {
      mode: 'EXPLICIT',
      productVariantId: preRead.productVariantId,
      productPackageId: preRead.productPackageId,
    });
    if (catalog.outcome !== 'valid') return catalog;
    const till = await lockRegisterAndTill(connection, branchId, preRead);
    if (till.outcome !== 'valid') return till;
    const sale = await selectSale(connection, branchId, saleId, { forUpdate: true });
    if (!sale) return { outcome: 'sale_not_found' };
    if (sale.status !== 'OPEN') return { outcome: 'sale_not_open' };
    const paymentState = analyzeSalePayments(
      await lockSalePayments(connection, saleId),
      sale.totalAmount,
    );
    if (paymentState.hasActiveTender) return { outcome: 'active_tender' };
    if (
      sale.currencyCode !== till.till.currencyCode ||
      sale.currencyCode !== context.branch.currencyCode
    ) return { outcome: 'currency_mismatch' };
    const current = await selectSaleItem(connection, saleId, saleItemId, {
      forUpdate: true,
    });
    if (!current) return { outcome: 'item_not_found' };
    const quantity = changes.quantity ?? current.quantity;
    const discountAmount = changes.discountAmount ?? current.discountAmount;
    const base = deriveBaseQuantity(quantity, current.packageConversionFactor);
    if (base.outcome !== 'calculated') return base;
    if (catalog.productPackage.conversionToBaseQuantity !== current.packageConversionFactor) {
      return { outcome: 'concurrent_change' };
    }
    if (Number(catalog.packageUnit.allowsFraction) !== 1 && !isWholeQuantity(quantity)) {
      return { outcome: 'fractional_package_quantity' };
    }
    if (Number(catalog.variant.isFractional) !== 1 && !isWholeQuantity(base.baseQuantity)) {
      return { outcome: 'fractional_base_quantity' };
    }
    const calculated = calculateSaleLine({
      quantity, unitPrice: current.unitPrice, discountAmount,
      taxRatePercent: current.taxRatePercent,
    });
    if (calculated.outcome !== 'calculated') return calculated;
    if (
      quantity === current.quantity &&
      discountAmount === current.discountAmount
    ) {
      return {
        outcome: 'unchanged', item: current,
        sale: await selectSaleDetail(connection, branchId, saleId),
      };
    }
    await connection.execute(
      `UPDATE sale_items SET quantity = ?, base_quantity = ?, discount_amount = ?,
         tax_amount = ?, line_total = ? WHERE sale_item_id = ?`,
      [quantity, base.baseQuantity, discountAmount, calculated.taxAmount,
        calculated.lineTotal, saleItemId],
    );
    const item = await selectSaleItem(connection, saleId, saleItemId);
    const totals = await recomputeSaleTotals(connection, saleId);
    if (totals.outcome !== 'calculated') abortSale(totals.outcome);
    await insertAuditLog(connection, {
      auditContext, branchId, actionType: 'SALE_ITEM_UPDATED',
      entityType: 'sale_items', entityRecordId: saleItemId,
      beforeValues: saleItemSnapshot(current), afterValues: saleItemSnapshot(item),
      notes: 'Sale item updated through the checkout API.',
    });
    return {
      outcome: 'updated', item,
      sale: await selectSaleDetail(connection, branchId, saleId),
    };
  });
}

async function deleteSaleItem(branchId, saleId, saleItemId, auditContext) {
  const preRead = await preReadSaleItem(branchId, saleId, saleItemId);
  if (!preRead) return { outcome: 'sale_not_found' };
  if (!preRead.saleItemId) return { outcome: 'item_not_found' };

  return withSalesTransaction(async (connection) => {
    const context = await lockSalesOperationalContext(
      connection, branchId, auditContext?.actorEmployeeId,
    );
    if (context.outcome !== 'valid') return context;
    const till = await lockRegisterAndTill(connection, branchId, preRead);
    if (till.outcome !== 'valid') return till;
    const sale = await selectSale(connection, branchId, saleId, { forUpdate: true });
    if (!sale) return { outcome: 'sale_not_found' };
    if (sale.status !== 'OPEN') return { outcome: 'sale_not_open' };
    const paymentState = analyzeSalePayments(
      await lockSalePayments(connection, saleId),
      sale.totalAmount,
    );
    if (paymentState.hasActiveTender) return { outcome: 'active_tender' };
    const item = await selectSaleItem(connection, saleId, saleItemId, {
      forUpdate: true,
    });
    if (!item) return { outcome: 'item_not_found' };
    await connection.execute('DELETE FROM sale_items WHERE sale_item_id = ?', [saleItemId]);
    const totals = await recomputeSaleTotals(connection, saleId);
    if (totals.outcome !== 'calculated') abortSale(totals.outcome);
    await insertAuditLog(connection, {
      auditContext, branchId, actionType: 'SALE_ITEM_DELETED',
      entityType: 'sale_items', entityRecordId: saleItemId,
      beforeValues: saleItemSnapshot(item), afterValues: null,
      notes: 'Sale item deleted from an open sale through the checkout API.',
    });
    return {
      outcome: 'deleted', item,
      sale: await selectSaleDetail(connection, branchId, saleId),
    };
  });
}

async function cancelSale(branchId, saleId, auditContext) {
  const preRead = await preReadSale(branchId, saleId);
  if (!preRead) return { outcome: 'sale_not_found' };
  return withSalesTransaction(async (connection) => {
    const context = await lockSalesOperationalContext(
      connection, branchId, auditContext?.actorEmployeeId,
    );
    if (context.outcome !== 'valid') return context;
    const till = await lockRegisterAndTill(connection, branchId, preRead, {
      requireOpen: false, allowCancellation: true,
    });
    if (till.outcome !== 'valid') return till;
    const current = await selectSale(connection, branchId, saleId, {
      forUpdate: true,
    });
    if (!current) return { outcome: 'sale_not_found' };
    if (current.status !== 'OPEN') return { outcome: 'sale_not_open' };
    const paymentState = analyzeSalePayments(
      await lockSalePayments(connection, saleId),
      current.totalAmount,
    );
    if (paymentState.hasPendingPayment) {
      return { outcome: 'sale_payment_pending' };
    }
    if (paymentState.hasCompletedPayment) {
      return { outcome: 'sale_payment_completed' };
    }
    await connection.execute(
      `UPDATE sales SET status = 'CANCELLED', cancelled_at = UTC_TIMESTAMP(6)
       WHERE sale_id = ?`,
      [saleId],
    );
    const sale = await selectSale(connection, branchId, saleId);
    await insertAuditLog(connection, {
      auditContext, branchId, actionType: 'SALE_CANCELLED',
      entityType: 'sales', entityRecordId: saleId,
      beforeValues: saleSnapshot(current), afterValues: saleSnapshot(sale),
      notes: 'Open sale cancelled through the checkout API.',
    });
    return {
      outcome: 'cancelled',
      sale: await selectSaleDetail(connection, branchId, saleId),
    };
  });
}

export {
  abortSale,
  addSaleItem,
  cancelSale,
  createSale,
  deleteSaleItem,
  findSale,
  analyzeSalePayments,
  listSales,
  lockSalePayments,
  lockCatalogForItem,
  lockCustomer,
  lockRegisterAndTill,
  lockSalesOperationalContext,
  preReadCatalogIdentity,
  preReadSale,
  recomputeSaleTotals,
  saleItemSnapshot,
  saleSnapshot,
  selectSale,
  selectSaleDetail,
  selectSaleItems,
  updateSale,
  updateSaleItem,
  withSalesTransaction,
};
