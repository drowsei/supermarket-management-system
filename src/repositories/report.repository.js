import pool from '../config/database.js';
import { countAsSafeNumber } from './productCatalog.repository.js';

const ZERO_MONEY = '0.00';
const ZERO_QUANTITY = '0.000';

function windowPredicate(alias, column, windows) {
  if (windows.length === 0) return { sql: 'FALSE', parameters: [] };
  return {
    sql: `(${windows.map(() => `(${alias}.branch_id = ? AND ${column} >= ? AND ${column} < ?)`).join(' OR ')})`,
    parameters: windows.flatMap(({ branchId, startUtc, endUtcExclusive }) => [
      branchId, startUtc, endUtcExclusive,
    ]),
  };
}

function asMap(rows, key = 'branchId') {
  return new Map(rows.map((row) => [row[key], row]));
}

async function listOrganizationBranches({ status, search }) {
  const predicates = [];
  const parameters = [];
  if (status) {
    predicates.push('b.status = ?');
    parameters.push(status);
  }
  if (search) {
    predicates.push(`(LOCATE(?, b.branch_code) > 0 OR LOCATE(?, b.branch_name) > 0 OR LOCATE(?, b.city) > 0)`);
    parameters.push(search, search, search);
  }
  const where = predicates.length ? `WHERE ${predicates.join(' AND ')}` : '';
  const [rows] = await pool.execute(
    `SELECT CAST(b.branch_id AS CHAR) AS branchId,
       b.branch_code AS branchCode, b.branch_name AS branchName,
       b.status, b.currency_code AS currencyCode, b.timezone
     FROM branches b ${where}
     ORDER BY b.branch_name, b.branch_id`,
    parameters,
  );
  return rows;
}

async function organizationSales(windows) {
  const header = windowPredicate('s', 's.sold_at', windows);
  const [headerRows] = await pool.execute(
    `SELECT CAST(s.branch_id AS CHAR) AS branchId,
       CAST(COUNT(*) AS CHAR) AS completedSalesCount,
       COALESCE(SUM(s.total_amount), 0.00) AS grossSalesAmount
     FROM sales s
     WHERE s.status = 'COMPLETED' AND ${header.sql}
     GROUP BY s.branch_id`,
    header.parameters,
  );
  const [quantityRows] = await pool.execute(
    `SELECT CAST(s.branch_id AS CHAR) AS branchId,
       CAST(u.unit_of_measure_id AS CHAR) AS unitOfMeasureId,
       u.unit_code AS unitCode, u.unit_name AS unitName, u.symbol AS unitSymbol,
       COALESCE(SUM(si.base_quantity), 0.000) AS soldBaseQuantity
     FROM sales s
     INNER JOIN sale_items si ON si.sale_id = s.sale_id
     INNER JOIN product_variants pv ON pv.product_variant_id = si.product_variant_id
     INNER JOIN units_of_measure u ON u.unit_of_measure_id = pv.unit_of_measure_id
     WHERE s.status = 'COMPLETED' AND ${header.sql}
     GROUP BY s.branch_id, u.unit_of_measure_id, u.unit_code, u.unit_name, u.symbol
     ORDER BY s.branch_id, u.unit_code, u.unit_of_measure_id`,
    header.parameters,
  );
  return { headers: asMap(headerRows), quantities: quantityRows };
}

async function organizationReturns(windows) {
  const header = windowPredicate('sr', 'sr.completed_at', windows);
  const [headerRows] = await pool.execute(
    `SELECT CAST(sr.branch_id AS CHAR) AS branchId,
       CAST(COUNT(*) AS CHAR) AS completedReturnCount,
       COALESCE(SUM(sr.refund_total_amount), 0.00) AS returnedMerchandiseAmount
     FROM sales_returns sr
     WHERE sr.status = 'COMPLETED' AND ${header.sql}
     GROUP BY sr.branch_id`,
    header.parameters,
  );
  const [quantityRows] = await pool.execute(
    `SELECT CAST(sr.branch_id AS CHAR) AS branchId,
       CAST(u.unit_of_measure_id AS CHAR) AS unitOfMeasureId,
       u.unit_code AS unitCode, u.unit_name AS unitName, u.symbol AS unitSymbol,
       COALESCE(SUM(sri.base_quantity_returned), 0.000) AS returnedBaseQuantity,
       COALESCE(SUM(CASE WHEN sri.is_restockable = 1 THEN sri.base_quantity_returned ELSE 0.000 END), 0.000) AS restockableBaseQuantity,
       COALESCE(SUM(CASE WHEN sri.is_restockable = 0 THEN sri.base_quantity_returned ELSE 0.000 END), 0.000) AS nonRestockableBaseQuantity
     FROM sales_returns sr
     INNER JOIN sales_return_items sri ON sri.sales_return_id = sr.sales_return_id
     INNER JOIN product_variants pv ON pv.product_variant_id = sri.product_variant_id
     INNER JOIN units_of_measure u ON u.unit_of_measure_id = pv.unit_of_measure_id
     WHERE sr.status = 'COMPLETED' AND ${header.sql}
     GROUP BY sr.branch_id, u.unit_of_measure_id, u.unit_code, u.unit_name, u.symbol
     ORDER BY sr.branch_id, u.unit_code, u.unit_of_measure_id`,
    header.parameters,
  );
  return { headers: asMap(headerRows), quantities: quantityRows };
}

async function organizationPayments(windows) {
  const range = windowPredicate('s', 'sp.paid_at', windows);
  const [rows] = await pool.execute(
    `SELECT CAST(s.branch_id AS CHAR) AS branchId,
       COALESCE(SUM(CASE WHEN sp.payment_type = 'PAYMENT' THEN sp.amount ELSE 0.00 END), 0.00) AS completedPaymentAmount,
       COALESCE(SUM(CASE WHEN sp.payment_type = 'REFUND' THEN sp.amount ELSE 0.00 END), 0.00) AS completedRefundAmount
     FROM sale_payments sp
     INNER JOIN sales s ON s.sale_id = sp.sale_id
     WHERE sp.status = 'COMPLETED' AND ${range.sql}
     GROUP BY s.branch_id`,
    range.parameters,
  );
  return asMap(rows);
}

async function getOrganizationReportEvidence(windows) {
  const [sales, returns, payments] = await Promise.all([
    organizationSales(windows), organizationReturns(windows), organizationPayments(windows),
  ]);
  return { sales, returns, payments };
}

function salePredicates(branchId, range, filters = {}) {
  const predicates = [
    's.branch_id = ?', "s.status = 'COMPLETED'", 's.sold_at >= ?', 's.sold_at < ?',
  ];
  const parameters = [branchId, range.startUtc, range.endUtcExclusive];
  for (const [field, column] of [
    ['cashierEmployeeId', 's.cashier_employee_id'], ['customerId', 's.customer_id'],
    ['posRegisterId', 's.pos_register_id'], ['tillSessionId', 's.till_session_id'],
  ]) {
    if (filters[field]) {
      predicates.push(`${column} = ?`);
      parameters.push(filters[field]);
    }
  }
  return { where: `WHERE ${predicates.join(' AND ')}`, parameters };
}

async function salesSummary(branchId, range, filters = {}) {
  const { where, parameters } = salePredicates(branchId, range, filters);
  const [[headers], [quantitiesByUnit]] = await Promise.all([
    pool.execute(
      `SELECT CAST(COUNT(*) AS CHAR) AS completedSalesCount,
         COALESCE(SUM(s.total_amount), 0.00) AS grossSalesAmount,
         COALESCE(SUM(s.subtotal_amount), 0.00) AS subtotalAmount,
         COALESCE(SUM(s.discount_amount), 0.00) AS discountAmount,
         COALESCE(SUM(s.tax_amount), 0.00) AS taxAmount,
         CAST(SUM(s.customer_id IS NOT NULL) AS CHAR) AS customerLinkedSalesCount,
         CAST(SUM(s.customer_id IS NULL) AS CHAR) AS walkInSalesCount
       FROM sales s ${where}`,
      parameters,
    ),
    pool.execute(
      `SELECT CAST(u.unit_of_measure_id AS CHAR) AS unitOfMeasureId,
         u.unit_code AS unitCode, u.unit_name AS unitName, u.symbol AS unitSymbol,
         COALESCE(SUM(si.base_quantity), 0.000) AS soldBaseQuantity
       FROM sales s
       INNER JOIN sale_items si ON si.sale_id = s.sale_id
       INNER JOIN product_variants pv ON pv.product_variant_id = si.product_variant_id
       INNER JOIN units_of_measure u ON u.unit_of_measure_id = pv.unit_of_measure_id
       ${where}
       GROUP BY u.unit_of_measure_id, u.unit_code, u.unit_name, u.symbol
       ORDER BY u.unit_code, u.unit_of_measure_id`,
      parameters,
    ),
  ]);
  return { ...headers[0], quantitiesByUnit };
}

