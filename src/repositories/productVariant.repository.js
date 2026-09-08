import pool from '../config/database.js';
import { databaseBoolean, toIsoString } from '../utils/record.js';
import { insertAuditLog } from './audit.repository.js';
import {
  countAsSafeNumber,
  getLastInsertId,
  lockRowsByIds,
  withCatalogTransaction,
} from './productCatalog.repository.js';

const PRODUCT_VARIANT_COLUMNS = `
  CAST(pv.product_variant_id AS CHAR) AS productVariantId,
  CAST(pv.product_id AS CHAR) AS productId,
  CAST(pv.unit_of_measure_id AS CHAR) AS unitOfMeasureId,
  pv.sku,
  pv.variant_name AS variantName,
  pv.size_value AS sizeValue,
  pv.units_per_pack AS unitsPerPack,
  pv.is_fractional AS isFractional,
  pv.lot_tracking_mode AS lotTrackingMode,
  pv.requires_expiry_date AS requiresExpiryDate,
  pv.default_selling_price AS defaultSellingPrice,
  pv.status,
  pv.created_at AS createdAt,
  pv.updated_at AS updatedAt
`;

const PRODUCT_VARIANT_UPDATE_COLUMNS = Object.freeze({
  unitOfMeasureId: 'unit_of_measure_id',
  sku: 'sku',
  variantName: 'variant_name',
  sizeValue: 'size_value',
  unitsPerPack: 'units_per_pack',
  isFractional: 'is_fractional',
  lotTrackingMode: 'lot_tracking_mode',
  requiresExpiryDate: 'requires_expiry_date',
  defaultSellingPrice: 'default_selling_price',
  status: 'status',
});

const VARIANT_OPERATIONAL_DEPENDENCIES = Object.freeze([
  ['branch_inventory', 'product_variant_id', 'branch_id'],
  [
    'inventory_transaction_items',
    'product_variant_id',
    'inventory_transaction_item_id',
  ],
  ['inventory_lots', 'product_variant_id', 'inventory_lot_id'],
  ['purchase_order_items', 'product_variant_id', 'purchase_order_item_id'],
  ['sale_items', 'product_variant_id', 'sale_item_id'],
  ['sales_return_items', 'product_variant_id', 'sales_return_item_id'],
  ['stock_transfer_items', 'product_variant_id', 'stock_transfer_item_id'],
  [
    'inventory_adjustment_items',
    'product_variant_id',
    'inventory_adjustment_item_id',
  ],
  ['stock_count_items', 'product_variant_id', 'stock_count_item_id'],
]);

