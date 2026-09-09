import pool from '../config/database.js';
import { databaseBoolean, toIsoString } from '../utils/record.js';
import { insertAuditLog } from './audit.repository.js';
import {
  countAsSafeNumber,
  withCatalogTransaction,
} from './productCatalog.repository.js';

const BRANCH_VARIANT_PRICE_COLUMNS = `
  CAST(bvp.branch_id AS CHAR) AS branchId,
  CAST(bvp.product_variant_id AS CHAR) AS productVariantId,
  bvp.selling_price AS sellingPrice,
  DATE_FORMAT(bvp.effective_from, '%Y-%m-%dT%H:%i:%s.%fZ') AS effectiveFrom,
  bvp.is_active AS isActive,
  CAST(bvp.updated_by_employee_id AS CHAR) AS updatedByEmployeeId,
  CASE
    WHEN bvp.is_active = 0 THEN 'INACTIVE'
    WHEN bvp.effective_from > UTC_TIMESTAMP(6) THEN 'FUTURE'
    ELSE 'EFFECTIVE'
  END AS effectiveStatus,
  bvp.created_at AS createdAt,
  bvp.updated_at AS updatedAt,
  pv.sku,
  pv.variant_name AS variantName,
  p.product_name AS productName
`;

function normalizeBranchVariantPrice(row) {
  if (!row) {
    return null;
  }

  return {
    branchId: row.branchId,
    productVariantId: row.productVariantId,
    sku: row.sku,
    variantName: row.variantName,
    productName: row.productName,
    sellingPrice: row.sellingPrice,
    effectiveFrom: row.effectiveFrom,
    isActive: databaseBoolean(row.isActive),
    effectiveStatus: row.effectiveStatus,
    updatedByEmployeeId: row.updatedByEmployeeId ?? null,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

function branchVariantPriceAuditSnapshot(branchVariantPrice) {
  return {
    branchId: branchVariantPrice.branchId,
    productVariantId: branchVariantPrice.productVariantId,
    sellingPrice: branchVariantPrice.sellingPrice,
    effectiveFrom: branchVariantPrice.effectiveFrom,
    isActive: branchVariantPrice.isActive,
    updatedByEmployeeId: branchVariantPrice.updatedByEmployeeId,
  };
}

async function selectVariantIdentity(executor, productVariantId) {
  const [rows] = await executor.execute(
    `SELECT
       CAST(pv.product_variant_id AS CHAR) AS productVariantId,
       CAST(pv.product_id AS CHAR) AS productId
     FROM product_variants pv
     WHERE pv.product_variant_id = ?
     LIMIT 1`,
    [productVariantId],
  );

  return rows[0] ?? null;
}

async function lockBranch(connection, branchId) {
  const [rows] = await connection.execute(
    `SELECT branch_id
     FROM branches
     WHERE branch_id = ?
     LIMIT 1
     FOR UPDATE`,
    [branchId],
  );

  return rows.length === 1;
}

async function lockProduct(connection, productId) {
  const [rows] = await connection.execute(
    `SELECT product_id
     FROM products
     WHERE product_id = ?
     LIMIT 1
     FOR UPDATE`,
    [productId],
  );

  return rows.length === 1;
}

async function lockVariant(connection, productId, productVariantId) {
  const [rows] = await connection.execute(
    `SELECT product_variant_id
     FROM product_variants
     WHERE product_variant_id = ?
       AND product_id = ?
     LIMIT 1
     FOR UPDATE`,
    [productVariantId, productId],
  );

  return rows.length === 1;
}

async function selectBranchVariantPrice(
  executor,
  branchId,
  productVariantId,
  { forUpdate = false } = {},
) {
  const [rows] = await executor.execute(
    `SELECT ${BRANCH_VARIANT_PRICE_COLUMNS}
     FROM branch_variant_prices bvp
     INNER JOIN product_variants pv
       ON pv.product_variant_id = bvp.product_variant_id
     INNER JOIN products p
       ON p.product_id = pv.product_id
     WHERE bvp.branch_id = ?
       AND bvp.product_variant_id = ?
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [branchId, productVariantId],
  );

  return normalizeBranchVariantPrice(rows[0]);
}

async function listBranchVariantPriceRecords(
  branchId,
  { search, isActive, effectiveStatus, limit, offset },
) {
  const predicates = ['bvp.branch_id = ?'];
  const parameters = [branchId];

  if (search) {
    predicates.push(`(
      LOCATE(?, pv.sku) > 0
      OR LOCATE(?, pv.variant_name) > 0
      OR LOCATE(?, p.product_name) > 0
    )`);
    parameters.push(search, search, search);
  }

  if (isActive !== null) {
    predicates.push('bvp.is_active = ?');
    parameters.push(isActive ? 1 : 0);
  }

  if (effectiveStatus === 'EFFECTIVE') {
    predicates.push('bvp.is_active = 1 AND bvp.effective_from <= UTC_TIMESTAMP(6)');
  } else if (effectiveStatus === 'FUTURE') {
    predicates.push('bvp.is_active = 1 AND bvp.effective_from > UTC_TIMESTAMP(6)');
  } else if (effectiveStatus === 'INACTIVE') {
    predicates.push('bvp.is_active = 0');
  }

  const whereClause = `WHERE ${predicates.join(' AND ')}`;
  const [countRows] = await pool.execute(
    `SELECT CAST(COUNT(*) AS CHAR) AS totalItems
     FROM branch_variant_prices bvp
     INNER JOIN product_variants pv
       ON pv.product_variant_id = bvp.product_variant_id
     INNER JOIN products p
       ON p.product_id = pv.product_id
     ${whereClause}`,
    parameters,
  );
  const [rows] = await pool.execute(
    `SELECT ${BRANCH_VARIANT_PRICE_COLUMNS}
     FROM branch_variant_prices bvp
     INNER JOIN product_variants pv
       ON pv.product_variant_id = bvp.product_variant_id
     INNER JOIN products p
       ON p.product_id = pv.product_id
     ${whereClause}
     ORDER BY p.product_name, pv.variant_name, pv.product_variant_id
     LIMIT ? OFFSET ?`,
    [...parameters, limit, offset],
  );

  return {
    items: rows.map(normalizeBranchVariantPrice),
    totalItems: countAsSafeNumber(
      countRows[0].totalItems,
      'branch variant price',
    ),
  };
}

async function findBranchVariantPrice(branchId, productVariantId) {
  if (!(await selectVariantIdentity(pool, productVariantId))) {
    return { outcome: 'variant_not_found' };
  }

  const branchVariantPrice = await selectBranchVariantPrice(
    pool,
    branchId,
    productVariantId,
  );

  return branchVariantPrice
    ? { outcome: 'found', branchVariantPrice }
    : { outcome: 'configuration_not_found' };
}

async function putBranchVariantPriceRecord(
  branchId,
  productVariantId,
  values,
  auditContext,
) {
  const identity = await selectVariantIdentity(pool, productVariantId);

  if (!identity) {
    return { outcome: 'variant_not_found' };
  }

  return withCatalogTransaction(async (connection) => {
    if (!(await lockBranch(connection, branchId))) {
      return { outcome: 'branch_not_found' };
    }

    if (!(await lockProduct(connection, identity.productId))) {
      return { outcome: 'variant_not_found' };
    }

    if (
      !(await lockVariant(
        connection,
        identity.productId,
        productVariantId,
      ))
    ) {
      return { outcome: 'variant_not_found' };
    }

    const current = await selectBranchVariantPrice(
      connection,
      branchId,
      productVariantId,
      { forUpdate: true },
    );
    const updatedByEmployeeId = auditContext?.actorEmployeeId ?? null;

    if (!current) {
      await connection.execute(
        `INSERT INTO branch_variant_prices (
           branch_id,
           product_variant_id,
           selling_price,
           effective_from,
           is_active,
           updated_by_employee_id
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          branchId,
          productVariantId,
          values.sellingPrice,
          values.effectiveFromDatabase,
          values.isActive ? 1 : 0,
          updatedByEmployeeId,
        ],
      );
      const branchVariantPrice = await selectBranchVariantPrice(
        connection,
        branchId,
        productVariantId,
      );

      await insertAuditLog(connection, {
        auditContext,
        branchId,
        actionType: 'BRANCH_VARIANT_PRICE_CREATED',
        entityType: 'branch_variant_prices',
        entityRecordId: `${branchId}:${productVariantId}`,
        beforeValues: null,
        afterValues: branchVariantPriceAuditSnapshot(branchVariantPrice),
        notes: 'Branch variant price configured through the pricing administration API.',
      });

      return { outcome: 'created', branchVariantPrice };
    }

    const unchanged =
      current.sellingPrice === values.sellingPrice &&
      current.effectiveFrom === values.effectiveFrom &&
      current.isActive === values.isActive;

    if (unchanged) {
      return { outcome: 'unchanged', branchVariantPrice: current };
    }

    await connection.execute(
      `UPDATE branch_variant_prices
       SET selling_price = ?,
           effective_from = ?,
           is_active = ?,
           updated_by_employee_id = ?
       WHERE branch_id = ?
         AND product_variant_id = ?`,
      [
        values.sellingPrice,
        values.effectiveFromDatabase,
        values.isActive ? 1 : 0,
        updatedByEmployeeId,
        branchId,
        productVariantId,
      ],
    );
    const branchVariantPrice = await selectBranchVariantPrice(
      connection,
      branchId,
      productVariantId,
    );

    await insertAuditLog(connection, {
      auditContext,
      branchId,
      actionType: 'BRANCH_VARIANT_PRICE_UPDATED',
      entityType: 'branch_variant_prices',
      entityRecordId: `${branchId}:${productVariantId}`,
      beforeValues: branchVariantPriceAuditSnapshot(current),
      afterValues: branchVariantPriceAuditSnapshot(branchVariantPrice),
      notes: 'Branch variant price updated through the pricing administration API.',
    });

    return { outcome: 'updated', branchVariantPrice };
  });
}

export {
  findBranchVariantPrice,
  listBranchVariantPriceRecords,
  putBranchVariantPriceRecord,
};
