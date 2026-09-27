import {
  calculateSaleHeader,
  compareQuantity,
  formatScaledDecimal,
  negateQuantity,
  parseScaledDecimal,
  reconstructWeightedAverage,
} from '../utils/salesDecimal.js';
import {
  applyBranchMovements,
  applyLotMovements,
  assertLotConsistency,
  lockBranchInventory,
  lockBranchLots,
} from './inventoryMovement.repository.js';
import {
  getLastInsertId,
  lockRowsByIds,
  uniqueSortedIds,
} from './productCatalog.repository.js';
import { generateDocumentNumber, selectUtcNow } from './purchasing.repository.js';
import {
  abortSale,
  analyzeSalePayments,
  lockCustomer,
  lockRegisterAndTill,
  lockSalePayments,
  lockSalesOperationalContext,
  preReadSale,
  saleSnapshot,
  selectSale,
  selectSaleDetail,
  selectSaleItems,
  withSalesTransaction,
} from './sale.repository.js';
import { insertAuditLog } from './audit.repository.js';
import pool from '../config/database.js';

function isDuplicateEntry(error) {
  return error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062;
}

function transactionNumberConflict(error) {
  return isDuplicateEntry(error) &&
    `${error?.message ?? ''} ${error?.sqlMessage ?? ''}`.includes(
      'uq_inventory_transactions_number',
    );
}

async function preReadCompletion(branchId, saleId) {
  const sale = await preReadSale(branchId, saleId);
  if (!sale) return null;
  const [rows] = await pool.execute(
    `SELECT CAST(si.sale_item_id AS CHAR) AS saleItemId,
       CAST(si.product_variant_id AS CHAR) AS productVariantId,
       CAST(si.product_package_id AS CHAR) AS productPackageId,
       CAST(pv.product_id AS CHAR) AS productId,
       CAST(pv.unit_of_measure_id AS CHAR) AS variantUnitId,
       CAST(pp.package_unit_of_measure_id AS CHAR) AS packageUnitId,
       CAST(p.category_id AS CHAR) AS categoryId,
       CAST(p.brand_id AS CHAR) AS brandId,
       CAST(p.tax_rate_id AS CHAR) AS taxRateId
     FROM sale_items si
     INNER JOIN product_variants pv
       ON pv.product_variant_id = si.product_variant_id
     INNER JOIN products p ON p.product_id = pv.product_id
     LEFT JOIN product_packages pp
       ON pp.product_package_id = si.product_package_id
      AND pp.product_variant_id = si.product_variant_id
     WHERE si.sale_id = ?
     ORDER BY si.line_number, si.sale_item_id`,
    [saleId],
  );
  return { sale, catalog: rows };
}