async function returnTotals(branchId, range) {
  const [[headers], [quantitiesByUnit]] = await Promise.all([
    pool.execute(
      `SELECT CAST(COUNT(*) AS CHAR) AS completedReturnCount,
         COALESCE(SUM(sr.refund_total_amount), 0.00) AS returnedMerchandiseAmount
       FROM sales_returns sr
       WHERE sr.branch_id = ? AND sr.status = 'COMPLETED'
         AND sr.completed_at >= ? AND sr.completed_at < ?`,
      [branchId, range.startUtc, range.endUtcExclusive],
    ),
    pool.execute(
      `SELECT CAST(u.unit_of_measure_id AS CHAR) AS unitOfMeasureId,
         u.unit_code AS unitCode, u.unit_name AS unitName, u.symbol AS unitSymbol,
         COALESCE(SUM(sri.base_quantity_returned), 0.000) AS returnedBaseQuantity,
         COALESCE(SUM(CASE WHEN sri.is_restockable = 1 THEN sri.base_quantity_returned ELSE 0.000 END), 0.000) AS restockableBaseQuantity,
         COALESCE(SUM(CASE WHEN sri.is_restockable = 0 THEN sri.base_quantity_returned ELSE 0.000 END), 0.000) AS nonRestockableBaseQuantity
       FROM sales_returns sr
       INNER JOIN sales_return_items sri ON sri.sales_return_id = sr.sales_return_id
       INNER JOIN product_variants pv ON pv.product_variant_id = sri.product_variant_id
       INNER JOIN units_of_measure u ON u.unit_of_measure_id = pv.unit_of_measure_id
       WHERE sr.branch_id = ? AND sr.status = 'COMPLETED'
         AND sr.completed_at >= ? AND sr.completed_at < ?
       GROUP BY u.unit_of_measure_id, u.unit_code, u.unit_name, u.symbol
       ORDER BY u.unit_code, u.unit_of_measure_id`,
      [branchId, range.startUtc, range.endUtcExclusive],
    ),
  ]);
  return { ...headers[0], quantitiesByUnit };
}

async function paymentTotals(branchId, range) {
  const [rows] = await pool.execute(
    `SELECT
       COALESCE(SUM(CASE WHEN sp.payment_type = 'PAYMENT' THEN sp.amount ELSE 0.00 END), 0.00) AS completedPaymentAmount,
       COALESCE(SUM(CASE WHEN sp.payment_type = 'REFUND' THEN sp.amount ELSE 0.00 END), 0.00) AS completedRefundAmount
     FROM sale_payments sp
     INNER JOIN sales s ON s.sale_id = sp.sale_id
     WHERE s.branch_id = ? AND sp.status = 'COMPLETED'
       AND sp.paid_at >= ? AND sp.paid_at < ?`,
    [branchId, range.startUtc, range.endUtcExclusive],
  );
  return rows[0];
}

async function overviewCurrentState(branchId) {
  const [[inventory], [tills], [orders]] = await Promise.all([
    pool.execute(
      `SELECT
         CAST(SUM(bi.quantity_on_hand > 0.000) AS CHAR) AS currentVariantCountWithStock,
         CAST(SUM(bi.quantity_on_hand > 0.000 AND bi.reorder_level > 0.000 AND bi.quantity_on_hand <= bi.reorder_level) AS CHAR) AS lowStockVariantCount,
         CAST(SUM(bi.quantity_on_hand <= 0.000) AS CHAR) AS outOfStockVariantCount
       FROM branch_inventory bi WHERE bi.branch_id = ?`,
      [branchId],
    ),
    pool.execute(
      `SELECT CAST(COUNT(*) AS CHAR) AS openTillSessionCount
       FROM till_sessions WHERE branch_id = ? AND status IN ('OPEN', 'SUSPENDED')`,
      [branchId],
    ),
    pool.execute(
      `SELECT CAST(COUNT(*) AS CHAR) AS openPurchaseOrderCount
       FROM purchase_orders
       WHERE branch_id = ? AND status IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'PARTIALLY_RECEIVED')`,
      [branchId],
    ),
  ]);
  return {
    currentVariantCountWithStock: inventory[0].currentVariantCountWithStock ?? '0',
    lowStockVariantCount: inventory[0].lowStockVariantCount ?? '0',
    outOfStockVariantCount: inventory[0].outOfStockVariantCount ?? '0',
    openTillSessionCount: tills[0].openTillSessionCount,
    openPurchaseOrderCount: orders[0].openPurchaseOrderCount,
  };
}

async function trendEvents(branchId, range) {
  const [[sales], [refunds]] = await Promise.all([
    pool.execute(
      `SELECT DATE_FORMAT(s.sold_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS occurredAt,
         s.total_amount AS grossSalesAmount, s.discount_amount AS discountAmount,
         s.tax_amount AS taxAmount
       FROM sales s
       WHERE s.branch_id = ? AND s.status = 'COMPLETED'
         AND s.sold_at >= ? AND s.sold_at < ?
       ORDER BY s.sold_at, s.sale_id`,
      [branchId, range.startUtc, range.endUtcExclusive],
    ),
    pool.execute(
      `SELECT DATE_FORMAT(sp.paid_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS occurredAt,
         sp.amount
       FROM sale_payments sp
       INNER JOIN sales s ON s.sale_id = sp.sale_id
       WHERE s.branch_id = ? AND sp.status = 'COMPLETED' AND sp.payment_type = 'REFUND'
         AND sp.paid_at >= ? AND sp.paid_at < ?
       ORDER BY sp.paid_at, sp.sale_payment_id`,
      [branchId, range.startUtc, range.endUtcExclusive],
    ),
  ]);
  return { sales, refunds };
}
function catalogFilters(filters, alias = { category: 'c', product: 'p', variant: 'pv' }) {
  const predicates = [];
  const parameters = [];
  if (filters.categoryId) {
    predicates.push(`${alias.category}.category_id = ?`);
    parameters.push(filters.categoryId);
  }
  if (filters.productId) {
    predicates.push(`${alias.product}.product_id = ?`);
    parameters.push(filters.productId);
  }
  if (filters.productVariantId) {
    predicates.push(`${alias.variant}.product_variant_id = ?`);
    parameters.push(filters.productVariantId);
  }
  if (filters.search) {
    predicates.push(`(LOCATE(?, ${alias.variant}.sku) > 0 OR LOCATE(?, ${alias.product}.product_code) > 0 OR LOCATE(?, ${alias.product}.product_name) > 0 OR LOCATE(?, ${alias.variant}.variant_name) > 0 OR LOCATE(?, ${alias.category}.category_name) > 0)`);
    parameters.push(...Array(5).fill(filters.search));
  }
  return { predicates, parameters };
}

