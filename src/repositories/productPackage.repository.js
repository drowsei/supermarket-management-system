import pool from '../config/database.js';
import { databaseBoolean, toIsoString } from '../utils/record.js';
import { insertAuditLog } from './audit.repository.js';
import {
  countAsSafeNumber,
  getLastInsertId,
  lockRowsByIds,
  withCatalogTransaction,
} from './productCatalog.repository.js';

const PRODUCT_PACKAGE_COLUMNS = `
  CAST(pp.product_package_id AS CHAR) AS productPackageId,
  CAST(pp.product_variant_id AS CHAR) AS productVariantId,
  CAST(pp.package_unit_of_measure_id AS CHAR) AS packageUnitOfMeasureId,
  pp.package_code AS packageCode,
  pp.package_name AS packageName,
  pp.conversion_to_base_quantity AS conversionToBaseQuantity,
  pp.is_base_unit AS isBaseUnit,
  pp.is_purchasable AS isPurchasable,
  pp.is_sellable AS isSellable,
  pp.default_selling_price AS defaultSellingPrice,
  pp.status,
  pp.created_at AS createdAt,
  pp.updated_at AS updatedAt
`;

const PRODUCT_PACKAGE_UPDATE_COLUMNS = Object.freeze({
  packageUnitOfMeasureId: 'package_unit_of_measure_id',
  packageCode: 'package_code',
  packageName: 'package_name',
  conversionToBaseQuantity: 'conversion_to_base_quantity',
  isBaseUnit: 'is_base_unit',
  isPurchasable: 'is_purchasable',
  isSellable: 'is_sellable',
  defaultSellingPrice: 'default_selling_price',
  status: 'status',
});

const PACKAGE_DEPENDENCIES = Object.freeze([
  ['supplier_product_packages', 'supplier_id'],
  ['branch_package_prices', 'branch_id'],
  ['purchase_order_items', 'purchase_order_item_id'],
  ['sale_items', 'sale_item_id'],
  ['sales_return_items', 'sales_return_item_id'],
]);

