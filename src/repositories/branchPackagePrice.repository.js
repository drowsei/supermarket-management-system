import pool from '../config/database.js';
import { databaseBoolean, toIsoString } from '../utils/record.js';
import { insertAuditLog } from './audit.repository.js';
import {
  countAsSafeNumber,
  withCatalogTransaction,
} from './productCatalog.repository.js';

const BRANCH_PACKAGE_PRICE_COLUMNS = `
  CAST(bpp.branch_id AS CHAR) AS branchId,
  CAST(bpp.product_package_id AS CHAR) AS productPackageId,
  CAST(pp.product_variant_id AS CHAR) AS productVariantId,
  bpp.selling_price AS sellingPrice,
  DATE_FORMAT(bpp.effective_from, '%Y-%m-%dT%H:%i:%s.%fZ') AS effectiveFrom,
  bpp.is_active AS isActive,
  CAST(bpp.updated_by_employee_id AS CHAR) AS updatedByEmployeeId,
  CASE
    WHEN bpp.is_active = 0 THEN 'INACTIVE'
    WHEN bpp.effective_from > UTC_TIMESTAMP(6) THEN 'FUTURE'
    ELSE 'EFFECTIVE'
  END AS effectiveStatus,
  bpp.created_at AS createdAt,
  bpp.updated_at AS updatedAt,
  pp.package_code AS packageCode,
  pp.package_name AS packageName,
  pv.sku,
  pv.variant_name AS variantName,
  p.product_name AS productName
`;

