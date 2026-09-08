import pool from '../config/database.js';
import { databaseBoolean, toIsoString } from '../utils/record.js';
import { insertAuditLog } from './audit.repository.js';
import {
  countAsSafeNumber,
  getLastInsertId,
  lockRowsByIds,
  withCatalogTransaction,
} from './productCatalog.repository.js';

const PRODUCT_COLUMNS = `
  CAST(p.product_id AS CHAR) AS productId,
  CAST(p.category_id AS CHAR) AS categoryId,
  CAST(p.brand_id AS CHAR) AS brandId,
  CAST(p.tax_rate_id AS CHAR) AS taxRateId,
  p.product_code AS productCode,
  p.product_name AS productName,
  p.description,
  p.status,
  p.created_at AS createdAt,
  p.updated_at AS updatedAt
`;

const PRODUCT_UPDATE_COLUMNS = Object.freeze({
  categoryId: 'category_id',
  brandId: 'brand_id',
  taxRateId: 'tax_rate_id',
  productCode: 'product_code',
  productName: 'product_name',
  description: 'description',
  status: 'status',
});

function normalizeProduct(row) {
  if (!row) {
    return null;
  }

  return {
    productId: row.productId,
    categoryId: row.categoryId,
    brandId: row.brandId ?? null,
    taxRateId: row.taxRateId ?? null,
    productCode: row.productCode,
    productName: row.productName,
    description: row.description ?? null,
    status: row.status,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

function productAuditSnapshot(product) {
  return {
    productId: product.productId,
    categoryId: product.categoryId,
    brandId: product.brandId,
    taxRateId: product.taxRateId,
    productCode: product.productCode,
    productName: product.productName,
    description: product.description,
    status: product.status,
  };
}

async function selectProduct(executor, productId, { forUpdate = false } = {}) {
  const [rows] = await executor.execute(
    `SELECT ${PRODUCT_COLUMNS}
     FROM products p
     WHERE p.product_id = ?
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [productId],
  );

  return normalizeProduct(rows[0]);
}

async function lockProductReferences(connection, referenceIds) {
  const categoryRows = await lockRowsByIds(connection, {
    table: 'categories',
    idColumn: 'category_id',
    ids: referenceIds.categoryIds,
    selectColumns:
      'CAST(category_id AS CHAR) AS id, is_active AS isActive',
  });
  const brandRows = await lockRowsByIds(connection, {
    table: 'brands',
    idColumn: 'brand_id',
    ids: referenceIds.brandIds,
    selectColumns: 'CAST(brand_id AS CHAR) AS id, is_active AS isActive',
  });
  const taxRows = await lockRowsByIds(connection, {
    table: 'tax_rates',
    idColumn: 'tax_rate_id',
    ids: referenceIds.taxRateIds,
    selectColumns: 'CAST(tax_rate_id AS CHAR) AS id, is_active AS isActive',
  });

  return {
    categories: new Map(
      categoryRows.map((row) => [
        row.id,
        { isActive: databaseBoolean(row.isActive) },
      ]),
    ),
    brands: new Map(
      brandRows.map((row) => [
        row.id,
        { isActive: databaseBoolean(row.isActive) },
      ]),
    ),
    taxRates: new Map(
      taxRows.map((row) => [
        row.id,
        { isActive: databaseBoolean(row.isActive) },
      ]),
    ),
  };
}

function validateLockedReferences(product, references) {
  const category = references.categories.get(product.categoryId);

  if (!category) {
    return 'category_not_found';
  }

  if (product.brandId !== null && !references.brands.has(product.brandId)) {
    return 'brand_not_found';
  }

  if (
    product.taxRateId !== null &&
    !references.taxRates.has(product.taxRateId)
  ) {
    return 'tax_rate_not_found';
  }

  if (product.status !== 'ACTIVE') {
    return null;
  }

  if (!category.isActive) {
    return 'inactive_category';
  }

  if (
    product.brandId !== null &&
    !references.brands.get(product.brandId).isActive
  ) {
    return 'inactive_brand';
  }

  if (
    product.taxRateId !== null &&
    !references.taxRates.get(product.taxRateId).isActive
  ) {
    return 'inactive_tax_rate';
  }

  return null;
}

async function lockActiveVariants(connection, productId) {
  const [rows] = await connection.execute(
    `SELECT CAST(product_variant_id AS CHAR) AS productVariantId
     FROM product_variants
     WHERE product_id = ?
       AND status = 'ACTIVE'
     ORDER BY product_variant_id
     FOR UPDATE`,
    [productId],
  );

  return rows;
}

async function listProducts({
  search,
  status,
  categoryId,
  brandId,
  taxRateId,
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
        p.product_code,
        p.product_name,
        COALESCE(p.description, '')
      )
    ) > 0`);
    parameters.push(search);
  }

  if (status !== null) {
    predicates.push('p.status = ?');
    parameters.push(status);
  }

  if (categoryId !== undefined) {
    predicates.push('p.category_id = ?');
    parameters.push(categoryId);
  }

  if (brandId !== undefined) {
    predicates.push(brandId === null ? 'p.brand_id IS NULL' : 'p.brand_id = ?');
    if (brandId !== null) {
      parameters.push(brandId);
    }
  }

  if (taxRateId !== undefined) {
    predicates.push(
      taxRateId === null ? 'p.tax_rate_id IS NULL' : 'p.tax_rate_id = ?',
    );
    if (taxRateId !== null) {
      parameters.push(taxRateId);
    }
  }

  const whereClause =
    predicates.length === 0 ? '' : `WHERE ${predicates.join(' AND ')}`;
  const [countRows] = await pool.execute(
    `SELECT CAST(COUNT(*) AS CHAR) AS totalItems
     FROM products p
     ${whereClause}`,
    parameters,
  );
  const [rows] = await pool.execute(
    `SELECT ${PRODUCT_COLUMNS}
     FROM products p
     ${whereClause}
     ORDER BY p.product_name, p.product_id
     LIMIT ? OFFSET ?`,
    [...parameters, limit, offset],
  );

  return {
    items: rows.map(normalizeProduct),
    totalItems: countAsSafeNumber(countRows[0].totalItems, 'product'),
  };
}

async function findProductById(productId) {
  return selectProduct(pool, productId);
}

async function createProductRecord(values, auditContext) {
  return withCatalogTransaction(async (connection) => {
    const references = await lockProductReferences(connection, {
      categoryIds: [values.categoryId],
      brandIds: [values.brandId],
      taxRateIds: [values.taxRateId],
    });
    const referenceOutcome = validateLockedReferences(values, references);

    if (referenceOutcome) {
      return { outcome: referenceOutcome };
    }

    await connection.execute(
      `INSERT INTO products (
         category_id,
         brand_id,
         tax_rate_id,
         product_code,
         product_name,
         description,
         status
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        values.categoryId,
        values.brandId,
        values.taxRateId,
        values.productCode,
        values.productName,
        values.description,
        values.status,
      ],
    );
    const productId = await getLastInsertId(connection);
    const product = await selectProduct(connection, productId);

    await insertAuditLog(connection, {
      auditContext,
      actionType: 'PRODUCT_CREATED',
      entityType: 'products',
      entityRecordId: productId,
      beforeValues: null,
      afterValues: productAuditSnapshot(product),
      notes: 'Product created through the product administration API.',
    });

    return { outcome: 'created', product };
  });
}

async function updateProductRecord(productId, changes, auditContext) {
  const preReadProduct = await selectProduct(pool, productId);

  if (!preReadProduct) {
    return { outcome: 'not_found' };
  }

  const proposedReferences = {
    categoryId: changes.categoryId ?? preReadProduct.categoryId,
    brandId: Object.hasOwn(changes, 'brandId')
      ? changes.brandId
      : preReadProduct.brandId,
    taxRateId: Object.hasOwn(changes, 'taxRateId')
      ? changes.taxRateId
      : preReadProduct.taxRateId,
  };

  return withCatalogTransaction(async (connection) => {
    const references = await lockProductReferences(connection, {
      categoryIds: [preReadProduct.categoryId, proposedReferences.categoryId],
      brandIds: [preReadProduct.brandId, proposedReferences.brandId],
      taxRateIds: [preReadProduct.taxRateId, proposedReferences.taxRateId],
    });
    const currentProduct = await selectProduct(connection, productId, {
      forUpdate: true,
    });

    if (!currentProduct) {
      return { outcome: 'not_found' };
    }

    if (
      currentProduct.categoryId !== preReadProduct.categoryId ||
      currentProduct.brandId !== preReadProduct.brandId ||
      currentProduct.taxRateId !== preReadProduct.taxRateId
    ) {
      return { outcome: 'concurrent_reference_change' };
    }

    const resultingProduct = { ...currentProduct, ...changes };
    const referenceOutcome = validateLockedReferences(
      resultingProduct,
      references,
    );

    if (referenceOutcome) {
      return { outcome: referenceOutcome };
    }

    const changedEntries = Object.entries(changes).filter(
      ([field, value]) => currentProduct[field] !== value,
    );

    if (changedEntries.length === 0) {
      return { outcome: 'unchanged', product: currentProduct };
    }

    if (
      currentProduct.status === 'ACTIVE' &&
      resultingProduct.status !== 'ACTIVE'
    ) {
      const activeVariants = await lockActiveVariants(connection, productId);

      if (activeVariants.length > 0) {
        return { outcome: 'active_variant_dependency' };
      }
    }

    const assignments = changedEntries.map(
      ([field]) => `${PRODUCT_UPDATE_COLUMNS[field]} = ?`,
    );
    const parameters = changedEntries.map(([, value]) => value);

    await connection.execute(
      `UPDATE products
       SET ${assignments.join(', ')}
       WHERE product_id = ?`,
      [...parameters, productId],
    );
    const product = await selectProduct(connection, productId);

    await insertAuditLog(connection, {
      auditContext,
      actionType: 'PRODUCT_UPDATED',
      entityType: 'products',
      entityRecordId: productId,
      beforeValues: productAuditSnapshot(currentProduct),
      afterValues: productAuditSnapshot(product),
      notes: 'Product updated through the product administration API.',
    });

    return { outcome: 'updated', product };
  });
}

export {
  createProductRecord,
  findProductById,
  listProducts,
  updateProductRecord,
};