function normalizeProductPackage(row) {
  if (!row) {
    return null;
  }

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

async function selectVariantState(executor, productVariantId) {
  const [rows] = await executor.execute(
    `SELECT
       CAST(pv.product_variant_id AS CHAR) AS productVariantId,
       CAST(pv.product_id AS CHAR) AS productId,
       CAST(pv.unit_of_measure_id AS CHAR) AS unitOfMeasureId,
       pv.status
     FROM product_variants pv
     WHERE pv.product_variant_id = ?
     LIMIT 1`,
    [productVariantId],
  );

  return rows[0] ?? null;
}

async function lockProduct(connection, productId) {
  const [rows] = await connection.execute(
    `SELECT CAST(product_id AS CHAR) AS productId
     FROM products
     WHERE product_id = ?
     LIMIT 1
     FOR UPDATE`,
    [productId],
  );

  return rows[0] ?? null;
}

async function lockVariant(connection, productId, productVariantId) {
  const [rows] = await connection.execute(
    `SELECT
       CAST(product_variant_id AS CHAR) AS productVariantId,
       CAST(product_id AS CHAR) AS productId,
       CAST(unit_of_measure_id AS CHAR) AS unitOfMeasureId,
       status
     FROM product_variants
     WHERE product_variant_id = ?
       AND product_id = ?
     LIMIT 1
     FOR UPDATE`,
    [productVariantId, productId],
  );

  return rows[0] ?? null;
}

async function lockUnits(connection, unitIds) {
  const rows = await lockRowsByIds(connection, {
    table: 'units_of_measure',
    idColumn: 'unit_of_measure_id',
    ids: unitIds,
    selectColumns: 'CAST(unit_of_measure_id AS CHAR) AS id',
  });

  return new Set(rows.map((row) => row.id));
}

async function selectProductPackage(
  executor,
  productPackageId,
  { forUpdate = false } = {},
) {
  const [rows] = await executor.execute(
    `SELECT ${PRODUCT_PACKAGE_COLUMNS}
     FROM product_packages pp
     WHERE pp.product_package_id = ?
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [productPackageId],
  );

  return normalizeProductPackage(rows[0]);
}

async function lockVariantPackages(connection, productVariantId) {
  const [rows] = await connection.execute(
    `SELECT ${PRODUCT_PACKAGE_COLUMNS}
     FROM product_packages pp
     WHERE pp.product_variant_id = ?
     ORDER BY pp.product_package_id
     FOR UPDATE`,
    [productVariantId],
  );

  return rows.map(normalizeProductPackage);
}

function activeBasePackages(packages) {
  return packages.filter(
    (productPackage) =>
      productPackage.isBaseUnit && productPackage.status === 'ACTIVE',
  );
}

function validateBasePackage(productPackage, variant) {
  if (!productPackage.isBaseUnit) {
    return null;
  }

  if (productPackage.conversionToBaseQuantity !== '1.000000') {
    return 'invalid_base_conversion';
  }

  if (productPackage.packageUnitOfMeasureId !== variant.unitOfMeasureId) {
    return 'invalid_base_unit';
  }

  return null;
}

function validateActiveVariantPackages(packages, variant) {
  if (variant.status !== 'ACTIVE') {
    return null;
  }

  return activeBasePackages(packages).length === 1
    ? null
    : 'active_base_invariant';
}

async function hasPackageDownstreamUse(connection, productPackageId) {
  for (const [table, primaryKey] of PACKAGE_DEPENDENCIES) {
    const [rows] = await connection.execute(
      `SELECT ${primaryKey}
       FROM ${table}
       WHERE product_package_id = ?
       ORDER BY ${primaryKey}
       LIMIT 1
       FOR UPDATE`,
      [productPackageId],
    );

    if (rows.length > 0) {
      return true;
    }
  }

  return false;
}

async function listProductPackages(
  productVariantId,
  {
    search,
    status,
    packageUnitOfMeasureId,
    isBaseUnit,
    isPurchasable,
    isSellable,
    limit,
    offset,
  },
) {
  const variant = await selectVariantState(pool, productVariantId);

  if (!variant) {
    return { outcome: 'variant_not_found' };
  }

  const predicates = ['pp.product_variant_id = ?'];
  const parameters = [productVariantId];

  if (search) {
    predicates.push(`LOCATE(
      ?,
      CONCAT_WS(' ', pp.package_code, pp.package_name)
    ) > 0`);
    parameters.push(search);
  }

  if (status !== null) {
    predicates.push('pp.status = ?');
    parameters.push(status);
  }

  if (packageUnitOfMeasureId !== undefined) {
    predicates.push('pp.package_unit_of_measure_id = ?');
    parameters.push(packageUnitOfMeasureId);
  }

  for (const [value, column] of [
    [isBaseUnit, 'pp.is_base_unit'],
    [isPurchasable, 'pp.is_purchasable'],
    [isSellable, 'pp.is_sellable'],
  ]) {
    if (value !== null) {
      predicates.push(`${column} = ?`);
      parameters.push(value ? 1 : 0);
    }
  }

  const whereClause = `WHERE ${predicates.join(' AND ')}`;
  const [countRows] = await pool.execute(
    `SELECT CAST(COUNT(*) AS CHAR) AS totalItems
     FROM product_packages pp
     ${whereClause}`,
    parameters,
  );
  const [rows] = await pool.execute(
    `SELECT ${PRODUCT_PACKAGE_COLUMNS}
     FROM product_packages pp
     ${whereClause}
     ORDER BY pp.is_base_unit DESC, pp.package_name, pp.product_package_id
     LIMIT ? OFFSET ?`,
    [...parameters, limit, offset],
  );

  return {
    outcome: 'found',
    items: rows.map(normalizeProductPackage),
    totalItems: countAsSafeNumber(countRows[0].totalItems, 'product package'),
  };
}

async function findProductPackageById(productPackageId) {
  return selectProductPackage(pool, productPackageId);
}

async function createProductPackageRecord(
  productVariantId,
  values,
  auditContext,
) {
  const preReadVariant = await selectVariantState(pool, productVariantId);

  if (!preReadVariant) {
    return { outcome: 'variant_not_found' };
  }

  return withCatalogTransaction(async (connection) => {
    const units = await lockUnits(connection, [
      preReadVariant.unitOfMeasureId,
      values.packageUnitOfMeasureId,
    ]);

    if (!units.has(values.packageUnitOfMeasureId)) {
      return { outcome: 'unit_not_found' };
    }

    if (!(await lockProduct(connection, preReadVariant.productId))) {
      return { outcome: 'variant_not_found' };
    }

    const variant = await lockVariant(
      connection,
      preReadVariant.productId,
      productVariantId,
    );

    if (!variant) {
      return { outcome: 'variant_not_found' };
    }

    if (variant.unitOfMeasureId !== preReadVariant.unitOfMeasureId) {
      return { outcome: 'concurrent_unit_change' };
    }

    const packages = await lockVariantPackages(connection, productVariantId);
    const projectedPackage = {
      ...values,
      productVariantId,
      productPackageId: null,
    };
    const baseOutcome = validateBasePackage(projectedPackage, variant);

    if (baseOutcome) {
      return { outcome: baseOutcome };
    }

    const projectedPackages = [...packages, projectedPackage];
    const invariantOutcome = validateActiveVariantPackages(
      projectedPackages,
      variant,
    );

    if (invariantOutcome) {
      return { outcome: invariantOutcome };
    }

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
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        productVariantId,
        values.packageUnitOfMeasureId,
        values.packageCode,
        values.packageName,
        values.conversionToBaseQuantity,
        values.isBaseUnit ? 1 : 0,
        values.isPurchasable ? 1 : 0,
        values.isSellable ? 1 : 0,
        values.defaultSellingPrice,
        values.status,
      ],
    );
    const productPackageId = await getLastInsertId(connection);
    const productPackage = await selectProductPackage(
      connection,
      productPackageId,
    );

    await insertAuditLog(connection, {
      auditContext,
      actionType: 'PRODUCT_PACKAGE_CREATED',
      entityType: 'product_packages',
      entityRecordId: productPackageId,
      beforeValues: null,
      afterValues: packageAuditSnapshot(productPackage),
      notes: 'Product package created through the product administration API.',
    });

    return { outcome: 'created', productPackage };
  });
}

async function updateProductPackageRecord(
  productPackageId,
  changes,
  auditContext,
) {
  const preReadPackage = await selectProductPackage(pool, productPackageId);
  const preReadVariant = preReadPackage
    ? await selectVariantState(pool, preReadPackage.productVariantId)
    : null;

  if (!preReadVariant || !preReadPackage) {
    return { outcome: 'not_found' };
  }

  const proposedUnitId =
    changes.packageUnitOfMeasureId ??
    preReadPackage.packageUnitOfMeasureId;

  return withCatalogTransaction(async (connection) => {
    const units = await lockUnits(connection, [
      preReadVariant.unitOfMeasureId,
      preReadPackage.packageUnitOfMeasureId,
      proposedUnitId,
    ]);

    if (!units.has(proposedUnitId)) {
      return { outcome: 'unit_not_found' };
    }

    if (!(await lockProduct(connection, preReadVariant.productId))) {
      return { outcome: 'not_found' };
    }

    const variant = await lockVariant(
      connection,
      preReadVariant.productId,
      preReadPackage.productVariantId,
    );

    if (!variant) {
      return { outcome: 'not_found' };
    }

    if (variant.unitOfMeasureId !== preReadVariant.unitOfMeasureId) {
      return { outcome: 'concurrent_unit_change' };
    }

    const packages = await lockVariantPackages(
      connection,
      preReadPackage.productVariantId,
    );
    const currentPackage = packages.find(
      (productPackage) =>
        productPackage.productPackageId === productPackageId,
    );

    if (!currentPackage) {
      return { outcome: 'not_found' };
    }

    if (
      currentPackage.packageUnitOfMeasureId !==
      preReadPackage.packageUnitOfMeasureId
    ) {
      return { outcome: 'concurrent_unit_change' };
    }

    const resultingPackage = { ...currentPackage, ...changes };
    const baseOutcome = validateBasePackage(resultingPackage, variant);

    if (baseOutcome) {
      return { outcome: baseOutcome };
    }

    const projectedPackages = packages.map((productPackage) =>
      productPackage.productPackageId === productPackageId
        ? resultingPackage
        : productPackage,
    );
    const invariantOutcome = validateActiveVariantPackages(
      projectedPackages,
      variant,
    );

    if (invariantOutcome) {
      return { outcome: invariantOutcome };
    }

    const changedEntries = Object.entries(changes).filter(
      ([field, value]) => currentPackage[field] !== value,
    );

    if (changedEntries.length === 0) {
      return { outcome: 'unchanged', productPackage: currentPackage };
    }

    const identityChanged = changedEntries.some(([field]) =>
      [
        'packageUnitOfMeasureId',
        'conversionToBaseQuantity',
        'isBaseUnit',
      ].includes(field),
    );

    if (
      identityChanged &&
      (await hasPackageDownstreamUse(connection, productPackageId))
    ) {
      return { outcome: 'established_package_identity' };
    }

    const assignments = changedEntries.map(
      ([field]) => `${PRODUCT_PACKAGE_UPDATE_COLUMNS[field]} = ?`,
    );
    const parameters = changedEntries.map(([field, value]) =>
      ['isBaseUnit', 'isPurchasable', 'isSellable'].includes(field)
        ? value
          ? 1
          : 0
        : value,
    );

    await connection.execute(
      `UPDATE product_packages
       SET ${assignments.join(', ')}
       WHERE product_package_id = ?`,
      [...parameters, productPackageId],
    );
    const productPackage = await selectProductPackage(
      connection,
      productPackageId,
    );

    await insertAuditLog(connection, {
      auditContext,
      actionType: 'PRODUCT_PACKAGE_UPDATED',
      entityType: 'product_packages',
      entityRecordId: productPackageId,
      beforeValues: packageAuditSnapshot(currentPackage),
      afterValues: packageAuditSnapshot(productPackage),
      notes: 'Product package updated through the product administration API.',
    });

    return { outcome: 'updated', productPackage };
  });
}

export {
  createProductPackageRecord,
  findProductPackageById,
  listProductPackages,
  updateProductPackageRecord,
};
