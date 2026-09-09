import pool from '../config/database.js';
import { databaseBoolean, toIsoString } from '../utils/record.js';
import { insertAuditLog } from './audit.repository.js';
import {
  countAsSafeNumber,
  withCatalogTransaction,
} from './productCatalog.repository.js';

const SUPPLIER_PACKAGE_COLUMNS = `
  CAST(spp.supplier_id AS CHAR) AS supplierId,
  CAST(spp.product_package_id AS CHAR) AS supplierProductPackageId,
  CAST(spp.product_package_id AS CHAR) AS productPackageId,
  CAST(spp.product_variant_id AS CHAR) AS supplierProductId,
  CAST(spp.product_variant_id AS CHAR) AS productVariantId,
  spp.supplier_package_sku AS supplierPackageSku,
  spp.minimum_package_quantity AS minimumPackageQuantity,
  spp.is_active AS isActive,
  spp.created_at AS createdAt,
  spp.updated_at AS updatedAt,
  sp.supplier_sku AS supplierSku,
  s.supplier_code AS supplierCode,
  s.supplier_name AS supplierName,
  s.status AS supplierStatus,
  pp.package_code AS packageCode,
  pp.package_name AS packageName,
  pp.conversion_to_base_quantity AS conversionToBaseQuantity,
  pp.is_purchasable AS isPurchasable,
  pp.status AS packageStatus,
  pv.sku,
  pv.variant_name AS variantName,
  pv.status AS variantStatus,
  CAST(p.product_id AS CHAR) AS productId,
  p.product_name AS productName,
  p.status AS productStatus
`;

const UPDATE_COLUMNS = Object.freeze({
  supplierPackageSku: 'supplier_package_sku',
  minimumPackageQuantity: 'minimum_package_quantity',
  isActive: 'is_active',
});

