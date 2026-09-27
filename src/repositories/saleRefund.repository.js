import { randomUUID } from 'node:crypto';

import pool from '../config/database.js';
import { insertAuditLog, lockTransferOperationalContext } from './inventoryMovement.repository.js';
import { selectPaymentMethod } from './paymentMethod.repository.js';
import { countAsSafeNumber, getLastInsertId } from './productCatalog.repository.js';
import {
  lockRegisterAndTill,
  lockSalePayments,
  selectSale,
  preReadSale,
} from './sale.repository.js';
import {
  REFUND_COLUMNS,
  lockReturnFamily,
  refundSummary,
  selectReturnRefunds,
  selectSalesReturn,
} from './salesReturn.repository.js';
import { selectUtcNow } from './purchasing.repository.js';
import { withInventoryTransaction } from './inventoryMovement.repository.js';
import { formatScaledDecimal, parseScaledDecimal } from '../utils/salesDecimal.js';

function generatePaymentNumber() {
  return `PAY-${randomUUID().replaceAll('-', '').toUpperCase()}`;
}

function classifyDuplicate(error) {
  if (error?.code !== 'ER_DUP_ENTRY' && error?.errno !== 1062) return null;
  const diagnostic = `${error?.message ?? ''} ${error?.sqlMessage ?? ''}`;
  if (diagnostic.includes('uq_sale_payments_number')) return 'payment_number_conflict';
  if (diagnostic.includes('uq_sale_payments_external_ref')) {
    return 'duplicate_external_reference';
  }
  return 'payment_conflict';
}

function refundSnapshot(payment) {
  return {
    salePaymentId: payment.salePaymentId,
    paymentNumber: payment.paymentNumber,
    saleId: payment.saleId,
    salesReturnId: payment.salesReturnId,
    paymentMethodId: payment.paymentMethodId,
    processedByEmployeeId: payment.processedByEmployeeId,
    paymentType: payment.paymentType,
    status: payment.status,
    amount: payment.amount,
    currencyCode: payment.currencyCode,
    externalReference: payment.externalReference,
    paidAt: payment.paidAt,
    notes: payment.notes,
  };
}