function productGrouping(groupBy) {
  if (groupBy === 'category') {
    return {
      select: `CAST(c.category_id AS CHAR) AS groupId, 'category' AS groupType,
        CAST(c.category_id AS CHAR) AS categoryId, c.category_code AS categoryCode,
        c.category_name AS categoryName,
        NULL AS productId, NULL AS productCode, NULL AS productName,
        NULL AS productVariantId, NULL AS sku, NULL AS variantName`,
      group: 'c.category_id, c.category_code, c.category_name',
    };
  }
  if (groupBy === 'product') {
    return {
      select: `CAST(p.product_id AS CHAR) AS groupId, 'product' AS groupType,
        CAST(c.category_id AS CHAR) AS categoryId, c.category_code AS categoryCode,
        c.category_name AS categoryName,
        CAST(p.product_id AS CHAR) AS productId, p.product_code AS productCode,
        p.product_name AS productName,
        NULL AS productVariantId, NULL AS sku, NULL AS variantName`,
      group: 'c.category_id, c.category_code, c.category_name, p.product_id, p.product_code, p.product_name',
    };
  }
  return {
    select: `CAST(pv.product_variant_id AS CHAR) AS groupId, 'variant' AS groupType,
      CAST(c.category_id AS CHAR) AS categoryId, c.category_code AS categoryCode,
      c.category_name AS categoryName,
      CAST(p.product_id AS CHAR) AS productId, p.product_code AS productCode,
      p.product_name AS productName,
      CAST(pv.product_variant_id AS CHAR) AS productVariantId,
      pv.sku, pv.variant_name AS variantName`,
    group: `c.category_id, c.category_code, c.category_name,
      p.product_id, p.product_code, p.product_name,
      pv.product_variant_id, pv.sku, pv.variant_name`,
  };
}

function productPerformanceSql(branchId, range, filters) {
  const grouping = productGrouping(filters.groupBy);
  const catalog = catalogFilters(filters);
  const catalogWhere = catalog.predicates.length ? `AND ${catalog.predicates.join(' AND ')}` : '';
  const saleParameters = [branchId, range.startUtc, range.endUtcExclusive, ...catalog.parameters];
  const returnParameters = [branchId, range.startUtc, range.endUtcExclusive, ...catalog.parameters];
  const soldQuantityAggregate = filters.groupBy === 'variant'
    ? 'COALESCE(SUM(soldBaseQuantity), 0.000)' : 'NULL';
  const returnedQuantityAggregate = filters.groupBy === 'variant'
    ? 'COALESCE(SUM(returnedBaseQuantity), 0.000)' : 'NULL';
  const eventRows = `
    SELECT ${grouping.select}, CAST(s.sale_id AS CHAR) AS saleKey,
      si.base_quantity AS soldBaseQuantity, si.line_total AS grossSalesAmount,
      si.tax_amount AS taxAmount,
      CASE WHEN si.unit_cost IS NULL THEN NULL ELSE si.base_quantity * si.unit_cost END AS historicalCost,
      CASE WHEN si.unit_cost IS NULL THEN 0 ELSE 1 END AS costedLineCount,
      CASE WHEN si.unit_cost IS NULL THEN 1 ELSE 0 END AS uncostedLineCount,
      0.000 AS returnedBaseQuantity, 0.00 AS returnedMerchandiseAmount
    FROM sale_items si
    INNER JOIN sales s ON s.sale_id = si.sale_id
    INNER JOIN product_variants pv ON pv.product_variant_id = si.product_variant_id
    INNER JOIN products p ON p.product_id = pv.product_id
    INNER JOIN categories c ON c.category_id = p.category_id
    WHERE s.branch_id = ? AND s.status = 'COMPLETED'
      AND s.sold_at >= ? AND s.sold_at < ? ${catalogWhere}
    UNION ALL
    SELECT ${grouping.select}, NULL AS saleKey,
      0.000, 0.00, 0.00, NULL, 0, 0,
      sri.base_quantity_returned, sri.refund_amount
    FROM sales_return_items sri
    INNER JOIN sales_returns sr ON sr.sales_return_id = sri.sales_return_id
    INNER JOIN product_variants pv ON pv.product_variant_id = sri.product_variant_id
    INNER JOIN products p ON p.product_id = pv.product_id
    INNER JOIN categories c ON c.category_id = p.category_id
    WHERE sr.branch_id = ? AND sr.status = 'COMPLETED'
      AND sr.completed_at >= ? AND sr.completed_at < ? ${catalogWhere}`;
  const aggregate = `SELECT groupId, groupType, categoryId, categoryCode, categoryName,
      productId, productCode, productName, productVariantId, sku, variantName,
      CAST(COUNT(DISTINCT saleKey) AS CHAR) AS completedSalesCount,
      ${soldQuantityAggregate} AS soldBaseQuantity,
      COALESCE(SUM(grossSalesAmount), 0.00) AS grossSalesAmount,
      COALESCE(SUM(taxAmount), 0.00) AS taxAmount,
      COALESCE(SUM(grossSalesAmount - taxAmount), 0.00) AS merchandiseRevenueBeforeReturns,
      CASE WHEN SUM(uncostedLineCount) > 0 THEN NULL
           ELSE COALESCE(ROUND(SUM(historicalCost), 2), 0.00) END AS historicalCostAmount,
      CASE WHEN SUM(uncostedLineCount) > 0 THEN NULL
           ELSE COALESCE(ROUND(SUM(grossSalesAmount - taxAmount) - SUM(historicalCost), 2), 0.00) END AS grossProfitBeforeReturns,
      CAST(SUM(costedLineCount) AS CHAR) AS costedLineCount,
      CAST(SUM(uncostedLineCount) AS CHAR) AS uncostedLineCount,
      ${returnedQuantityAggregate} AS returnedBaseQuantity,
      COALESCE(SUM(returnedMerchandiseAmount), 0.00) AS returnedMerchandiseAmount
    FROM (${eventRows}) report_events
    GROUP BY groupId, groupType, categoryId, categoryCode, categoryName,
      productId, productCode, productName, productVariantId, sku, variantName`;
  return { aggregate, parameters: [...saleParameters, ...returnParameters] };
}

function productQuantityGroupColumn(groupBy) {
  if (groupBy === 'category') return 'c.category_id';
  if (groupBy === 'product') return 'p.product_id';
  return 'pv.product_variant_id';
}

async function productQuantityBreakdown(branchId, range, filters, groupIds) {
  if (groupIds.length === 0) return [];
  const groupColumn = productQuantityGroupColumn(filters.groupBy);
  const placeholders = groupIds.map(() => '?').join(', ');
  const catalog = catalogFilters(filters);
  const catalogWhere = catalog.predicates.length
    ? `AND ${catalog.predicates.join(' AND ')}` : '';
  const groupWhere = `AND ${groupColumn} IN (${placeholders})`;
  const saleParameters = [
    branchId, range.startUtc, range.endUtcExclusive, ...catalog.parameters, ...groupIds,
  ];
  const returnParameters = [
    branchId, range.startUtc, range.endUtcExclusive, ...catalog.parameters, ...groupIds,
  ];
  const [rows] = await pool.execute(
    `SELECT groupId, unitOfMeasureId, unitCode, unitName, unitSymbol,
       COALESCE(SUM(soldBaseQuantity), 0.000) AS soldBaseQuantity,
       COALESCE(SUM(returnedBaseQuantity), 0.000) AS returnedBaseQuantity
     FROM (
       SELECT CAST(${groupColumn} AS CHAR) AS groupId,
         CAST(u.unit_of_measure_id AS CHAR) AS unitOfMeasureId,
         u.unit_code AS unitCode, u.unit_name AS unitName, u.symbol AS unitSymbol,
         si.base_quantity AS soldBaseQuantity, 0.000 AS returnedBaseQuantity
       FROM sale_items si
       INNER JOIN sales s ON s.sale_id = si.sale_id
       INNER JOIN product_variants pv ON pv.product_variant_id = si.product_variant_id
       INNER JOIN products p ON p.product_id = pv.product_id
       INNER JOIN categories c ON c.category_id = p.category_id
       INNER JOIN units_of_measure u ON u.unit_of_measure_id = pv.unit_of_measure_id
       WHERE s.branch_id = ? AND s.status = 'COMPLETED'
         AND s.sold_at >= ? AND s.sold_at < ? ${catalogWhere} ${groupWhere}
       UNION ALL
       SELECT CAST(${groupColumn} AS CHAR) AS groupId,
         CAST(u.unit_of_measure_id AS CHAR) AS unitOfMeasureId,
         u.unit_code AS unitCode, u.unit_name AS unitName, u.symbol AS unitSymbol,
         0.000, sri.base_quantity_returned
       FROM sales_return_items sri
       INNER JOIN sales_returns sr ON sr.sales_return_id = sri.sales_return_id
       INNER JOIN product_variants pv ON pv.product_variant_id = sri.product_variant_id
       INNER JOIN products p ON p.product_id = pv.product_id
       INNER JOIN categories c ON c.category_id = p.category_id
       INNER JOIN units_of_measure u ON u.unit_of_measure_id = pv.unit_of_measure_id
       WHERE sr.branch_id = ? AND sr.status = 'COMPLETED'
         AND sr.completed_at >= ? AND sr.completed_at < ? ${catalogWhere} ${groupWhere}
     ) quantity_events
     GROUP BY groupId, unitOfMeasureId, unitCode, unitName, unitSymbol
     ORDER BY groupId, unitCode, unitOfMeasureId`,
    [...saleParameters, ...returnParameters],
  );
  return rows;
}

