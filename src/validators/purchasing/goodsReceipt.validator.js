import HttpError from '../../utils/httpError.js';
import { compareDecimals } from '../../utils/purchasingDecimal.js';
import { parseDate, requireAtLeastOneKey } from '../admin/common.validator.js';
import {
  GOODS_RECEIPT_STATUSES,
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
  parseUnitCost,
  validateDocumentId,
} from './common.validator.js';

const RECEIPT_FIELDS = Object.freeze([
  'purchaseOrderId', 'supplierDeliveryNote', 'supplierInvoiceNumber', 'notes',
]);
const RECEIPT_PATCH_FIELDS = Object.freeze([
  'supplierDeliveryNote', 'supplierInvoiceNumber', 'notes',
]);
const ITEM_CREATE_FIELDS = Object.freeze([
  'purchaseOrderItemId', 'packageQuantityAccepted', 'packageQuantityRejected',
  'actualUnitCost', 'discountAmount', 'taxAmount',
]);
const ITEM_PATCH_FIELDS = Object.freeze([
  'packageQuantityAccepted', 'packageQuantityRejected', 'actualUnitCost',
  'discountAmount', 'taxAmount',
]);

function nullable(body, field, maximumLength, fallback) {
  return body[field] === undefined
    ? fallback
    : parseNullableString(body[field], field, maximumLength);
}

function validateGoodsReceiptId(value) {
  return validateDocumentId(value, 'goodsReceiptId');
}

function validateGoodsReceiptItemId(value) {
  return validateDocumentId(value, 'goodsReceiptItemId');
}

function validateGoodsReceiptListQuery(query) {
  assertAllowedKeys(query, [
    'search', 'status', 'purchaseOrderId', 'supplierId',
    'receivedByEmployeeId', 'from', 'to', 'page', 'limit',
  ]);
  return {
    ...parsePagination(query),
    ...parseListDates(query),
    search: parseSearch(query.search, 180),
    status:
      query.status === undefined
        ? null
        : parseEnum(query.status, 'status', GOODS_RECEIPT_STATUSES),
    purchaseOrderId:
      query.purchaseOrderId === undefined
        ? null
        : parseId(query.purchaseOrderId, 'purchaseOrderId'),
    supplierId:
      query.supplierId === undefined
        ? null
        : parseId(query.supplierId, 'supplierId'),
    receivedByEmployeeId:
      query.receivedByEmployeeId === undefined
        ? null
        : parseId(query.receivedByEmployeeId, 'receivedByEmployeeId'),
  };
}

function validateCreateGoodsReceipt(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, RECEIPT_FIELDS);
  if (!Object.hasOwn(body, 'purchaseOrderId')) {
    throw new HttpError(400, 'purchaseOrderId is required');
  }
  return {
    purchaseOrderId: parseId(body.purchaseOrderId, 'purchaseOrderId'),
    supplierDeliveryNote: nullable(body, 'supplierDeliveryNote', 100, null),
    supplierInvoiceNumber: nullable(body, 'supplierInvoiceNumber', 100, null),
    notes: nullable(body, 'notes', 1000, null),
  };
}

function validatePatchGoodsReceipt(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, RECEIPT_PATCH_FIELDS);
  requireAtLeastOneKey(body);
  return Object.fromEntries(
    Object.keys(body).map((field) => [
      field,
      parseNullableString(
        body[field],
        field,
        field === 'notes' ? 1000 : 100,
      ),
    ]),
  );
}

function parseReceiptItemValues(body, create) {
  const values = {};
  if (create) {
    if (!Object.hasOwn(body, 'purchaseOrderItemId')) {
      throw new HttpError(400, 'purchaseOrderItemId is required');
    }
    values.purchaseOrderItemId = parseId(
      body.purchaseOrderItemId,
      'purchaseOrderItemId',
    );
  }
  for (const required of [
    'packageQuantityAccepted', 'packageQuantityRejected', 'actualUnitCost',
  ]) {
    if (create && !Object.hasOwn(body, required)) {
      throw new HttpError(400, `${required} is required`);
    }
  }
  if (Object.hasOwn(body, 'packageQuantityAccepted')) {
    values.packageQuantityAccepted = parseQuantity(
      body.packageQuantityAccepted,
      'packageQuantityAccepted',
    );
  }
  if (Object.hasOwn(body, 'packageQuantityRejected')) {
    values.packageQuantityRejected = parseQuantity(
      body.packageQuantityRejected,
      'packageQuantityRejected',
    );
  }
  if (Object.hasOwn(body, 'actualUnitCost')) {
    values.actualUnitCost = parseUnitCost(body.actualUnitCost, 'actualUnitCost');
  }
  if (create || Object.hasOwn(body, 'discountAmount')) {
    values.discountAmount =
      body.discountAmount === undefined
        ? '0.00'
        : parseMoney(body.discountAmount, 'discountAmount');
  }
  if (create || Object.hasOwn(body, 'taxAmount')) {
    values.taxAmount =
      body.taxAmount === undefined ? '0.00' : parseMoney(body.taxAmount, 'taxAmount');
  }
  return values;
}