async function selectRefund(
  executor, saleId, salesReturnId, salePaymentId, { forUpdate = false } = {},
) {
  const [rows] = await executor.execute(
    `SELECT ${REFUND_COLUMNS}
     FROM sale_payments sp
     WHERE sp.sale_id = ? AND sp.sales_return_id = ?
       AND sp.sale_payment_id = ? AND sp.payment_type = 'REFUND'
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [saleId, salesReturnId, salePaymentId],
  );
  return rows[0] ?? null;
}

async function preReadPaymentMethod(paymentMethodId) {
  const [rows] = await pool.execute(
    `SELECT CAST(payment_method_id AS CHAR) AS paymentMethodId, method_type AS methodType
     FROM payment_methods WHERE payment_method_id = ? LIMIT 1`,
    [paymentMethodId],
  );
  return rows[0] ?? null;
}

async function preReadRefund(branchId, saleId, salesReturnId, salePaymentId) {
  const [rows] = await pool.execute(
    `SELECT CAST(sp.sale_payment_id AS CHAR) AS salePaymentId,
       CAST(sp.payment_method_id AS CHAR) AS paymentMethodId,
       pm.method_type AS methodType
     FROM sale_payments sp
     JOIN sales s ON s.sale_id = sp.sale_id
     JOIN payment_methods pm ON pm.payment_method_id = sp.payment_method_id
     WHERE s.branch_id = ? AND sp.sale_id = ? AND sp.sales_return_id = ?
       AND sp.sale_payment_id = ? AND sp.payment_type = 'REFUND'
     LIMIT 1`,
    [branchId, saleId, salesReturnId, salePaymentId],
  );
  return rows[0] ?? null;
}

function paymentTotals(payments) {
  let collected = 0n;
  let activeRefunds = 0n;
  let completedRefunds = 0n;
  for (const payment of payments) {
    const amount = parseScaledDecimal(payment.amount, 2);
    if (payment.paymentType === 'PAYMENT' && payment.status === 'COMPLETED') {
      collected += amount;
    }
    if (payment.paymentType === 'REFUND' &&
      ['PENDING', 'COMPLETED'].includes(payment.status)) {
      activeRefunds += amount;
    }
    if (payment.paymentType === 'REFUND' && payment.status === 'COMPLETED') {
      completedRefunds += amount;
    }
  }
  return { collected, activeRefunds, completedRefunds };
}

function validateRefundCapacity(family, salesReturnId, payments, amount, excludedId = null) {
  const target = family.returns.find((row) => row.salesReturnId === salesReturnId);
  const requested = parseScaledDecimal(amount, 2);
  const active = payments.filter((row) => row.salePaymentId !== excludedId &&
    row.paymentType === 'REFUND' && ['PENDING', 'COMPLETED'].includes(row.status));
  const targetActive = active.filter((row) => row.salesReturnId === salesReturnId)
    .reduce((sum, row) => sum + parseScaledDecimal(row.amount, 2), 0n);
  if (targetActive + requested > parseScaledDecimal(target.refundTotalAmount, 2)) {
    return 'return_refund_exceeded';
  }
  const totals = paymentTotals(payments.filter((row) => row.salePaymentId !== excludedId));
  if (totals.activeRefunds + requested > totals.collected) {
    return 'sale_payment_refund_exceeded';
  }
  const entitlement = family.returns
    .filter((row) => row.status === 'COMPLETED')
    .reduce((sum, row) => sum + parseScaledDecimal(row.refundTotalAmount, 2), 0n);
  if (totals.activeRefunds + requested > entitlement) {
    return 'sale_return_refund_exceeded';
  }
  return null;
}

async function lockRefundContext(
  connection,
  branchId,
  saleId,
  salesReturnId,
  auditContext,
  { cash, requireOpenTill, preSale },
) {
  const operational = await lockTransferOperationalContext(
    connection, branchId, [branchId], auditContext?.actorEmployeeId,
  );
  if (operational.outcome !== 'valid') return operational;
  let till = null;
  if (cash) {
    const tillResult = await lockRegisterAndTill(connection, branchId, preSale, {
      requireOpen: requireOpenTill,
      allowCancellation: !requireOpenTill,
    });
    if (tillResult.outcome !== 'valid') {
      return tillResult.outcome === 'till_not_open'
        ? { outcome: 'cash_till_not_open' }
        : tillResult;
    }
    till = tillResult.till;
  }
  const family = await lockReturnFamily(connection, branchId, saleId);
  if (family.outcome !== 'valid') return family;
  if (family.sale.status !== 'COMPLETED') return { outcome: 'sale_not_returnable' };
  const salesReturn = family.returns.find(
    (row) => row.salesReturnId === salesReturnId && row.branchId === branchId,
  );
  if (!salesReturn) return { outcome: 'return_not_found' };
  const payments = await lockSalePayments(connection, saleId);
  if (cash && (
    family.sale.posRegisterId !== preSale.posRegisterId ||
    family.sale.tillSessionId !== preSale.tillSessionId ||
    family.sale.cashierEmployeeId !== preSale.cashierEmployeeId ||
    till.currencyCode !== family.sale.currencyCode
  )) return { outcome: 'concurrent_change' };
  if (operational.branches[0].currencyCode !== family.sale.currencyCode) {
    return { outcome: 'currency_mismatch' };
  }
  return { outcome: 'valid', operational, family, salesReturn, payments, till };
}

async function listSaleRefundRecords(branchId, saleId, salesReturnId, filters) {
  const salesReturn = await selectSalesReturn(pool, branchId, saleId, salesReturnId);
  if (!salesReturn) {
    const sale = await selectSale(pool, branchId, saleId);
    return { outcome: sale ? 'return_not_found' : 'sale_not_found' };
  }
  const [countRows] = await pool.execute(
    `SELECT CAST(COUNT(*) AS CHAR) AS totalItems
     FROM sale_payments
     WHERE sale_id = ? AND sales_return_id = ? AND payment_type = 'REFUND'`,
    [saleId, salesReturnId],
  );
  const [rows] = await pool.execute(
    `SELECT ${REFUND_COLUMNS}
     FROM sale_payments sp
     WHERE sp.sale_id = ? AND sp.sales_return_id = ? AND sp.payment_type = 'REFUND'
     ORDER BY sp.created_at, sp.sale_payment_id LIMIT ? OFFSET ?`,
    [saleId, salesReturnId, filters.limit, filters.offset],
  );
  const allRows = await selectReturnRefunds(pool, saleId, salesReturnId);
  return {
    outcome: 'found', items: rows,
    totalItems: countAsSafeNumber(countRows[0].totalItems, 'sale refund'),
    summary: refundSummary(allRows, salesReturn.refundTotalAmount),
  };
}

async function createSaleRefundRecord(
  branchId, saleId, salesReturnId, values, auditContext,
) {
  const [saleRead, methodRead] = await Promise.all([
    preReadSale(branchId, saleId),
    preReadPaymentMethod(values.paymentMethodId),
  ]);
  if (!saleRead) return { outcome: 'sale_not_found' };
  if (!methodRead) return { outcome: 'payment_method_not_found' };
  const cash = methodRead.methodType === 'CASH';
  return withInventoryTransaction(async (connection) => {
    const locked = await lockRefundContext(
      connection, branchId, saleId, salesReturnId, auditContext,
      { cash, requireOpenTill: cash, preSale: saleRead },
    );
    if (locked.outcome !== 'valid') return locked;
    if (locked.salesReturn.status !== 'COMPLETED') {
      return { outcome: 'return_not_refundable' };
    }
    const method = await selectPaymentMethod(connection, values.paymentMethodId, {
      forUpdate: true,
    });
    if (!method) return { outcome: 'payment_method_not_found' };
    if (method.methodType !== methodRead.methodType) return { outcome: 'concurrent_change' };
    if (!method.isActive) return { outcome: 'payment_method_inactive' };
    if (method.requiresReference && values.externalReference === null) {
      return { outcome: 'external_reference_required' };
    }
    const capacity = validateRefundCapacity(
      locked.family, salesReturnId, locked.payments, values.amount,
    );
    if (capacity) return { outcome: capacity };
    let salePaymentId = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await connection.execute(
          `INSERT INTO sale_payments (
             payment_number, sale_id, sales_return_id, payment_method_id,
             processed_by_employee_id, payment_type, status, amount,
             currency_code, external_reference, paid_at, notes
           ) VALUES (?, ?, ?, ?, ?, 'REFUND', 'PENDING', ?, ?, ?, NULL, ?)`,
          [generatePaymentNumber(), saleId, salesReturnId, values.paymentMethodId,
            auditContext.actorEmployeeId, values.amount,
            locked.family.sale.currencyCode, values.externalReference, values.notes],
        );
        salePaymentId = await getLastInsertId(connection);
        break;
      } catch (error) {
        const duplicate = classifyDuplicate(error);
        if (duplicate === 'payment_number_conflict') continue;
        if (duplicate) return { outcome: duplicate };
        throw error;
      }
    }
    if (salePaymentId === null) return { outcome: 'payment_number_conflict' };
    const payment = await selectRefund(
      connection, saleId, salesReturnId, salePaymentId,
    );
    await insertAuditLog(connection, {
      auditContext, branchId, actionType: 'SALE_REFUND_CREATED',
      entityType: 'sale_payments', entityRecordId: salePaymentId,
      beforeValues: null, afterValues: refundSnapshot(payment),
      notes: 'Pending return-linked refund created.',
    });
    return { outcome: 'created', payment };
  });
}

async function transitionSaleRefundRecord(
  branchId,
  saleId,
  salesReturnId,
  salePaymentId,
  transition,
  auditContext,
) {
  const preRead = await preReadRefund(
    branchId, saleId, salesReturnId, salePaymentId,
  );
  if (!preRead) return { outcome: 'refund_not_found' };
  const saleRead = await preReadSale(branchId, saleId);
  if (!saleRead) return { outcome: 'sale_not_found' };
  const cash = preRead.methodType === 'CASH';
  const complete = transition === 'COMPLETED';
  return withInventoryTransaction(async (connection) => {
    const locked = await lockRefundContext(
      connection, branchId, saleId, salesReturnId, auditContext,
      { cash: cash && complete, requireOpenTill: cash && complete, preSale: saleRead },
    );
    if (locked.outcome !== 'valid') return locked;
    if (locked.salesReturn.status !== 'COMPLETED') {
      return { outcome: 'return_not_refundable' };
    }
    const payment = locked.payments.find(
      (row) => row.salePaymentId === salePaymentId &&
        row.salesReturnId === salesReturnId && row.paymentType === 'REFUND',
    );
    if (!payment) return { outcome: 'refund_not_found' };
    if (payment.status !== 'PENDING') return { outcome: 'invalid_refund_transition' };
    const method = await selectPaymentMethod(connection, payment.paymentMethodId, {
      forUpdate: true,
    });
    if (!method) return { outcome: 'payment_method_not_found' };
    if (method.methodType !== preRead.methodType) return { outcome: 'concurrent_change' };
    if (complete) {
      const capacity = validateRefundCapacity(
        locked.family, salesReturnId, locked.payments, payment.amount,
        salePaymentId,
      );
      if (capacity) return { outcome: capacity };
      if (payment.currencyCode !== locked.family.sale.currencyCode) {
        return { outcome: 'currency_mismatch' };
      }
    }
    const paidAt = complete ? await selectUtcNow(connection) : null;
    await connection.execute(
      'UPDATE sale_payments SET status = ?, paid_at = ? WHERE sale_payment_id = ?',
      [transition, paidAt, salePaymentId],
    );
    const updated = await selectRefund(
      connection, saleId, salesReturnId, salePaymentId,
    );
    await insertAuditLog(connection, {
      auditContext, branchId, actionType: `SALE_REFUND_${transition}`,
      entityType: 'sale_payments', entityRecordId: salePaymentId,
      beforeValues: refundSnapshot(payment), afterValues: refundSnapshot(updated),
      notes: `Return-linked refund transitioned to ${transition}.`,
    });
    return { outcome: 'transitioned', payment: updated };
  });
}

export {
  createSaleRefundRecord,
  listSaleRefundRecords,
  paymentTotals,
  selectRefund,
  transitionSaleRefundRecord,
};
