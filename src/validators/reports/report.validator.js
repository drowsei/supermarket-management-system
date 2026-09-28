import HttpError from '../../utils/httpError.js';
import {
  assertAllowedKeys,
  optionalEnum,
  optionalId,
  parseBoundedInteger,
  parsePagination,
  parseQueryBoolean,
  parseSearch,
  requiredDateRange,
} from './common.validator.js';

const BRANCH_STATUSES = ['ACTIVE', 'INACTIVE', 'CLOSED'];
const ITEM_CONDITIONS = ['UNOPENED', 'OPENED', 'DAMAGED', 'EXPIRED', 'DEFECTIVE', 'OTHER'];
const PAYMENT_TYPES = ['PAYMENT', 'REFUND'];
const PAYMENT_STATUSES = ['PENDING', 'COMPLETED', 'FAILED', 'CANCELLED'];
const METHOD_TYPES = ['CASH', 'CARD', 'BANK_TRANSFER', 'MOBILE_MONEY', 'VOUCHER', 'OTHER'];
const LOT_TRACKING_MODES = ['NONE', 'OPTIONAL', 'REQUIRED'];
const STOCK_STATES = ['IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK'];
const TRANSACTION_TYPES = [
  'OPENING_BALANCE', 'PURCHASE_RECEIPT', 'SALE', 'SALE_VOID', 'TRANSFER_OUT',
  'TRANSFER_IN', 'ADJUSTMENT', 'CUSTOMER_RETURN', 'SUPPLIER_RETURN',
];
const PURCHASE_STATUSES = [
  'DRAFT', 'SUBMITTED', 'APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED',
];
const TILL_STATUSES = ['OPEN', 'SUSPENDED', 'CLOSED', 'CANCELLED'];

function baseRange(query, allowed) {
  assertAllowedKeys(query, allowed);
  return requiredDateRange(query);
}

function validateBranchComparisonQuery(query) {
  return {
    ...baseRange(query, ['from', 'to', 'status', 'search', 'page', 'limit']),
    status: optionalEnum(query.status, 'status', BRANCH_STATUSES),
    search: parseSearch(query.search, 150),
    ...parsePagination(query),
  };
}

function validateOverviewQuery(query) {
  return baseRange(query, ['from', 'to']);
}

function validateSalesSummaryQuery(query) {
  return {
    ...baseRange(query, [
      'from', 'to', 'cashierEmployeeId', 'customerId', 'posRegisterId', 'tillSessionId',
    ]),
    cashierEmployeeId: optionalId(query.cashierEmployeeId, 'cashierEmployeeId'),
    customerId: optionalId(query.customerId, 'customerId'),
    posRegisterId: optionalId(query.posRegisterId, 'posRegisterId'),
    tillSessionId: optionalId(query.tillSessionId, 'tillSessionId'),
  };
}

function validateSalesTrendQuery(query) {
  return {
    ...baseRange(query, ['from', 'to', 'groupBy']),
    groupBy: optionalEnum(query.groupBy, 'groupBy', ['day', 'week', 'month'], 'day'),
  };
}

function validateProductReportQuery(query) {
  const range = baseRange(query, [
    'from', 'to', 'groupBy', 'categoryId', 'productId', 'productVariantId',
    'search', 'page', 'limit', 'sort', 'sortDirection',
  ]);
  const groupBy = optionalEnum(
    query.groupBy, 'groupBy', ['variant', 'product', 'category'], 'variant',
  );
  const sort = optionalEnum(query.sort, 'sort', [
    'grossSalesAmount', 'soldBaseQuantity', 'completedSalesCount',
    'returnedBaseQuantity', 'returnedMerchandiseAmount', 'grossProfitBeforeReturns',
  ], 'grossSalesAmount');
  if (groupBy !== 'variant' && ['soldBaseQuantity', 'returnedBaseQuantity'].includes(sort)) {
    throw new HttpError(
      400,
      'Base quantity sorting is available only when groupBy is variant',
    );
  }
  return {
    ...range,
    groupBy,
    categoryId: optionalId(query.categoryId, 'categoryId'),
    productId: optionalId(query.productId, 'productId'),
    productVariantId: optionalId(query.productVariantId, 'productVariantId'),
    search: parseSearch(query.search, 180),
    sort,
    sortDirection: optionalEnum(query.sortDirection, 'sortDirection', ['asc', 'desc'], 'desc'),
    ...parsePagination(query),
  };
}