async function productPerformance(branchId, range, filters) {
  const { aggregate, parameters } = productPerformanceSql(branchId, range, filters);
  const sortColumns = {
    grossSalesAmount: 'grossSalesAmount', soldBaseQuantity: 'soldBaseQuantity',
    completedSalesCount: 'completedSalesCount', returnedBaseQuantity: 'returnedBaseQuantity',
    returnedMerchandiseAmount: 'returnedMerchandiseAmount',
    grossProfitBeforeReturns: 'grossProfitBeforeReturns',
  };
  const [countRows] = await pool.execute(
    `SELECT CAST(COUNT(*) AS CHAR) AS totalItems FROM (${aggregate}) grouped_products`,
    parameters,
  );
  const [rows] = await pool.execute(
    `${aggregate}
     ORDER BY ${sortColumns[filters.sort]} ${filters.sortDirection.toUpperCase()}, groupId
     LIMIT ? OFFSET ?`,
    [...parameters, filters.limit, filters.offset],
  );
  const quantityRows = await productQuantityBreakdown(
    branchId, range, filters, rows.map(({ groupId }) => groupId),
  );
  const quantitiesByGroup = new Map();
  for (const quantity of quantityRows) {
    const groupQuantities = quantitiesByGroup.get(quantity.groupId) ?? [];
    const { groupId, ...unitQuantity } = quantity;
    groupQuantities.push(unitQuantity);
    quantitiesByGroup.set(groupId, groupQuantities);
  }
  const items = rows.map((row) => {
    const quantitiesByUnit = quantitiesByGroup.get(row.groupId) ?? [];
    if (filters.groupBy !== 'variant') return { ...row, quantitiesByUnit };
    const baseUnit = quantitiesByUnit[0];
    return {
      ...row,
      unitOfMeasureId: baseUnit?.unitOfMeasureId ?? null,
      unitCode: baseUnit?.unitCode ?? null,
      unitName: baseUnit?.unitName ?? null,
      unitSymbol: baseUnit?.unitSymbol ?? null,
      quantitiesByUnit,
    };
  });
  return {
    items,
    totalItems: countAsSafeNumber(countRows[0].totalItems, 'product report'),
  };
}

function optionalReturnItemPredicates(filters) {
  const predicates = [];
  const parameters = [];
  for (const [field, column] of [
    ['returnReasonId', 'sri.return_reason_id'], ['itemCondition', 'sri.item_condition'],
    ['productVariantId', 'sri.product_variant_id'], ['customerId', 'sr.customer_id'],
  ]) {
    if (filters[field] !== null && filters[field] !== undefined) {
      predicates.push(`${column} = ?`);
      parameters.push(filters[field]);
    }
  }
  if (filters.isRestockable !== null) {
    predicates.push('sri.is_restockable = ?');
    parameters.push(filters.isRestockable ? 1 : 0);
  }
  return { predicates, parameters };
}

function returnItemPredicates(branchId, range, filters) {
  const optional = optionalReturnItemPredicates(filters);
  const predicates = [
    'sr.branch_id = ?', "sr.status = 'COMPLETED'", 'sr.completed_at >= ?', 'sr.completed_at < ?',
    ...optional.predicates,
  ];
  return {
    where: `WHERE ${predicates.join(' AND ')}`,
    parameters: [branchId, range.startUtc, range.endUtcExclusive, ...optional.parameters],
    optional,
  };
}

async function returnsReport(branchId, range, filters) {
  const { where, parameters, optional } = returnItemPredicates(branchId, range, filters);
  const matchedReturns = `SELECT sr.sales_return_id, sr.refund_total_amount
    FROM sales_return_items sri
    INNER JOIN sales_returns sr ON sr.sales_return_id = sri.sales_return_id
    ${where}
    GROUP BY sr.sales_return_id, sr.refund_total_amount`;
  const grouped = `SELECT CAST(sri.return_reason_id AS CHAR) AS returnReasonId,
      rr.reason_code AS reasonCode, rr.reason_name AS returnReason,
      sri.item_condition AS itemCondition,
      CAST(sri.product_variant_id AS CHAR) AS productVariantId,
      pv.sku, pv.variant_name AS variantName,
      CAST(u.unit_of_measure_id AS CHAR) AS unitOfMeasureId,
      u.unit_code AS unitCode, u.unit_name AS unitName, u.symbol AS unitSymbol,
      COALESCE(SUM(sri.base_quantity_returned), 0.000) AS returnedBaseQuantity,
      COALESCE(SUM(sri.refund_amount), 0.00) AS refundEntitlementAmount
    FROM sales_return_items sri
    INNER JOIN sales_returns sr ON sr.sales_return_id = sri.sales_return_id
    INNER JOIN return_reasons rr ON rr.return_reason_id = sri.return_reason_id
    INNER JOIN product_variants pv ON pv.product_variant_id = sri.product_variant_id
    INNER JOIN units_of_measure u ON u.unit_of_measure_id = pv.unit_of_measure_id
    ${where}
    GROUP BY sri.return_reason_id, rr.reason_code, rr.reason_name,
      sri.item_condition, sri.product_variant_id, pv.sku, pv.variant_name,
      u.unit_of_measure_id, u.unit_code, u.unit_name, u.symbol`;
  const optionalSql = optional.predicates.length
    ? `AND ${optional.predicates.join(' AND ')}` : '';
  const [[headerRows], [quantityRows], [refundRows], [pendingRows], [countRows], [rows]] = await Promise.all([
    pool.execute(
      `SELECT CAST(COUNT(DISTINCT sr.sales_return_id) AS CHAR) AS completedReturnCount,
         COALESCE(SUM(sri.refund_amount), 0.00) AS returnedMerchandiseAmount
       FROM sales_return_items sri
       INNER JOIN sales_returns sr ON sr.sales_return_id = sri.sales_return_id
       ${where}`,
      parameters,
    ),
    pool.execute(
      `SELECT CAST(u.unit_of_measure_id AS CHAR) AS unitOfMeasureId,
         u.unit_code AS unitCode, u.unit_name AS unitName, u.symbol AS unitSymbol,
         COALESCE(SUM(sri.base_quantity_returned), 0.000) AS returnedBaseQuantity,
         COALESCE(SUM(CASE WHEN sri.is_restockable = 1 THEN sri.base_quantity_returned ELSE 0.000 END), 0.000) AS restockableBaseQuantity,
         COALESCE(SUM(CASE WHEN sri.is_restockable = 0 THEN sri.base_quantity_returned ELSE 0.000 END), 0.000) AS nonRestockableBaseQuantity
       FROM sales_return_items sri
       INNER JOIN sales_returns sr ON sr.sales_return_id = sri.sales_return_id
       INNER JOIN product_variants pv ON pv.product_variant_id = sri.product_variant_id
       INNER JOIN units_of_measure u ON u.unit_of_measure_id = pv.unit_of_measure_id
       ${where}
       GROUP BY u.unit_of_measure_id, u.unit_code, u.unit_name, u.symbol
       ORDER BY u.unit_code, u.unit_of_measure_id`,
      parameters,
    ),
    pool.execute(
      `SELECT COALESCE(SUM(sp.amount), 0.00) AS completedRefundAmount
       FROM sale_payments sp
       INNER JOIN sales_returns sr ON sr.sales_return_id = sp.sales_return_id
       WHERE sr.branch_id = ? AND sr.status = 'COMPLETED'
         AND sp.status = 'COMPLETED' AND sp.payment_type = 'REFUND'
         AND sp.paid_at >= ? AND sp.paid_at < ?
         AND EXISTS (
           SELECT 1 FROM sales_return_items sri
           WHERE sri.sales_return_id = sr.sales_return_id ${optionalSql}
         )`,
      [branchId, range.startUtc, range.endUtcExclusive, ...optional.parameters],
    ),
    pool.execute(
      `SELECT COALESCE(SUM(sp.amount), 0.00) AS pendingRefundAmount
       FROM (${matchedReturns}) matched_returns
       INNER JOIN sale_payments sp ON sp.sales_return_id = matched_returns.sales_return_id
       WHERE sp.status = 'PENDING' AND sp.payment_type = 'REFUND'`,
      parameters,
    ),
    pool.execute(`SELECT CAST(COUNT(*) AS CHAR) AS totalItems FROM (${grouped}) return_groups`, parameters),
    pool.execute(
      `${grouped} ORDER BY refundEntitlementAmount DESC, returnReasonId, itemCondition, productVariantId LIMIT ? OFFSET ?`,
      [...parameters, filters.limit, filters.offset],
    ),
  ]);
  return {
    summary: {
      ...headerRows[0],
      quantitiesByUnit: quantityRows,
      ...refundRows[0],
      ...pendingRows[0],
    },
    items: rows,
    totalItems: countAsSafeNumber(countRows[0].totalItems, 'returns report'),
  };
}
function paymentFilters(branchId, range, filters, completed) {
  const predicates = ['s.branch_id = ?'];
  const parameters = [branchId];
  if (completed) {
    predicates.push("sp.status = 'COMPLETED'", 'sp.paid_at >= ?', 'sp.paid_at < ?');
  } else {
    predicates.push('sp.created_at >= ?', 'sp.created_at < ?');
  }
  parameters.push(range.startUtc, range.endUtcExclusive);
  if (filters.paymentMethodId) {
    predicates.push('sp.payment_method_id = ?');
    parameters.push(filters.paymentMethodId);
  }
  if (filters.paymentType) {
    predicates.push('sp.payment_type = ?');
    parameters.push(filters.paymentType);
  }
  if (filters.methodType) {
    predicates.push('pm.method_type = ?');
    parameters.push(filters.methodType);
  }
  if (filters.status) {
    predicates.push('sp.status = ?');
    parameters.push(filters.status);
  }
  return { where: `WHERE ${predicates.join(' AND ')}`, parameters };
}

