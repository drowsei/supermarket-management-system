import { randomUUID } from 'node:crypto';

import pool from '../config/database.js';
import { insertAuditLog } from './audit.repository.js';
import { selectPaymentMethod } from './paymentMethod.repository.js';
import { countAsSafeNumber, getLastInsertId } from './productCatalog.repository.js';
import {
  analyzeSalePayments,
  lockRegisterAndTill,
  lockSalePayments,
  lockSalesOperationalContext,
  preReadSale,
  selectSale,
  withSalesTransaction,
} from './sale.repository.js';
import { selectUtcNow } from './purchasing.repository.js';

const PAYMENT_COLUMNS = `
  CAST(sp.sale_payment_id AS CHAR) AS salePaymentId,
  sp.payment_number AS paymentNumber,
  CAST(sp.sale_id AS CHAR) AS saleId,
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

function isDuplicateEntry(error) {
  return error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062;
}

function duplicateDiagnostic(error) {
  return `${error?.message ?? ''} ${error?.sqlMessage ?? ''}`;
}

function classifyPaymentDuplicate(error) {
  if (!isDuplicateEntry(error)) return null;
  const diagnostic = duplicateDiagnostic(error);
  if (diagnostic.includes('uq_sale_payments_number')) return 'payment_number_conflict';
  if (diagnostic.includes('uq_sale_payments_external_ref')) {
    return 'duplicate_external_reference';
  }
  return 'payment_conflict';
}

function generatePaymentNumber() {
  return `PAY-${randomUUID().replaceAll('-', '').toUpperCase()}`;
}

function paymentSnapshot(payment) {
  return {
    salePaymentId: payment.salePaymentId,
    paymentNumber: payment.paymentNumber,
    saleId: payment.saleId,
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

function addDateRange(predicates, parameters, { from, to }) {
  if (from) {
    predicates.push('sp.created_at >= ?');
    parameters.push(`${from} 00:00:00`);
  }
  if (to) {
    if (to === '9999-12-31') {
      predicates.push('sp.created_at <= ?');
      parameters.push('9999-12-31 23:59:59.999999');
    } else {
      predicates.push('sp.created_at < DATE_ADD(?, INTERVAL 1 DAY)');
      parameters.push(`${to} 00:00:00`);
    }
  }
}

async function selectSalePayment(
  executor,
  saleId,
  salePaymentId,
  { forUpdate = false } = {},
) {
  const [rows] = await executor.execute(
    `SELECT ${PAYMENT_COLUMNS}
     FROM sale_payments sp
     WHERE sp.sale_id = ? AND sp.sale_payment_id = ?
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [saleId, salePaymentId],
  );
  return rows[0] ?? null;
}

async function listSalePaymentRecords(branchId, saleId, filters) {
  const sale = await selectSale(pool, branchId, saleId);
  if (!sale) return { outcome: 'sale_not_found' };

  const predicates = ['sp.sale_id = ?'];
  const parameters = [saleId];
  for (const [value, column] of [
    [filters.status, 'sp.status'],
    [filters.paymentMethodId, 'sp.payment_method_id'],
    [filters.paymentType, 'sp.payment_type'],
  ]) {
    if (value !== null) {
      predicates.push(`${column} = ?`);
      parameters.push(value);
    }
  }
  addDateRange(predicates, parameters, filters);
  const where = `WHERE ${predicates.join(' AND ')}`;
  const [countRows] = await pool.execute(
    `SELECT CAST(COUNT(*) AS CHAR) AS totalItems
     FROM sale_payments sp ${where}`,
    parameters,
  );
  const [rows] = await pool.execute(
    `SELECT ${PAYMENT_COLUMNS}
     FROM sale_payments sp ${where}
     ORDER BY sp.created_at, sp.sale_payment_id
     LIMIT ? OFFSET ?`,
    [...parameters, filters.limit, filters.offset],
  );
  const [allRows] = await pool.execute(
    `SELECT payment_type AS paymentType, status, amount
     FROM sale_payments
     WHERE sale_id = ?
     ORDER BY sale_payment_id`,
    [saleId],
  );

  return {
    outcome: 'found',
    items: rows,
    totalItems: countAsSafeNumber(countRows[0].totalItems, 'sale payment'),
    summary: analyzeSalePayments(allRows, sale.totalAmount).summary,
  };
}

async function findSalePayment(branchId, saleId, salePaymentId) {
  const sale = await selectSale(pool, branchId, saleId);
  if (!sale) return { outcome: 'sale_not_found' };
  const payment = await selectSalePayment(pool, saleId, salePaymentId);
  if (!payment) return { outcome: 'payment_not_found' };
  return { outcome: 'found', payment };
}

async function lockPaymentContext(
  connection,
  branchId,
  saleId,
  auditContext,
  { requireOpenTill, allowCancellation },
  preRead,
) {
  const context = await lockSalesOperationalContext(
    connection,
    branchId,
    auditContext?.actorEmployeeId,
    { cashierEmployeeId: preRead.cashierEmployeeId },
  );
  if (context.outcome !== 'valid') return context;
  const till = await lockRegisterAndTill(connection, branchId, preRead, {
    requireOpen: requireOpenTill,
    allowCancellation,
  });
  if (till.outcome !== 'valid') return till;
  const sale = await selectSale(connection, branchId, saleId, { forUpdate: true });
  if (!sale) return { outcome: 'sale_not_found' };
  if (sale.status !== 'OPEN') return { outcome: 'sale_not_open' };
  if (
    sale.posRegisterId !== preRead.posRegisterId ||
    sale.tillSessionId !== preRead.tillSessionId ||
    sale.cashierEmployeeId !== preRead.cashierEmployeeId
  ) return { outcome: 'concurrent_change' };
  if (
    sale.currencyCode !== till.till.currencyCode ||
    sale.currencyCode !== context.branch.currencyCode
  ) return { outcome: 'currency_mismatch' };
  const payments = await lockSalePayments(connection, saleId);
  return { outcome: 'valid', context, till: till.till, sale, payments };
}

