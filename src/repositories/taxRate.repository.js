import pool from '../config/database.js';
import { databaseBoolean, toIsoString } from '../utils/record.js';
import { insertAuditLog } from './audit.repository.js';

const TAX_RATE_COLUMNS = `
  CAST(tr.tax_rate_id AS CHAR) AS taxRateId,
  tr.tax_code AS taxCode,
  tr.tax_name AS taxName,
  tr.rate_percent AS ratePercent,
  tr.is_inclusive AS isInclusive,
  tr.is_active AS isActive,
  tr.created_at AS createdAt,
  tr.updated_at AS updatedAt
`;

const TAX_RATE_UPDATE_COLUMNS = Object.freeze({
  taxCode: 'tax_code',
  taxName: 'tax_name',
  ratePercent: 'rate_percent',
  isInclusive: 'is_inclusive',
  isActive: 'is_active',
});

function countAsSafeNumber(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error('The tax-rate count query returned an invalid result.');
  }

  const count = BigInt(value);

  if (count > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('The tax-rate count exceeds the supported API range.');
  }

  return Number(count);
}

function normalizeTaxRate(row) {
  if (!row) {
    return null;
  }

  if (typeof row.ratePercent !== 'string') {
    throw new Error('The tax-rate decimal query returned an invalid result.');
  }

  return {
    taxRateId: row.taxRateId,
    taxCode: row.taxCode,
    taxName: row.taxName,
    ratePercent: row.ratePercent,
    isInclusive: databaseBoolean(row.isInclusive),
    isActive: databaseBoolean(row.isActive),
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

function taxRateAuditSnapshot(taxRate) {
  return {
    taxRateId: taxRate.taxRateId,
    taxCode: taxRate.taxCode,
    taxName: taxRate.taxName,
    ratePercent: taxRate.ratePercent,
    isInclusive: taxRate.isInclusive,
    isActive: taxRate.isActive,
  };
}

async function withTransaction(work) {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    try {
      await connection.rollback();
    } catch (rollbackError) {
      error.rollbackError = rollbackError;
    }

    throw error;
  } finally {
    connection.release();
  }
}

async function getLastInsertId(connection) {
  const [rows] = await connection.execute(
    'SELECT CAST(LAST_INSERT_ID() AS CHAR) AS insertedId',
  );

  return rows[0].insertedId;
}

async function selectTaxRate(
  executor,
  taxRateId,
  { forUpdate = false } = {},
) {
  const [rows] = await executor.execute(
    `SELECT ${TAX_RATE_COLUMNS}
     FROM tax_rates tr
     WHERE tr.tax_rate_id = ?
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [taxRateId],
  );

  return normalizeTaxRate(rows[0]);
}

async function lockReferencingProducts(connection, taxRateId) {
  const [rows] = await connection.execute(
    `SELECT
       CAST(p.product_id AS CHAR) AS productId,
       p.status
     FROM products p
     WHERE p.tax_rate_id = ?
     ORDER BY p.product_id
     FOR UPDATE`,
    [taxRateId],
  );

  return rows;
}

async function listTaxRateRecords({
  search,
  isActive,
  isInclusive,
  limit,
  offset,
}) {
  const predicates = [];
  const parameters = [];

  if (search) {
    predicates.push(
      `LOCATE(?, CONCAT_WS(' ', tr.tax_code, tr.tax_name)) > 0`,
    );
    parameters.push(search);
  }

  if (isActive !== null) {
    predicates.push('tr.is_active = ?');
    parameters.push(isActive ? 1 : 0);
  }

  if (isInclusive !== null) {
    predicates.push('tr.is_inclusive = ?');
    parameters.push(isInclusive ? 1 : 0);
  }

  const whereClause =
    predicates.length === 0 ? '' : `WHERE ${predicates.join(' AND ')}`;
  const [countRows] = await pool.execute(
    `SELECT CAST(COUNT(*) AS CHAR) AS totalItems
     FROM tax_rates tr
     ${whereClause}`,
    parameters,
  );
  const [rows] = await pool.execute(
    `SELECT ${TAX_RATE_COLUMNS}
     FROM tax_rates tr
     ${whereClause}
     ORDER BY tr.tax_code, tr.tax_rate_id
     LIMIT ? OFFSET ?`,
    [...parameters, limit, offset],
  );

  return {
    items: rows.map(normalizeTaxRate),
    totalItems: countAsSafeNumber(countRows[0].totalItems),
  };
}

async function findTaxRateById(taxRateId) {
  return selectTaxRate(pool, taxRateId);
}

async function createTaxRateRecord(values, auditContext) {
  return withTransaction(async (connection) => {
    await connection.execute(
      `INSERT INTO tax_rates (
         tax_code,
         tax_name,
         rate_percent,
         is_inclusive,
         is_active
       ) VALUES (?, ?, ?, ?, ?)`,
      [
        values.taxCode,
        values.taxName,
        values.ratePercent,
        values.isInclusive ? 1 : 0,
        values.isActive ? 1 : 0,
      ],
    );
    const taxRateId = await getLastInsertId(connection);
    const taxRate = await selectTaxRate(connection, taxRateId);

    await insertAuditLog(connection, {
      auditContext,
      actionType: 'TAX_RATE_CREATED',
      entityType: 'tax_rates',
      entityRecordId: taxRateId,
      beforeValues: null,
      afterValues: taxRateAuditSnapshot(taxRate),
      notes: 'Tax rate created through the catalog administration API.',
    });

    return taxRate;
  });
}

async function updateTaxRateRecord(taxRateId, changes, auditContext) {
  return withTransaction(async (connection) => {
    const currentTaxRate = await selectTaxRate(connection, taxRateId, {
      forUpdate: true,
    });

    if (!currentTaxRate) {
      return { outcome: 'not_found' };
    }

    const changedEntries = Object.entries(changes).filter(
      ([field, value]) => currentTaxRate[field] !== value,
    );

    if (changedEntries.length === 0) {
      return { outcome: 'unchanged', taxRate: currentTaxRate };
    }

    if (currentTaxRate.isActive && changes.isActive === false) {
      const referencingProducts = await lockReferencingProducts(
        connection,
        taxRateId,
      );

      if (referencingProducts.some((product) => product.status === 'ACTIVE')) {
        return { outcome: 'active_product_dependency' };
      }
    }

    const assignments = changedEntries.map(
      ([field]) => `${TAX_RATE_UPDATE_COLUMNS[field]} = ?`,
    );
    const parameters = changedEntries.map(([field, value]) =>
      field === 'isInclusive' || field === 'isActive'
        ? value
          ? 1
          : 0
        : value,
    );

    await connection.execute(
      `UPDATE tax_rates
       SET ${assignments.join(', ')}
       WHERE tax_rate_id = ?`,
      [...parameters, taxRateId],
    );
    const taxRate = await selectTaxRate(connection, taxRateId);

    await insertAuditLog(connection, {
      auditContext,
      actionType: 'TAX_RATE_UPDATED',
      entityType: 'tax_rates',
      entityRecordId: taxRateId,
      beforeValues: taxRateAuditSnapshot(currentTaxRate),
      afterValues: taxRateAuditSnapshot(taxRate),
      notes: 'Tax rate updated through the catalog administration API.',
    });

    return { outcome: 'updated', taxRate };
  });
}

export {
  createTaxRateRecord,
  findTaxRateById,
  listTaxRateRecords,
  updateTaxRateRecord,
};