function normalizeProductVariant(row) {
  if (!row) {
    return null;
  }

  return {
    productVariantId: row.productVariantId,
    productId: row.productId,
    unitOfMeasureId: row.unitOfMeasureId,
    sku: row.sku,
    variantName: row.variantName,
    sizeValue: row.sizeValue ?? null,
    unitsPerPack: row.unitsPerPack,
    isFractional: databaseBoolean(row.isFractional),
    lotTrackingMode: row.lotTrackingMode,
    requiresExpiryDate: databaseBoolean(row.requiresExpiryDate),
    defaultSellingPrice: row.defaultSellingPrice,
    status: row.status,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

function variantAuditSnapshot(variant) {
  return {
    productVariantId: variant.productVariantId,
    productId: variant.productId,
    unitOfMeasureId: variant.unitOfMeasureId,
    sku: variant.sku,
    variantName: variant.variantName,
    sizeValue: variant.sizeValue,
    unitsPerPack: variant.unitsPerPack,
    isFractional: variant.isFractional,
    lotTrackingMode: variant.lotTrackingMode,
    requiresExpiryDate: variant.requiresExpiryDate,
    defaultSellingPrice: variant.defaultSellingPrice,
    status: variant.status,
  };
}

function packageAuditSnapshot(productPackage) {
  return {
    productPackageId: productPackage.productPackageId,
    productVariantId: productPackage.productVariantId,
    packageUnitOfMeasureId: productPackage.packageUnitOfMeasureId,
    packageCode: productPackage.packageCode,
    packageName: productPackage.packageName,
    conversionToBaseQuantity: productPackage.conversionToBaseQuantity,
    isBaseUnit: productPackage.isBaseUnit,
    isPurchasable: productPackage.isPurchasable,
    isSellable: productPackage.isSellable,
    defaultSellingPrice: productPackage.defaultSellingPrice,
    status: productPackage.status,
  };
}

async function selectProductVariant(
  executor,
  productId,
  productVariantId,
  { forUpdate = false } = {},
) {
  const [rows] = await executor.execute(
    `SELECT ${PRODUCT_VARIANT_COLUMNS}
     FROM product_variants pv
     WHERE pv.product_variant_id = ?
       AND pv.product_id = ?
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [productVariantId, productId],
  );

  return normalizeProductVariant(rows[0]);
}

async function selectProductVariantById(
  executor,
  productVariantId,
  { forUpdate = false } = {},
) {
  const [rows] = await executor.execute(
    `SELECT ${PRODUCT_VARIANT_COLUMNS}
     FROM product_variants pv
     WHERE pv.product_variant_id = ?
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [productVariantId],
  );

  return normalizeProductVariant(rows[0]);
}

async function selectProductState(connection, productId, forUpdate = false) {
  const [rows] = await connection.execute(
    `SELECT CAST(product_id AS CHAR) AS productId, status
     FROM products
     WHERE product_id = ?
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [productId],
  );

  return rows[0] ?? null;
}

async function lockUnits(connection, unitIds) {
  const rows = await lockRowsByIds(connection, {
    table: 'units_of_measure',
    idColumn: 'unit_of_measure_id',
    ids: unitIds,
    selectColumns:
      'CAST(unit_of_measure_id AS CHAR) AS id, allows_fraction AS allowsFraction',
  });

  return new Map(
    rows.map((row) => [
      row.id,
      { allowsFraction: databaseBoolean(row.allowsFraction) },
    ]),
  );
}

async function lockVariantPackages(connection, productVariantId) {
  const [rows] = await connection.execute(
    `SELECT
       CAST(product_package_id AS CHAR) AS productPackageId,
       is_base_unit AS isBaseUnit,
       status
     FROM product_packages
     WHERE product_variant_id = ?
     ORDER BY product_package_id
     FOR UPDATE`,
    [productVariantId],
  );

  return rows.map((row) => ({
    productPackageId: row.productPackageId,
    isBaseUnit: databaseBoolean(row.isBaseUnit),
    status: row.status,
  }));
}

function hasExactlyOneActiveBasePackage(packages) {
  return (
    packages.filter(
      (productPackage) =>
        productPackage.isBaseUnit && productPackage.status === 'ACTIVE',
    ).length === 1
  );
}

async function lockFirstDependency(
  connection,
  table,
  foreignKeyColumn,
  primaryKeyColumn,
  productVariantId,
) {
  const [rows] = await connection.execute(
    `SELECT ${primaryKeyColumn}
     FROM ${table}
     WHERE ${foreignKeyColumn} = ?
     ORDER BY ${primaryKeyColumn}
     LIMIT 1
     FOR UPDATE`,
    [productVariantId],
  );

  return rows.length > 0;
}

async function hasVariantOperationalHistory(connection, productVariantId) {
  for (const [table, foreignKey, primaryKey] of VARIANT_OPERATIONAL_DEPENDENCIES) {
    if (
      await lockFirstDependency(
        connection,
        table,
        foreignKey,
        primaryKey,
        productVariantId,
      )
    ) {
      return true;
    }
  }

  return false;
}

async function hasVariantBaseIdentityUse(connection, productVariantId) {
  const [supplierRows] = await connection.execute(
    `SELECT supplier_id
     FROM supplier_products
     WHERE product_variant_id = ?
     ORDER BY supplier_id
     LIMIT 1
     FOR UPDATE`,
    [productVariantId],
  );

  if (supplierRows.length > 0) {
    return true;
  }

  return hasVariantOperationalHistory(connection, productVariantId);
}

async function selectCreatedBasePackage(connection, productPackageId) {
  const [rows] = await connection.execute(
    `SELECT
       CAST(product_package_id AS CHAR) AS productPackageId,
       CAST(product_variant_id AS CHAR) AS productVariantId,
       CAST(package_unit_of_measure_id AS CHAR) AS packageUnitOfMeasureId,
       package_code AS packageCode,
       package_name AS packageName,
       conversion_to_base_quantity AS conversionToBaseQuantity,
       is_base_unit AS isBaseUnit,
       is_purchasable AS isPurchasable,
       is_sellable AS isSellable,
       default_selling_price AS defaultSellingPrice,
       status,
       created_at AS createdAt,
       updated_at AS updatedAt
     FROM product_packages
     WHERE product_package_id = ?
     LIMIT 1`,
    [productPackageId],
  );
  const row = rows[0];

  return {
    productPackageId: row.productPackageId,
    productVariantId: row.productVariantId,
    packageUnitOfMeasureId: row.packageUnitOfMeasureId,
    packageCode: row.packageCode,
    packageName: row.packageName,
    conversionToBaseQuantity: row.conversionToBaseQuantity,
    isBaseUnit: databaseBoolean(row.isBaseUnit),
    isPurchasable: databaseBoolean(row.isPurchasable),
    isSellable: databaseBoolean(row.isSellable),
    defaultSellingPrice: row.defaultSellingPrice ?? null,
    status: row.status,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

async function listProductVariants(
  productId,
  {
    search,
    status,
    unitOfMeasureId,
    isFractional,
    lotTrackingMode,
    requiresExpiryDate,
    limit,
    offset,
  },
) {
  const product = await selectProductState(pool, productId);

  if (!product) {
    return { outcome: 'product_not_found' };
  }

  const predicates = ['pv.product_id = ?'];
  const parameters = [productId];

  if (search) {
    predicates.push(`LOCATE(
      ?,
      CONCAT_WS(' ', pv.sku, pv.variant_name)
    ) > 0`);
    parameters.push(search);
  }

  if (status !== null) {
    predicates.push('pv.status = ?');
    parameters.push(status);
  }

  if (unitOfMeasureId !== undefined) {
    predicates.push('pv.unit_of_measure_id = ?');
    parameters.push(unitOfMeasureId);
  }

  if (isFractional !== null) {
    predicates.push('pv.is_fractional = ?');
    parameters.push(isFractional ? 1 : 0);
  }

  if (lotTrackingMode !== null) {
    predicates.push('pv.lot_tracking_mode = ?');
    parameters.push(lotTrackingMode);
  }

  if (requiresExpiryDate !== null) {
    predicates.push('pv.requires_expiry_date = ?');
    parameters.push(requiresExpiryDate ? 1 : 0);
  }

  const whereClause = `WHERE ${predicates.join(' AND ')}`;
  const [countRows] = await pool.execute(
    `SELECT CAST(COUNT(*) AS CHAR) AS totalItems
     FROM product_variants pv
     ${whereClause}`,
    parameters,
  );
  const [rows] = await pool.execute(
    `SELECT ${PRODUCT_VARIANT_COLUMNS}
     FROM product_variants pv
     ${whereClause}
     ORDER BY pv.variant_name, pv.product_variant_id
     LIMIT ? OFFSET ?`,
    [...parameters, limit, offset],
  );

  return {
    outcome: 'found',
    items: rows.map(normalizeProductVariant),
    totalItems: countAsSafeNumber(countRows[0].totalItems, 'product variant'),
  };
}

async function findProductVariantById(productVariantId) {
  return selectProductVariantById(pool, productVariantId);
}

async function createProductVariantRecord(
  productId,
  values,
  auditContext,
) {
  return withCatalogTransaction(async (connection) => {
    const units = await lockUnits(connection, [values.unitOfMeasureId]);
    const unit = units.get(values.unitOfMeasureId);

    if (!unit) {
      return { outcome: 'unit_not_found' };
    }

    const product = await selectProductState(connection, productId, true);

    if (!product) {
      return { outcome: 'product_not_found' };
    }

    if (values.isFractional && !unit.allowsFraction) {
      return { outcome: 'fractional_unit_conflict' };
    }

    if (values.requiresExpiryDate && values.lotTrackingMode === 'NONE') {
      return { outcome: 'invalid_lot_configuration' };
    }

    if (values.status === 'ACTIVE' && product.status !== 'ACTIVE') {
      return { outcome: 'inactive_parent_product' };
    }

    if (values.status === 'ACTIVE' && !values.basePackage) {
      return { outcome: 'missing_active_base_package' };
    }

    await connection.execute(
      `INSERT INTO product_variants (
         product_id,
         unit_of_measure_id,
         sku,
         variant_name,
         size_value,
         units_per_pack,
         is_fractional,
         lot_tracking_mode,
         requires_expiry_date,
         default_selling_price,
         status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        productId,
        values.unitOfMeasureId,
        values.sku,
        values.variantName,
        values.sizeValue,
        values.unitsPerPack,
        values.isFractional ? 1 : 0,
        values.lotTrackingMode,
        values.requiresExpiryDate ? 1 : 0,
        values.defaultSellingPrice,
        values.status,
      ],
    );
    const productVariantId = await getLastInsertId(connection);
    const productVariant = await selectProductVariant(
      connection,
      productId,
      productVariantId,
    );

    await insertAuditLog(connection, {
      auditContext,
      actionType: 'PRODUCT_VARIANT_CREATED',
      entityType: 'product_variants',
      entityRecordId: productVariantId,
      beforeValues: null,
      afterValues: variantAuditSnapshot(productVariant),
      notes: 'Product variant created through the product administration API.',
    });

    let basePackage = null;

    if (values.basePackage) {
      await connection.execute(
        `INSERT INTO product_packages (
           product_variant_id,
           package_unit_of_measure_id,
           package_code,
           package_name,
           conversion_to_base_quantity,
           is_base_unit,
           is_purchasable,
           is_sellable,
           default_selling_price,
           status
         ) VALUES (?, ?, ?, ?, '1.000000', 1, ?, ?, ?, 'ACTIVE')`,
        [
          productVariantId,
          values.unitOfMeasureId,
          values.basePackage.packageCode,
          values.basePackage.packageName,
          values.basePackage.isPurchasable ? 1 : 0,
          values.basePackage.isSellable ? 1 : 0,
          values.basePackage.defaultSellingPrice,
        ],
      );
      const productPackageId = await getLastInsertId(connection);
      basePackage = await selectCreatedBasePackage(
        connection,
        productPackageId,
      );

      await insertAuditLog(connection, {
        auditContext,
        actionType: 'PRODUCT_PACKAGE_CREATED',
        entityType: 'product_packages',
        entityRecordId: productPackageId,
        beforeValues: null,
        afterValues: packageAuditSnapshot(basePackage),
        notes:
          'Base package created atomically with its product variant through the product administration API.',
      });
    }

    if (values.status === 'ACTIVE') {
      const packages = await lockVariantPackages(
        connection,
        productVariantId,
      );

      if (!hasExactlyOneActiveBasePackage(packages)) {
        throw new Error(
          'The active base-package invariant could not be established.',
        );
      }
    }

    return {
      outcome: 'created',
      productVariant,
      basePackage,
    };
  });
}

