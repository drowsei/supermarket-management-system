import pool from '../config/database.js';
import { insertAuditLog } from './audit.repository.js';
import { toDateString, toIsoString } from '../utils/record.js';

const BRANCH_SELECT = `
  CAST(b.branch_id AS CHAR) AS branchId,
  b.branch_code AS branchCode,
  b.branch_name AS branchName,
  b.phone,
  b.email,
  b.address_line_1 AS addressLine1,
  b.address_line_2 AS addressLine2,
  b.city,
  b.state_region AS stateRegion,
  b.postal_code AS postalCode,
  b.country_code AS countryCode,
  b.currency_code AS currencyCode,
  b.timezone,
  DATE_FORMAT(b.opened_on, '%Y-%m-%d') AS openedOn,
  b.status,
  b.created_at AS createdAt,
  b.updated_at AS updatedAt
`;

const COLUMN_BY_FIELD = Object.freeze({
  branchCode: 'branch_code',
  branchName: 'branch_name',
  phone: 'phone',
  email: 'email',
  addressLine1: 'address_line_1',
  addressLine2: 'address_line_2',
  city: 'city',
  stateRegion: 'state_region',
  postalCode: 'postal_code',
  countryCode: 'country_code',
  currencyCode: 'currency_code',
  timezone: 'timezone',
  openedOn: 'opened_on',
  status: 'status',
});

function normalizeBranch(row) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    openedOn: toDateString(row.openedOn),
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

async function selectBranch(connection, branchId, lock = false) {
  const [rows] = await connection.execute(
    `SELECT ${BRANCH_SELECT}
     FROM branches b
     WHERE b.branch_id = ?
     LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [branchId],
  );

  return normalizeBranch(rows[0]);
}

async function listBranches({ status, search, limit, offset }) {
  const predicates = [];
  const parameters = [];

  if (status) {
    predicates.push('b.status = ?');
    parameters.push(status);
  }

  if (search) {
    predicates.push(`(
      b.branch_code LIKE CONCAT('%', ?, '%')
      OR b.branch_name LIKE CONCAT('%', ?, '%')
      OR b.city LIKE CONCAT('%', ?, '%')
    )`);
    parameters.push(search, search, search);
  }

  const where = predicates.length > 0 ? `WHERE ${predicates.join(' AND ')}` : '';
  const [countRows] = await pool.execute(
    `SELECT COUNT(*) AS totalItems FROM branches b ${where}`,
    parameters,
  );
  const [rows] = await pool.execute(
    `SELECT ${BRANCH_SELECT}
     FROM branches b
     ${where}
     ORDER BY b.branch_name, b.branch_id
     LIMIT ? OFFSET ?`,
    [...parameters, limit, offset],
  );

  return {
    items: rows.map(normalizeBranch),
    totalItems: Number(countRows[0].totalItems),
  };
}

async function findBranchById(branchId) {
  return selectBranch(pool, branchId);
}

async function createBranch(values, auditContext) {
  let connection;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    await connection.execute(
      `INSERT INTO branches (
         branch_code, branch_name, phone, email, address_line_1,
         address_line_2, city, state_region, postal_code, country_code,
         currency_code, timezone, opened_on, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        values.branchCode,
        values.branchName,
        values.phone,
        values.email,
        values.addressLine1,
        values.addressLine2,
        values.city,
        values.stateRegion,
        values.postalCode,
        values.countryCode,
        values.currencyCode,
        values.timezone,
        values.openedOn,
        values.status,
      ],
    );
    const [idRows] = await connection.query(
      'SELECT CAST(LAST_INSERT_ID() AS CHAR) AS branchId',
    );
    const branch = await selectBranch(connection, idRows[0].branchId);

    await insertAuditLog(connection, {
      auditContext,
      branchId: branch.branchId,
      actionType: 'BRANCH_CREATED',
      entityType: 'branches',
      entityRecordId: branch.branchId,
      afterValues: branch,
      notes: 'Branch created through the administration API.',
    });
    await connection.commit();
    return branch;
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        error.rollbackError = rollbackError;
      }
    }
    throw error;
  } finally {
    connection?.release();
  }
}

async function updateBranch(branchId, changes, auditContext) {
  let connection;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const before = await selectBranch(connection, branchId, true);

    if (!before) {
      await connection.rollback();
      return null;
    }

    const entries = Object.entries(changes);
    const assignments = entries.map(
      ([field]) => `${COLUMN_BY_FIELD[field]} = ?`,
    );

    await connection.execute(
      `UPDATE branches SET ${assignments.join(', ')} WHERE branch_id = ?`,
      [...entries.map(([, value]) => value), branchId],
    );
    const after = await selectBranch(connection, branchId);

    await insertAuditLog(connection, {
      auditContext,
      branchId,
      actionType: 'BRANCH_UPDATED',
      entityType: 'branches',
      entityRecordId: branchId,
      beforeValues: before,
      afterValues: after,
      notes: 'Branch updated through the administration API.',
    });
    await connection.commit();
    return after;
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        error.rollbackError = rollbackError;
      }
    }
    throw error;
  } finally {
    connection?.release();
  }
}

export { createBranch, findBranchById, listBranches, updateBranch };