async function createSalePaymentRecord(branchId, saleId, values, auditContext) {
  const preRead = await preReadSale(branchId, saleId);
  if (!preRead) return { outcome: 'sale_not_found' };
  return withSalesTransaction(async (connection) => {
    const locked = await lockPaymentContext(
      connection,
      branchId,
      saleId,
      auditContext,
      { requireOpenTill: true, allowCancellation: false },
      preRead,
    );
    if (locked.outcome !== 'valid') return locked;

    const method = await selectPaymentMethod(connection, values.paymentMethodId, {
      forUpdate: true,
    });
    if (!method) return { outcome: 'payment_method_not_found' };
    if (!method.isActive) return { outcome: 'payment_method_inactive' };
    if (method.requiresReference && values.externalReference === null) {
      return { outcome: 'external_reference_required' };
    }

    const paymentState = analyzeSalePayments(locked.payments, locked.sale.totalAmount);
    const requestedAmount = BigInt(values.amount.replace('.', ''));
    if (paymentState.active + requestedAmount > paymentState.total) {
      return { outcome: 'payment_overpaid' };
    }

    let salePaymentId = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await connection.execute(
          `INSERT INTO sale_payments (
             payment_number, sale_id, sales_return_id, payment_method_id,
             processed_by_employee_id, payment_type, status, amount,
             currency_code, external_reference, paid_at, notes
           ) VALUES (?, ?, NULL, ?, ?, 'PAYMENT', 'PENDING', ?, ?, ?, NULL, ?)`,
          [
            generatePaymentNumber(), saleId, values.paymentMethodId,
            auditContext.actorEmployeeId, values.amount, locked.sale.currencyCode,
            values.externalReference, values.notes,
          ],
        );
        salePaymentId = await getLastInsertId(connection);
        break;
      } catch (error) {
        const duplicate = classifyPaymentDuplicate(error);
        if (duplicate === 'payment_number_conflict') continue;
        if (duplicate) return { outcome: duplicate };
        throw error;
      }
    }
    if (salePaymentId === null) return { outcome: 'payment_number_conflict' };

    const payment = await selectSalePayment(connection, saleId, salePaymentId);
    await insertAuditLog(connection, {
      auditContext,
      branchId,
      actionType: 'SALE_PAYMENT_CREATED',
      entityType: 'SALE_PAYMENT',
      entityRecordId: salePaymentId,
      beforeValues: null,
      afterValues: paymentSnapshot(payment),
      notes: 'Pending sale payment created through the tender API.',
    });
    return { outcome: 'created', payment };
  });
}

async function transitionSalePaymentRecord(
  branchId,
  saleId,
  salePaymentId,
  transition,
  auditContext,
) {
  const complete = transition === 'COMPLETED';
  const preRead = await preReadSale(branchId, saleId);
  if (!preRead) return { outcome: 'sale_not_found' };
  return withSalesTransaction(async (connection) => {
    const locked = await lockPaymentContext(
      connection,
      branchId,
      saleId,
      auditContext,
      { requireOpenTill: complete, allowCancellation: !complete },
      preRead,
    );
    if (locked.outcome !== 'valid') return locked;
    const payment = locked.payments.find(
      (row) => row.salePaymentId === salePaymentId,
    );
    if (!payment) return { outcome: 'payment_not_found' };
    if (payment.paymentType !== 'PAYMENT' || payment.status !== 'PENDING') {
      return { outcome: 'invalid_payment_transition' };
    }
    const method = await selectPaymentMethod(connection, payment.paymentMethodId, {
      forUpdate: true,
    });
    if (!method) return { outcome: 'payment_method_not_found' };

    if (complete) {
      const state = analyzeSalePayments(locked.payments, locked.sale.totalAmount);
      const targetAmount = BigInt(payment.amount.replace('.', ''));
      if (state.completed + targetAmount > state.total) {
        return { outcome: 'payment_overpaid' };
      }
    }

    const paidAt = complete ? await selectUtcNow(connection) : null;
    await connection.execute(
      `UPDATE sale_payments
       SET status = ?, paid_at = ?
       WHERE sale_payment_id = ?`,
      [transition, paidAt, salePaymentId],
    );
    const updated = await selectSalePayment(connection, saleId, salePaymentId);
    await insertAuditLog(connection, {
      auditContext,
      branchId,
      actionType: `SALE_PAYMENT_${transition}`,
      entityType: 'SALE_PAYMENT',
      entityRecordId: salePaymentId,
      beforeValues: paymentSnapshot(payment),
      afterValues: paymentSnapshot(updated),
      notes: `Sale payment marked ${transition.toLowerCase()} through the tender API.`,
    });
    return { outcome: 'transitioned', payment: updated };
  });
}

export {
  createSalePaymentRecord,
  findSalePayment,
  listSalePaymentRecords,
  paymentSnapshot,
  transitionSalePaymentRecord,
};
