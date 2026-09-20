import pool from '../config/database.js';
import { toIsoString } from '../utils/record.js';
import { insertAuditLog } from './audit.repository.js';
import {
  countAsSafeNumber,
  getLastInsertId,
  withCatalogTransaction,
} from './productCatalog.repository.js';

const CUSTOMER_COLUMNS = `
  CAST(c.customer_id AS CHAR) AS customerId,
  c.customer_number AS customerNumber,
  c.customer_type AS customerType,
  c.first_name AS firstName,
  c.last_name AS lastName,
  c.business_name AS businessName,
  c.email,
  c.phone,
  c.loyalty_number AS loyaltyNumber,
  DATE_FORMAT(c.date_of_birth, '%Y-%m-%d') AS dateOfBirth,
  c.status,
  c.created_at AS createdAt,
  c.updated_at AS updatedAt
`;

const CUSTOMER_UPDATE_COLUMNS = Object.freeze({
  customerType: 'customer_type',
  firstName: 'first_name',
  lastName: 'last_name',
  businessName: 'business_name',
  email: 'email',
  phone: 'phone',
  loyaltyNumber: 'loyalty_number',
  dateOfBirth: 'date_of_birth',
  status: 'status',
});

function normalizeCustomer(row) {
  if (!row) {
    return null;
  }

  return {
    customerId: row.customerId,
    customerNumber: row.customerNumber,
    customerType: row.customerType,
    firstName: row.firstName ?? null,
    lastName: row.lastName ?? null,
    businessName: row.businessName ?? null,
    email: row.email ?? null,
    phone: row.phone ?? null,
    loyaltyNumber: row.loyaltyNumber ?? null,
    dateOfBirth: row.dateOfBirth ?? null,
    status: row.status,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

function customerAuditSnapshot(customer) {
  return {
    customerId: customer.customerId,
    customerNumber: customer.customerNumber,
    customerType: customer.customerType,
    firstName: customer.firstName,
    lastName: customer.lastName,
    businessName: customer.businessName,
    email: customer.email,
    phone: customer.phone,
    loyaltyNumber: customer.loyaltyNumber,
    dateOfBirth: customer.dateOfBirth,
    status: customer.status,
  };
}

async function selectCustomer(
  executor,
  customerId,
  { forUpdate = false } = {},
) {
  const [rows] = await executor.execute(
    `SELECT ${CUSTOMER_COLUMNS}
     FROM customers c
     WHERE c.customer_id = ?
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [customerId],
  );

  return normalizeCustomer(rows[0]);
}

async function listCustomers({
  search,
  customerType,
  status,
  loyaltyNumber,
  email,
  phone,
  limit,
  offset,
}) {
  const predicates = [];
  const parameters = [];

  if (search) {
    predicates.push(`LOCATE(
      ?,
      CONCAT_WS(
        ' ',
        c.customer_number,
        c.first_name,
        c.last_name,
        c.business_name,
        c.email,
        c.phone,
        c.loyalty_number
      )
    ) > 0`);
    parameters.push(search);
  }

  if (customerType !== null) {
    predicates.push('c.customer_type = ?');
    parameters.push(customerType);
  }

  if (status !== null) {
    predicates.push('c.status = ?');
    parameters.push(status);
  }

  if (loyaltyNumber !== null) {
    predicates.push('c.loyalty_number = ?');
    parameters.push(loyaltyNumber);
  }

  if (email !== null) {
    predicates.push('c.email = ?');
    parameters.push(email);
  }

  if (phone !== null) {
    predicates.push('c.phone = ?');
    parameters.push(phone);
  }

  const whereClause = predicates.length
    ? `WHERE ${predicates.join(' AND ')}`
    : '';
  const [countRows] = await pool.execute(
    `SELECT CAST(COUNT(*) AS CHAR) AS totalItems
     FROM customers c
     ${whereClause}`,
    parameters,
  );
  const [rows] = await pool.execute(
    `SELECT ${CUSTOMER_COLUMNS}
     FROM customers c
     ${whereClause}
     ORDER BY c.customer_number, c.customer_id
     LIMIT ? OFFSET ?`,
    [...parameters, limit, offset],
  );

  return {
    items: rows.map(normalizeCustomer),
    totalItems: countAsSafeNumber(countRows[0].totalItems, 'customer'),
  };
}

async function findCustomerById(customerId) {
  return selectCustomer(pool, customerId);
}

async function lockCustomerById(connection, customerId) {
  return selectCustomer(connection, customerId, { forUpdate: true });
}

async function insertCustomer(connection, values) {
  await connection.execute(
    `INSERT INTO customers (
       customer_number,
       customer_type,
       first_name,
       last_name,
       business_name,
       email,
       phone,
       loyalty_number,
       date_of_birth,
       status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      values.customerNumber,
      values.customerType,
      values.firstName,
      values.lastName,
      values.businessName,
      values.email,
      values.phone,
      values.loyaltyNumber,
      values.dateOfBirth,
      values.status,
    ],
  );
  const customerId = await getLastInsertId(connection);

  return selectCustomer(connection, customerId);
}

async function applyCustomerUpdate(connection, customerId, changedEntries) {
  const assignments = changedEntries.map(
    ([field]) => `${CUSTOMER_UPDATE_COLUMNS[field]} = ?`,
  );
  const parameters = changedEntries.map(([, value]) => value);

  await connection.execute(
    `UPDATE customers
     SET ${assignments.join(', ')}
     WHERE customer_id = ?`,
    [...parameters, customerId],
  );

  return selectCustomer(connection, customerId);
}

async function insertCustomerAudit(
  connection,
  { auditContext, actionType, beforeCustomer, afterCustomer },
) {
  await insertAuditLog(connection, {
    auditContext,
    actionType,
    entityType: 'customers',
    entityRecordId: afterCustomer.customerId,
    beforeValues:
      beforeCustomer === null ? null : customerAuditSnapshot(beforeCustomer),
    afterValues: customerAuditSnapshot(afterCustomer),
    notes:
      actionType === 'CUSTOMER_CREATED'
        ? 'Customer created through the customer administration API.'
        : 'Customer updated through the customer administration API.',
  });
}

function classifyCustomerDuplicate(error) {
  if (error?.code !== 'ER_DUP_ENTRY' && error?.errno !== 1062) {
    return null;
  }

  const diagnostic = `${error.message ?? ''} ${error.sqlMessage ?? ''}`;

  if (diagnostic.includes('uq_customers_number')) {
    return 'customer_number';
  }

  if (diagnostic.includes('uq_customers_loyalty')) {
    return 'loyalty_number';
  }

  return 'unknown';
}

function withCustomerTransaction(work) {
  return withCatalogTransaction(work);
}

export {
  applyCustomerUpdate,
  classifyCustomerDuplicate,
  findCustomerById,
  insertCustomer,
  insertCustomerAudit,
  listCustomers,
  lockCustomerById,
  withCustomerTransaction,
};