async function paymentsReport(branchId, range, filters) {
  const financial = paymentFilters(branchId, range, filters, true);
  const attempts = paymentFilters(branchId, range, filters, false);
  const [[financialRows], [attemptRows]] = await Promise.all([
    pool.execute(
      `SELECT CAST(pm.payment_method_id AS CHAR) AS paymentMethodId,
         pm.method_code AS methodCode, pm.method_name AS methodName, pm.method_type AS methodType,
         COALESCE(SUM(CASE WHEN sp.payment_type = 'PAYMENT' THEN sp.amount ELSE 0.00 END), 0.00) AS completedPaymentAmount,
         COALESCE(SUM(CASE WHEN sp.payment_type = 'REFUND' THEN sp.amount ELSE 0.00 END), 0.00) AS completedRefundAmount,
         CAST(SUM(sp.payment_type = 'PAYMENT') AS CHAR) AS completedPaymentCount,
         CAST(SUM(sp.payment_type = 'REFUND') AS CHAR) AS completedRefundCount
       FROM sale_payments sp INNER JOIN sales s ON s.sale_id = sp.sale_id
       INNER JOIN payment_methods pm ON pm.payment_method_id = sp.payment_method_id
       ${financial.where}
       GROUP BY pm.payment_method_id, pm.method_code, pm.method_name, pm.method_type`,
      financial.parameters,
    ),
    pool.execute(
      `SELECT CAST(pm.payment_method_id AS CHAR) AS paymentMethodId,
         pm.method_code AS methodCode, pm.method_name AS methodName, pm.method_type AS methodType,
         CAST(SUM(sp.status = 'PENDING') AS CHAR) AS pendingCount,
         CAST(SUM(sp.status = 'FAILED') AS CHAR) AS failedCount,
         CAST(SUM(sp.status = 'CANCELLED') AS CHAR) AS cancelledCount
       FROM sale_payments sp INNER JOIN sales s ON s.sale_id = sp.sale_id
       INNER JOIN payment_methods pm ON pm.payment_method_id = sp.payment_method_id
       ${attempts.where}
       GROUP BY pm.payment_method_id, pm.method_code, pm.method_name, pm.method_type`,
      attempts.parameters,
    ),
  ]);
  return { financialRows, attemptRows };
}
function inventoryWhere(branchId, filters, expiryStart, expiryEnd) {
  const predicates = ['bi.branch_id = ?'];
  const parameters = [branchId];
  if (filters.categoryId) {
    predicates.push('p.category_id = ?'); parameters.push(filters.categoryId);
  }
  if (filters.productId) {
    predicates.push('p.product_id = ?'); parameters.push(filters.productId);
  }
  if (filters.productVariantId) {
    predicates.push('pv.product_variant_id = ?'); parameters.push(filters.productVariantId);
  }
  if (filters.lotTrackingMode) {
    predicates.push('pv.lot_tracking_mode = ?'); parameters.push(filters.lotTrackingMode);
  }
  if (filters.search) {
    predicates.push('(LOCATE(?, pv.sku) > 0 OR LOCATE(?, p.product_code) > 0 OR LOCATE(?, p.product_name) > 0 OR LOCATE(?, pv.variant_name) > 0)');
    parameters.push(...Array(4).fill(filters.search));
  }
  if (filters.stockState === 'OUT_OF_STOCK') predicates.push('bi.quantity_on_hand <= 0.000');
  if (filters.stockState === 'LOW_STOCK') predicates.push('bi.quantity_on_hand > 0.000 AND bi.reorder_level > 0.000 AND bi.quantity_on_hand <= bi.reorder_level');
  if (filters.stockState === 'IN_STOCK') predicates.push('bi.quantity_on_hand > 0.000 AND (bi.reorder_level = 0.000 OR bi.quantity_on_hand > bi.reorder_level)');
  if (filters.expiringWithinDays !== null) {
    predicates.push(`EXISTS (
      SELECT 1 FROM branch_lot_inventory exp_bli
      INNER JOIN inventory_lots exp_il ON exp_il.inventory_lot_id = exp_bli.inventory_lot_id
      WHERE exp_bli.branch_id = bi.branch_id
        AND exp_il.product_variant_id = bi.product_variant_id
        AND exp_bli.quantity_on_hand > 0.000
        AND exp_bli.status = 'AVAILABLE' AND exp_il.status = 'ACTIVE'
        AND exp_il.expires_on >= ? AND exp_il.expires_on <= ?
    )`);
    parameters.push(expiryStart, expiryEnd);
  }
  return { where: `WHERE ${predicates.join(' AND ')}`, parameters };
}

