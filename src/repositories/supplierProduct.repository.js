import pool from '../config/database.js';
import { databaseBoolean, toIsoString } from '../utils/record.js';
import { insertAuditLog } from './audit.repository.js';
import {
  countAsSafeNumber,
  withCatalogTransaction,
} from './productCatalog.repository.js';

const SUPPLIER_PRODUCT_COLUMNS = `
  CAST(sp.supplier_id AS CHAR) AS supplierId,
  CAST(sp.product_variant_id AS CHAR) AS supplierProductId,
  CAST(sp.product_variant_id AS CHAR) AS productVariantId,
  sp.supplier_sku AS supplierSku,
  sp.is_preferred AS isPreferred,
  sp.lead_time_days AS leadTimeDays,
  sp.minimum_order_quantity AS minimumOrderQuantity,
  sp.created_at AS createdAt,
  sp.updated_at AS updatedAt,
  s.supplier_code AS supplierCode,
  s.supplier_name AS supplierName,
  s.status AS supplierStatus,
  pv.sku,
  pv.variant_name AS variantName,
  pv.status AS variantStatus,
  CAST(p.product_id AS CHAR) AS productId,
  p.product_name AS productName,
  p.status AS productStatus
`;

const UPDATE_COLUMNS = Object.freeze({
  supplierSku: 'supplier_sku',
  isPreferred: 'is_preferred',
  leadTimeDays: 'lead_time_days',
  minimumOrderQuantity: 'minimum_order_quantity',
});

