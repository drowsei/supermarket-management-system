import { insertAuditLog } from './audit.repository.js';
import {
  countAsSafeNumber,
  getLastInsertId,
  lockRowsByIds,
  uniqueSortedIds,
} from './productCatalog.repository.js';
import {
  generateDocumentNumber,
  lockOperationalContext,
  pool,
  selectUtcNow,
  withPurchasingTransaction,
} from './purchasing.repository.js';
import {
  calculateHeaderTotals,
  calculatePurchaseLine,
  compareDecimals,
  deriveBaseQuantity,
  isWholeBaseQuantity,
  subtractDecimals,
} from '../utils/purchasingDecimal.js';
import { toIsoString } from '../utils/record.js';

const PURCHASE_ORDER_COLUMNS = `
  CAST(po.purchase_order_id AS CHAR) AS purchaseOrderId,
  po.purchase_order_number AS purchaseOrderNumber,
  CAST(po.branch_id AS CHAR) AS branchId,
  CAST(po.supplier_id AS CHAR) AS supplierId,
  po.status,
  DATE_FORMAT(po.ordered_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS orderedAt,
  DATE_FORMAT(po.expected_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS expectedAt,
  CAST(po.created_by_employee_id AS CHAR) AS createdByEmployeeId,
  CAST(po.approved_by_employee_id AS CHAR) AS approvedByEmployeeId,
  CAST(po.cancelled_by_employee_id AS CHAR) AS cancelledByEmployeeId,
  DATE_FORMAT(po.approved_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS approvedAt,
  DATE_FORMAT(po.cancelled_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS cancelledAt,
  po.supplier_quote_number AS supplierQuoteNumber,
  po.currency_code AS currencyCode,
  po.subtotal_amount AS subtotalAmount,
  po.discount_amount AS discountAmount,
  po.tax_amount AS taxAmount,
  po.shipping_amount AS shippingAmount,
  po.total_amount AS totalAmount,
  po.notes,
  po.created_at AS createdAt,
  po.updated_at AS updatedAt,
  s.supplier_code AS supplierCode,
  s.supplier_name AS supplierName,
  b.branch_code AS branchCode,
  b.branch_name AS branchName
`;

const PURCHASE_ORDER_ITEM_COLUMNS = `
  CAST(poi.purchase_order_item_id AS CHAR) AS purchaseOrderItemId,
  CAST(poi.purchase_order_id AS CHAR) AS purchaseOrderId,
  poi.line_number AS lineNumber,
  CAST(poi.product_variant_id AS CHAR) AS productVariantId,
  CAST(poi.product_package_id AS CHAR) AS productPackageId,
  poi.item_description AS itemDescription,
  poi.ordered_package_quantity AS orderedPackageQuantity,
  poi.package_conversion_factor AS packageConversionFactor,
  poi.ordered_quantity AS orderedQuantity,
  poi.unit_cost AS unitCost,
  poi.discount_amount AS discountAmount,
  poi.tax_rate_percent AS taxRatePercent,
  poi.tax_amount AS taxAmount,
  poi.line_total AS lineTotal,
  poi.created_at AS createdAt,
  poi.updated_at AS updatedAt
`;