async function lockCompletionCatalog(connection, references) {
  const referenceTables = [
    ['categories', 'category_id', references.map((row) => row.categoryId)],
    ['brands', 'brand_id', references.map((row) => row.brandId)],
    ['tax_rates', 'tax_rate_id', references.map((row) => row.taxRateId)],
    [
      'units_of_measure',
      'unit_of_measure_id',
      references.flatMap((row) => [row.variantUnitId, row.packageUnitId]),
    ],
  ];
  for (const [table, idColumn, ids] of referenceTables) {
    await lockRowsByIds(connection, {
      table, idColumn, ids, selectColumns: idColumn,
    });
  }

  const products = await lockRowsByIds(connection, {
    table: 'products', idColumn: 'product_id',
    ids: references.map((row) => row.productId),
    selectColumns: `CAST(product_id AS CHAR) AS productId,
      CAST(category_id AS CHAR) AS categoryId,
      CAST(brand_id AS CHAR) AS brandId,
      CAST(tax_rate_id AS CHAR) AS taxRateId, status`,
  });
  const variants = await lockRowsByIds(connection, {
    table: 'product_variants', idColumn: 'product_variant_id',
    ids: references.map((row) => row.productVariantId),
    selectColumns: `CAST(product_variant_id AS CHAR) AS productVariantId,
      CAST(product_id AS CHAR) AS productId,
      CAST(unit_of_measure_id AS CHAR) AS variantUnitId,
      status, is_fractional AS isFractional,
      lot_tracking_mode AS lotTrackingMode`,
  });
  const variantIds = uniqueSortedIds(references.map((row) => row.productVariantId));
  let packages = [];
  if (variantIds.length > 0) {
    const placeholders = variantIds.map(() => '?').join(', ');
    const [rows] = await connection.execute(
      `SELECT CAST(product_package_id AS CHAR) AS productPackageId,
         CAST(product_variant_id AS CHAR) AS productVariantId,
         CAST(package_unit_of_measure_id AS CHAR) AS packageUnitId,
         status, is_sellable AS isSellable
       FROM product_packages
       WHERE product_variant_id IN (${placeholders})
       ORDER BY product_variant_id, product_package_id FOR UPDATE`,
      variantIds,
    );
    packages = rows;
  }

  const productMap = new Map(products.map((row) => [row.productId, row]));
  const variantMap = new Map(variants.map((row) => [row.productVariantId, row]));
  const packageMap = new Map(packages.map((row) => [row.productPackageId, row]));
  const policies = new Map();

  for (const reference of references) {
    const product = productMap.get(reference.productId);
    const variant = variantMap.get(reference.productVariantId);
    const productPackage = packageMap.get(reference.productPackageId);
    if (!product || !variant || !productPackage) {
      return { outcome: 'catalog_changed' };
    }
    if (
      product.categoryId !== reference.categoryId ||
      product.brandId !== reference.brandId ||
      product.taxRateId !== reference.taxRateId ||
      variant.productId !== reference.productId ||
      variant.variantUnitId !== reference.variantUnitId ||
      productPackage.productVariantId !== reference.productVariantId ||
      productPackage.packageUnitId !== reference.packageUnitId
    ) return { outcome: 'catalog_changed' };
    if (product.status !== 'ACTIVE') return { outcome: 'product_not_active' };
    if (variant.status !== 'ACTIVE') return { outcome: 'variant_not_active' };
    if (productPackage.status !== 'ACTIVE') return { outcome: 'package_not_active' };
    if (Number(productPackage.isSellable) !== 1) {
      return { outcome: 'package_not_sellable' };
    }
    policies.set(reference.productVariantId, {
      isFractional: Number(variant.isFractional) === 1,
      lotTrackingMode: variant.lotTrackingMode,
    });
  }
  return { outcome: 'valid', policies };
}

async function lockGlobalLotsForVariants(connection, variantIds, utcDate) {
  const ids = uniqueSortedIds(variantIds);
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const [rows] = await connection.execute(
    `SELECT CAST(il.inventory_lot_id AS CHAR) AS inventoryLotId,
       CAST(il.product_variant_id AS CHAR) AS productVariantId,
       il.status, DATE_FORMAT(il.expires_on, '%Y-%m-%d') AS expiresOn,
       il.expires_on < ? AS isExpired
     FROM inventory_lots il
     WHERE il.product_variant_id IN (${placeholders})
     ORDER BY il.product_variant_id, il.inventory_lot_id FOR UPDATE`,
    [utcDate, ...ids],
  );
  return rows;
}

async function lockValuationHistory(connection, branchId, variantIds) {
  const ids = uniqueSortedIds(variantIds);
  const result = new Map(ids.map((id) => [id, []]));
  if (ids.length === 0) return result;
  const placeholders = ids.map(() => '?').join(', ');
  const [rows] = await connection.execute(
    `SELECT CAST(iti.product_variant_id AS CHAR) AS productVariantId,
       iti.quantity_change AS quantityChange, iti.unit_cost AS unitCost
     FROM inventory_transactions it
     INNER JOIN inventory_transaction_items iti
       ON iti.inventory_transaction_id = it.inventory_transaction_id
     WHERE it.branch_id = ?
       AND iti.product_variant_id IN (${placeholders})
     ORDER BY it.occurred_at, it.inventory_transaction_id,
       iti.line_number, iti.inventory_transaction_item_id
     FOR UPDATE`,
    [branchId, ...ids],
  );
  for (const row of rows) result.get(row.productVariantId)?.push(row);
  return result;
}