function normalizeSupplierProduct(row) {
  if (!row) {
    return null;
  }

  return {
    supplierId: row.supplierId,
    supplierProductId: row.supplierProductId,
    productVariantId: row.productVariantId,
    supplierSku: row.supplierSku ?? null,
    isPreferred: databaseBoolean(row.isPreferred),
    leadTimeDays: row.leadTimeDays ?? null,
    minimumOrderQuantity: row.minimumOrderQuantity,
    supplierCode: row.supplierCode,
    supplierName: row.supplierName,
    supplierStatus: row.supplierStatus,
    productId: row.productId,
    productName: row.productName,
    productStatus: row.productStatus,
    sku: row.sku,
    variantName: row.variantName,
    variantStatus: row.variantStatus,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

function auditSnapshot(record) {
  return {
    supplierId: record.supplierId,
    productVariantId: record.productVariantId,
    supplierSku: record.supplierSku,
    isPreferred: record.isPreferred,
    leadTimeDays: record.leadTimeDays,
    minimumOrderQuantity: record.minimumOrderQuantity,
  };
}

async function selectSupplierProduct(executor, supplierId, productVariantId) {
  const [rows] = await executor.execute(
    `SELECT ${SUPPLIER_PRODUCT_COLUMNS}
     FROM supplier_products sp
     INNER JOIN suppliers s ON s.supplier_id = sp.supplier_id
     INNER JOIN product_variants pv
       ON pv.product_variant_id = sp.product_variant_id
     INNER JOIN products p ON p.product_id = pv.product_id
     WHERE sp.supplier_id = ?
       AND sp.product_variant_id = ?
     LIMIT 1`,
    [supplierId, productVariantId],
  );

  return normalizeSupplierProduct(rows[0]);
}

async function selectSupplierState(executor, supplierId) {
  const [rows] = await executor.execute(
    `SELECT CAST(supplier_id AS CHAR) AS supplierId, status
     FROM suppliers
     WHERE supplier_id = ?
     LIMIT 1`,
    [supplierId],
  );

  return rows[0] ?? null;
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

async function lockProductAndVariant(connection, productId, productVariantId) {
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

  await connection.execute(
    `SELECT product_package_id
     FROM product_packages
     WHERE product_variant_id = ?
     ORDER BY product_package_id
     FOR UPDATE`,
    [productVariantId],
  );

  return {
    productStatus: productRows[0].status,
    variantStatus: variantRows[0].status,
  };
}

async function lockSupplier(connection, supplierId) {
  const [rows] = await connection.execute(
    `SELECT CAST(supplier_id AS CHAR) AS supplierId, status
     FROM suppliers
     WHERE supplier_id = ?
     LIMIT 1
     FOR UPDATE`,
    [supplierId],
  );

  return rows[0] ?? null;
}

async function lockSupplierRelationships(connection, supplierId, productVariantId) {
  await connection.execute(
    `SELECT product_variant_id
     FROM supplier_products
     WHERE supplier_id = ?
     ORDER BY product_variant_id
     FOR UPDATE`,
    [supplierId],
  );
  const [variantRows] = await connection.execute(
    `SELECT supplier_id, product_variant_id, is_preferred
     FROM supplier_products
     WHERE product_variant_id = ?
     ORDER BY supplier_id
     FOR UPDATE`,
    [productVariantId],
  );

  return variantRows;
}

function lifecycleIsActive(supplier, catalogState) {
  return (
    supplier.status === 'ACTIVE' &&
    catalogState.productStatus === 'ACTIVE' &&
    catalogState.variantStatus === 'ACTIVE'
  );
}

async function listSupplierProducts(
  supplierId,
  { search, productVariantId, isPreferred, limit, offset },
) {
  if (!(await selectSupplierState(pool, supplierId))) {
    return { outcome: 'supplier_not_found' };
  }

  const predicates = ['sp.supplier_id = ?'];
  const parameters = [supplierId];

  if (search) {
    predicates.push(`LOCATE(
      ?,
      CONCAT_WS(' ', sp.supplier_sku, pv.sku, pv.variant_name, p.product_name)
    ) > 0`);
    parameters.push(search);
  }

  if (productVariantId !== undefined) {
    predicates.push('sp.product_variant_id = ?');
    parameters.push(productVariantId);
  }

  if (isPreferred !== null) {
    predicates.push('sp.is_preferred = ?');
    parameters.push(isPreferred ? 1 : 0);
  }

  const whereClause = `WHERE ${predicates.join(' AND ')}`;
  const [countRows] = await pool.execute(
    `SELECT CAST(COUNT(*) AS CHAR) AS totalItems
     FROM supplier_products sp
     INNER JOIN product_variants pv
       ON pv.product_variant_id = sp.product_variant_id
     INNER JOIN products p ON p.product_id = pv.product_id
     ${whereClause}`,
    parameters,
  );
  const [rows] = await pool.execute(
    `SELECT ${SUPPLIER_PRODUCT_COLUMNS}
     FROM supplier_products sp
     INNER JOIN suppliers s ON s.supplier_id = sp.supplier_id
     INNER JOIN product_variants pv
       ON pv.product_variant_id = sp.product_variant_id
     INNER JOIN products p ON p.product_id = pv.product_id
     ${whereClause}
     ORDER BY p.product_name, pv.variant_name, sp.product_variant_id
     LIMIT ? OFFSET ?`,
    [...parameters, limit, offset],
  );

  return {
    outcome: 'found',
    items: rows.map(normalizeSupplierProduct),
    totalItems: countAsSafeNumber(countRows[0].totalItems, 'supplier product'),
  };
}

async function findSupplierProduct(supplierId, productVariantId) {
  if (!(await selectSupplierState(pool, supplierId))) {
    return { outcome: 'supplier_not_found' };
  }

  const supplierProduct = await selectSupplierProduct(
    pool,
    supplierId,
    productVariantId,
  );

  return supplierProduct
    ? { outcome: 'found', supplierProduct }
    : { outcome: 'not_found' };
}

async function createSupplierProductRecord(
  supplierId,
  values,
  auditContext,
) {
  const identity = await selectVariantIdentity(pool, values.productVariantId);

  if (!identity) {
    return { outcome: 'variant_not_found' };
  }

  return withCatalogTransaction(async (connection) => {
    const catalogState = await lockProductAndVariant(
      connection,
      identity.productId,
      values.productVariantId,
    );

    if (!catalogState) {
      return { outcome: 'variant_not_found' };
    }

    const supplier = await lockSupplier(connection, supplierId);

    if (!supplier) {
      return { outcome: 'supplier_not_found' };
    }

    const relationships = await lockSupplierRelationships(
      connection,
      supplierId,
      values.productVariantId,
    );

    if (
      relationships.some(
        (relationship) =>
          String(relationship.supplier_id) === supplierId,
      )
    ) {
      return { outcome: 'duplicate_relationship' };
    }

    if (!lifecycleIsActive(supplier, catalogState)) {
      return { outcome: 'inactive_catalog_identity' };
    }

    if (
      values.isPreferred &&
      relationships.some((relationship) =>
        databaseBoolean(relationship.is_preferred),
      )
    ) {
      return { outcome: 'preferred_conflict' };
    }

    await connection.execute(
      `INSERT INTO supplier_products (
         supplier_id,
         product_variant_id,
         supplier_sku,
         is_preferred,
         lead_time_days,
         minimum_order_quantity
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        supplierId,
        values.productVariantId,
        values.supplierSku,
        values.isPreferred ? 1 : 0,
        values.leadTimeDays,
        values.minimumOrderQuantity,
      ],
    );
    const supplierProduct = await selectSupplierProduct(
      connection,
      supplierId,
      values.productVariantId,
    );

    await insertAuditLog(connection, {
      auditContext,
      actionType: 'SUPPLIER_PRODUCT_CREATED',
      entityType: 'supplier_products',
      entityRecordId: `${supplierId}:${values.productVariantId}`,
      beforeValues: null,
      afterValues: auditSnapshot(supplierProduct),
      notes: 'Supplier product relationship created through the supplier administration API.',
    });

    return { outcome: 'created', supplierProduct };
  });
}

async function updateSupplierProductRecord(
  supplierId,
  productVariantId,
  changes,
  auditContext,
) {
  const identity = await selectVariantIdentity(pool, productVariantId);

  if (!identity) {
    return { outcome: 'not_found' };
  }

  return withCatalogTransaction(async (connection) => {
    const catalogState = await lockProductAndVariant(
      connection,
      identity.productId,
      productVariantId,
    );

    if (!catalogState) {
      return { outcome: 'not_found' };
    }

    const supplier = await lockSupplier(connection, supplierId);

    if (!supplier) {
      return { outcome: 'supplier_not_found' };
    }

    const relationships = await lockSupplierRelationships(
      connection,
      supplierId,
      productVariantId,
    );
    const current = await selectSupplierProduct(
      connection,
      supplierId,
      productVariantId,
    );

    if (!current) {
      return { outcome: 'not_found' };
    }

    const changedEntries = Object.entries(changes).filter(
      ([field, value]) => current[field] !== value,
    );

    if (changedEntries.length === 0) {
      return { outcome: 'unchanged', supplierProduct: current };
    }

    const resulting = { ...current, ...changes };

    if (resulting.isPreferred) {
      if (!lifecycleIsActive(supplier, catalogState)) {
        return { outcome: 'inactive_catalog_identity' };
      }

      if (
        relationships.some(
          (relationship) =>
            String(relationship.supplier_id) !== supplierId &&
            databaseBoolean(relationship.is_preferred),
        )
      ) {
        return { outcome: 'preferred_conflict' };
      }
    }

    const assignments = changedEntries.map(
      ([field]) => `${UPDATE_COLUMNS[field]} = ?`,
    );
    const parameters = changedEntries.map(([field, value]) =>
      field === 'isPreferred' ? (value ? 1 : 0) : value,
    );

    await connection.execute(
      `UPDATE supplier_products
       SET ${assignments.join(', ')}
       WHERE supplier_id = ?
         AND product_variant_id = ?`,
      [...parameters, supplierId, productVariantId],
    );
    const supplierProduct = await selectSupplierProduct(
      connection,
      supplierId,
      productVariantId,
    );

    await insertAuditLog(connection, {
      auditContext,
      actionType: 'SUPPLIER_PRODUCT_UPDATED',
      entityType: 'supplier_products',
      entityRecordId: `${supplierId}:${productVariantId}`,
      beforeValues: auditSnapshot(current),
      afterValues: auditSnapshot(supplierProduct),
      notes: 'Supplier product relationship updated through the supplier administration API.',
    });

    return { outcome: 'updated', supplierProduct };
  });
}

export {
  createSupplierProductRecord,
  findSupplierProduct,
  listSupplierProducts,
  updateSupplierProductRecord,
};
