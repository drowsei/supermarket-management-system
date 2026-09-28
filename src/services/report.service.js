import {
  ZERO_MONEY,
  ZERO_QUANTITY,
  customerReport as fetchCustomerReport,
  getOrganizationReportEvidence,
  inventoryMovements as fetchInventoryMovements,
  inventoryReport as fetchInventoryReport,
  listOrganizationBranches,
  overviewCurrentState,
  paymentTotals,
  paymentsReport as fetchPaymentsReport,
  productPerformance as fetchProductPerformance,
  purchasingReport as fetchPurchasingReport,
  returnTotals,
  returnsReport as fetchReturnsReport,
  salesSummary as fetchSalesSummary,
  supplierReport as fetchSupplierReport,
  tillReport as fetchTillReport,
  trendEvents,
} from '../repositories/report.repository.js';
import {
  buildBusinessRange,
  currentLocalDate,
  enumeratePeriods,
  localBusinessDate,
  periodStart,
  shiftDate,
} from '../utils/reportDateRange.js';
import {
  addMoney,
  averageMoney,
  multiplyQuantityByCost,
  subtractMoney,
} from '../utils/reportDecimal.js';
import {
  formatScaledDecimal,
  parseScaledDecimal,
  reconstructWeightedAverage,
} from '../utils/salesDecimal.js';

function safeCount(value) {
  const count = Number(value ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('Report count exceeds the safe integer range');
  }
  return count;
}

function addQuantity(...values) {
  return formatScaledDecimal(
    values.reduce(
      (total, value) => total + parseScaledDecimal(value ?? ZERO_QUANTITY, 3, { signed: true }),
      0n,
    ),
    3,
  );
}

const UNIT_QUANTITY_FIELDS = [
  'soldBaseQuantity',
  'returnedBaseQuantity',
  'restockableBaseQuantity',
  'nonRestockableBaseQuantity',
];

