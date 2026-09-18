import HttpError from '../../utils/httpError.js';
import {
  assertAllowedKeys,
  assertPlainObject,
  parseDate,
  parseEnum,
  parseId,
  parsePagination,
  parseSearch,
} from '../admin/common.validator.js';
import { parseExactDecimal } from '../products/common.validator.js';

const STOCK_STATUSES = Object.freeze(['IN_STOCK', 'OUT_OF_STOCK', 'LOW_STOCK']);
const LOT_TRACKING_MODES = Object.freeze(['NONE', 'OPTIONAL', 'REQUIRED']);
const BRANCH_LOT_STATUSES = Object.freeze([
  'AVAILABLE', 'QUARANTINED', 'BLOCKED', 'DEPLETED',
]);
const GLOBAL_LOT_STATUSES = Object.freeze([
  'ACTIVE', 'QUARANTINED', 'RECALLED', 'CLOSED',
]);
const TRANSACTION_TYPES = Object.freeze([
  'OPENING_BALANCE', 'PURCHASE_RECEIPT', 'SALE', 'SALE_VOID',
  'TRANSFER_OUT', 'TRANSFER_IN', 'ADJUSTMENT',
  'CUSTOMER_RETURN', 'SUPPLIER_RETURN',
]);

function optionalId(value, name) {
  return value === undefined ? null : parseId(value, name);
}

function optionalEnum(value, name, values) {
  return value === undefined ? null : parseEnum(value, name, values);
}

function validateInventoryListQuery(query) {
  assertAllowedKeys(query, [
    'search', 'productVariantId', 'categoryId', 'brandId',
    'stockStatus', 'lotTrackingMode', 'page', 'limit',
  ]);
  return {
    ...parsePagination(query),
    search: parseSearch(query.search, 180),
    productVariantId: optionalId(query.productVariantId, 'productVariantId'),
    categoryId: optionalId(query.categoryId, 'categoryId'),
    brandId: optionalId(query.brandId, 'brandId'),
    stockStatus: optionalEnum(query.stockStatus, 'stockStatus', STOCK_STATUSES),
    lotTrackingMode: optionalEnum(query.lotTrackingMode, 'lotTrackingMode', LOT_TRACKING_MODES),
  };
}

function validateInventorySettings(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, ['reorderLevel', 'reorderQuantity']);
  for (const field of ['reorderLevel', 'reorderQuantity']) {
    if (!Object.hasOwn(body, field)) {
      throw new HttpError(400, `${field} is required`);
    }
  }
  return {
    reorderLevel: parseExactDecimal(body.reorderLevel, 'reorderLevel', {
      precision: 15, scale: 3,
    }),
    reorderQuantity: parseExactDecimal(body.reorderQuantity, 'reorderQuantity', {
      precision: 15, scale: 3,
    }),
  };
}

function validateLotListQuery(query) {
  assertAllowedKeys(query, [
    'search', 'productVariantId', 'branchLotStatus', 'lotStatus',
    'expiresBefore', 'expiresAfter', 'page', 'limit',
  ]);
  const expiresBefore = query.expiresBefore === undefined
    ? null : parseDate(query.expiresBefore, 'expiresBefore');
  const expiresAfter = query.expiresAfter === undefined
    ? null : parseDate(query.expiresAfter, 'expiresAfter');
  if (expiresBefore && expiresAfter && expiresAfter > expiresBefore) {
    throw new HttpError(400, 'expiresAfter must not be later than expiresBefore');
  }
  return {
    ...parsePagination(query),
    search: parseSearch(query.search, 180),
    productVariantId: optionalId(query.productVariantId, 'productVariantId'),
    branchLotStatus: optionalEnum(
      query.branchLotStatus, 'branchLotStatus', BRANCH_LOT_STATUSES,
    ),
    lotStatus: optionalEnum(query.lotStatus, 'lotStatus', GLOBAL_LOT_STATUSES),
    expiresBefore,
    expiresAfter,
  };
}

function validateLotStatus(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, ['status']);
  if (!Object.hasOwn(body, 'status')) {
    throw new HttpError(400, 'status is required');
  }
  const status = parseEnum(body.status, 'status', BRANCH_LOT_STATUSES);
  if (status === 'DEPLETED') {
    throw new HttpError(409, 'DEPLETED is system-owned and cannot be selected');
  }
  return { status };
}

function validateTransactionListQuery(query) {
  assertAllowedKeys(query, [
    'search', 'transactionType', 'productVariantId', 'inventoryLotId',
    'createdByEmployeeId', 'from', 'to', 'page', 'limit',
  ]);
  const from = query.from === undefined ? null : parseDate(query.from, 'from');
  const to = query.to === undefined ? null : parseDate(query.to, 'to');
  if (from && to && from > to) {
    throw new HttpError(400, 'from must not be later than to');
  }
  return {
    ...parsePagination(query),
    search: parseSearch(query.search, 180),
    transactionType: optionalEnum(query.transactionType, 'transactionType', TRANSACTION_TYPES),
    productVariantId: optionalId(query.productVariantId, 'productVariantId'),
    inventoryLotId: optionalId(query.inventoryLotId, 'inventoryLotId'),
    createdByEmployeeId: optionalId(query.createdByEmployeeId, 'createdByEmployeeId'),
    from,
    to,
  };
}

export {
  BRANCH_LOT_STATUSES,
  GLOBAL_LOT_STATUSES,
  TRANSACTION_TYPES,
  validateInventoryListQuery,
  validateInventorySettings,
  validateLotListQuery,
  validateLotStatus,
  validateTransactionListQuery,
};