function normalizePurchaseOrder(row) {
  if (!row) return null;
  return {
    ...row,
    approvedByEmployeeId: row.approvedByEmployeeId ?? null,
    cancelledByEmployeeId: row.cancelledByEmployeeId ?? null,
    orderedAt: row.orderedAt ?? null,
    expectedAt: row.expectedAt ?? null,
    approvedAt: row.approvedAt ?? null,
    cancelledAt: row.cancelledAt ?? null,
    supplierQuoteNumber: row.supplierQuoteNumber ?? null,
    notes: row.notes ?? null,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

function normalizePurchaseOrderItem(row) {
  if (!row) return null;
  const result = {
    ...row,
    productPackageId: row.productPackageId ?? null,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
  if (Object.hasOwn(row, 'acceptedQuantity')) {
    result.acceptedQuantity = row.acceptedQuantity;
    result.remainingQuantity = row.remainingQuantity;
  }
  return result;
}

function purchaseOrderAuditSnapshot(order) {
  const {
    supplierCode, supplierName, branchCode, branchName, createdAt, updatedAt,
    ...snapshot
  } = order;
  return snapshot;
}

function purchaseOrderItemAuditSnapshot(item) {
  const { createdAt, updatedAt, acceptedQuantity, remainingQuantity, ...snapshot } = item;
  return snapshot;
}

async function selectPurchaseOrder(executor, branchId, purchaseOrderId, forUpdate = false) {
  const [rows] = await executor.execute(
    `SELECT ${PURCHASE_ORDER_COLUMNS}
     FROM purchase_orders po
     INNER JOIN suppliers s ON s.supplier_id = po.supplier_id
     INNER JOIN branches b ON b.branch_id = po.branch_id
     WHERE po.branch_id = ? AND po.purchase_order_id = ?
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [branchId, purchaseOrderId],
  );
  return normalizePurchaseOrder(rows[0]);
}

async function selectPurchaseOrderItem(
  executor,
  branchId,
  purchaseOrderId,
  purchaseOrderItemId,
  forUpdate = false,
) {
  const [rows] = await executor.execute(
    `SELECT ${PURCHASE_ORDER_ITEM_COLUMNS}
     FROM purchase_order_items poi
     INNER JOIN purchase_orders po ON po.purchase_order_id = poi.purchase_order_id
     WHERE po.branch_id = ?
       AND poi.purchase_order_id = ?
       AND poi.purchase_order_item_id = ?
     LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [branchId, purchaseOrderId, purchaseOrderItemId],
  );
  return normalizePurchaseOrderItem(rows[0]);
}

async function selectOrderItems(executor, purchaseOrderId, { progress = false, forUpdate = false } = {}) {
  const progressColumns = progress
    ? `,
       COALESCE(SUM(CASE WHEN gr.status = 'POSTED' THEN gri.quantity_accepted ELSE 0 END), 0.000)
         AS acceptedQuantity,
       poi.ordered_quantity - COALESCE(SUM(CASE WHEN gr.status = 'POSTED' THEN gri.quantity_accepted ELSE 0 END), 0.000)
         AS remainingQuantity`
    : '';
  const progressJoins = progress
    ? `LEFT JOIN goods_receipt_items gri
         ON gri.purchase_order_item_id = poi.purchase_order_item_id
       LEFT JOIN goods_receipts gr
         ON gr.goods_receipt_id = gri.goods_receipt_id`
    : '';
  const group = progress ? 'GROUP BY poi.purchase_order_item_id' : '';
  const [rows] = await executor.execute(
    `SELECT ${PURCHASE_ORDER_ITEM_COLUMNS}${progressColumns}
     FROM purchase_order_items poi
     ${progressJoins}
     WHERE poi.purchase_order_id = ?
     ${group}
     ORDER BY poi.line_number, poi.purchase_order_item_id${forUpdate ? ' FOR UPDATE' : ''}`,
    [purchaseOrderId],
  );
  return rows.map(normalizePurchaseOrderItem);
}

async function listPurchaseOrders(branchId, filters) {
  const predicates = ['po.branch_id = ?'];
  const parameters = [branchId];
  if (filters.search) {
    predicates.push(`LOCATE(?, CONCAT_WS(' ', po.purchase_order_number,
      po.supplier_quote_number, s.supplier_code, s.supplier_name)) > 0`);
    parameters.push(filters.search);
  }
  for (const [value, column] of [
    [filters.status, 'po.status'],
    [filters.supplierId, 'po.supplier_id'],
    [filters.createdByEmployeeId, 'po.created_by_employee_id'],
  ]) {
    if (value !== null) {
      predicates.push(`${column} = ?`);
      parameters.push(value);
    }
  }
  if (filters.from) {
    predicates.push('po.created_at >= ?');
    parameters.push(filters.from);
  }
  if (filters.to) {
    predicates.push('po.created_at < DATE_ADD(?, INTERVAL 1 DAY)');
    parameters.push(filters.to);
  }
  const where = `WHERE ${predicates.join(' AND ')}`;
  const [countRows] = await pool.execute(
    `SELECT CAST(COUNT(*) AS CHAR) AS totalItems
     FROM purchase_orders po INNER JOIN suppliers s ON s.supplier_id = po.supplier_id
     ${where}`,
    parameters,
  );
  const [rows] = await pool.execute(
    `SELECT ${PURCHASE_ORDER_COLUMNS}
     FROM purchase_orders po
     INNER JOIN suppliers s ON s.supplier_id = po.supplier_id
     INNER JOIN branches b ON b.branch_id = po.branch_id
     ${where}
     ORDER BY po.created_at DESC, po.purchase_order_id DESC
     LIMIT ? OFFSET ?`,
    [...parameters, filters.limit, filters.offset],
  );
  return {
    items: rows.map(normalizePurchaseOrder),
    totalItems: countAsSafeNumber(countRows[0].totalItems, 'purchase order'),
  };
}

async function findPurchaseOrder(branchId, purchaseOrderId) {
  const purchaseOrder = await selectPurchaseOrder(pool, branchId, purchaseOrderId);
  if (!purchaseOrder) return null;
  return {
    purchaseOrder,
    items: await selectOrderItems(pool, purchaseOrderId, { progress: true }),
  };
}

async function validateOperational(connection, branchId, auditContext) {
  const context = await lockOperationalContext(
    connection,
    branchId,
    auditContext?.actorEmployeeId,
  );
  return context;
}

async function createPurchaseOrder(branchId, values, auditContext) {
  return withPurchasingTransaction(async (connection) => {
    const operational = await validateOperational(connection, branchId, auditContext);
    if (operational.outcome !== 'valid') return operational;

    const [supplierRows] = await connection.execute(
      `SELECT CAST(supplier_id AS CHAR) AS supplierId, status
       FROM suppliers WHERE supplier_id = ? LIMIT 1 FOR UPDATE`,
      [values.supplierId],
    );
    if (!supplierRows[0]) return { outcome: 'supplier_not_found' };
    if (supplierRows[0].status !== 'ACTIVE') return { outcome: 'supplier_not_active' };

    const now = await selectUtcNow(connection);
    if (values.expectedAt !== null && values.expectedAt < now) {
      return { outcome: 'expected_in_past' };
    }
    const purchaseOrderNumber = generateDocumentNumber('PO');
    await connection.execute(
      `INSERT INTO purchase_orders (
         purchase_order_number, branch_id, supplier_id, status, expected_at,
         created_by_employee_id, supplier_quote_number, currency_code,
         shipping_amount, total_amount, notes
       ) VALUES (?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?)`,
      [
        purchaseOrderNumber, branchId, values.supplierId, values.expectedAt,
        auditContext.actorEmployeeId, values.supplierQuoteNumber,
        operational.branch.currencyCode, values.shippingAmount,
        values.shippingAmount, values.notes,
      ],
    );
    const purchaseOrderId = await getLastInsertId(connection);
    const purchaseOrder = await selectPurchaseOrder(connection, branchId, purchaseOrderId);
    await insertAuditLog(connection, {
      auditContext,
      branchId,
      actionType: 'PURCHASE_ORDER_CREATED',
      entityType: 'purchase_orders',
      entityRecordId: purchaseOrderId,
      beforeValues: null,
      afterValues: purchaseOrderAuditSnapshot(purchaseOrder),
      notes: 'Purchase order draft created.',
    });
    return { outcome: 'created', purchaseOrder };
  });
}

async function recalculateHeader(connection, branchId, purchaseOrderId, shippingAmount) {
  const items = await selectOrderItems(connection, purchaseOrderId);
  const calculatedItems = items.map((item) => ({
    subtotalAmount: calculatePurchaseLine(item).subtotalAmount,
    discountAmount: item.discountAmount,
    taxAmount: item.taxAmount,
  }));
  const totals = calculateHeaderTotals(calculatedItems, shippingAmount);
  await connection.execute(
    `UPDATE purchase_orders SET
       subtotal_amount = ?, discount_amount = ?, tax_amount = ?, total_amount = ?
     WHERE purchase_order_id = ?`,
    [
      totals.subtotalAmount, totals.discountAmount, totals.taxAmount,
      totals.totalAmount, purchaseOrderId,
    ],
  );
  return selectPurchaseOrder(connection, branchId, purchaseOrderId);
}

const HEADER_COLUMNS = Object.freeze({
  expectedAt: 'expected_at',
  supplierQuoteNumber: 'supplier_quote_number',
  shippingAmount: 'shipping_amount',
  notes: 'notes',
});

async function updatePurchaseOrder(branchId, purchaseOrderId, changes, auditContext) {
  return withPurchasingTransaction(async (connection) => {
    const operational = await validateOperational(connection, branchId, auditContext);
    if (operational.outcome !== 'valid') return operational;
    const current = await selectPurchaseOrder(connection, branchId, purchaseOrderId, true);
    if (!current) return { outcome: 'not_found' };
    if (current.status !== 'DRAFT') return { outcome: 'not_draft' };
    if (changes.expectedAt !== undefined && changes.expectedAt !== null) {
      const now = await selectUtcNow(connection);
      if (changes.expectedAt < now) return { outcome: 'expected_in_past' };
    }
    const changed = Object.entries(changes).filter(([field, value]) => {
      const currentValue =
        field === 'expectedAt' && current.expectedAt
          ? current.expectedAt.replace('T', ' ').replace('Z', '')
          : current[field];
      return currentValue !== value;
    });
    if (changed.length === 0) return { outcome: 'unchanged', purchaseOrder: current };
    await connection.execute(
      `UPDATE purchase_orders SET ${changed.map(([field]) => `${HEADER_COLUMNS[field]} = ?`).join(', ')}
       WHERE purchase_order_id = ?`,
      [...changed.map(([, value]) => value), purchaseOrderId],
    );
    const shippingAmount = changes.shippingAmount ?? current.shippingAmount;
    const purchaseOrder = await recalculateHeader(
      connection, branchId, purchaseOrderId, shippingAmount,
    );
    await insertAuditLog(connection, {
      auditContext, branchId,
      actionType: 'PURCHASE_ORDER_UPDATED', entityType: 'purchase_orders',
      entityRecordId: purchaseOrderId,
      beforeValues: purchaseOrderAuditSnapshot(current),
      afterValues: purchaseOrderAuditSnapshot(purchaseOrder),
      notes: 'Purchase order draft header updated.',
    });
    return { outcome: 'updated', purchaseOrder };
  });
}

async function preReadItemIdentity(branchId, purchaseOrderId, productVariantId) {
  const [rows] = await pool.execute(
    `SELECT
       CAST(po.supplier_id AS CHAR) AS supplierId,
       CAST(pv.product_id AS CHAR) AS productId
     FROM purchase_orders po
     INNER JOIN product_variants pv ON pv.product_variant_id = ?
     WHERE po.branch_id = ? AND po.purchase_order_id = ?
     LIMIT 1`,
    [productVariantId, branchId, purchaseOrderId],
  );
  return rows[0] ?? null;
}

async function lockEligibility(connection, supplierId, productId, productVariantId) {
  const [productRows] = await connection.execute(
    `SELECT status, product_name AS productName
     FROM products WHERE product_id = ? LIMIT 1 FOR UPDATE`,
    [productId],
  );
  if (!productRows[0]) return { outcome: 'variant_not_found' };
  const [variantRows] = await connection.execute(
    `SELECT
       CAST(product_variant_id AS CHAR) AS productVariantId,
       CAST(product_id AS CHAR) AS productId,
       sku, variant_name AS variantName, status, is_fractional AS isFractional,
       lot_tracking_mode AS lotTrackingMode,
       requires_expiry_date AS requiresExpiryDate
     FROM product_variants
     WHERE product_variant_id = ? AND product_id = ?
     LIMIT 1 FOR UPDATE`,
    [productVariantId, productId],
  );
  if (!variantRows[0]) return { outcome: 'variant_not_found' };
  const [packageRows] = await connection.execute(
    `SELECT
       CAST(product_package_id AS CHAR) AS productPackageId,
       package_name AS packageName, conversion_to_base_quantity AS conversionFactor,
       status, is_purchasable AS isPurchasable
     FROM product_packages
     WHERE product_variant_id = ?
     ORDER BY product_package_id FOR UPDATE`,
    [productVariantId],
  );
  const [supplierRows] = await connection.execute(
    `SELECT status FROM suppliers WHERE supplier_id = ? LIMIT 1 FOR UPDATE`,
    [supplierId],
  );
  if (!supplierRows[0]) return { outcome: 'supplier_not_found' };
  const [supplierProductRows] = await connection.execute(
    `SELECT minimum_order_quantity AS minimumOrderQuantity
     FROM supplier_products
     WHERE supplier_id = ? AND product_variant_id = ?
     LIMIT 1 FOR UPDATE`,
    [supplierId, productVariantId],
  );
  const [supplierPackageRows] = await connection.execute(
    `SELECT
       CAST(product_package_id AS CHAR) AS productPackageId,
       minimum_package_quantity AS minimumPackageQuantity,
       is_active AS isActive
     FROM supplier_product_packages
     WHERE supplier_id = ? AND product_variant_id = ?
     ORDER BY product_package_id FOR UPDATE`,
    [supplierId, productVariantId],
  );
  return {
    outcome: 'found',
    product: productRows[0], variant: variantRows[0], packages: packageRows,
    supplier: supplierRows[0], supplierProduct: supplierProductRows[0] ?? null,
    supplierPackages: supplierPackageRows,
  };
}

function validateEligibility(state, productPackageId, orderedPackageQuantity, orderedQuantity) {
  if (state.product.status !== 'ACTIVE' || state.variant.status !== 'ACTIVE') {
    return 'inactive_product';
  }
  if (state.supplier.status !== 'ACTIVE') return 'supplier_not_active';
  if (!state.supplierProduct) return 'supplier_relationship_missing';
  if (
    compareDecimals(orderedQuantity, state.supplierProduct.minimumOrderQuantity, 3) < 0
  ) return 'minimum_order_quantity';
  if (!state.variant.isFractional && !isWholeBaseQuantity(orderedQuantity)) {
    return 'fractional_quantity';
  }
  if (productPackageId === null) return null;
  const productPackage = state.packages.find(
    (entry) => entry.productPackageId === productPackageId,
  );
  if (!productPackage) return 'package_not_found';
  if (productPackage.status !== 'ACTIVE' || !productPackage.isPurchasable) {
    return 'package_not_purchasable';
  }
  const supplierPackage = state.supplierPackages.find(
    (entry) => entry.productPackageId === productPackageId,
  );
  if (!supplierPackage || !supplierPackage.isActive) {
    return 'supplier_package_missing';
  }
  if (
    compareDecimals(orderedPackageQuantity, supplierPackage.minimumPackageQuantity, 3) < 0
  ) return 'minimum_package_quantity';
  return null;
}

function buildItemCalculation(values, conversionFactor) {
  const orderedQuantity = deriveBaseQuantity(
    values.orderedPackageQuantity,
    conversionFactor,
  );
  const calculation = calculatePurchaseLine({ ...values, orderedQuantity });
  return { orderedQuantity, ...calculation };
}

async function createPurchaseOrderItem(
  branchId, purchaseOrderId, values, auditContext,
) {
  const identity = await preReadItemIdentity(
    branchId, purchaseOrderId, values.productVariantId,
  );
  if (!identity) return { outcome: 'not_found' };
  return withPurchasingTransaction(async (connection) => {
    const operational = await validateOperational(connection, branchId, auditContext);
    if (operational.outcome !== 'valid') return operational;
    const eligibility = await lockEligibility(
      connection, identity.supplierId, identity.productId, values.productVariantId,
    );
    if (eligibility.outcome !== 'found') return eligibility;
    const purchaseOrder = await selectPurchaseOrder(
      connection, branchId, purchaseOrderId, true,
    );
    if (!purchaseOrder) return { outcome: 'not_found' };
    if (purchaseOrder.status !== 'DRAFT') return { outcome: 'not_draft' };
    if (purchaseOrder.supplierId !== identity.supplierId) {
      return { outcome: 'concurrent_change' };
    }
    const productPackage = values.productPackageId === null
      ? null
      : eligibility.packages.find(
        (entry) => entry.productPackageId === values.productPackageId,
      );
    const conversionFactor = productPackage?.conversionFactor ?? '1.000000';
    const calculation = buildItemCalculation(values, conversionFactor);
    if (calculation.outcome !== 'calculated') return calculation;
    const invalid = validateEligibility(
      eligibility, values.productPackageId, values.orderedPackageQuantity,
      calculation.orderedQuantity,
    );
    if (invalid) return { outcome: invalid };
    const [lineRows] = await connection.execute(
      `SELECT COALESCE(MAX(line_number), 0) + 1 AS lineNumber
       FROM purchase_order_items WHERE purchase_order_id = ?`,
      [purchaseOrderId],
    );
    const lineNumber = lineRows[0].lineNumber;
    if (lineNumber > 65_535) return { outcome: 'too_many_items' };
    const itemDescription = `${eligibility.product.productName} - ${eligibility.variant.variantName}${
      productPackage ? ` (${productPackage.packageName})` : ''
    }`.slice(0, 255);
    await connection.execute(
      `INSERT INTO purchase_order_items (
         purchase_order_id, line_number, product_variant_id, product_package_id,
         item_description, ordered_package_quantity, package_conversion_factor,
         ordered_quantity, unit_cost, discount_amount, tax_rate_percent,
         tax_amount, line_total
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        purchaseOrderId, lineNumber, values.productVariantId,
        values.productPackageId, itemDescription, values.orderedPackageQuantity,
        conversionFactor, calculation.orderedQuantity, values.unitCost,
        values.discountAmount, values.taxRatePercent, calculation.taxAmount,
        calculation.lineTotal,
      ],
    );
    const itemId = await getLastInsertId(connection);
    const item = await selectPurchaseOrderItem(
      connection, branchId, purchaseOrderId, itemId,
    );
    const updatedOrder = await recalculateHeader(
      connection, branchId, purchaseOrderId, purchaseOrder.shippingAmount,
    );
    await insertAuditLog(connection, {
      auditContext, branchId,
      actionType: 'PURCHASE_ORDER_ITEM_CREATED', entityType: 'purchase_order_items',
      entityRecordId: itemId, beforeValues: null,
      afterValues: purchaseOrderItemAuditSnapshot(item),
      notes: `Purchase order ${updatedOrder.purchaseOrderNumber} item created.`,
    });
    return { outcome: 'created', item, purchaseOrder: updatedOrder };
  });
}

async function preReadExistingItem(branchId, purchaseOrderId, purchaseOrderItemId) {
  const [rows] = await pool.execute(
    `SELECT
       CAST(poi.product_variant_id AS CHAR) AS productVariantId,
       CAST(poi.product_package_id AS CHAR) AS productPackageId,
       CAST(pv.product_id AS CHAR) AS productId,
       CAST(po.supplier_id AS CHAR) AS supplierId
     FROM purchase_order_items poi
     INNER JOIN purchase_orders po ON po.purchase_order_id = poi.purchase_order_id
     INNER JOIN product_variants pv ON pv.product_variant_id = poi.product_variant_id
     WHERE po.branch_id = ? AND poi.purchase_order_id = ?
       AND poi.purchase_order_item_id = ? LIMIT 1`,
    [branchId, purchaseOrderId, purchaseOrderItemId],
  );
  return rows[0] ?? null;
}

async function updatePurchaseOrderItem(
  branchId, purchaseOrderId, purchaseOrderItemId, changes, auditContext,
) {
  const identity = await preReadExistingItem(
    branchId, purchaseOrderId, purchaseOrderItemId,
  );
  if (!identity) return { outcome: 'item_not_found' };
  return withPurchasingTransaction(async (connection) => {
    const operational = await validateOperational(connection, branchId, auditContext);
    if (operational.outcome !== 'valid') return operational;
    const eligibility = await lockEligibility(
      connection, identity.supplierId, identity.productId, identity.productVariantId,
    );
    if (eligibility.outcome !== 'found') return eligibility;
    const purchaseOrder = await selectPurchaseOrder(
      connection, branchId, purchaseOrderId, true,
    );
    if (!purchaseOrder) return { outcome: 'not_found' };
    if (purchaseOrder.status !== 'DRAFT') return { outcome: 'not_draft' };
    const current = await selectPurchaseOrderItem(
      connection, branchId, purchaseOrderId, purchaseOrderItemId, true,
    );
    if (!current) return { outcome: 'item_not_found' };
    if (
      current.productVariantId !== identity.productVariantId ||
      current.productPackageId !== identity.productPackageId
    ) return { outcome: 'concurrent_change' };
    const projected = { ...current, ...changes };
    const calculation = buildItemCalculation(
      projected, current.packageConversionFactor,
    );
    if (calculation.outcome !== 'calculated') return calculation;
    const invalid = validateEligibility(
      eligibility, current.productPackageId, projected.orderedPackageQuantity,
      calculation.orderedQuantity,
    );
    if (invalid) return { outcome: invalid };
    const finalValues = {
      orderedPackageQuantity: projected.orderedPackageQuantity,
      unitCost: projected.unitCost,
      discountAmount: projected.discountAmount,
      taxRatePercent: projected.taxRatePercent,
      orderedQuantity: calculation.orderedQuantity,
      taxAmount: calculation.taxAmount,
      lineTotal: calculation.lineTotal,
    };
    const unchanged = Object.entries(finalValues).every(
      ([field, value]) => current[field] === value,
    );
    if (unchanged) return { outcome: 'unchanged', item: current, purchaseOrder };
    await connection.execute(
      `UPDATE purchase_order_items SET
         ordered_package_quantity = ?, ordered_quantity = ?, unit_cost = ?,
         discount_amount = ?, tax_rate_percent = ?, tax_amount = ?, line_total = ?
       WHERE purchase_order_item_id = ?`,
      [
        finalValues.orderedPackageQuantity, finalValues.orderedQuantity,
        finalValues.unitCost, finalValues.discountAmount,
        finalValues.taxRatePercent, finalValues.taxAmount,
        finalValues.lineTotal, purchaseOrderItemId,
      ],
    );
    const item = await selectPurchaseOrderItem(
      connection, branchId, purchaseOrderId, purchaseOrderItemId,
    );
    const updatedOrder = await recalculateHeader(
      connection, branchId, purchaseOrderId, purchaseOrder.shippingAmount,
    );
    await insertAuditLog(connection, {
      auditContext, branchId,
      actionType: 'PURCHASE_ORDER_ITEM_UPDATED', entityType: 'purchase_order_items',
      entityRecordId: purchaseOrderItemId,
      beforeValues: purchaseOrderItemAuditSnapshot(current),
      afterValues: purchaseOrderItemAuditSnapshot(item),
      notes: `Purchase order ${updatedOrder.purchaseOrderNumber} item updated.`,
    });
    return { outcome: 'updated', item, purchaseOrder: updatedOrder };
  });
}

async function deletePurchaseOrderItem(
  branchId, purchaseOrderId, purchaseOrderItemId, auditContext,
) {
  return withPurchasingTransaction(async (connection) => {
    const operational = await validateOperational(connection, branchId, auditContext);
    if (operational.outcome !== 'valid') return operational;
    const purchaseOrder = await selectPurchaseOrder(
      connection, branchId, purchaseOrderId, true,
    );
    if (!purchaseOrder) return { outcome: 'not_found' };
    if (purchaseOrder.status !== 'DRAFT') return { outcome: 'not_draft' };
    const item = await selectPurchaseOrderItem(
      connection, branchId, purchaseOrderId, purchaseOrderItemId, true,
    );
    if (!item) return { outcome: 'item_not_found' };
    await connection.execute(
      'DELETE FROM purchase_order_items WHERE purchase_order_item_id = ?',
      [purchaseOrderItemId],
    );
    const updatedOrder = await recalculateHeader(
      connection, branchId, purchaseOrderId, purchaseOrder.shippingAmount,
    );
    await insertAuditLog(connection, {
      auditContext, branchId,
      actionType: 'PURCHASE_ORDER_ITEM_DELETED', entityType: 'purchase_order_items',
      entityRecordId: purchaseOrderItemId,
      beforeValues: purchaseOrderItemAuditSnapshot(item), afterValues: null,
      notes: `Purchase order ${updatedOrder.purchaseOrderNumber} draft item deleted.`,
    });
    return { outcome: 'deleted', item, purchaseOrder: updatedOrder };
  });
}

async function preReadOrderCatalog(branchId, purchaseOrderId) {
  const [orderRows] = await pool.execute(
    `SELECT CAST(supplier_id AS CHAR) AS supplierId
     FROM purchase_orders WHERE branch_id = ? AND purchase_order_id = ? LIMIT 1`,
    [branchId, purchaseOrderId],
  );
  if (!orderRows[0]) return null;
  const [itemRows] = await pool.execute(
    `SELECT
       CAST(poi.purchase_order_item_id AS CHAR) AS purchaseOrderItemId,
       CAST(poi.product_variant_id AS CHAR) AS productVariantId,
       CAST(poi.product_package_id AS CHAR) AS productPackageId,
       CAST(pv.product_id AS CHAR) AS productId
     FROM purchase_order_items poi
     INNER JOIN product_variants pv ON pv.product_variant_id = poi.product_variant_id
     WHERE poi.purchase_order_id = ? ORDER BY poi.purchase_order_item_id`,
    [purchaseOrderId],
  );
  return { supplierId: orderRows[0].supplierId, items: itemRows };
}

async function lockCatalogSet(connection, preRead) {
  const products = await lockRowsByIds(connection, {
    table: 'products', idColumn: 'product_id',
    ids: preRead.items.map((item) => item.productId),
    selectColumns: 'CAST(product_id AS CHAR) AS productId, status',
  });
  const variants = await lockRowsByIds(connection, {
    table: 'product_variants', idColumn: 'product_variant_id',
    ids: preRead.items.map((item) => item.productVariantId),
    selectColumns: `CAST(product_variant_id AS CHAR) AS productVariantId,
      CAST(product_id AS CHAR) AS productId, status, is_fractional AS isFractional`,
  });
  const variantIds = uniqueSortedIds(preRead.items.map((item) => item.productVariantId));
  const placeholders = variantIds.map(() => '?').join(', ');
  let packages = [];
  if (variantIds.length) {
    [packages] = await connection.execute(
      `SELECT CAST(product_package_id AS CHAR) AS productPackageId,
        CAST(product_variant_id AS CHAR) AS productVariantId,
        status, is_purchasable AS isPurchasable
       FROM product_packages WHERE product_variant_id IN (${placeholders})
       ORDER BY product_variant_id, product_package_id FOR UPDATE`,
      variantIds,
    );
  }
  const [supplierRows] = await connection.execute(
    'SELECT status FROM suppliers WHERE supplier_id = ? LIMIT 1 FOR UPDATE',
    [preRead.supplierId],
  );
  let supplierProducts = [];
  let supplierPackages = [];
  if (variantIds.length) {
    [supplierProducts] = await connection.execute(
      `SELECT CAST(product_variant_id AS CHAR) AS productVariantId,
        minimum_order_quantity AS minimumOrderQuantity
       FROM supplier_products
       WHERE supplier_id = ? AND product_variant_id IN (${placeholders})
       ORDER BY product_variant_id FOR UPDATE`,
      [preRead.supplierId, ...variantIds],
    );
    [supplierPackages] = await connection.execute(
      `SELECT CAST(product_variant_id AS CHAR) AS productVariantId,
        CAST(product_package_id AS CHAR) AS productPackageId,
        minimum_package_quantity AS minimumPackageQuantity, is_active AS isActive
       FROM supplier_product_packages
       WHERE supplier_id = ? AND product_variant_id IN (${placeholders})
       ORDER BY product_variant_id, product_package_id FOR UPDATE`,
      [preRead.supplierId, ...variantIds],
    );
  }
  return { products, variants, packages, supplier: supplierRows[0], supplierProducts, supplierPackages };
}

function validateCurrentOrderItems(preRead, persistedItems, state) {
  if (!state.supplier || state.supplier.status !== 'ACTIVE') return 'supplier_not_active';
  if (persistedItems.length === 0) return 'empty_order';
  if (persistedItems.length !== preRead.items.length) return 'concurrent_change';
  const products = new Map(state.products.map((entry) => [entry.productId, entry]));
  const variants = new Map(state.variants.map((entry) => [entry.productVariantId, entry]));
  const preItems = new Map(preRead.items.map((entry) => [entry.purchaseOrderItemId, entry]));
  for (const item of persistedItems) {
    const identity = preItems.get(item.purchaseOrderItemId);
    if (!identity || identity.productVariantId !== item.productVariantId) return 'concurrent_change';
    if (products.get(identity.productId)?.status !== 'ACTIVE') return 'inactive_product';
    const variant = variants.get(item.productVariantId);
    if (!variant || variant.status !== 'ACTIVE') return 'inactive_product';
    if (!variant.isFractional && !isWholeBaseQuantity(item.orderedQuantity)) {
      return 'fractional_quantity';
    }
    const relationship = state.supplierProducts.find(
      (entry) => entry.productVariantId === item.productVariantId,
    );
    if (!relationship) return 'supplier_relationship_missing';
    if (compareDecimals(item.orderedQuantity, relationship.minimumOrderQuantity, 3) < 0) {
      return 'minimum_order_quantity';
    }
    if (item.productPackageId !== null) {
      const currentPackage = state.packages.find(
        (entry) => entry.productPackageId === item.productPackageId &&
          entry.productVariantId === item.productVariantId,
      );
      if (!currentPackage || currentPackage.status !== 'ACTIVE' || !currentPackage.isPurchasable) {
        return 'package_not_purchasable';
      }
      const supplierPackage = state.supplierPackages.find(
        (entry) => entry.productPackageId === item.productPackageId && entry.isActive,
      );
      if (!supplierPackage) return 'supplier_package_missing';
      if (compareDecimals(item.orderedPackageQuantity, supplierPackage.minimumPackageQuantity, 3) < 0) {
        return 'minimum_package_quantity';
      }
    }
    const recomputed = calculatePurchaseLine(item);
    if (
      recomputed.outcome !== 'calculated' ||
      recomputed.taxAmount !== item.taxAmount || recomputed.lineTotal !== item.lineTotal
    ) return 'invalid_totals';
  }
  return null;
}

async function transitionPurchaseOrder(
  branchId, purchaseOrderId, action, reason, auditContext,
) {
  const preRead = await preReadOrderCatalog(branchId, purchaseOrderId);
  if (!preRead) return { outcome: 'not_found' };
  return withPurchasingTransaction(async (connection) => {
    const operational = await validateOperational(connection, branchId, auditContext);
    if (operational.outcome !== 'valid') return operational;
    let catalogState = null;
    if (action === 'submit' || action === 'approve') {
      catalogState = await lockCatalogSet(connection, preRead);
    }
    const purchaseOrder = await selectPurchaseOrder(
      connection, branchId, purchaseOrderId, true,
    );
    if (!purchaseOrder) return { outcome: 'not_found' };
    const items = await selectOrderItems(connection, purchaseOrderId);
    if (action === 'submit' && purchaseOrder.status !== 'DRAFT') {
      return { outcome: 'invalid_transition' };
    }
    if (action === 'approve' && purchaseOrder.status !== 'SUBMITTED') {
      return { outcome: 'invalid_transition' };
    }
    if (action === 'cancel') {
      if (!['DRAFT', 'SUBMITTED', 'APPROVED'].includes(purchaseOrder.status)) {
        return { outcome: 'invalid_transition' };
      }
      const [receiptRows] = await connection.execute(
        `SELECT goods_receipt_id FROM goods_receipts
         WHERE purchase_order_id = ? AND status <> 'CANCELLED'
         ORDER BY goods_receipt_id FOR UPDATE`,
        [purchaseOrderId],
      );
      if (receiptRows.length) return { outcome: 'dependent_receipt' };
    } else {
      const invalid = validateCurrentOrderItems(preRead, items, catalogState);
      if (invalid) return { outcome: invalid };
      const totals = calculateHeaderTotals(
        items.map((item) => ({
          subtotalAmount: calculatePurchaseLine(item).subtotalAmount,
          discountAmount: item.discountAmount,
          taxAmount: item.taxAmount,
        })),
        purchaseOrder.shippingAmount,
      );
      if (
        totals.subtotalAmount !== purchaseOrder.subtotalAmount ||
        totals.discountAmount !== purchaseOrder.discountAmount ||
        totals.taxAmount !== purchaseOrder.taxAmount ||
        totals.totalAmount !== purchaseOrder.totalAmount
      ) return { outcome: 'invalid_totals' };
    }
    const now = await selectUtcNow(connection);
    if (
      action === 'submit' && purchaseOrder.expectedAt !== null &&
      purchaseOrder.expectedAt.replace('T', ' ').replace('Z', '') < now
    ) return { outcome: 'expected_in_past' };
    let updateSql;
    let parameters;
    let auditAction;
    if (action === 'submit') {
      updateSql = "UPDATE purchase_orders SET status = 'SUBMITTED', ordered_at = ? WHERE purchase_order_id = ?";
      parameters = [now, purchaseOrderId];
      auditAction = 'PURCHASE_ORDER_SUBMITTED';
    } else if (action === 'approve') {
      updateSql = `UPDATE purchase_orders SET status = 'APPROVED',
        approved_by_employee_id = ?, approved_at = ? WHERE purchase_order_id = ?`;
      parameters = [auditContext.actorEmployeeId, now, purchaseOrderId];
      auditAction = 'PURCHASE_ORDER_APPROVED';
    } else {
      updateSql = `UPDATE purchase_orders SET status = 'CANCELLED',
        cancelled_by_employee_id = ?, cancelled_at = ? WHERE purchase_order_id = ?`;
      parameters = [auditContext.actorEmployeeId, now, purchaseOrderId];
      auditAction = 'PURCHASE_ORDER_CANCELLED';
    }
    await connection.execute(updateSql, parameters);
    const updated = await selectPurchaseOrder(connection, branchId, purchaseOrderId);
    await insertAuditLog(connection, {
      auditContext, branchId, actionType: auditAction,
      entityType: 'purchase_orders', entityRecordId: purchaseOrderId,
      beforeValues: purchaseOrderAuditSnapshot(purchaseOrder),
      afterValues: purchaseOrderAuditSnapshot(updated),
      notes: action === 'cancel'
        ? (reason ? `Purchase order cancelled: ${reason}` : 'Purchase order cancelled.')
        : `Purchase order ${action === 'submit' ? 'submitted' : 'approved'}.`,
    });
    return { outcome: action === 'cancel' ? 'cancelled' : action === 'submit' ? 'submitted' : 'approved', purchaseOrder: updated };
  });
}

export {
  createPurchaseOrder,
  createPurchaseOrderItem,
  deletePurchaseOrderItem,
  findPurchaseOrder,
  listPurchaseOrders,
  transitionPurchaseOrder,
  updatePurchaseOrder,
  updatePurchaseOrderItem,
};