async function inventoryReport(branchId, filters, expiryStart, expiryEnd) {
  const { where, parameters } = inventoryWhere(branchId, filters, expiryStart, expiryEnd);
  const [countRows] = await pool.execute(
    `SELECT CAST(COUNT(*) AS CHAR) AS totalItems
     FROM branch_inventory bi
     INNER JOIN product_variants pv ON pv.product_variant_id = bi.product_variant_id
     INNER JOIN products p ON p.product_id = pv.product_id
     INNER JOIN units_of_measure u ON u.unit_of_measure_id = pv.unit_of_measure_id
     ${where}`,
    parameters,
  );
  const [rows] = await pool.execute(
    `SELECT CAST(bi.product_variant_id AS CHAR) AS productVariantId,
       pv.sku, pv.variant_name AS variantName,
       CAST(p.product_id AS CHAR) AS productId, p.product_code AS productCode,
       p.product_name AS productName, CAST(p.category_id AS CHAR) AS categoryId,
       CAST(u.unit_of_measure_id AS CHAR) AS unitOfMeasureId,
       u.unit_code AS unitCode, u.unit_name AS unitName, u.symbol AS unitSymbol,
       pv.lot_tracking_mode AS lotTrackingMode,
       bi.quantity_on_hand AS quantityOnHand, bi.reorder_level AS reorderLevel,
       bi.reorder_quantity AS reorderQuantity,
       CAST(COALESCE(lots.lot_count, 0) AS CHAR) AS lotCount,
       CAST(COALESCE(lots.available_lot_count, 0) AS CHAR) AS availableLotCount,
       DATE_FORMAT(lots.earliest_expiry_date, '%Y-%m-%d') AS earliestExpiryDate,
       CAST(COALESCE(lots.expiring_lot_count, 0) AS CHAR) AS expiringLotCount
     FROM branch_inventory bi
     INNER JOIN product_variants pv ON pv.product_variant_id = bi.product_variant_id
     INNER JOIN products p ON p.product_id = pv.product_id
     INNER JOIN units_of_measure u ON u.unit_of_measure_id = pv.unit_of_measure_id
     LEFT JOIN (
       SELECT bli.branch_id, il.product_variant_id,
         COUNT(*) AS lot_count,
         SUM(bli.status = 'AVAILABLE' AND il.status = 'ACTIVE' AND (il.expires_on IS NULL OR il.expires_on >= ?)) AS available_lot_count,
         MIN(CASE WHEN il.status <> 'CLOSED' AND bli.status <> 'DEPLETED' THEN il.expires_on END) AS earliest_expiry_date,
         SUM(bli.status = 'AVAILABLE' AND il.status = 'ACTIVE' AND il.expires_on >= ? AND il.expires_on <= ?) AS expiring_lot_count
       FROM branch_lot_inventory bli
       INNER JOIN inventory_lots il ON il.inventory_lot_id = bli.inventory_lot_id
       WHERE bli.branch_id = ? AND bli.quantity_on_hand > 0.000
         AND bli.status <> 'DEPLETED' AND il.status <> 'CLOSED'
       GROUP BY bli.branch_id, il.product_variant_id
     ) lots ON lots.branch_id = bi.branch_id AND lots.product_variant_id = bi.product_variant_id
     ${where}
     ORDER BY pv.sku, bi.product_variant_id LIMIT ? OFFSET ?`,
    [expiryStart, expiryStart, expiryEnd, branchId, ...parameters, filters.limit, filters.offset],
  );
  const variantIds = rows.map(({ productVariantId }) => productVariantId);
  let histories = [];
  if (variantIds.length) {
    const placeholders = variantIds.map(() => '?').join(', ');
    [histories] = await pool.execute(
      `SELECT CAST(iti.product_variant_id AS CHAR) AS productVariantId,
         iti.quantity_change AS quantityChange, iti.unit_cost AS unitCost
       FROM inventory_transaction_items iti
       INNER JOIN inventory_transactions it ON it.inventory_transaction_id = iti.inventory_transaction_id
       WHERE it.branch_id = ? AND iti.product_variant_id IN (${placeholders})
       ORDER BY it.occurred_at, it.inventory_transaction_id, iti.inventory_transaction_item_id`,
      [branchId, ...variantIds],
    );
  }
  return {
    items: rows,
    histories,
    totalItems: countAsSafeNumber(countRows[0].totalItems, 'inventory report'),
  };
}

async function inventoryMovements(branchId, range, filters) {
  const predicates = ['it.branch_id = ?', 'it.occurred_at >= ?', 'it.occurred_at < ?'];
  const parameters = [branchId, range.startUtc, range.endUtcExclusive];
  for (const [field, column] of [
    ['productVariantId', 'iti.product_variant_id'], ['transactionType', 'it.transaction_type'],
    ['createdByEmployeeId', 'it.created_by_employee_id'],
  ]) {
    if (filters[field]) {
      predicates.push(`${column} = ?`); parameters.push(filters[field]);
    }
  }
  const where = `WHERE ${predicates.join(' AND ')}`;
  const [countRows] = await pool.execute(
    `SELECT CAST(COUNT(*) AS CHAR) AS totalItems
     FROM inventory_transaction_items iti
     INNER JOIN inventory_transactions it ON it.inventory_transaction_id = iti.inventory_transaction_id ${where}`,
    parameters,
  );
  const [rows] = await pool.execute(
    `SELECT CAST(it.inventory_transaction_id AS CHAR) AS inventoryTransactionId,
       CAST(iti.inventory_transaction_item_id AS CHAR) AS inventoryTransactionItemId,
       it.transaction_number AS transactionNumber, it.transaction_type AS transactionType,
       DATE_FORMAT(it.occurred_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS occurredAt,
       CAST(it.created_by_employee_id AS CHAR) AS createdByEmployeeId,
       e.employee_number AS employeeNumber, e.first_name AS employeeFirstName,
       e.last_name AS employeeLastName,
       CAST(iti.product_variant_id AS CHAR) AS productVariantId,
       pv.sku, pv.variant_name AS variantName,
       iti.quantity_change AS quantityChange, iti.unit_cost AS unitCost
     FROM inventory_transaction_items iti
     INNER JOIN inventory_transactions it ON it.inventory_transaction_id = iti.inventory_transaction_id
     INNER JOIN product_variants pv ON pv.product_variant_id = iti.product_variant_id
     LEFT JOIN employees e ON e.employee_id = it.created_by_employee_id
     ${where}
     ORDER BY it.occurred_at DESC, it.inventory_transaction_id DESC,
       iti.inventory_transaction_item_id DESC LIMIT ? OFFSET ?`,
    [...parameters, filters.limit, filters.offset],
  );
  return {
    items: rows,
    totalItems: countAsSafeNumber(countRows[0].totalItems, 'inventory movement report'),
  };
}

function purchaseFilters(branchId, range, filters, alias = 'po') {
  const predicates = [`${alias}.branch_id = ?`, `${alias}.ordered_at >= ?`, `${alias}.ordered_at < ?`];
  const parameters = [branchId, range.startUtc, range.endUtcExclusive];
  if (filters.supplierId) {
    predicates.push(`${alias}.supplier_id = ?`); parameters.push(filters.supplierId);
  }
  if (filters.status) {
    predicates.push(`${alias}.status = ?`); parameters.push(filters.status);
  }
  return { where: `WHERE ${predicates.join(' AND ')}`, parameters };
}

async function purchasingReport(branchId, range, filters) {
  const orders = purchaseFilters(branchId, range, filters);
  const receiptPredicates = [
    'gr.branch_id = ?', "gr.status = 'POSTED'", 'gr.posted_at >= ?', 'gr.posted_at < ?',
  ];
  const receiptParameters = [branchId, range.startUtc, range.endUtcExclusive];
  if (filters.supplierId) {
    receiptPredicates.push('gr.supplier_id = ?'); receiptParameters.push(filters.supplierId);
  }
  if (filters.status) {
    receiptPredicates.push('po.status = ?'); receiptParameters.push(filters.status);
  }
  const receiptWhere = `WHERE ${receiptPredicates.join(' AND ')}`;
  const [[orderRows], [orderLineRows], [receiptRows]] = await Promise.all([
    pool.execute(
      `SELECT CAST(COUNT(*) AS CHAR) AS purchaseOrderCount,
         COALESCE(SUM(po.total_amount), 0.00) AS orderedAmount
       FROM purchase_orders po ${orders.where}`,
      orders.parameters,
    ),
    pool.execute(
      `SELECT CAST(COUNT(*) AS CHAR) AS orderedLineCount
       FROM purchase_order_items poi INNER JOIN purchase_orders po ON po.purchase_order_id = poi.purchase_order_id ${orders.where}`,
      orders.parameters,
    ),
    pool.execute(
      `SELECT CAST(COUNT(DISTINCT gr.goods_receipt_id) AS CHAR) AS postedReceiptCount,
         CAST(COUNT(gri.goods_receipt_item_id) AS CHAR) AS receiptLineCount,
         CAST(SUM(gri.quantity_accepted > 0.000) AS CHAR) AS acceptedLineCount,
         CAST(SUM(gri.quantity_rejected > 0.000) AS CHAR) AS rejectedLineCount,
         COALESCE(SUM(gri.line_total), 0.00) AS actualReceivedCostAmount
       FROM goods_receipts gr
       INNER JOIN purchase_orders po ON po.purchase_order_id = gr.purchase_order_id
       LEFT JOIN goods_receipt_items gri ON gri.goods_receipt_id = gr.goods_receipt_id
       ${receiptWhere}`,
      receiptParameters,
    ),
  ]);
  return { orderPeriod: { ...orderRows[0], ...orderLineRows[0] }, receiptPeriod: receiptRows[0] };
}