async function updateProductVariantRecord(
  productVariantId,
  changes,
  auditContext,
) {
  const preReadVariant = await selectProductVariantById(
    pool,
    productVariantId,
  );

  if (!preReadVariant) {
    return { outcome: 'not_found' };
  }

  const productId = preReadVariant.productId;
  const proposedUnitId =
    changes.unitOfMeasureId ?? preReadVariant.unitOfMeasureId;

  return withCatalogTransaction(async (connection) => {
    const units = await lockUnits(connection, [
      preReadVariant.unitOfMeasureId,
      proposedUnitId,
    ]);
    const product = await selectProductState(connection, productId, true);

    if (!product) {
      return { outcome: 'not_found' };
    }

    const currentVariant = await selectProductVariant(
      connection,
      productId,
      productVariantId,
      { forUpdate: true },
    );

    if (!currentVariant) {
      return { outcome: 'not_found' };
    }

    if (currentVariant.unitOfMeasureId !== preReadVariant.unitOfMeasureId) {
      return { outcome: 'concurrent_unit_change' };
    }

    const selectedUnit = units.get(proposedUnitId);

    if (!selectedUnit) {
      return { outcome: 'unit_not_found' };
    }

    const packages = await lockVariantPackages(connection, productVariantId);
    const resultingVariant = { ...currentVariant, ...changes };

    if (resultingVariant.isFractional && !selectedUnit.allowsFraction) {
      return { outcome: 'fractional_unit_conflict' };
    }

    if (
      resultingVariant.requiresExpiryDate &&
      resultingVariant.lotTrackingMode === 'NONE'
    ) {
      return { outcome: 'invalid_lot_configuration' };
    }

    if (resultingVariant.status === 'ACTIVE') {
      if (product.status !== 'ACTIVE') {
        return { outcome: 'inactive_parent_product' };
      }

      if (!hasExactlyOneActiveBasePackage(packages)) {
        return { outcome: 'missing_active_base_package' };
      }
    }

    const changedEntries = Object.entries(changes).filter(
      ([field, value]) => currentVariant[field] !== value,
    );

    if (changedEntries.length === 0) {
      return { outcome: 'unchanged', productVariant: currentVariant };
    }

    if (
      proposedUnitId !== currentVariant.unitOfMeasureId &&
      (packages.length > 0 ||
        (await hasVariantBaseIdentityUse(connection, productVariantId)))
    ) {
      return { outcome: 'established_base_unit' };
    }

    const lotConfigurationChanged = changedEntries.some(([field]) =>
      ['lotTrackingMode', 'requiresExpiryDate'].includes(field),
    );

    if (
      lotConfigurationChanged &&
      (await hasVariantOperationalHistory(connection, productVariantId))
    ) {
      return { outcome: 'established_lot_configuration' };
    }

    const assignments = changedEntries.map(
      ([field]) => `${PRODUCT_VARIANT_UPDATE_COLUMNS[field]} = ?`,
    );
    const parameters = changedEntries.map(([field, value]) =>
      ['isFractional', 'requiresExpiryDate'].includes(field)
        ? value
          ? 1
          : 0
        : value,
    );

    await connection.execute(
      `UPDATE product_variants
       SET ${assignments.join(', ')}
       WHERE product_variant_id = ?
         AND product_id = ?`,
      [...parameters, productVariantId, productId],
    );
    const productVariant = await selectProductVariant(
      connection,
      productId,
      productVariantId,
    );

    await insertAuditLog(connection, {
      auditContext,
      actionType: 'PRODUCT_VARIANT_UPDATED',
      entityType: 'product_variants',
      entityRecordId: productVariantId,
      beforeValues: variantAuditSnapshot(currentVariant),
      afterValues: variantAuditSnapshot(productVariant),
      notes: 'Product variant updated through the product administration API.',
    });

    return { outcome: 'updated', productVariant };
  });
}

export {
  createProductVariantRecord,
  findProductVariantById,
  listProductVariants,
  updateProductVariantRecord,
};
