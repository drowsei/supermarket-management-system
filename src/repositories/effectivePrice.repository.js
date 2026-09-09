import pool from '../config/database.js';

function formatEvaluatedAt(row) {
  return row.evaluatedAt;
}

async function findEffectiveVariantPrice(branchId, productVariantId) {
  const [rows] = await pool.execute(
    `SELECT
       CAST(? AS CHAR) AS branchId,
       CAST(pv.product_variant_id AS CHAR) AS productVariantId,
       CASE
         WHEN bvp.is_active = 1
          AND bvp.effective_from <= clock.evaluated_at
           THEN bvp.selling_price
         ELSE pv.default_selling_price
       END AS sellingPrice,
       CASE
         WHEN bvp.is_active = 1
          AND bvp.effective_from <= clock.evaluated_at
           THEN 'BRANCH_VARIANT'
         ELSE 'VARIANT_DEFAULT'
       END AS source,
       CASE
         WHEN bvp.is_active = 1
          AND bvp.effective_from <= clock.evaluated_at
           THEN DATE_FORMAT(bvp.effective_from, '%Y-%m-%dT%H:%i:%s.%fZ')
         ELSE NULL
       END AS effectiveFrom,
       DATE_FORMAT(clock.evaluated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS evaluatedAt
     FROM product_variants pv
     CROSS JOIN (SELECT UTC_TIMESTAMP(6) AS evaluated_at) clock
     LEFT JOIN branch_variant_prices bvp
       ON bvp.branch_id = ?
      AND bvp.product_variant_id = pv.product_variant_id
     WHERE pv.product_variant_id = ?
     LIMIT 1`,
    [branchId, branchId, productVariantId],
  );
  const row = rows[0];

  if (!row) {
    return null;
  }

  return {
    branchId: row.branchId,
    productVariantId: row.productVariantId,
    sellingPrice: row.sellingPrice,
    source: row.source,
    effectiveFrom: row.effectiveFrom ?? null,
    evaluatedAt: formatEvaluatedAt(row),
  };
}

async function findEffectivePackagePrice(branchId, productPackageId) {
  const [rows] = await pool.execute(
    `SELECT
       CAST(? AS CHAR) AS branchId,
       CAST(pp.product_package_id AS CHAR) AS productPackageId,
       CAST(pp.product_variant_id AS CHAR) AS productVariantId,
       pp.default_selling_price AS packageDefaultSellingPrice,
       pp.conversion_to_base_quantity AS conversionToBaseQuantity,
       pv.default_selling_price AS variantDefaultSellingPrice,
       CASE
         WHEN bpp.is_active = 1
          AND bpp.effective_from <= clock.evaluated_at
           THEN bpp.selling_price
         ELSE NULL
       END AS branchPackageSellingPrice,
       CASE
         WHEN bpp.is_active = 1
          AND bpp.effective_from <= clock.evaluated_at
           THEN DATE_FORMAT(bpp.effective_from, '%Y-%m-%dT%H:%i:%s.%fZ')
         ELSE NULL
       END AS branchPackageEffectiveFrom,
       CASE
         WHEN bvp.is_active = 1
          AND bvp.effective_from <= clock.evaluated_at
           THEN bvp.selling_price
         ELSE NULL
       END AS branchVariantSellingPrice,
       CASE
         WHEN bvp.is_active = 1
          AND bvp.effective_from <= clock.evaluated_at
           THEN DATE_FORMAT(bvp.effective_from, '%Y-%m-%dT%H:%i:%s.%fZ')
         ELSE NULL
       END AS branchVariantEffectiveFrom,
       DATE_FORMAT(clock.evaluated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS evaluatedAt
     FROM product_packages pp
     INNER JOIN product_variants pv
       ON pv.product_variant_id = pp.product_variant_id
     CROSS JOIN (SELECT UTC_TIMESTAMP(6) AS evaluated_at) clock
     LEFT JOIN branch_package_prices bpp
       ON bpp.branch_id = ?
      AND bpp.product_package_id = pp.product_package_id
     LEFT JOIN branch_variant_prices bvp
       ON bvp.branch_id = ?
      AND bvp.product_variant_id = pp.product_variant_id
     WHERE pp.product_package_id = ?
     LIMIT 1`,
    [branchId, branchId, branchId, productPackageId],
  );
  const row = rows[0];

  if (!row) {
    return null;
  }

  return {
    branchId: row.branchId,
    productPackageId: row.productPackageId,
    productVariantId: row.productVariantId,
    packageDefaultSellingPrice: row.packageDefaultSellingPrice ?? null,
    conversionToBaseQuantity: row.conversionToBaseQuantity,
    variantDefaultSellingPrice: row.variantDefaultSellingPrice,
    branchPackageSellingPrice: row.branchPackageSellingPrice ?? null,
    branchPackageEffectiveFrom: row.branchPackageEffectiveFrom ?? null,
    branchVariantSellingPrice: row.branchVariantSellingPrice ?? null,
    branchVariantEffectiveFrom: row.branchVariantEffectiveFrom ?? null,
    evaluatedAt: formatEvaluatedAt(row),
  };
}

export { findEffectivePackagePrice, findEffectiveVariantPrice };