function supplierReportSql(branchId, range, filters) {
  const predicates = [];
  const parameters = [branchId, range.startUtc, range.endUtcExclusive,
    branchId, range.startUtc, range.endUtcExclusive];
  if (filters.supplierId) {
    predicates.push('sup.supplier_id = ?'); parameters.push(filters.supplierId);
  }
  if (filters.search) {
    predicates.push('(LOCATE(?, sup.supplier_code) > 0 OR LOCATE(?, sup.supplier_name) > 0)');
    parameters.push(filters.search, filters.search);
  }
  predicates.push('(COALESCE(po_metrics.purchase_order_count, 0) > 0 OR COALESCE(gr_metrics.posted_receipt_count, 0) > 0)');
  const where = `WHERE ${predicates.join(' AND ')}`;
  const base = `SELECT CAST(sup.supplier_id AS CHAR) AS supplierId,
      sup.supplier_code AS supplierCode, sup.supplier_name AS supplierName, sup.status,
      CAST(COALESCE(po_metrics.purchase_order_count, 0) AS CHAR) AS purchaseOrderCount,
      COALESCE(po_metrics.ordered_amount, 0.00) AS orderedAmount,
      CAST(COALESCE(po_metrics.ordered_line_count, 0) AS CHAR) AS orderedLineCount,
      CAST(COALESCE(gr_metrics.posted_receipt_count, 0) AS CHAR) AS postedReceiptCount,
      CAST(COALESCE(gr_metrics.receipt_line_count, 0) AS CHAR) AS receiptLineCount,
      CAST(COALESCE(gr_metrics.accepted_line_count, 0) AS CHAR) AS acceptedLineCount,
      CAST(COALESCE(gr_metrics.rejected_line_count, 0) AS CHAR) AS rejectedLineCount,
      COALESCE(gr_metrics.actual_received_cost_amount, 0.00) AS actualReceivedCostAmount
    FROM suppliers sup
    LEFT JOIN (
      SELECT po.supplier_id, COUNT(*) AS purchase_order_count,
        SUM(po.total_amount) AS ordered_amount,
        SUM(COALESCE(order_lines.line_count, 0)) AS ordered_line_count
      FROM purchase_orders po
      LEFT JOIN (
        SELECT purchase_order_id, COUNT(*) AS line_count
        FROM purchase_order_items GROUP BY purchase_order_id
      ) order_lines ON order_lines.purchase_order_id = po.purchase_order_id
      WHERE po.branch_id = ? AND po.ordered_at >= ? AND po.ordered_at < ?
      GROUP BY po.supplier_id
    ) po_metrics ON po_metrics.supplier_id = sup.supplier_id
    LEFT JOIN (
      SELECT gr.supplier_id, COUNT(DISTINCT gr.goods_receipt_id) AS posted_receipt_count,
        COUNT(gri.goods_receipt_item_id) AS receipt_line_count,
        SUM(gri.quantity_accepted > 0.000) AS accepted_line_count,
        SUM(gri.quantity_rejected > 0.000) AS rejected_line_count,
        SUM(gri.line_total) AS actual_received_cost_amount
      FROM goods_receipts gr
      LEFT JOIN goods_receipt_items gri ON gri.goods_receipt_id = gr.goods_receipt_id
      WHERE gr.branch_id = ? AND gr.status = 'POSTED' AND gr.posted_at >= ? AND gr.posted_at < ?
      GROUP BY gr.supplier_id
    ) gr_metrics ON gr_metrics.supplier_id = sup.supplier_id
    ${where}`;
  return { base, parameters };
}

async function supplierReport(branchId, range, filters) {
  const { base, parameters } = supplierReportSql(branchId, range, filters);
  const [countRows] = await pool.execute(
    `SELECT CAST(COUNT(*) AS CHAR) AS totalItems FROM (${base}) supplier_rows`, parameters,
  );
  const [rows] = await pool.execute(
    `${base} ORDER BY orderedAmount DESC, supplierCode, supplierId LIMIT ? OFFSET ?`,
    [...parameters, filters.limit, filters.offset],
  );
  return { items: rows, totalItems: countAsSafeNumber(countRows[0].totalItems, 'supplier report') };
}
function tillReportSql(branchId, range, filters) {
  const predicates = ['ts.branch_id = ?', 'ts.opened_at >= ?', 'ts.opened_at < ?'];
  const parameters = [branchId, range.startUtc, range.endUtcExclusive];
  if (filters.cashierEmployeeId) {
    predicates.push('ts.cashier_employee_id = ?'); parameters.push(filters.cashierEmployeeId);
  }
  if (filters.posRegisterId) {
    predicates.push('ts.pos_register_id = ?'); parameters.push(filters.posRegisterId);
  }
  if (filters.status) {
    predicates.push('ts.status = ?'); parameters.push(filters.status);
  }
  const where = `WHERE ${predicates.join(' AND ')}`;
  const base = `SELECT CAST(ts.till_session_id AS CHAR) AS tillSessionId,
      ts.session_number AS sessionNumber, ts.status,
      CAST(ts.pos_register_id AS CHAR) AS posRegisterId,
      pr.register_code AS registerCode, pr.register_name AS registerName,
      CAST(ts.cashier_employee_id AS CHAR) AS cashierEmployeeId,
      e.employee_number AS cashierEmployeeNumber,
      e.first_name AS cashierFirstName, e.last_name AS cashierLastName,
      DATE_FORMAT(ts.opened_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS openedAt,
      DATE_FORMAT(ts.closed_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS closedAt,
      ts.opening_cash_amount AS openingCashAmount,
      ts.expected_closing_cash_amount AS expectedClosingCashAmount,
      ts.actual_closing_cash_amount AS actualClosingCashAmount,
      ts.cash_difference_amount AS cashDifferenceAmount,
      COALESCE(cash.completed_cash_payment_amount, 0.00) AS completedCashPaymentAmount,
      COALESCE(cash.completed_cash_refund_amount, 0.00) AS completedCashRefundAmount,
      COALESCE(movements.cash_in_amount, 0.00) AS cashInAmount,
      COALESCE(movements.cash_out_amount, 0.00) AS cashOutAmount,
      COALESCE(movements.cash_drop_amount, 0.00) AS cashDropAmount,
      COALESCE(movements.payout_amount, 0.00) AS payoutAmount,
      ts.opening_cash_amount
        + COALESCE(cash.completed_cash_payment_amount, 0.00)
        - COALESCE(cash.completed_cash_refund_amount, 0.00)
        + COALESCE(movements.cash_in_amount, 0.00)
        - COALESCE(movements.cash_out_amount, 0.00)
        - COALESCE(movements.cash_drop_amount, 0.00)
        - COALESCE(movements.payout_amount, 0.00) AS calculatedExpectedCashAmount
    FROM till_sessions ts
    INNER JOIN pos_registers pr ON pr.pos_register_id = ts.pos_register_id
    INNER JOIN employees e ON e.employee_id = ts.cashier_employee_id
    LEFT JOIN (
      SELECT s.till_session_id,
        SUM(CASE WHEN sp.payment_type = 'PAYMENT' THEN sp.amount ELSE 0.00 END) AS completed_cash_payment_amount,
        SUM(CASE WHEN sp.payment_type = 'REFUND' THEN sp.amount ELSE 0.00 END) AS completed_cash_refund_amount
      FROM sales s
      INNER JOIN sale_payments sp ON sp.sale_id = s.sale_id
      INNER JOIN payment_methods pm ON pm.payment_method_id = sp.payment_method_id
      WHERE s.branch_id = ? AND s.till_session_id IS NOT NULL
        AND sp.status = 'COMPLETED' AND pm.method_type = 'CASH'
      GROUP BY s.till_session_id
    ) cash ON cash.till_session_id = ts.till_session_id
    LEFT JOIN (
      SELECT tcm.till_session_id,
        SUM(CASE WHEN tcm.movement_type = 'CASH_IN' THEN tcm.amount ELSE 0.00 END) AS cash_in_amount,
        SUM(CASE WHEN tcm.movement_type = 'CASH_OUT' THEN tcm.amount ELSE 0.00 END) AS cash_out_amount,
        SUM(CASE WHEN tcm.movement_type = 'CASH_DROP' THEN tcm.amount ELSE 0.00 END) AS cash_drop_amount,
        SUM(CASE WHEN tcm.movement_type = 'PAYOUT' THEN tcm.amount ELSE 0.00 END) AS payout_amount
      FROM till_cash_movements tcm
      INNER JOIN till_sessions movement_ts ON movement_ts.till_session_id = tcm.till_session_id
      WHERE movement_ts.branch_id = ?
      GROUP BY tcm.till_session_id
    ) movements ON movements.till_session_id = ts.till_session_id
    ${where}`;
  return { base, parameters: [branchId, branchId, ...parameters] };
}

