import pool from '../config/database.js';

function countAsSafeNumber(value, entityLabel) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error(`The ${entityLabel} count query returned an invalid result.`);
  }

  const count = BigInt(value);

  if (count > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`The ${entityLabel} count exceeds the supported API range.`);
  }

  return Number(count);
}

async function getLastInsertId(connection) {
  const [rows] = await connection.execute(
    'SELECT CAST(LAST_INSERT_ID() AS CHAR) AS insertedId',
  );

  return rows[0].insertedId;
}

async function withCatalogTransaction(work) {
  const connection = await pool.getConnection();
  let transactionStarted = false;
  let discardConnection = false;

  try {
    await connection.beginTransaction();
    transactionStarted = true;

    const result = await work(connection);

    await connection.commit();
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) {
      try {
        await connection.rollback();
        transactionStarted = false;
      } catch (rollbackError) {
        discardConnection = true;

        try {
          error.rollbackError = rollbackError;
        } catch {
          // Preserve the original error if the error object is not extensible.
        }
      }
    }

    throw error;
  } finally {
    if (discardConnection) {
      try {
        connection.destroy();
      } catch {
        // A connection with an uncertain transaction state is never reused.
      }
    } else {
      try {
        connection.release();
      } catch {
        try {
          connection.destroy();
        } catch {
          // Cleanup must not turn a committed mutation into an ambiguous retry.
        }
      }
    }
  }
}

function uniqueSortedIds(ids) {
  return [...new Set(ids.filter((id) => id !== null && id !== undefined))]
    .sort((left, right) => {
      const leftId = BigInt(left);
      const rightId = BigInt(right);
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });
}

async function lockRowsByIds(
  connection,
  { table, idColumn, ids, selectColumns },
) {
  const sortedIds = uniqueSortedIds(ids);

  if (sortedIds.length === 0) {
    return [];
  }

  const placeholders = sortedIds.map(() => '?').join(', ');
  const [rows] = await connection.execute(
    `SELECT ${selectColumns}
     FROM ${table}
     WHERE ${idColumn} IN (${placeholders})
     ORDER BY ${idColumn}
     FOR UPDATE`,
    sortedIds,
  );

  return rows;
}

export {
  countAsSafeNumber,
  getLastInsertId,
  lockRowsByIds,
  uniqueSortedIds,
  withCatalogTransaction,
};