function validateCreateGoodsReceiptItem(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, ITEM_CREATE_FIELDS);
  const values = parseReceiptItemValues(body, true);
  if (
    compareDecimals(values.packageQuantityAccepted, '0.000', 3) === 0 &&
    compareDecimals(values.packageQuantityRejected, '0.000', 3) === 0
  ) {
    throw new HttpError(400, 'At least one accepted or rejected quantity is required');
  }
  return values;
}

function validatePatchGoodsReceiptItem(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, ITEM_PATCH_FIELDS);
  requireAtLeastOneKey(body);
  return parseReceiptItemValues(body, false);
}

function parseLot(lot, itemIndex, lotIndex) {
  assertPlainObject(lot, `lotAllocations[${itemIndex}].lots[${lotIndex}]`);
  assertAllowedKeys(lot, [
    'inventoryLotId', 'lotNumber', 'manufacturedOn', 'expiresOn', 'quantityReceived',
  ]);
  const hasId = Object.hasOwn(lot, 'inventoryLotId');
  const hasNumber = Object.hasOwn(lot, 'lotNumber');
  if (hasId === hasNumber) {
    throw new HttpError(400, 'Each lot must provide exactly one lot identity mode');
  }
  if (!Object.hasOwn(lot, 'quantityReceived')) {
    throw new HttpError(400, 'quantityReceived is required for every lot');
  }
  if (hasId && (Object.hasOwn(lot, 'manufacturedOn') || Object.hasOwn(lot, 'expiresOn'))) {
    throw new HttpError(400, 'Existing inventoryLotId allocations cannot provide lot dates');
  }
  const manufacturedOn =
    hasNumber && Object.hasOwn(lot, 'manufacturedOn')
      ? parseDate(lot.manufacturedOn, 'manufacturedOn', { nullable: true })
      : null;
  const expiresOn =
    hasNumber && Object.hasOwn(lot, 'expiresOn')
      ? parseDate(lot.expiresOn, 'expiresOn', { nullable: true })
      : null;
  if (manufacturedOn && expiresOn && expiresOn < manufacturedOn) {
    throw new HttpError(400, 'expiresOn must not precede manufacturedOn');
  }
  const lotNumber = hasNumber
    ? parseNullableString(lot.lotNumber, 'lotNumber', 100)
    : null;
  if (hasNumber && lotNumber === null) {
    throw new HttpError(400, 'lotNumber must not be null');
  }
  return {
    inventoryLotId: hasId ? parseId(lot.inventoryLotId, 'inventoryLotId') : null,
    lotNumber,
    manufacturedOn,
    expiresOn,
    quantityReceived: parseQuantity(
      lot.quantityReceived,
      'quantityReceived',
      { positive: true },
    ),
  };
}

function validateReceiptPosting(body) {
  if (body === undefined) return { lotAllocations: [] };
  assertPlainObject(body);
  assertAllowedKeys(body, ['lotAllocations']);
  const allocations = body.lotAllocations ?? [];
  if (!Array.isArray(allocations)) {
    throw new HttpError(400, 'lotAllocations must be an array');
  }
  const seenItems = new Set();
  return {
    lotAllocations: allocations.map((allocation, itemIndex) => {
      assertPlainObject(allocation, `lotAllocations[${itemIndex}]`);
      assertAllowedKeys(allocation, ['goodsReceiptItemId', 'lots']);
      if (!Object.hasOwn(allocation, 'goodsReceiptItemId')) {
        throw new HttpError(400, 'goodsReceiptItemId is required');
      }
      const goodsReceiptItemId = parseId(
        allocation.goodsReceiptItemId,
        'goodsReceiptItemId',
      );
      if (seenItems.has(goodsReceiptItemId)) {
        throw new HttpError(400, 'lotAllocations contains a duplicate receipt item');
      }
      seenItems.add(goodsReceiptItemId);
      if (!Array.isArray(allocation.lots) || allocation.lots.length === 0) {
        throw new HttpError(400, 'lots must be a non-empty array');
      }
      return {
        goodsReceiptItemId,
        lots: allocation.lots.map((lot, lotIndex) =>
          parseLot(lot, itemIndex, lotIndex),
        ),
      };
    }),
  };
}

export {
  validateCreateGoodsReceipt,
  validateCreateGoodsReceiptItem,
  validateGoodsReceiptId,
  validateGoodsReceiptItemId,
  validateGoodsReceiptListQuery,
  validatePatchGoodsReceipt,
  validatePatchGoodsReceiptItem,
  validateReceiptPosting,
};