async function tillReport(branchId, range, filters) {
  const { base, parameters } = tillReportSql(branchId, range, filters);
  const [[countRows], [rows], [summaryRows]] = await Promise.all([
    pool.execute(`SELECT CAST(COUNT(*) AS CHAR) AS totalItems FROM (${base}) till_rows`, parameters),
    pool.execute(
      `${base} ORDER BY openedAt DESC, tillSessionId DESC LIMIT ? OFFSET ?`,
      [...parameters, filters.limit, filters.offset],
    ),
    pool.execute(
      `SELECT CAST(COUNT(*) AS CHAR) AS sessionCount,
         CAST(SUM(status = 'CLOSED') AS CHAR) AS closedSessionCount,
         COALESCE(SUM(completedCashPaymentAmount), 0.00) AS completedCashPaymentAmount,
         COALESCE(SUM(completedCashRefundAmount), 0.00) AS completedCashRefundAmount,
         COALESCE(SUM(cashInAmount), 0.00) AS cashInAmount,
         COALESCE(SUM(cashOutAmount), 0.00) AS cashOutAmount,
         COALESCE(SUM(cashDropAmount), 0.00) AS cashDropAmount,
         COALESCE(SUM(payoutAmount), 0.00) AS payoutAmount
       FROM (${base}) till_rows`,
      parameters,
    ),
  ]);
  return {
    items: rows,
    summary: summaryRows[0],
    totalItems: countAsSafeNumber(countRows[0].totalItems, 'till report'),
  };
}

function customerReportSql(branchId, range, filters) {
  const predicates = [];
  const parameters = [
    branchId, range.startUtc, range.endUtcExclusive,
    branchId, range.startUtc, range.endUtcExclusive,
    branchId, range.startUtc, range.endUtcExclusive,
  ];
  if (filters.customerId) {
    predicates.push('c.customer_id = ?'); parameters.push(filters.customerId);
  }
  if (filters.search) {
    predicates.push(`LOCATE(?, CONCAT_WS(' ', c.customer_number, c.first_name, c.last_name, c.business_name, c.email, c.phone, c.loyalty_number)) > 0`);
    parameters.push(filters.search);
  }
  predicates.push('(COALESCE(sales_metrics.completed_sales_count, 0) > 0 OR COALESCE(return_metrics.completed_return_count, 0) > 0 OR COALESCE(refund_metrics.completed_refund_count, 0) > 0)');
  const base = `SELECT CAST(c.customer_id AS CHAR) AS customerId,
      c.customer_number AS customerNumber, c.customer_type AS customerType,
      c.first_name AS firstName, c.last_name AS lastName, c.business_name AS businessName,
      c.status,
      CAST(COALESCE(sales_metrics.completed_sales_count, 0) AS CHAR) AS completedSalesCount,
      COALESCE(sales_metrics.gross_sales_amount, 0.00) AS grossSalesAmount,
      DATE_FORMAT(sales_metrics.last_purchase_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS lastPurchaseAt,
      CAST(COALESCE(return_metrics.completed_return_count, 0) AS CHAR) AS completedReturnCount,
      COALESCE(return_metrics.returned_merchandise_amount, 0.00) AS returnedMerchandiseAmount,
      COALESCE(refund_metrics.completed_refund_amount, 0.00) AS completedRefundAmount
    FROM customers c
    LEFT JOIN (
      SELECT s.customer_id, COUNT(*) AS completed_sales_count,
        SUM(s.total_amount) AS gross_sales_amount, MAX(s.sold_at) AS last_purchase_at
      FROM sales s
      WHERE s.branch_id = ? AND s.status = 'COMPLETED' AND s.customer_id IS NOT NULL
        AND s.sold_at >= ? AND s.sold_at < ?
      GROUP BY s.customer_id
    ) sales_metrics ON sales_metrics.customer_id = c.customer_id
    LEFT JOIN (
      SELECT sr.customer_id, COUNT(*) AS completed_return_count,
        SUM(sr.refund_total_amount) AS returned_merchandise_amount
      FROM sales_returns sr
      WHERE sr.branch_id = ? AND sr.status = 'COMPLETED' AND sr.customer_id IS NOT NULL
        AND sr.completed_at >= ? AND sr.completed_at < ?
      GROUP BY sr.customer_id
    ) return_metrics ON return_metrics.customer_id = c.customer_id
    LEFT JOIN (
      SELECT s.customer_id, COUNT(*) AS completed_refund_count,
        SUM(sp.amount) AS completed_refund_amount
      FROM sale_payments sp INNER JOIN sales s ON s.sale_id = sp.sale_id
      WHERE s.branch_id = ? AND s.customer_id IS NOT NULL
        AND sp.status = 'COMPLETED' AND sp.payment_type = 'REFUND'
        AND sp.paid_at >= ? AND sp.paid_at < ?
      GROUP BY s.customer_id
    ) refund_metrics ON refund_metrics.customer_id = c.customer_id
    WHERE ${predicates.join(' AND ')}`;
  return { base, parameters };
}

async function customerReport(branchId, range, filters) {
  const { base, parameters } = customerReportSql(branchId, range, filters);
  const [[countRows], [rows], [summaryRows]] = await Promise.all([
    pool.execute(`SELECT CAST(COUNT(*) AS CHAR) AS totalItems FROM (${base}) customer_rows`, parameters),
    pool.execute(
      `${base} ORDER BY grossSalesAmount DESC, customerNumber, customerId LIMIT ? OFFSET ?`,
      [...parameters, filters.limit, filters.offset],
    ),
    pool.execute(
      `SELECT CAST(COUNT(*) AS CHAR) AS customerCount,
         COALESCE(SUM(grossSalesAmount), 0.00) AS grossSalesAmount,
         COALESCE(SUM(returnedMerchandiseAmount), 0.00) AS returnedMerchandiseAmount,
         COALESCE(SUM(completedRefundAmount), 0.00) AS completedRefundAmount
       FROM (${base}) customer_rows`,
      parameters,
    ),
  ]);
  return {
    items: rows,
    summary: summaryRows[0],
    totalItems: countAsSafeNumber(countRows[0].totalItems, 'customer report'),
  };
}

export {
  ZERO_MONEY,
  ZERO_QUANTITY,
  customerReport,
  getOrganizationReportEvidence,
  inventoryMovements,
  inventoryReport,
  listOrganizationBranches,
  overviewCurrentState,
  paymentTotals,
  paymentsReport,
  productPerformance,
  purchasingReport,
  returnTotals,
  returnsReport,
  salesSummary,
  supplierReport,
  tillReport,
  trendEvents,
};
