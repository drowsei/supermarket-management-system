import HttpError from '../../utils/httpError.js';
import { compareDecimals } from '../../utils/purchasingDecimal.js';
import { requireAtLeastOneKey } from '../admin/common.validator.js';
import {
  PURCHASE_ORDER_STATUSES,
  assertAllowedKeys,
  assertPlainObject,
  parseEnum,
  parseId,
  parseListDates,
  parseMoney,
  parseNullableString,
  parsePagination,
  parseQuantity,
  parseSearch,
  parseTaxRate,
  parseUnitCost,
  parseUtcDateTime,
  validateDocumentId,
} from './common.validator.js';

const CREATE_FIELDS = Object.freeze([
  'supplierId', 'expectedAt', 'supplierQuoteNumber', 'shippingAmount', 'notes',
]);
const PATCH_FIELDS = Object.freeze([
  'expectedAt', 'supplierQuoteNumber', 'shippingAmount', 'notes',
]);
const ITEM_CREATE_FIELDS = Object.freeze([
  'productVariantId', 'productPackageId', 'orderedPackageQuantity',
  'unitCost', 'discountAmount', 'taxRatePercent',
]);
const ITEM_PATCH_FIELDS = Object.freeze([
  'orderedPackageQuantity', 'unitCost', 'discountAmount', 'taxRatePercent',
]);

function optionalNullableString(body, field, maximumLength, defaultValue) {
  return body[field] === undefined
    ? defaultValue
    : parseNullableString(body[field], field, maximumLength);
}

function validatePurchaseOrderId(value) {
  return validateDocumentId(value, 'purchaseOrderId');
}

function validatePurchaseOrderItemId(value) {
  return validateDocumentId(value, 'purchaseOrderItemId');
}

function validatePurchaseOrderListQuery(query) {
  assertAllowedKeys(query, [
    'search', 'status', 'supplierId', 'createdByEmployeeId', 'from', 'to',
    'page', 'limit',
  ]);
  return {
    ...parsePagination(query),
    ...parseListDates(query),
    search: parseSearch(query.search, 180),
    status:
      query.status === undefined
        ? null
        : parseEnum(query.status, 'status', PURCHASE_ORDER_STATUSES),
    supplierId:
      query.supplierId === undefined
        ? null
        : parseId(query.supplierId, 'supplierId'),
    createdByEmployeeId:
      query.createdByEmployeeId === undefined
        ? null
        : parseId(query.createdByEmployeeId, 'createdByEmployeeId'),
  };
}

function validateCreatePurchaseOrder(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, CREATE_FIELDS);
  if (!Object.hasOwn(body, 'supplierId')) {
    throw new HttpError(400, 'supplierId is required');
  }
  return {
    supplierId: parseId(body.supplierId, 'supplierId'),
    expectedAt:
      body.expectedAt === undefined
        ? null
        : parseUtcDateTime(body.expectedAt, 'expectedAt', { nullable: true }),
    supplierQuoteNumber: optionalNullableString(
      body, 'supplierQuoteNumber', 100, null,
    ),
    shippingAmount:
      body.shippingAmount === undefined
        ? '0.00'
        : parseMoney(body.shippingAmount, 'shippingAmount'),
    notes: optionalNullableString(body, 'notes', 1000, null),
  };
}

function validatePatchPurchaseOrder(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, PATCH_FIELDS);
  requireAtLeastOneKey(body);
  const changes = {};
  if (Object.hasOwn(body, 'expectedAt')) {
    changes.expectedAt = parseUtcDateTime(body.expectedAt, 'expectedAt', {
      nullable: true,
    });
  }
  if (Object.hasOwn(body, 'supplierQuoteNumber')) {
    changes.supplierQuoteNumber = parseNullableString(
      body.supplierQuoteNumber, 'supplierQuoteNumber', 100,
    );
  }
  if (Object.hasOwn(body, 'shippingAmount')) {
    changes.shippingAmount = parseMoney(body.shippingAmount, 'shippingAmount');
  }
  if (Object.hasOwn(body, 'notes')) {
    changes.notes = parseNullableString(body.notes, 'notes', 1000);
  }
  return changes;
}

function parsePurchaseItemValues(body, fields) {
  const values = {};
  if (fields.includes('productVariantId')) {
    if (!Object.hasOwn(body, 'productVariantId')) {
      throw new HttpError(400, 'productVariantId is required');
    }
    values.productVariantId = parseId(body.productVariantId, 'productVariantId');
    values.productPackageId =
      body.productPackageId === undefined || body.productPackageId === null
        ? null
        : parseId(body.productPackageId, 'productPackageId');
  }
  for (const required of ['orderedPackageQuantity', 'unitCost']) {
    if (fields.includes(required) && !Object.hasOwn(body, required)) {
      throw new HttpError(400, `${required} is required`);
    }
  }
  if (Object.hasOwn(body, 'orderedPackageQuantity')) {
    values.orderedPackageQuantity = parseQuantity(
      body.orderedPackageQuantity, 'orderedPackageQuantity', { positive: true },
    );
  }
  if (Object.hasOwn(body, 'unitCost')) {
    values.unitCost = parseUnitCost(body.unitCost, 'unitCost');
  }
  if (Object.hasOwn(body, 'discountAmount') || fields.includes('productVariantId')) {
    values.discountAmount =
      body.discountAmount === undefined
        ? '0.00'
        : parseMoney(body.discountAmount, 'discountAmount');
  }
  if (Object.hasOwn(body, 'taxRatePercent') || fields.includes('productVariantId')) {
    values.taxRatePercent =
      body.taxRatePercent === undefined
        ? '0.0000'
        : parseTaxRate(body.taxRatePercent);
  }
  return values;
}

function validateCreatePurchaseOrderItem(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, ITEM_CREATE_FIELDS);
  return parsePurchaseItemValues(body, ITEM_CREATE_FIELDS);
}

function validatePatchPurchaseOrderItem(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, ITEM_PATCH_FIELDS);
  requireAtLeastOneKey(body);
  return parsePurchaseItemValues(body, Object.keys(body));
}

function validateCancelPurchaseOrder(body) {
  if (body === undefined) return { reason: null };
  assertPlainObject(body);
  assertAllowedKeys(body, ['reason']);
  return {
    reason:
      body.reason === undefined
        ? null
        : parseNullableString(body.reason, 'reason', 1000),
  };
}

export {
  validateCancelPurchaseOrder,
  validateCreatePurchaseOrder,
  validateCreatePurchaseOrderItem,
  validatePatchPurchaseOrder,
  validatePatchPurchaseOrderItem,
  validatePurchaseOrderId,
  validatePurchaseOrderItemId,
  validatePurchaseOrderListQuery,
};