function normalizeBranchPackagePrice(row) {
  if (!row) {
    return null;
  }

  return {
    branchId: row.branchId,
    productPackageId: row.productPackageId,
    productVariantId: row.productVariantId,
    packageCode: row.packageCode,
    packageName: row.packageName,
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

function branchPackagePriceAuditSnapshot(branchPackagePrice) {
  return {
    branchId: branchPackagePrice.branchId,
    productPackageId: branchPackagePrice.productPackageId,
    productVariantId: branchPackagePrice.productVariantId,
    sellingPrice: branchPackagePrice.sellingPrice,
    effectiveFrom: branchPackagePrice.effectiveFrom,
    isActive: branchPackagePrice.isActive,
    updatedByEmployeeId: branchPackagePrice.updatedByEmployeeId,
  };
}

async function selectPackageIdentity(executor, productPackageId) {
  const [rows] = await executor.execute(
    `SELECT
       CAST(pp.product_package_id AS CHAR) AS productPackageId,
       CAST(pp.product_variant_id AS CHAR) AS productVariantId,
       CAST(pv.product_id AS CHAR) AS productId
     FROM product_packages pp
     INNER JOIN product_variants pv
       ON pv.product_variant_id = pp.product_variant_id
     WHERE pp.product_package_id = ?
     LIMIT 1`,
    [productPackageId],
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

async function lockPackage(connection, productVariantId, productPackageId) {
  const [rows] = await connection.execute(
    `SELECT product_package_id
     FROM product_packages
     WHERE product_package_id = ?
       AND product_variant_id = ?
     LIMIT 1
     FOR UPDATE`,
    [productPackageId, productVariantId],
  );

  return rows.length === 1;
}

async function selectBranchPackagePrice(
  executor,
  branchId,
  productPackageId,
  { forUpdate = false } = {},
) {
  const [rows] = await executor.execute(
    `SELECT ${BRANCH_PACKAGE_PRICE_COLUMNS}
     FROM branch_package_prices bpp
     INNER JOIN product_packages pp
       ON pp.product_package_id = bpp.product_package_id
     INNER JOIN product_variants pv
       ON pv.product_variant_id = pp.product_variant_id
     INNER JOIN products p
       ON p.product_id = pv.product_id
     WHERE bpp.branch_id = ?
       AND bpp.product_package_id = ?
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [branchId, productPackageId],
  );

  return normalizeBranchPackagePrice(rows[0]);
}

async function listBranchPackagePriceRecords(
  branchId,
  { search, isActive, effectiveStatus, limit, offset },
) {
  const predicates = ['bpp.branch_id = ?'];
  const parameters = [branchId];

  if (search) {
    predicates.push(`(
      LOCATE(?, pp.package_code) > 0
      OR LOCATE(?, pp.package_name) > 0
      OR LOCATE(?, pv.sku) > 0
      OR LOCATE(?, pv.variant_name) > 0
      OR LOCATE(?, p.product_name) > 0
    )`);
    parameters.push(search, search, search, search, search);
  }

  if (isActive !== null) {
    predicates.push('bpp.is_active = ?');
    parameters.push(isActive ? 1 : 0);
  }

  if (effectiveStatus === 'EFFECTIVE') {
    predicates.push('bpp.is_active = 1 AND bpp.effective_from <= UTC_TIMESTAMP(6)');
  } else if (effectiveStatus === 'FUTURE') {
    predicates.push('bpp.is_active = 1 AND bpp.effective_from > UTC_TIMESTAMP(6)');
  } else if (effectiveStatus === 'INACTIVE') {
    predicates.push('bpp.is_active = 0');
  }

  const whereClause = `WHERE ${predicates.join(' AND ')}`;
  const [countRows] = await pool.execute(
    `SELECT CAST(COUNT(*) AS CHAR) AS totalItems
     FROM branch_package_prices bpp
     INNER JOIN product_packages pp
       ON pp.product_package_id = bpp.product_package_id
     INNER JOIN product_variants pv
       ON pv.product_variant_id = pp.product_variant_id
     INNER JOIN products p
       ON p.product_id = pv.product_id
     ${whereClause}`,
    parameters,
  );
  const [rows] = await pool.execute(
    `SELECT ${BRANCH_PACKAGE_PRICE_COLUMNS}
     FROM branch_package_prices bpp
     INNER JOIN product_packages pp
       ON pp.product_package_id = bpp.product_package_id
     INNER JOIN product_variants pv
       ON pv.product_variant_id = pp.product_variant_id
     INNER JOIN products p
       ON p.product_id = pv.product_id
     ${whereClause}
     ORDER BY p.product_name, pv.variant_name, pp.package_name, pp.product_package_id
     LIMIT ? OFFSET ?`,
    [...parameters, limit, offset],
  );

  return {
    items: rows.map(normalizeBranchPackagePrice),
    totalItems: countAsSafeNumber(
      countRows[0].totalItems,
      'branch package price',
    ),
  };
}

async function findBranchPackagePrice(branchId, productPackageId) {
  if (!(await selectPackageIdentity(pool, productPackageId))) {
    return { outcome: 'package_not_found' };
  }

  const branchPackagePrice = await selectBranchPackagePrice(
    pool,
    branchId,
    productPackageId,
  );

  return branchPackagePrice
    ? { outcome: 'found', branchPackagePrice }
    : { outcome: 'configuration_not_found' };
}

async function putBranchPackagePriceRecord(
  branchId,
  productPackageId,
  values,
  auditContext,
) {
  const identity = await selectPackageIdentity(pool, productPackageId);

  if (!identity) {
    return { outcome: 'package_not_found' };
  }

  return withCatalogTransaction(async (connection) => {
    if (!(await lockBranch(connection, branchId))) {
      return { outcome: 'branch_not_found' };
    }

    if (!(await lockProduct(connection, identity.productId))) {
      return { outcome: 'package_not_found' };
    }

    if (
      !(await lockVariant(
        connection,
        identity.productId,
        identity.productVariantId,
      ))
    ) {
      return { outcome: 'package_not_found' };
    }

    if (
      !(await lockPackage(
        connection,
        identity.productVariantId,
        productPackageId,
      ))
    ) {
      return { outcome: 'package_not_found' };
    }

    const current = await selectBranchPackagePrice(
      connection,
      branchId,
      productPackageId,
      { forUpdate: true },
    );
    const updatedByEmployeeId = auditContext?.actorEmployeeId ?? null;

    if (!current) {
      await connection.execute(
        `INSERT INTO branch_package_prices (
           branch_id,
           product_package_id,
           selling_price,
           effective_from,
           is_active,
           updated_by_employee_id
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          branchId,
          productPackageId,
          values.sellingPrice,
          values.effectiveFromDatabase,
          values.isActive ? 1 : 0,
          updatedByEmployeeId,
        ],
      );
      const branchPackagePrice = await selectBranchPackagePrice(
        connection,
        branchId,
        productPackageId,
      );

      await insertAuditLog(connection, {
        auditContext,
        branchId,
        actionType: 'BRANCH_PACKAGE_PRICE_CREATED',
        entityType: 'branch_package_prices',
        entityRecordId: `${branchId}:${productPackageId}`,
        beforeValues: null,
        afterValues: branchPackagePriceAuditSnapshot(branchPackagePrice),
        notes: 'Branch package price configured through the pricing administration API.',
      });

      return { outcome: 'created', branchPackagePrice };
    }

    const unchanged =
      current.sellingPrice === values.sellingPrice &&
      current.effectiveFrom === values.effectiveFrom &&
      current.isActive === values.isActive;

    if (unchanged) {
      return { outcome: 'unchanged', branchPackagePrice: current };
    }

    await connection.execute(
      `UPDATE branch_package_prices
       SET selling_price = ?,
           effective_from = ?,
           is_active = ?,
           updated_by_employee_id = ?
       WHERE branch_id = ?
         AND product_package_id = ?`,
      [
        values.sellingPrice,
        values.effectiveFromDatabase,
        values.isActive ? 1 : 0,
        updatedByEmployeeId,
        branchId,
        productPackageId,
      ],
    );
    const branchPackagePrice = await selectBranchPackagePrice(
      connection,
      branchId,
      productPackageId,
    );

    await insertAuditLog(connection, {
      auditContext,
      branchId,
      actionType: 'BRANCH_PACKAGE_PRICE_UPDATED',
      entityType: 'branch_package_prices',
      entityRecordId: `${branchId}:${productPackageId}`,
      beforeValues: branchPackagePriceAuditSnapshot(current),
      afterValues: branchPackagePriceAuditSnapshot(branchPackagePrice),
      notes: 'Branch package price updated through the pricing administration API.',
    });

    return { outcome: 'updated', branchPackagePrice };
  });
}

export {
  findBranchPackagePrice,
  listBranchPackagePriceRecords,
  putBranchPackagePriceRecord,
};
