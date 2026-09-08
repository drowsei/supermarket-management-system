import pool from '../config/database.js';
import { barcodeValidationMessage } from '../utils/barcode.js';
import { databaseBoolean, toIsoString } from '../utils/record.js';
import { insertAuditLog } from './audit.repository.js';
import {
  countAsSafeNumber,
  getLastInsertId,
  withCatalogTransaction,
} from './productCatalog.repository.js';

const PRODUCT_BARCODE_COLUMNS = `
  CAST(pb.barcode_id AS CHAR) AS barcodeId,
  CAST(pb.product_variant_id AS CHAR) AS productVariantId,
  CAST(pb.product_package_id AS CHAR) AS productPackageId,
  pb.barcode,
  pb.barcode_type AS barcodeType,
  pb.is_primary AS isPrimary,
  pb.created_at AS createdAt,
  pb.updated_at AS updatedAt
`;

const PRODUCT_BARCODE_UPDATE_COLUMNS = Object.freeze({
  productPackageId: 'product_package_id',
  barcode: 'barcode',
  barcodeType: 'barcode_type',
  isPrimary: 'is_primary',
});

function normalizeProductBarcode(row) {
  if (!row) {
    return null;
  }

  return {
    barcodeId: row.barcodeId,
    productVariantId: row.productVariantId,
    productPackageId: row.productPackageId ?? null,
    barcode: row.barcode,
    barcodeType: row.barcodeType,
    isPrimary: databaseBoolean(row.isPrimary),
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

function barcodeAuditSnapshot(productBarcode) {
  return {
    barcodeId: productBarcode.barcodeId,
    productVariantId: productBarcode.productVariantId,
    productPackageId: productBarcode.productPackageId,
    barcode: productBarcode.barcode,
    barcodeType: productBarcode.barcodeType,
    isPrimary: productBarcode.isPrimary,
  };
}

async function selectVariantState(executor, productVariantId) {
  const [rows] = await executor.execute(
    `SELECT
       CAST(product_variant_id AS CHAR) AS productVariantId,
       CAST(product_id AS CHAR) AS productId
     FROM product_variants
     WHERE product_variant_id = ?
     LIMIT 1`,
    [productVariantId],
  );

  return rows[0] ?? null;
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

  return rows.length > 0;
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

  return rows.length > 0;
}

async function lockVariantPackages(connection, productVariantId) {
  const [rows] = await connection.execute(
    `SELECT CAST(product_package_id AS CHAR) AS productPackageId
     FROM product_packages
     WHERE product_variant_id = ?
     ORDER BY product_package_id
     FOR UPDATE`,
    [productVariantId],
  );

  return new Set(rows.map((row) => row.productPackageId));
}

async function selectProductBarcode(
  executor,
  barcodeId,
  { forUpdate = false } = {},
) {
  const [rows] = await executor.execute(
    `SELECT ${PRODUCT_BARCODE_COLUMNS}
     FROM product_barcodes pb
     WHERE pb.barcode_id = ?
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [barcodeId],
  );

  return normalizeProductBarcode(rows[0]);
}

async function lockVariantBarcodes(connection, productVariantId) {
  const [rows] = await connection.execute(
    `SELECT ${PRODUCT_BARCODE_COLUMNS}
     FROM product_barcodes pb
     WHERE pb.product_variant_id = ?
     ORDER BY pb.barcode_id
     FOR UPDATE`,
    [productVariantId],
  );

  return rows.map(normalizeProductBarcode);
}

function samePackageScope(leftPackageId, rightPackageId) {
  return leftPackageId === rightPackageId;
}

async function hasSaleHistory(connection, barcodeId) {
  const [rows] = await connection.execute(
    `SELECT sale_item_id
     FROM sale_items
     WHERE barcode_id = ?
     ORDER BY sale_item_id
     LIMIT 1
     FOR UPDATE`,
    [barcodeId],
  );

  return rows.length > 0;
}

async function listProductBarcodes(
  productVariantId,
  {
    search,
    barcodeType,
    productPackageId,
    isPrimary,
    limit,
    offset,
  },
) {
  if (!(await selectVariantState(pool, productVariantId))) {
    return { outcome: 'variant_not_found' };
  }

  const predicates = ['pb.product_variant_id = ?'];
  const parameters = [productVariantId];

  if (search) {
    predicates.push('LOCATE(?, pb.barcode) > 0');
    parameters.push(search);
  }

  if (barcodeType !== null) {
    predicates.push('pb.barcode_type = ?');
    parameters.push(barcodeType);
  }

  if (productPackageId !== undefined) {
    predicates.push(
      productPackageId === null
        ? 'pb.product_package_id IS NULL'
        : 'pb.product_package_id = ?',
    );
    if (productPackageId !== null) {
      parameters.push(productPackageId);
    }
  }

  if (isPrimary !== null) {
    predicates.push('pb.is_primary = ?');
    parameters.push(isPrimary ? 1 : 0);
  }

  const whereClause = `WHERE ${predicates.join(' AND ')}`;
  const [countRows] = await pool.execute(
    `SELECT CAST(COUNT(*) AS CHAR) AS totalItems
     FROM product_barcodes pb
     ${whereClause}`,
    parameters,
  );
  const [rows] = await pool.execute(
    `SELECT ${PRODUCT_BARCODE_COLUMNS}
     FROM product_barcodes pb
     ${whereClause}
     ORDER BY pb.is_primary DESC, pb.barcode, pb.barcode_id
     LIMIT ? OFFSET ?`,
    [...parameters, limit, offset],
  );

  return {
    outcome: 'found',
    items: rows.map(normalizeProductBarcode),
    totalItems: countAsSafeNumber(countRows[0].totalItems, 'product barcode'),
  };
}

async function findProductBarcodeById(barcodeId) {
  return selectProductBarcode(pool, barcodeId);
}

async function findProductBarcodeByValue(barcode) {
  const [rows] = await pool.execute(
    `SELECT ${PRODUCT_BARCODE_COLUMNS}
     FROM product_barcodes pb
     WHERE pb.barcode = ?
     LIMIT 1`,
    [barcode],
  );

  return normalizeProductBarcode(rows[0]);
}

async function createProductBarcodeRecord(
  productVariantId,
  values,
  auditContext,
) {
  const variant = await selectVariantState(pool, productVariantId);

  if (!variant) {
    return { outcome: 'variant_not_found' };
  }

  const { productId } = variant;

  return withCatalogTransaction(async (connection) => {
    if (!(await lockProduct(connection, productId))) {
      return { outcome: 'variant_not_found' };
    }

    if (!(await lockVariant(connection, productId, productVariantId))) {
      return { outcome: 'variant_not_found' };
    }

    const packageIds = await lockVariantPackages(
      connection,
      productVariantId,
    );
    const barcodes = await lockVariantBarcodes(connection, productVariantId);

    if (
      values.productPackageId !== null &&
      !packageIds.has(values.productPackageId)
    ) {
      return { outcome: 'package_not_found' };
    }

    const validationMessage = barcodeValidationMessage(
      values.barcode,
      values.barcodeType,
    );

    if (validationMessage) {
      return { outcome: 'invalid_barcode', message: validationMessage };
    }

    if (
      values.isPrimary &&
      barcodes.some(
        (productBarcode) =>
          productBarcode.isPrimary &&
          samePackageScope(
            productBarcode.productPackageId,
            values.productPackageId,
          ),
      )
    ) {
      return { outcome: 'primary_conflict' };
    }

    await connection.execute(
      `INSERT INTO product_barcodes (
         product_variant_id,
         product_package_id,
         barcode,
         barcode_type,
         is_primary
       ) VALUES (?, ?, ?, ?, ?)`,
      [
        productVariantId,
        values.productPackageId,
        values.barcode,
        values.barcodeType,
        values.isPrimary ? 1 : 0,
      ],
    );
    const barcodeId = await getLastInsertId(connection);
    const productBarcode = await selectProductBarcode(connection, barcodeId);

    await insertAuditLog(connection, {
      auditContext,
      actionType: 'PRODUCT_BARCODE_CREATED',
      entityType: 'product_barcodes',
      entityRecordId: barcodeId,
      beforeValues: null,
      afterValues: barcodeAuditSnapshot(productBarcode),
      notes: 'Product barcode created through the product administration API.',
    });

    return { outcome: 'created', productBarcode };
  });
}

async function updateProductBarcodeRecord(
  barcodeId,
  changes,
  auditContext,
) {
  const preReadBarcode = await selectProductBarcode(pool, barcodeId);

  if (!preReadBarcode) {
    return { outcome: 'not_found' };
  }

  const productVariantId = preReadBarcode.productVariantId;
  const variant = await selectVariantState(pool, productVariantId);

  if (!variant) {
    return { outcome: 'not_found' };
  }

  const { productId } = variant;

  return withCatalogTransaction(async (connection) => {
    if (!(await lockProduct(connection, productId))) {
      return { outcome: 'not_found' };
    }

    if (!(await lockVariant(connection, productId, productVariantId))) {
      return { outcome: 'not_found' };
    }

    const packageIds = await lockVariantPackages(
      connection,
      productVariantId,
    );
    const barcodes = await lockVariantBarcodes(connection, productVariantId);
    const currentBarcode = barcodes.find(
      (productBarcode) => productBarcode.barcodeId === barcodeId,
    );

    if (!currentBarcode) {
      return { outcome: 'not_found' };
    }

    const resultingBarcode = { ...currentBarcode, ...changes };
    const changedEntries = Object.entries(changes).filter(
      ([field, value]) => currentBarcode[field] !== value,
    );

    if (changedEntries.length === 0) {
      return { outcome: 'unchanged', productBarcode: currentBarcode };
    }

    const identityChanged = changedEntries.some(([field]) =>
      ['productPackageId', 'barcode', 'barcodeType'].includes(field),
    );
    const barcodeFormatChanged = changedEntries.some(([field]) =>
      ['barcode', 'barcodeType'].includes(field),
    );

    if (identityChanged && (await hasSaleHistory(connection, barcodeId))) {
      return { outcome: 'historical_barcode' };
    }

    if (
      resultingBarcode.productPackageId !== null &&
      !packageIds.has(resultingBarcode.productPackageId)
    ) {
      return { outcome: 'package_not_found' };
    }

    const validationMessage = barcodeFormatChanged
      ? barcodeValidationMessage(
          resultingBarcode.barcode,
          resultingBarcode.barcodeType,
        )
      : null;

    if (validationMessage) {
      return { outcome: 'invalid_barcode', message: validationMessage };
    }

    const destinationPrimary = resultingBarcode.isPrimary
      ? barcodes.find(
          (productBarcode) =>
            productBarcode.barcodeId !== barcodeId &&
            productBarcode.isPrimary &&
            samePackageScope(
              productBarcode.productPackageId,
              resultingBarcode.productPackageId,
            ),
        )
      : null;

    if (destinationPrimary) {
      await connection.execute(
        `UPDATE product_barcodes
         SET is_primary = 0
         WHERE barcode_id = ?
           AND product_variant_id = ?`,
        [destinationPrimary.barcodeId, productVariantId],
      );

      await insertAuditLog(connection, {
        auditContext,
        actionType: 'PRODUCT_BARCODE_UPDATED',
        entityType: 'product_barcodes',
        entityRecordId: destinationPrimary.barcodeId,
        beforeValues: barcodeAuditSnapshot(destinationPrimary),
        afterValues: barcodeAuditSnapshot({
          ...destinationPrimary,
          isPrimary: false,
        }),
        notes:
          'Product barcode demoted during a primary-barcode switch through the product administration API.',
      });
    }

    const assignments = changedEntries.map(
      ([field]) => `${PRODUCT_BARCODE_UPDATE_COLUMNS[field]} = ?`,
    );
    const parameters = changedEntries.map(([field, value]) =>
      field === 'isPrimary' ? (value ? 1 : 0) : value,
    );

    await connection.execute(
      `UPDATE product_barcodes
       SET ${assignments.join(', ')}
       WHERE barcode_id = ?
         AND product_variant_id = ?`,
      [...parameters, barcodeId, productVariantId],
    );
    const productBarcode = await selectProductBarcode(connection, barcodeId);

    if (productBarcode.isPrimary) {
      const resultingBarcodes = await lockVariantBarcodes(
        connection,
        productVariantId,
      );
      const primaryCount = resultingBarcodes.filter(
        (candidate) =>
          candidate.isPrimary &&
          samePackageScope(
            candidate.productPackageId,
            productBarcode.productPackageId,
          ),
      ).length;

      if (primaryCount !== 1) {
        throw new Error(
          'The primary-barcode invariant could not be established.',
        );
      }
    }

    await insertAuditLog(connection, {
      auditContext,
      actionType: 'PRODUCT_BARCODE_UPDATED',
      entityType: 'product_barcodes',
      entityRecordId: barcodeId,
      beforeValues: barcodeAuditSnapshot(currentBarcode),
      afterValues: barcodeAuditSnapshot(productBarcode),
      notes: 'Product barcode updated through the product administration API.',
    });

    return { outcome: 'updated', productBarcode };
  });
}

async function deleteProductBarcodeRecord(
  barcodeId,
  auditContext,
) {
  const preReadBarcode = await selectProductBarcode(pool, barcodeId);

  if (!preReadBarcode) {
    return { outcome: 'not_found' };
  }

  const productVariantId = preReadBarcode.productVariantId;
  const variant = await selectVariantState(pool, productVariantId);

  if (!variant) {
    return { outcome: 'not_found' };
  }

  const { productId } = variant;

  return withCatalogTransaction(async (connection) => {
    if (!(await lockProduct(connection, productId))) {
      return { outcome: 'not_found' };
    }

    if (!(await lockVariant(connection, productId, productVariantId))) {
      return { outcome: 'not_found' };
    }

    await lockVariantPackages(connection, productVariantId);
    const barcodes = await lockVariantBarcodes(connection, productVariantId);
    const currentBarcode = barcodes.find(
      (productBarcode) => productBarcode.barcodeId === barcodeId,
    );

    if (!currentBarcode) {
      return { outcome: 'not_found' };
    }

    if (await hasSaleHistory(connection, barcodeId)) {
      return { outcome: 'historical_barcode_delete' };
    }

    const [deleteResult] = await connection.execute(
      `DELETE FROM product_barcodes
       WHERE barcode_id = ?
         AND product_variant_id = ?`,
      [barcodeId, productVariantId],
    );

    if (deleteResult.affectedRows !== 1) {
      throw new Error('The product barcode could not be deleted safely.');
    }

    await insertAuditLog(connection, {
      auditContext,
      actionType: 'PRODUCT_BARCODE_DELETED',
      entityType: 'product_barcodes',
      entityRecordId: barcodeId,
      beforeValues: barcodeAuditSnapshot(currentBarcode),
      afterValues: null,
      notes: 'Unused product barcode deleted through the product administration API.',
    });

    return { outcome: 'deleted', productBarcode: currentBarcode };
  });
}

export {
  createProductBarcodeRecord,
  deleteProductBarcodeRecord,
  findProductBarcodeById,
  findProductBarcodeByValue,
  listProductBarcodes,
  updateProductBarcodeRecord,
};