function branchKey(branchId, id) {
  return `${branchId}:${id}`;
}

function aggregateRequired(items) {
  const totals = new Map();
  for (const item of items) {
    const current = totals.get(item.productVariantId) ?? 0n;
    totals.set(
      item.productVariantId,
      current + parseScaledDecimal(item.baseQuantity, 3),
    );
  }
  return totals;
}

function eligibleLots(globalLots, branchLots, branchId, variantId, utcDate) {
  return globalLots
    .filter((lot) => {
      const branchLot = branchLots.get(branchKey(branchId, lot.inventoryLotId));
      return lot.productVariantId === variantId &&
        lot.status === 'ACTIVE' &&
        (lot.expiresOn === null || lot.expiresOn >= utcDate) &&
        branchLot?.status === 'AVAILABLE' &&
        compareQuantity(branchLot.quantityOnHand, '0.000') > 0;
    })
    .sort((left, right) => {
      if (left.expiresOn === null && right.expiresOn !== null) return 1;
      if (left.expiresOn !== null && right.expiresOn === null) return -1;
      if (left.expiresOn !== right.expiresOn) {
        return left.expiresOn < right.expiresOn ? -1 : 1;
      }
      const leftId = BigInt(left.inventoryLotId);
      const rightId = BigInt(right.inventoryLotId);
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });
}

function allocateSaleLots(
  items,
  policies,
  globalLots,
  branchLots,
  branchId,
  utcDate,
) {
  const available = new Map();
  for (const lot of globalLots) {
    const row = branchLots.get(branchKey(branchId, lot.inventoryLotId));
    if (row) available.set(lot.inventoryLotId, parseScaledDecimal(row.quantityOnHand, 3));
  }
  const allocations = new Map();

  for (const item of items) {
    const mode = policies.get(item.productVariantId)?.lotTrackingMode;
    if (mode === 'NONE') {
      allocations.set(item.saleItemId, []);
      continue;
    }
    let remaining = parseScaledDecimal(item.baseQuantity, 3);
    const itemLots = [];
    for (const lot of eligibleLots(
      globalLots, branchLots, branchId, item.productVariantId, utcDate,
    )) {
      const lotAvailable = available.get(lot.inventoryLotId) ?? 0n;
      if (lotAvailable <= 0n || remaining <= 0n) continue;
      const allocated = lotAvailable < remaining ? lotAvailable : remaining;
      available.set(lot.inventoryLotId, lotAvailable - allocated);
      remaining -= allocated;
      itemLots.push({
        inventoryLotId: lot.inventoryLotId,
        baseQuantityAllocated: formatScaledDecimal(allocated, 3),
      });
    }
    if (mode === 'REQUIRED' && remaining > 0n) {
      return { outcome: 'required_lot_shortage' };
    }
    allocations.set(item.saleItemId, itemLots);
  }
  return { outcome: 'allocated', allocations };
}

async function createSaleLedger(
  connection,
  { branchId, actorEmployeeId, sale, items, costs, allocations, completionTime },
) {
  let inventoryTransactionId = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await connection.execute(
        `INSERT INTO inventory_transactions (
           branch_id, transaction_number, transaction_type, occurred_at,
           created_by_employee_id, notes
         ) VALUES (?, ?, 'SALE', ?, ?, ?)`,
        [branchId, generateDocumentNumber('IT'), completionTime,
          actorEmployeeId, `Sale ${sale.saleNumber}`],
      );
      inventoryTransactionId = await getLastInsertId(connection);
      break;
    } catch (error) {
      if (transactionNumberConflict(error)) continue;
      throw error;
    }
  }
  if (inventoryTransactionId === null) {
    return { outcome: 'transaction_number_conflict' };
  }

  for (const item of items) {
    const cost = costs.get(item.productVariantId);
    await connection.execute(
      `INSERT INTO inventory_transaction_items (
         inventory_transaction_id, line_number, product_variant_id,
         quantity_change, unit_cost
       ) VALUES (?, ?, ?, ?, ?)`,
      [inventoryTransactionId, item.lineNumber, item.productVariantId,
        negateQuantity(item.baseQuantity), cost],
    );
    const inventoryTransactionItemId = await getLastInsertId(connection);
    for (const lot of allocations.get(item.saleItemId) ?? []) {
      await connection.execute(
        `INSERT INTO inventory_transaction_lot_allocations (
           inventory_transaction_item_id, inventory_lot_id,
           product_variant_id, quantity_change, unit_cost
         ) VALUES (?, ?, ?, ?, ?)`,
        [inventoryTransactionItemId, lot.inventoryLotId, item.productVariantId,
          negateQuantity(lot.baseQuantityAllocated), cost],
      );
    }
  }
  return { outcome: 'created', inventoryTransactionId };
}

