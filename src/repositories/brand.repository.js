import pool from '../config/database.js';
import { databaseBoolean, toIsoString } from '../utils/record.js';
import { insertAuditLog } from './audit.repository.js';

const BRAND_COLUMNS = `
  CAST(b.brand_id AS CHAR) AS brandId,
  b.brand_code AS brandCode,
  b.brand_name AS brandName,
  b.description,
  b.is_active AS isActive,
  b.created_at AS createdAt,
  b.updated_at AS updatedAt
`;

const BRAND_UPDATE_COLUMNS = Object.freeze({
  brandCode: 'brand_code',
  brandName: 'brand_name',
  description: 'description',
  isActive: 'is_active',
});

function countAsSafeNumber(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error('The brand count query returned an invalid result.');
  }

  const count = BigInt(value);

  if (count > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('The brand count exceeds the supported API range.');
  }

  return Number(count);
}

function normalizeBrand(row) {
  if (!row) {
    return null;
  }

  return {
    brandId: row.brandId,
    brandCode: row.brandCode,
    brandName: row.brandName,
    description: row.description ?? null,
    isActive: databaseBoolean(row.isActive),
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

function brandAuditSnapshot(brand) {
  return {
    brandId: brand.brandId,
    brandCode: brand.brandCode,
    brandName: brand.brandName,
    description: brand.description,
    isActive: brand.isActive,
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

async function selectBrand(executor, brandId, { forUpdate = false } = {}) {
  const [rows] = await executor.execute(
    `SELECT ${BRAND_COLUMNS}
     FROM brands b
     WHERE b.brand_id = ?
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [brandId],
  );

  return normalizeBrand(rows[0]);
}

async function lockReferencingProducts(connection, brandId) {
  const [rows] = await connection.execute(
    `SELECT
       CAST(p.product_id AS CHAR) AS productId,
       p.status
     FROM products p
     WHERE p.brand_id = ?
     ORDER BY p.product_id
     FOR UPDATE`,
    [brandId],
  );

  return rows;
}

async function listBrandRecords({ search, isActive, limit, offset }) {
  const predicates = [];
  const parameters = [];

  if (search) {
    predicates.push(`LOCATE(
      ?,
      CONCAT_WS(
        ' ',
        b.brand_code,
        b.brand_name,
        COALESCE(b.description, '')
      )
    ) > 0`);
    parameters.push(search);
  }

  if (isActive !== null) {
    predicates.push('b.is_active = ?');
    parameters.push(isActive ? 1 : 0);
  }

  const whereClause =
    predicates.length === 0 ? '' : `WHERE ${predicates.join(' AND ')}`;
  const [countRows] = await pool.execute(
    `SELECT CAST(COUNT(*) AS CHAR) AS totalItems
     FROM brands b
     ${whereClause}`,
    parameters,
  );
  const [rows] = await pool.execute(
    `SELECT ${BRAND_COLUMNS}
     FROM brands b
     ${whereClause}
     ORDER BY b.brand_name, b.brand_id
     LIMIT ? OFFSET ?`,
    [...parameters, limit, offset],
  );

  return {
    items: rows.map(normalizeBrand),
    totalItems: countAsSafeNumber(countRows[0].totalItems),
  };
}

async function findBrandById(brandId) {
  return selectBrand(pool, brandId);
}

async function createBrandRecord(values, auditContext) {
  return withTransaction(async (connection) => {
    await connection.execute(
      `INSERT INTO brands (
         brand_code,
         brand_name,
         description,
         is_active
       ) VALUES (?, ?, ?, ?)`,
      [
        values.brandCode,
        values.brandName,
        values.description,
        values.isActive ? 1 : 0,
      ],
    );
    const brandId = await getLastInsertId(connection);
    const brand = await selectBrand(connection, brandId);

    await insertAuditLog(connection, {
      auditContext,
      actionType: 'BRAND_CREATED',
      entityType: 'brands',
      entityRecordId: brandId,
      beforeValues: null,
      afterValues: brandAuditSnapshot(brand),
      notes: 'Brand created through the catalog administration API.',
    });

    return brand;
  });
}

async function updateBrandRecord(brandId, changes, auditContext) {
  return withTransaction(async (connection) => {
    const currentBrand = await selectBrand(connection, brandId, {
      forUpdate: true,
    });

    if (!currentBrand) {
      return { outcome: 'not_found' };
    }

    const changedEntries = Object.entries(changes).filter(
      ([field, value]) => currentBrand[field] !== value,
    );

    if (changedEntries.length === 0) {
      return { outcome: 'unchanged', brand: currentBrand };
    }

    if (currentBrand.isActive && changes.isActive === false) {
      const referencingProducts = await lockReferencingProducts(
        connection,
        brandId,
      );

      if (referencingProducts.some((product) => product.status === 'ACTIVE')) {
        return { outcome: 'active_product_dependency' };
      }
    }

    const assignments = changedEntries.map(
      ([field]) => `${BRAND_UPDATE_COLUMNS[field]} = ?`,
    );
    const parameters = changedEntries.map(([field, value]) =>
      field === 'isActive' ? (value ? 1 : 0) : value,
    );

    await connection.execute(
      `UPDATE brands
       SET ${assignments.join(', ')}
       WHERE brand_id = ?`,
      [...parameters, brandId],
    );
    const brand = await selectBrand(connection, brandId);

    await insertAuditLog(connection, {
      auditContext,
      actionType: 'BRAND_UPDATED',
      entityType: 'brands',
      entityRecordId: brandId,
      beforeValues: brandAuditSnapshot(currentBrand),
      afterValues: brandAuditSnapshot(brand),
      notes: 'Brand updated through the catalog administration API.',
    });

    return { outcome: 'updated', brand };
  });
}

export {
  createBrandRecord,
  findBrandById,
  listBrandRecords,
  updateBrandRecord,
};