function validateReturnsReportQuery(query) {
  return {
    ...baseRange(query, [
      'from', 'to', 'returnReasonId', 'itemCondition', 'isRestockable',
      'productVariantId', 'customerId', 'page', 'limit',
    ]),
    returnReasonId: optionalId(query.returnReasonId, 'returnReasonId'),
    itemCondition: optionalEnum(query.itemCondition, 'itemCondition', ITEM_CONDITIONS),
    isRestockable: parseQueryBoolean(query.isRestockable, 'isRestockable'),
    productVariantId: optionalId(query.productVariantId, 'productVariantId'),
    customerId: optionalId(query.customerId, 'customerId'),
    ...parsePagination(query),
  };
}

function validatePaymentsReportQuery(query) {
  return {
    ...baseRange(query, [
      'from', 'to', 'paymentMethodId', 'paymentType', 'methodType', 'status',
    ]),
    paymentMethodId: optionalId(query.paymentMethodId, 'paymentMethodId'),
    paymentType: optionalEnum(query.paymentType, 'paymentType', PAYMENT_TYPES),
    methodType: optionalEnum(query.methodType, 'methodType', METHOD_TYPES),
    status: optionalEnum(query.status, 'status', PAYMENT_STATUSES),
  };
}

function validateInventoryReportQuery(query) {
  assertAllowedKeys(query, [
    'categoryId', 'productId', 'productVariantId', 'stockState',
    'lotTrackingMode', 'search', 'expiringWithinDays', 'page', 'limit',
  ]);
  return {
    categoryId: optionalId(query.categoryId, 'categoryId'),
    productId: optionalId(query.productId, 'productId'),
    productVariantId: optionalId(query.productVariantId, 'productVariantId'),
    stockState: optionalEnum(query.stockState, 'stockState', STOCK_STATES),
    lotTrackingMode: optionalEnum(query.lotTrackingMode, 'lotTrackingMode', LOT_TRACKING_MODES),
    search: parseSearch(query.search, 180),
    expiringWithinDays: parseBoundedInteger(
      query.expiringWithinDays,
      'expiringWithinDays',
      { minimum: 0, maximum: 3650 },
    ),
    ...parsePagination(query),
  };
}

function validateMovementReportQuery(query) {
  return {
    ...baseRange(query, [
      'from', 'to', 'productVariantId', 'transactionType',
      'createdByEmployeeId', 'page', 'limit',
    ]),
    productVariantId: optionalId(query.productVariantId, 'productVariantId'),
    transactionType: optionalEnum(query.transactionType, 'transactionType', TRANSACTION_TYPES),
    createdByEmployeeId: optionalId(query.createdByEmployeeId, 'createdByEmployeeId'),
    ...parsePagination(query),
  };
}

function validatePurchasingReportQuery(query) {
  return {
    ...baseRange(query, ['from', 'to', 'supplierId', 'status']),
    supplierId: optionalId(query.supplierId, 'supplierId'),
    status: optionalEnum(query.status, 'status', PURCHASE_STATUSES),
  };
}

function validateSupplierReportQuery(query) {
  return {
    ...baseRange(query, ['from', 'to', 'supplierId', 'search', 'page', 'limit']),
    supplierId: optionalId(query.supplierId, 'supplierId'),
    search: parseSearch(query.search, 180),
    ...parsePagination(query),
  };
}

function validateTillReportQuery(query) {
  return {
    ...baseRange(query, [
      'from', 'to', 'cashierEmployeeId', 'posRegisterId', 'status', 'page', 'limit',
    ]),
    cashierEmployeeId: optionalId(query.cashierEmployeeId, 'cashierEmployeeId'),
    posRegisterId: optionalId(query.posRegisterId, 'posRegisterId'),
    status: optionalEnum(query.status, 'status', TILL_STATUSES),
    ...parsePagination(query),
  };
}

function validateCustomerReportQuery(query) {
  return {
    ...baseRange(query, ['from', 'to', 'customerId', 'search', 'page', 'limit']),
    customerId: optionalId(query.customerId, 'customerId'),
    search: parseSearch(query.search, 180),
    ...parsePagination(query),
  };
}

export {
  validateBranchComparisonQuery,
  validateCustomerReportQuery,
  validateInventoryReportQuery,
  validateMovementReportQuery,
  validateOverviewQuery,
  validatePaymentsReportQuery,
  validateProductReportQuery,
  validatePurchasingReportQuery,
  validateReturnsReportQuery,
  validateSalesSummaryQuery,
  validateSalesTrendQuery,
  validateSupplierReportQuery,
  validateTillReportQuery,
};