async function completeSale(branchId, saleId, auditContext) {
  const preRead = await preReadCompletion(branchId, saleId);
  if (!preRead) return { outcome: 'sale_not_found' };

  return withSalesTransaction(async (connection) => {
    const context = await lockSalesOperationalContext(
      connection,
      branchId,
      auditContext?.actorEmployeeId,
      { cashierEmployeeId: preRead.sale.cashierEmployeeId },
    );
    if (context.outcome !== 'valid') return context;

    const catalog = await lockCompletionCatalog(connection, preRead.catalog);
    if (catalog.outcome !== 'valid') return catalog;
    const customer = await lockCustomer(connection, preRead.sale.customerId);
    if (customer.outcome !== 'valid') return customer;
    const till = await lockRegisterAndTill(connection, branchId, preRead.sale);
    if (till.outcome !== 'valid') return till;
    const sale = await selectSale(connection, branchId, saleId, { forUpdate: true });
    if (!sale) return { outcome: 'sale_not_found' };
    if (sale.status !== 'OPEN') return { outcome: 'sale_not_open' };
    if (
      sale.posRegisterId !== preRead.sale.posRegisterId ||
      sale.tillSessionId !== preRead.sale.tillSessionId ||
      sale.cashierEmployeeId !== preRead.sale.cashierEmployeeId ||
      sale.customerId !== preRead.sale.customerId
    ) return { outcome: 'concurrent_change' };
    if (
      sale.currencyCode !== till.till.currencyCode ||
      sale.currencyCode !== context.branch.currencyCode
    ) return { outcome: 'currency_mismatch' };

    const paymentState = analyzeSalePayments(
      await lockSalePayments(connection, saleId),
      sale.totalAmount,
    );
    if (paymentState.hasRefund) return { outcome: 'payment_history_conflict' };
    if (paymentState.hasPendingPayment) return { outcome: 'payment_pending' };
    if (paymentState.completed < paymentState.total) {
      return { outcome: 'payment_incomplete' };
    }
    if (paymentState.completed > paymentState.total) {
      return { outcome: 'payment_overpaid' };
    }

    const items = await selectSaleItems(connection, saleId, { forUpdate: true });
    if (items.length === 0) return { outcome: 'empty_sale' };
    if (
      items.length !== preRead.catalog.length ||
      items.some((item, index) =>
        item.saleItemId !== preRead.catalog[index]?.saleItemId ||
        item.productVariantId !== preRead.catalog[index]?.productVariantId ||
        item.productPackageId !== preRead.catalog[index]?.productPackageId)
    ) return { outcome: 'concurrent_change' };

    const totals = calculateSaleHeader(items);
    if (totals.outcome !== 'calculated') return totals;
    if (
      totals.subtotalAmount !== sale.subtotalAmount ||
      totals.discountAmount !== sale.discountAmount ||
      totals.taxAmount !== sale.taxAmount ||
      totals.totalAmount !== sale.totalAmount
    ) return { outcome: 'header_totals_conflict' };

    const completionTime = await selectUtcNow(connection);
    const utcDate = completionTime.slice(0, 10);
    const variantIds = uniqueSortedIds(items.map((item) => item.productVariantId));
    const globalLots = await lockGlobalLotsForVariants(
      connection, variantIds, utcDate,
    );
    const branchInventory = await lockBranchInventory(
      connection, [branchId], variantIds,
    );
    const required = aggregateRequired(items);
    for (const [variantId, requiredScaled] of required) {
      const row = branchInventory.get(branchKey(branchId, variantId));
      if (!row || parseScaledDecimal(row.quantityOnHand, 3) < requiredScaled) {
        return { outcome: 'insufficient_stock' };
      }
    }
    const branchLots = await lockBranchLots(
      connection, [branchId], globalLots.map((lot) => lot.inventoryLotId),
    );
    const history = await lockValuationHistory(connection, branchId, variantIds);
    const costs = new Map();
    for (const variantId of variantIds) {
      const projected = branchInventory.get(
        branchKey(branchId, variantId),
      )?.quantityOnHand ?? '0.000';
      const valuation = reconstructWeightedAverage(
        history.get(variantId) ?? [], projected,
      );
      if (valuation.outcome !== 'calculated') return valuation;
      costs.set(variantId, valuation.unitCost);
    }

    const allocation = allocateSaleLots(
      items, catalog.policies, globalLots, branchLots, branchId, utcDate,
    );
    if (allocation.outcome !== 'allocated') return allocation;
    const movements = items.map((item) => ({
      productVariantId: item.productVariantId,
      quantityChange: negateQuantity(item.baseQuantity),
      unitCost: costs.get(item.productVariantId),
      lots: (allocation.allocations.get(item.saleItemId) ?? []).map((lot) => ({
        inventoryLotId: lot.inventoryLotId,
        quantityChange: negateQuantity(lot.baseQuantityAllocated),
        unitCost: costs.get(item.productVariantId),
      })),
    }));

    const ledger = await createSaleLedger(connection, {
      branchId, actorEmployeeId: auditContext.actorEmployeeId,
      sale, items, costs, allocations: allocation.allocations, completionTime,
    });
    if (ledger.outcome !== 'created') abortSale(ledger.outcome);
    const branchResult = await applyBranchMovements(
      connection, branchId, movements, branchInventory,
    );
    if (branchResult.outcome !== 'applied') abortSale(branchResult.outcome);
    const lotResult = await applyLotMovements(
      connection, branchId,
      movements.flatMap((movement) => movement.lots),
      branchLots, globalLots, { outboundStrict: true },
    );
    if (lotResult.outcome !== 'applied') abortSale(lotResult.outcome);
    const consistent = await assertLotConsistency(
      connection, branchId, catalog.policies, variantIds,
    );
    if (consistent.outcome !== 'valid') abortSale(consistent.outcome);

    for (const item of items) {
      for (const lot of allocation.allocations.get(item.saleItemId) ?? []) {
        await connection.execute(
          `INSERT INTO sale_item_lots (
             sale_item_id, inventory_lot_id, product_variant_id,
             base_quantity_allocated
           ) VALUES (?, ?, ?, ?)`,
          [item.saleItemId, lot.inventoryLotId, item.productVariantId,
            lot.baseQuantityAllocated],
        );
      }
      await connection.execute(
        'UPDATE sale_items SET unit_cost = ? WHERE sale_item_id = ?',
        [costs.get(item.productVariantId), item.saleItemId],
      );
    }

    await connection.execute(
      `UPDATE sales SET status = 'COMPLETED', sold_at = ?,
         inventory_transaction_id = ? WHERE sale_id = ?`,
      [completionTime, ledger.inventoryTransactionId, saleId],
    );
    const completed = await selectSale(connection, branchId, saleId);
    await insertAuditLog(connection, {
      auditContext, branchId, actionType: 'SALE_COMPLETED',
      entityType: 'sales', entityRecordId: saleId,
      beforeValues: saleSnapshot(sale), afterValues: saleSnapshot(completed),
      notes: 'Sale completed and inventory posted atomically through the checkout API.',
    });
    return {
      outcome: 'completed',
      sale: await selectSaleDetail(connection, branchId, saleId),
    };
  });
}

export { completeSale };