function normalizeSupplierProductPackage(row) {
  if (!row) {
    return null;
  }

  return {
    supplierId: row.supplierId,
    supplierProductPackageId: row.supplierProductPackageId,
    productPackageId: row.productPackageId,
    supplierProductId: row.supplierProductId,
    productVariantId: row.productVariantId,
    supplierPackageSku: row.supplierPackageSku ?? null,
    minimumPackageQuantity: row.minimumPackageQuantity,
    isActive: databaseBoolean(row.isActive),
    supplierSku: row.supplierSku ?? null,
    supplierCode: row.supplierCode,
    supplierName: row.supplierName,
    supplierStatus: row.supplierStatus,
    productId: row.productId,
    productName: row.productName,
    productStatus: row.productStatus,
    sku: row.sku,
    variantName: row.variantName,
    variantStatus: row.variantStatus,
    packageCode: row.packageCode,
    packageName: row.packageName,
    conversionToBaseQuantity: row.conversionToBaseQuantity,
    isPurchasable: databaseBoolean(row.isPurchasable),
    packageStatus: row.packageStatus,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

function auditSnapshot(record) {
  return {
    supplierId: record.supplierId,
    productVariantId: record.productVariantId,
    productPackageId: record.productPackageId,
    supplierPackageSku: record.supplierPackageSku,
    minimumPackageQuantity: record.minimumPackageQuantity,
    isActive: record.isActive,
  };
}

async function selectSupplier(executor, supplierId) {
  const [rows] = await executor.execute(
    `SELECT CAST(supplier_id AS CHAR) AS supplierId, status
     FROM suppliers
     WHERE supplier_id = ?
     LIMIT 1`,
    [supplierId],
  );

  return rows[0] ?? null;
}

async function selectSupplierProduct(executor, supplierId, productVariantId) {
  const [rows] = await executor.execute(
    `SELECT
       CAST(sp.supplier_id AS CHAR) AS supplierId,
       CAST(sp.product_variant_id AS CHAR) AS productVariantId,
       CAST(pv.product_id AS CHAR) AS productId
     FROM supplier_products sp
     INNER JOIN product_variants pv
       ON pv.product_variant_id = sp.product_variant_id
     WHERE sp.supplier_id = ?
       AND sp.product_variant_id = ?
     LIMIT 1`,
    [supplierId, productVariantId],
  );

  return rows[0] ?? null;
}

async function selectPackageIdentity(executor, productPackageId) {
  const [rows] = await executor.execute(
    `SELECT
       CAST(pp.product_package_id AS CHAR) AS productPackageId,
       CAST(pp.product_variant_id AS CHAR) AS productVariantId
     FROM product_packages pp
     WHERE pp.product_package_id = ?
     LIMIT 1`,
    [productPackageId],
  );

  return rows[0] ?? null;
}

async function selectSupplierProductPackage(
  executor,
  supplierId,
  productPackageId,
) {
  const [rows] = await executor.execute(
    `SELECT ${SUPPLIER_PACKAGE_COLUMNS}
     FROM supplier_product_packages spp
     INNER JOIN supplier_products sp
       ON sp.supplier_id = spp.supplier_id
      AND sp.product_variant_id = spp.product_variant_id
     INNER JOIN suppliers s ON s.supplier_id = sp.supplier_id
     INNER JOIN product_packages pp
       ON pp.product_package_id = spp.product_package_id
      AND pp.product_variant_id = spp.product_variant_id
     INNER JOIN product_variants pv
       ON pv.product_variant_id = spp.product_variant_id
     INNER JOIN products p ON p.product_id = pv.product_id
     WHERE spp.supplier_id = ?
       AND spp.product_package_id = ?
     LIMIT 1`,
    [supplierId, productPackageId],
  );

  return normalizeSupplierProductPackage(rows[0]);
}

async function lockCatalogHierarchy(
  connection,
  productId,
  productVariantId,
) {
  const [productRows] = await connection.execute(
    `SELECT CAST(product_id AS CHAR) AS productId, status
     FROM products
     WHERE product_id = ?
     LIMIT 1
     FOR UPDATE`,
    [productId],
  );

  if (!productRows[0]) {
    return null;
  }

  const [variantRows] = await connection.execute(
    `SELECT CAST(product_variant_id AS CHAR) AS productVariantId, status
     FROM product_variants
     WHERE product_variant_id = ?
       AND product_id = ?
     LIMIT 1
     FOR UPDATE`,
    [productVariantId, productId],
  );

  if (!variantRows[0]) {
    return null;
  }

  const [packageRows] = await connection.execute(
    `SELECT
       CAST(product_package_id AS CHAR) AS productPackageId,
       CAST(product_variant_id AS CHAR) AS productVariantId,
       is_purchasable AS isPurchasable,
       status
     FROM product_packages
     WHERE product_variant_id = ?
     ORDER BY product_package_id
     FOR UPDATE`,
    [productVariantId],
  );

  return {
    productStatus: productRows[0].status,
    variantStatus: variantRows[0].status,
    packages: packageRows.map((row) => ({
      productPackageId: row.productPackageId,
      productVariantId: row.productVariantId,
      isPurchasable: databaseBoolean(row.isPurchasable),
      status: row.status,
    })),
  };
}

async function lockSupplierHierarchy(connection, supplierId, productVariantId) {
  const [supplierRows] = await connection.execute(
    `SELECT CAST(supplier_id AS CHAR) AS supplierId, status
     FROM suppliers
     WHERE supplier_id = ?
     LIMIT 1
     FOR UPDATE`,
    [supplierId],
  );

  if (!supplierRows[0]) {
    return null;
  }

  await connection.execute(
    `SELECT product_variant_id
     FROM supplier_products
     WHERE supplier_id = ?
     ORDER BY product_variant_id
     FOR UPDATE`,
    [supplierId],
  );
  const [supplierProductRows] = await connection.execute(
    `SELECT supplier_id, product_variant_id
     FROM supplier_products
     WHERE product_variant_id = ?
     ORDER BY supplier_id
     FOR UPDATE`,
    [productVariantId],
  );
  await connection.execute(
    `SELECT product_package_id
     FROM supplier_product_packages
     WHERE supplier_id = ?
     ORDER BY product_package_id
     FOR UPDATE`,
    [supplierId],
  );
  await connection.execute(
    `SELECT supplier_id, product_package_id
     FROM supplier_product_packages
     WHERE product_variant_id = ?
     ORDER BY supplier_id, product_package_id
     FOR UPDATE`,
    [productVariantId],
  );

  return {
    supplier: supplierRows[0],
    hasSupplierProduct: supplierProductRows.some(
      (row) => String(row.supplier_id) === supplierId,
    ),
  };
}

function activePackageConfiguration(catalogState, supplierState, targetPackage) {
  return (
    catalogState.productStatus === 'ACTIVE' &&
    catalogState.variantStatus === 'ACTIVE' &&
    supplierState.supplier.status === 'ACTIVE' &&
    targetPackage.status === 'ACTIVE' &&
    targetPackage.isPurchasable
  );
}

async function listSupplierProductPackages(
  supplierId,
  productVariantId,
  { search, productPackageId, isActive, limit, offset },
) {
  if (!(await selectSupplier(pool, supplierId))) {
    return { outcome: 'supplier_not_found' };
  }

  if (!(await selectSupplierProduct(pool, supplierId, productVariantId))) {
    return { outcome: 'supplier_product_not_found' };
  }

  const predicates = [
    'spp.supplier_id = ?',
    'spp.product_variant_id = ?',
  ];
  const parameters = [supplierId, productVariantId];

  if (search) {
    predicates.push(`LOCATE(
      ?,
      CONCAT_WS(' ', spp.supplier_package_sku, pp.package_code, pp.package_name)
    ) > 0`);
    parameters.push(search);
  }

  if (productPackageId !== undefined) {
    predicates.push('spp.product_package_id = ?');
    parameters.push(productPackageId);
  }

  if (isActive !== null) {
    predicates.push('spp.is_active = ?');
    parameters.push(isActive ? 1 : 0);
  }

  const whereClause = `WHERE ${predicates.join(' AND ')}`;
  const joins = `
    FROM supplier_product_packages spp
    INNER JOIN supplier_products sp
      ON sp.supplier_id = spp.supplier_id
     AND sp.product_variant_id = spp.product_variant_id
    INNER JOIN suppliers s ON s.supplier_id = sp.supplier_id
    INNER JOIN product_packages pp
      ON pp.product_package_id = spp.product_package_id
     AND pp.product_variant_id = spp.product_variant_id
    INNER JOIN product_variants pv
      ON pv.product_variant_id = spp.product_variant_id
    INNER JOIN products p ON p.product_id = pv.product_id
  `;
  const [countRows] = await pool.execute(
    `SELECT CAST(COUNT(*) AS CHAR) AS totalItems
     ${joins}
     ${whereClause}`,
    parameters,
  );
  const [rows] = await pool.execute(
    `SELECT ${SUPPLIER_PACKAGE_COLUMNS}
     ${joins}
     ${whereClause}
     ORDER BY pp.package_name, spp.product_package_id
     LIMIT ? OFFSET ?`,
    [...parameters, limit, offset],
  );

  return {
    outcome: 'found',
    items: rows.map(normalizeSupplierProductPackage),
    totalItems: countAsSafeNumber(
      countRows[0].totalItems,
      'supplier product package',
    ),
  };
}

async function findSupplierProductPackage(supplierId, productPackageId) {
  if (!(await selectSupplier(pool, supplierId))) {
    return { outcome: 'supplier_not_found' };
  }

  const supplierProductPackage = await selectSupplierProductPackage(
    pool,
    supplierId,
    productPackageId,
  );

  return supplierProductPackage
    ? { outcome: 'found', supplierProductPackage }
    : { outcome: 'not_found' };
}

async function createSupplierProductPackageRecord(
  supplierId,
  productVariantId,
  values,
  auditContext,
) {
  if (!(await selectSupplier(pool, supplierId))) {
    return { outcome: 'supplier_not_found' };
  }

  const parent = await selectSupplierProduct(
    pool,
    supplierId,
    productVariantId,
  );

  if (!parent) {
    return { outcome: 'supplier_product_not_found' };
  }

  const packageIdentity = await selectPackageIdentity(
    pool,
    values.productPackageId,
  );

  if (!packageIdentity) {
    return { outcome: 'package_not_found' };
  }

  if (packageIdentity.productVariantId !== productVariantId) {
    return { outcome: 'package_variant_mismatch' };
  }

  return withCatalogTransaction(async (connection) => {
    const catalogState = await lockCatalogHierarchy(
      connection,
      parent.productId,
      productVariantId,
    );

    if (!catalogState) {
      return { outcome: 'supplier_product_not_found' };
    }

    const supplierState = await lockSupplierHierarchy(
      connection,
      supplierId,
      productVariantId,
    );

    if (!supplierState) {
      return { outcome: 'supplier_not_found' };
    }

    if (!supplierState.hasSupplierProduct) {
      return { outcome: 'supplier_product_not_found' };
    }

    const targetPackage = catalogState.packages.find(
      (productPackage) =>
        productPackage.productPackageId === values.productPackageId,
    );

    if (!targetPackage) {
      return { outcome: 'package_variant_mismatch' };
    }

    if (
      await selectSupplierProductPackage(
        connection,
        supplierId,
        values.productPackageId,
      )
    ) {
      return { outcome: 'duplicate_relationship' };
    }

    if (!activePackageConfiguration(catalogState, supplierState, targetPackage)) {
      return { outcome: 'inactive_catalog_identity' };
    }

    await connection.execute(
      `INSERT INTO supplier_product_packages (
         supplier_id,
         product_package_id,
         product_variant_id,
         supplier_package_sku,
         minimum_package_quantity,
         is_active
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        supplierId,
        values.productPackageId,
        productVariantId,
        values.supplierPackageSku,
        values.minimumPackageQuantity,
        values.isActive ? 1 : 0,
      ],
    );
    const supplierProductPackage = await selectSupplierProductPackage(
      connection,
      supplierId,
      values.productPackageId,
    );

    await insertAuditLog(connection, {
      auditContext,
      actionType: 'SUPPLIER_PRODUCT_PACKAGE_CREATED',
      entityType: 'supplier_product_packages',
      entityRecordId: `${supplierId}:${values.productPackageId}`,
      beforeValues: null,
      afterValues: auditSnapshot(supplierProductPackage),
      notes: 'Supplier package relationship created through the supplier administration API.',
    });

    return { outcome: 'created', supplierProductPackage };
  });
}

async function updateSupplierProductPackageRecord(
  supplierId,
  productPackageId,
  changes,
  auditContext,
) {
  const currentPreRead = await selectSupplierProductPackage(
    pool,
    supplierId,
    productPackageId,
  );

  if (!currentPreRead) {
    return { outcome: 'not_found' };
  }

  return withCatalogTransaction(async (connection) => {
    const catalogState = await lockCatalogHierarchy(
      connection,
      currentPreRead.productId,
      currentPreRead.productVariantId,
    );

    if (!catalogState) {
      return { outcome: 'not_found' };
    }

    const supplierState = await lockSupplierHierarchy(
      connection,
      supplierId,
      currentPreRead.productVariantId,
    );

    if (!supplierState?.hasSupplierProduct) {
      return { outcome: 'not_found' };
    }

    const current = await selectSupplierProductPackage(
      connection,
      supplierId,
      productPackageId,
    );

    if (!current) {
      return { outcome: 'not_found' };
    }

    const changedEntries = Object.entries(changes).filter(
      ([field, value]) => current[field] !== value,
    );

    if (changedEntries.length === 0) {
      return { outcome: 'unchanged', supplierProductPackage: current };
    }

    const targetPackage = catalogState.packages.find(
      (productPackage) => productPackage.productPackageId === productPackageId,
    );
    const resulting = { ...current, ...changes };

    if (
      resulting.isActive &&
      (!targetPackage ||
        !activePackageConfiguration(catalogState, supplierState, targetPackage))
    ) {
      return { outcome: 'inactive_catalog_identity' };
    }

    const assignments = changedEntries.map(
      ([field]) => `${UPDATE_COLUMNS[field]} = ?`,
    );
    const parameters = changedEntries.map(([field, value]) =>
      field === 'isActive' ? (value ? 1 : 0) : value,
    );

    await connection.execute(
      `UPDATE supplier_product_packages
       SET ${assignments.join(', ')}
       WHERE supplier_id = ?
         AND product_package_id = ?`,
      [...parameters, supplierId, productPackageId],
    );
    const supplierProductPackage = await selectSupplierProductPackage(
      connection,
      supplierId,
      productPackageId,
    );

    await insertAuditLog(connection, {
      auditContext,
      actionType: 'SUPPLIER_PRODUCT_PACKAGE_UPDATED',
      entityType: 'supplier_product_packages',
      entityRecordId: `${supplierId}:${productPackageId}`,
      beforeValues: auditSnapshot(current),
      afterValues: auditSnapshot(supplierProductPackage),
      notes: 'Supplier package relationship updated through the supplier administration API.',
    });

    return { outcome: 'updated', supplierProductPackage };
  });
}

export {
  createSupplierProductPackageRecord,
  findSupplierProductPackage,
  listSupplierProductPackages,
  updateSupplierProductPackageRecord,
};
