import pool from '../config/database.js';
import { databaseBoolean } from '../utils/record.js';
import { insertAuditLog } from './audit.repository.js';
import {
  countAsSafeNumber,
  getLastInsertId,
  withCatalogTransaction,
} from './productCatalog.repository.js';

const PAYMENT_METHOD_COLUMNS = `
  CAST(pm.payment_method_id AS CHAR) AS paymentMethodId,
  pm.method_code AS methodCode,
  pm.method_name AS methodName,
  pm.method_type AS methodType,
  pm.requires_reference AS requiresReference,
  pm.is_active AS isActive,
  DATE_FORMAT(pm.created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS createdAt,
  DATE_FORMAT(pm.updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS updatedAt
`;

const UPDATE_COLUMNS = Object.freeze({
  methodCode: 'method_code',
  methodName: 'method_name',
  requiresReference: 'requires_reference',
  isActive: 'is_active',
});

function normalizePaymentMethod(row) {
  if (!row) return null;

  return {
    ...row,
    requiresReference: databaseBoolean(row.requiresReference),
    isActive: databaseBoolean(row.isActive),
  };
}

function paymentMethodSnapshot(method) {
  return {
    paymentMethodId: method.paymentMethodId,
    methodCode: method.methodCode,
    methodName: method.methodName,
    methodType: method.methodType,
    requiresReference: method.requiresReference,
    isActive: method.isActive,
  };
}

async function selectPaymentMethod(
  executor,
  paymentMethodId,
  { forUpdate = false } = {},
) {
  const [rows] = await executor.execute(
    `SELECT ${PAYMENT_METHOD_COLUMNS}
     FROM payment_methods pm
     WHERE pm.payment_method_id = ?
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [paymentMethodId],
  );

  return normalizePaymentMethod(rows[0]);
}

async function listPaymentMethodRecords(filters) {
  const predicates = [];
  const parameters = [];

  if (filters.search) {
    predicates.push("LOCATE(?, CONCAT_WS(' ', pm.method_code, pm.method_name)) > 0");
    parameters.push(filters.search);
  }
  for (const [value, column] of [
    [filters.methodType, 'pm.method_type'],
    [filters.isActive, 'pm.is_active'],
    [filters.requiresReference, 'pm.requires_reference'],
  ]) {
    if (value !== null) {
      predicates.push(`${column} = ?`);
      parameters.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
    }
  }

  const where = predicates.length === 0
    ? ''
    : `WHERE ${predicates.join(' AND ')}`;
  const [countRows] = await pool.execute(
    `SELECT CAST(COUNT(*) AS CHAR) AS totalItems
     FROM payment_methods pm ${where}`,
    parameters,
  );
  const [rows] = await pool.execute(
    `SELECT ${PAYMENT_METHOD_COLUMNS}
     FROM payment_methods pm ${where}
     ORDER BY pm.method_code, pm.payment_method_id
     LIMIT ? OFFSET ?`,
    [...parameters, filters.limit, filters.offset],
  );

  return {
    items: rows.map(normalizePaymentMethod),
    totalItems: countAsSafeNumber(
      countRows[0].totalItems,
      'payment method',
    ),
  };
}

async function findPaymentMethodById(paymentMethodId) {
  return selectPaymentMethod(pool, paymentMethodId);
}

async function createPaymentMethodRecord(values, auditContext) {
  return withCatalogTransaction(async (connection) => {
    await connection.execute(
      `INSERT INTO payment_methods (
         method_code,
         method_name,
         method_type,
         requires_reference,
         is_active
       ) VALUES (?, ?, ?, ?, ?)`,
      [
        values.methodCode,
        values.methodName,
        values.methodType,
        values.requiresReference ? 1 : 0,
        values.isActive ? 1 : 0,
      ],
    );
    const paymentMethodId = await getLastInsertId(connection);
    const paymentMethod = await selectPaymentMethod(
      connection,
      paymentMethodId,
    );

    await insertAuditLog(connection, {
      auditContext,
      branchId: null,
      actionType: 'PAYMENT_METHOD_CREATED',
      entityType: 'PAYMENT_METHOD',
      entityRecordId: paymentMethodId,
      beforeValues: null,
      afterValues: paymentMethodSnapshot(paymentMethod),
      notes: 'Payment method created through the administration API.',
    });

    return paymentMethod;
  });
}

async function updatePaymentMethodRecord(
  paymentMethodId,
  changes,
  auditContext,
) {
  return withCatalogTransaction(async (connection) => {
    const current = await selectPaymentMethod(connection, paymentMethodId, {
      forUpdate: true,
    });
    if (!current) return { outcome: 'not_found' };

    const changedEntries = Object.entries(changes).filter(
      ([field, value]) => current[field] !== value,
    );
    if (changedEntries.length === 0) {
      return { outcome: 'unchanged', paymentMethod: current };
    }

    const assignments = changedEntries.map(
      ([field]) => `${UPDATE_COLUMNS[field]} = ?`,
    );
    const parameters = changedEntries.map(([field, value]) =>
      ['requiresReference', 'isActive'].includes(field)
        ? (value ? 1 : 0)
        : value,
    );

    await connection.execute(
      `UPDATE payment_methods
       SET ${assignments.join(', ')}
       WHERE payment_method_id = ?`,
      [...parameters, paymentMethodId],
    );
    const paymentMethod = await selectPaymentMethod(
      connection,
      paymentMethodId,
    );

    await insertAuditLog(connection, {
      auditContext,
      branchId: null,
      actionType: 'PAYMENT_METHOD_UPDATED',
      entityType: 'PAYMENT_METHOD',
      entityRecordId: paymentMethodId,
      beforeValues: paymentMethodSnapshot(current),
      afterValues: paymentMethodSnapshot(paymentMethod),
      notes: 'Payment method updated through the administration API.',
    });

    return { outcome: 'updated', paymentMethod };
  });
}

export {
  createPaymentMethodRecord,
  findPaymentMethodById,
  listPaymentMethodRecords,
  paymentMethodSnapshot,
  selectPaymentMethod,
  updatePaymentMethodRecord,
};