function compareUnitQuantities(left, right) {
  const codeOrder = left.unitCode.localeCompare(right.unitCode);
  if (codeOrder !== 0) return codeOrder;
  const leftId = BigInt(left.unitOfMeasureId);
  const rightId = BigInt(right.unitOfMeasureId);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function mergeQuantitiesByUnit(...collections) {
  const byUnit = new Map();
  for (const rows of collections) {
    for (const row of rows ?? []) {
      if (!byUnit.has(row.unitOfMeasureId)) {
        byUnit.set(row.unitOfMeasureId, {
          unitOfMeasureId: row.unitOfMeasureId,
          unitCode: row.unitCode,
          unitName: row.unitName,
          unitSymbol: row.unitSymbol,
          soldBaseQuantity: ZERO_QUANTITY,
          returnedBaseQuantity: ZERO_QUANTITY,
          restockableBaseQuantity: ZERO_QUANTITY,
          nonRestockableBaseQuantity: ZERO_QUANTITY,
        });
      }
      const unit = byUnit.get(row.unitOfMeasureId);
      for (const field of UNIT_QUANTITY_FIELDS) {
        if (row[field] !== undefined) unit[field] = addQuantity(unit[field], row[field]);
      }
    }
  }
  return [...byUnit.values()].sort(compareUnitQuantities);
}

function quantitiesByBranch(rows) {
  const byBranch = new Map();
  for (const row of rows) {
    const branchRows = byBranch.get(row.branchId) ?? [];
    const { branchId, ...quantity } = row;
    branchRows.push(quantity);
    byBranch.set(branchId, branchRows);
  }
  return byBranch;
}

function branchRange(branch, filters) {
  return buildBusinessRange(filters.from, filters.to, branch.timezone);
}

function reportContext(branch, filters) {
  return {
    branch: {
      branchId: branch.branchId,
      branchCode: branch.branchCode,
      branchName: branch.branchName,
      status: branch.status,
    },
    currencyCode: branch.currencyCode,
    timezone: branch.timezone,
    period: { from: filters.from, to: filters.to },
  };
}

async function organizationBranchesReport(filters) {
  const branches = await listOrganizationBranches(filters);
  const windows = branches.map((branch) => ({
    branchId: branch.branchId,
    ...buildBusinessRange(filters.from, filters.to, branch.timezone),
  }));
  const evidence = await getOrganizationReportEvidence(windows);
  const salesQuantities = quantitiesByBranch(evidence.sales.quantities);
  const returnQuantities = quantitiesByBranch(evidence.returns.quantities);
  const rows = branches.map((branch) => {
    const sales = evidence.sales.headers.get(branch.branchId) ?? {};
    const returns = evidence.returns.headers.get(branch.branchId) ?? {};
    const payments = evidence.payments.get(branch.branchId) ?? {};
    const grossSalesAmount = sales.grossSalesAmount ?? ZERO_MONEY;
    const completedRefundAmount = payments.completedRefundAmount ?? ZERO_MONEY;
    return {
      ...branch,
      completedSalesCount: safeCount(sales.completedSalesCount),
      grossSalesAmount,
      returnedMerchandiseAmount: returns.returnedMerchandiseAmount ?? ZERO_MONEY,
      completedRefundAmount,
      netSalesAmount: subtractMoney(grossSalesAmount, completedRefundAmount),
      completedPaymentAmount: payments.completedPaymentAmount ?? ZERO_MONEY,
      quantitiesByUnit: mergeQuantitiesByUnit(
        salesQuantities.get(branch.branchId),
        returnQuantities.get(branch.branchId),
      ),
      completedReturnCount: safeCount(returns.completedReturnCount),
    };
  });
  const byCurrency = new Map();
  for (const row of rows) {
    const current = byCurrency.get(row.currencyCode) ?? {
      currencyCode: row.currencyCode,
      branchCount: 0,
      completedSalesCount: 0,
      grossSalesAmount: ZERO_MONEY,
      returnedMerchandiseAmount: ZERO_MONEY,
      completedRefundAmount: ZERO_MONEY,
      netSalesAmount: ZERO_MONEY,
      completedPaymentAmount: ZERO_MONEY,
      quantitiesByUnit: [],
    };
    current.branchCount += 1;
    current.completedSalesCount += row.completedSalesCount;
    for (const field of [
      'grossSalesAmount', 'returnedMerchandiseAmount', 'completedRefundAmount',
      'netSalesAmount', 'completedPaymentAmount',
    ]) current[field] = addMoney(current[field], row[field]);
    current.quantitiesByUnit = mergeQuantitiesByUnit(
      current.quantitiesByUnit, row.quantitiesByUnit,
    );
    byCurrency.set(row.currencyCode, current);
  }
  const start = filters.offset;
  return {
    items: rows.slice(start, start + filters.limit),
    totalItems: rows.length,
    summary: {
      period: { from: filters.from, to: filters.to },
      totalsByCurrency: [...byCurrency.values()].sort((a, b) =>
        a.currencyCode.localeCompare(b.currencyCode)),
    },
  };
}

function normalizeSales(summary) {
  const completedSalesCount = safeCount(summary.completedSalesCount);
  return {
    completedSalesCount,
    grossSalesAmount: summary.grossSalesAmount,
    subtotalAmount: summary.subtotalAmount,
    discountAmount: summary.discountAmount,
    taxAmount: summary.taxAmount,
    quantitiesByUnit: mergeQuantitiesByUnit(summary.quantitiesByUnit),
    customerLinkedSalesCount: safeCount(summary.customerLinkedSalesCount),
    walkInSalesCount: safeCount(summary.walkInSalesCount),
    averageSaleValue: averageMoney(summary.grossSalesAmount, completedSalesCount),
  };
}

function normalizeReturns(summary) {
  return {
    ...summary,
    completedReturnCount: safeCount(summary.completedReturnCount),
  };
}

async function branchOverviewReport(branch, filters) {
  const range = branchRange(branch, filters);
  const [sales, returns, payments, current] = await Promise.all([
    fetchSalesSummary(branch.branchId, range),
    returnTotals(branch.branchId, range),
    paymentTotals(branch.branchId, range),
    overviewCurrentState(branch.branchId),
  ]);
  const normalizedSales = normalizeSales(sales);
  const normalizedReturns = normalizeReturns(returns);
  const {
    quantitiesByUnit: salesQuantities,
    ...salesMetrics
  } = normalizedSales;
  const {
    quantitiesByUnit: returnQuantities,
    ...returnMetrics
  } = normalizedReturns;
  return {
    ...reportContext(branch, filters),
    ...salesMetrics,
    ...returnMetrics,
    quantitiesByUnit: mergeQuantitiesByUnit(salesQuantities, returnQuantities),
    ...payments,
    netSalesAmount: subtractMoney(
      salesMetrics.grossSalesAmount,
      payments.completedRefundAmount,
    ),
    currentVariantCountWithStock: safeCount(current.currentVariantCountWithStock),
    lowStockVariantCount: safeCount(current.lowStockVariantCount),
    outOfStockVariantCount: safeCount(current.outOfStockVariantCount),
    openTillSessionCount: safeCount(current.openTillSessionCount),
    openPurchaseOrderCount: safeCount(current.openPurchaseOrderCount),
  };
}

async function salesSummaryReport(branch, filters) {
  const result = normalizeSales(
    await fetchSalesSummary(branch.branchId, branchRange(branch, filters), filters),
  );
  return { ...reportContext(branch, filters), ...result };
}

async function salesTrendReport(branch, filters) {
  const range = branchRange(branch, filters);
  const events = await trendEvents(branch.branchId, range);
  const buckets = new Map(enumeratePeriods(filters.from, filters.to, filters.groupBy).map(
    (start) => [start, {
      periodStart: start,
      completedSalesCount: 0,
      grossSalesAmount: ZERO_MONEY,
      discountAmount: ZERO_MONEY,
      taxAmount: ZERO_MONEY,
      completedRefundAmount: ZERO_MONEY,
      netSalesAmount: ZERO_MONEY,
    }],
  ));
  for (const sale of events.sales) {
    const start = periodStart(
      localBusinessDate(`${sale.occurredAt}`, branch.timezone), filters.groupBy,
    );
    const bucket = buckets.get(start);
    bucket.completedSalesCount += 1;
    bucket.grossSalesAmount = addMoney(bucket.grossSalesAmount, sale.grossSalesAmount);
    bucket.discountAmount = addMoney(bucket.discountAmount, sale.discountAmount);
    bucket.taxAmount = addMoney(bucket.taxAmount, sale.taxAmount);
  }
  for (const refund of events.refunds) {
    const start = periodStart(
      localBusinessDate(`${refund.occurredAt}`, branch.timezone), filters.groupBy,
    );
    const bucket = buckets.get(start);
    bucket.completedRefundAmount = addMoney(bucket.completedRefundAmount, refund.amount);
  }
  for (const bucket of buckets.values()) {
    bucket.netSalesAmount = subtractMoney(bucket.grossSalesAmount, bucket.completedRefundAmount);
  }
  return {
    ...reportContext(branch, filters),
    groupBy: filters.groupBy,
    items: [...buckets.values()],
  };
}

async function productPerformanceReport(branch, filters) {
  const result = await fetchProductPerformance(
    branch.branchId, branchRange(branch, filters), filters,
  );
  result.items = result.items.map((item) => ({
    ...item,
    completedSalesCount: safeCount(item.completedSalesCount),
    costedLineCount: safeCount(item.costedLineCount),
    uncostedLineCount: safeCount(item.uncostedLineCount),
  }));
  return { ...reportContext(branch, filters), groupBy: filters.groupBy, ...result };
}

async function returnsReport(branch, filters) {
  const result = await fetchReturnsReport(
    branch.branchId, branchRange(branch, filters), filters,
  );
  result.summary.completedReturnCount = safeCount(result.summary.completedReturnCount);
  return { ...reportContext(branch, filters), ...result };
}

async function paymentsReport(branch, filters) {
  const result = await fetchPaymentsReport(
    branch.branchId, branchRange(branch, filters), filters,
  );
  const methods = new Map();
  for (const row of [...result.financialRows, ...result.attemptRows]) {
    if (!methods.has(row.paymentMethodId)) {
      methods.set(row.paymentMethodId, {
        paymentMethodId: row.paymentMethodId,
        methodCode: row.methodCode,
        methodName: row.methodName,
        methodType: row.methodType,
        completedPaymentAmount: ZERO_MONEY,
        completedRefundAmount: ZERO_MONEY,
        netTenderAmount: ZERO_MONEY,
        completedPaymentCount: 0,
        completedRefundCount: 0,
        pendingCount: 0,
        failedCount: 0,
        cancelledCount: 0,
      });
    }
    const method = methods.get(row.paymentMethodId);
    for (const field of ['completedPaymentAmount', 'completedRefundAmount']) {
      if (row[field] !== undefined) method[field] = row[field];
    }
    for (const field of [
      'completedPaymentCount', 'completedRefundCount', 'pendingCount', 'failedCount', 'cancelledCount',
    ]) if (row[field] !== undefined) method[field] = safeCount(row[field]);
    method.netTenderAmount = subtractMoney(
      method.completedPaymentAmount, method.completedRefundAmount,
    );
  }
  const items = [...methods.values()].sort((a, b) => {
    const codeOrder = a.methodCode.localeCompare(b.methodCode);
    if (codeOrder !== 0) return codeOrder;
    const left = BigInt(a.paymentMethodId);
    const right = BigInt(b.paymentMethodId);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const summary = items.reduce((total, item) => ({
    completedPaymentAmount: addMoney(total.completedPaymentAmount, item.completedPaymentAmount),
    completedRefundAmount: addMoney(total.completedRefundAmount, item.completedRefundAmount),
    netTenderAmount: addMoney(total.netTenderAmount, item.netTenderAmount),
    completedPaymentCount: total.completedPaymentCount + item.completedPaymentCount,
    completedRefundCount: total.completedRefundCount + item.completedRefundCount,
    pendingCount: total.pendingCount + item.pendingCount,
    failedCount: total.failedCount + item.failedCount,
    cancelledCount: total.cancelledCount + item.cancelledCount,
  }), {
    completedPaymentAmount: ZERO_MONEY, completedRefundAmount: ZERO_MONEY,
    netTenderAmount: ZERO_MONEY, completedPaymentCount: 0, completedRefundCount: 0,
    pendingCount: 0, failedCount: 0, cancelledCount: 0,
  });
  return { ...reportContext(branch, filters), summary, items };
}

function stockState(quantity, reorderLevel) {
  const onHand = parseScaledDecimal(quantity, 3, { signed: true });
  if (onHand < 0n) return 'DATA_INCONSISTENT';
  if (onHand === 0n) return 'OUT_OF_STOCK';
  const reorder = parseScaledDecimal(reorderLevel, 3);
  return reorder > 0n && onHand <= reorder ? 'LOW_STOCK' : 'IN_STOCK';
}

async function inventoryReport(branch, filters) {
  const today = currentLocalDate(branch.timezone);
  const expiryEnd = filters.expiringWithinDays === null
    ? '1000-01-01' : shiftDate(today, filters.expiringWithinDays);
  const result = await fetchInventoryReport(
    branch.branchId, filters, today, expiryEnd,
  );
  const histories = new Map();
  for (const movement of result.histories) {
    const rows = histories.get(movement.productVariantId) ?? [];
    rows.push({ quantityChange: movement.quantityChange, unitCost: movement.unitCost });
    histories.set(movement.productVariantId, rows);
  }
  result.items = result.items.map((item) => {
    const quantity = parseScaledDecimal(item.quantityOnHand, 3, { signed: true });
    let valuationStatus;
    let currentValuationAmount = null;
    let currentWeightedAverageUnitCost = null;
    if (quantity < 0n) valuationStatus = 'INCONSISTENT_HISTORY';
    else if (quantity === 0n) {
      valuationStatus = 'NO_STOCK';
      currentValuationAmount = ZERO_MONEY;
    } else if (!histories.has(item.productVariantId)) valuationStatus = 'NO_COST_HISTORY';
    else {
      const valuation = reconstructWeightedAverage(
        histories.get(item.productVariantId), item.quantityOnHand,
      );
      if (valuation.outcome === 'calculated') {
        valuationStatus = 'AVAILABLE';
        currentWeightedAverageUnitCost = valuation.unitCost;
        currentValuationAmount = multiplyQuantityByCost(item.quantityOnHand, valuation.unitCost);
      } else if (valuation.outcome === 'valuation_unavailable') valuationStatus = 'NO_COST_HISTORY';
      else valuationStatus = 'INCONSISTENT_HISTORY';
    }
    return {
      ...item,
      lotCount: safeCount(item.lotCount),
      availableLotCount: safeCount(item.availableLotCount),
      expiringLotCount: safeCount(item.expiringLotCount),
      stockState: stockState(item.quantityOnHand, item.reorderLevel),
      currentWeightedAverageUnitCost,
      currentValuationAmount,
      valuationStatus,
    };
  });
  return {
    branch: reportContext(branch, { from: null, to: null }).branch,
    currencyCode: branch.currencyCode,
    timezone: branch.timezone,
    asOfBusinessDate: today,
    items: result.items,
    totalItems: result.totalItems,
  };
}

async function inventoryMovementReport(branch, filters) {
  const result = await fetchInventoryMovements(
    branch.branchId, branchRange(branch, filters), filters,
  );
  result.items = result.items.map((item) => ({
    ...item,
    extendedCostAmount: multiplyQuantityByCost(item.quantityChange, item.unitCost),
  }));
  return { ...reportContext(branch, filters), ...result };
}

async function purchasingReport(branch, filters) {
  const result = await fetchPurchasingReport(
    branch.branchId, branchRange(branch, filters), filters,
  );
  for (const section of [result.orderPeriod, result.receiptPeriod]) {
    for (const field of Object.keys(section)) {
      if (field.endsWith('Count')) section[field] = safeCount(section[field]);
    }
  }
  return { ...reportContext(branch, filters), ...result };
}

async function supplierReport(branch, filters) {
  const result = await fetchSupplierReport(
    branch.branchId, branchRange(branch, filters), filters,
  );
  result.items = result.items.map((item) => {
    const normalized = { ...item };
    for (const field of Object.keys(normalized)) {
      if (field.endsWith('Count')) normalized[field] = safeCount(normalized[field]);
    }
    return normalized;
  });
  return { ...reportContext(branch, filters), ...result };
}

async function tillReport(branch, filters) {
  const result = await fetchTillReport(branch.branchId, branchRange(branch, filters), filters);
  result.summary.sessionCount = safeCount(result.summary.sessionCount);
  result.summary.closedSessionCount = safeCount(result.summary.closedSessionCount);
  return { ...reportContext(branch, filters), ...result };
}

async function customerReport(branch, filters) {
  const result = await fetchCustomerReport(
    branch.branchId, branchRange(branch, filters), filters,
  );
  result.summary.customerCount = safeCount(result.summary.customerCount);
  result.items = result.items.map((item) => ({
    ...item,
    completedSalesCount: safeCount(item.completedSalesCount),
    completedReturnCount: safeCount(item.completedReturnCount),
  }));
  return { ...reportContext(branch, filters), ...result };
}

export {
  branchOverviewReport,
  customerReport,
  inventoryMovementReport,
  inventoryReport,
  organizationBranchesReport,
  paymentsReport,
  productPerformanceReport,
  purchasingReport,
  returnsReport,
  salesSummaryReport,
  salesTrendReport,
  supplierReport,
  tillReport,
};
