import pool from '../config/database.js';
import { databaseBoolean, toIsoString } from '../utils/record.js';
import { insertAuditLog } from './audit.repository.js';

const UNIT_OF_MEASURE_COLUMNS = `
  CAST(uom.unit_of_measure_id AS CHAR) AS unitOfMeasureId,
  uom.unit_code AS unitCode,
  uom.unit_name AS unitName,
  uom.symbol,
  uom.allows_fraction AS allowsFraction,
  uom.created_at AS createdAt,
  uom.updated_at AS updatedAt
`;

const UNIT_OF_MEASURE_UPDATE_COLUMNS = Object.freeze({
  unitCode: 'unit_code',
  unitName: 'unit_name',
  symbol: 'symbol',
  allowsFraction: 'allows_fraction',
});

function countAsSafeNumber(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error('The unit-of-measure count query returned an invalid result.');
  }

  const count = BigInt(value);

  if (count > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('The unit-of-measure count exceeds the supported API range.');
  }

  return Number(count);
}

function normalizeUnitOfMeasure(row) {
  if (!row) {
    return null;
  }

  return {
    unitOfMeasureId: row.unitOfMeasureId,
    unitCode: row.unitCode,
    unitName: row.unitName,
    symbol: row.symbol,
    allowsFraction: databaseBoolean(row.allowsFraction),
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

function unitOfMeasureAuditSnapshot(unitOfMeasure) {
  return {
    unitOfMeasureId: unitOfMeasure.unitOfMeasureId,
    unitCode: unitOfMeasure.unitCode,
    unitName: unitOfMeasure.unitName,
    symbol: unitOfMeasure.symbol,
    allowsFraction: unitOfMeasure.allowsFraction,
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

async function selectUnitOfMeasure(
  executor,
  unitOfMeasureId,
  { forUpdate = false } = {},
) {
  const [rows] = await executor.execute(
    `SELECT ${UNIT_OF_MEASURE_COLUMNS}
     FROM units_of_measure uom
     WHERE uom.unit_of_measure_id = ?
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [unitOfMeasureId],
  );

  return normalizeUnitOfMeasure(rows[0]);
}

async function listUnitOfMeasures({
  search,
  allowsFraction,
  limit,
  offset,
}) {
  const predicates = [];
  const parameters = [];

  if (search) {
    predicates.push(`LOCATE(
      ?,
      CONCAT_WS(' ', uom.unit_code, uom.unit_name, uom.symbol)
    ) > 0`);
    parameters.push(search);
  }

  if (allowsFraction !== null) {
    predicates.push('uom.allows_fraction = ?');
    parameters.push(allowsFraction ? 1 : 0);
  }

  const whereClause =
    predicates.length === 0 ? '' : `WHERE ${predicates.join(' AND ')}`;
  const [countRows] = await pool.execute(
    `SELECT CAST(COUNT(*) AS CHAR) AS totalItems
     FROM units_of_measure uom
     ${whereClause}`,
    parameters,
  );
  const [rows] = await pool.execute(
    `SELECT ${UNIT_OF_MEASURE_COLUMNS}
     FROM units_of_measure uom
     ${whereClause}
     ORDER BY uom.unit_code, uom.unit_of_measure_id
     LIMIT ? OFFSET ?`,
    [...parameters, limit, offset],
  );

  return {
    items: rows.map(normalizeUnitOfMeasure),
    totalItems: countAsSafeNumber(countRows[0].totalItems),
  };
}

async function findUnitOfMeasureById(unitOfMeasureId) {
  return selectUnitOfMeasure(pool, unitOfMeasureId);
}

async function createUnitOfMeasureRecord(values, auditContext) {
  return withTransaction(async (connection) => {
    await connection.execute(
      `INSERT INTO units_of_measure (
         unit_code,
         unit_name,
         symbol,
         allows_fraction
       ) VALUES (?, ?, ?, ?)`,
      [
        values.unitCode,
        values.unitName,
        values.symbol,
        values.allowsFraction ? 1 : 0,
      ],
    );
    const unitOfMeasureId = await getLastInsertId(connection);
    const unitOfMeasure = await selectUnitOfMeasure(
      connection,
      unitOfMeasureId,
    );

    await insertAuditLog(connection, {
      auditContext,
      actionType: 'UNIT_OF_MEASURE_CREATED',
      entityType: 'units_of_measure',
      entityRecordId: unitOfMeasureId,
      beforeValues: null,
      afterValues: unitOfMeasureAuditSnapshot(unitOfMeasure),
      notes: 'Unit of measure created through the catalog administration API.',
    });

    return unitOfMeasure;
  });
}

async function updateUnitOfMeasureRecord(
  unitOfMeasureId,
  changes,
  auditContext,
) {
  return withTransaction(async (connection) => {
    const currentUnitOfMeasure = await selectUnitOfMeasure(
      connection,
      unitOfMeasureId,
      { forUpdate: true },
    );

    if (!currentUnitOfMeasure) {
      return { outcome: 'not_found' };
    }

    const changedEntries = Object.entries(changes).filter(
      ([field, value]) => currentUnitOfMeasure[field] !== value,
    );

    if (changedEntries.length === 0) {
      return {
        outcome: 'unchanged',
        unitOfMeasure: currentUnitOfMeasure,
      };
    }

    if (
      currentUnitOfMeasure.allowsFraction &&
      changes.allowsFraction === false
    ) {
      const [fractionalVariantRows] = await connection.execute(
        `SELECT CAST(product_variant_id AS CHAR) AS productVariantId
         FROM product_variants
         WHERE unit_of_measure_id = ?
           AND is_fractional = 1
         FOR UPDATE`,
        [unitOfMeasureId],
      );

      if (fractionalVariantRows.length > 0) {
        return { outcome: 'fractional_variant_dependency' };
      }
    }

    const assignments = changedEntries.map(
      ([field]) => `${UNIT_OF_MEASURE_UPDATE_COLUMNS[field]} = ?`,
    );
    const parameters = changedEntries.map(([field, value]) =>
      field === 'allowsFraction' ? (value ? 1 : 0) : value,
    );

    await connection.execute(
      `UPDATE units_of_measure
       SET ${assignments.join(', ')}
       WHERE unit_of_measure_id = ?`,
      [...parameters, unitOfMeasureId],
    );
    const unitOfMeasure = await selectUnitOfMeasure(
      connection,
      unitOfMeasureId,
    );

    await insertAuditLog(connection, {
      auditContext,
      actionType: 'UNIT_OF_MEASURE_UPDATED',
      entityType: 'units_of_measure',
      entityRecordId: unitOfMeasureId,
      beforeValues: unitOfMeasureAuditSnapshot(currentUnitOfMeasure),
      afterValues: unitOfMeasureAuditSnapshot(unitOfMeasure),
      notes: 'Unit of measure updated through the catalog administration API.',
    });

    return { outcome: 'updated', unitOfMeasure };
  });
}

export {
  createUnitOfMeasureRecord,
  findUnitOfMeasureById,
  listUnitOfMeasures,
  updateUnitOfMeasureRecord,
};
