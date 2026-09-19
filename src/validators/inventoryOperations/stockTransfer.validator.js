import HttpError from '../../utils/httpError.js';
import {
  assertAllowedKeys,
  assertPlainObject,
  parseEnum,
  parseId,
  parseListQuery,
  parseNullableText,
  parseQuantity,
  parseRequiredArray,
} from './common.validator.js';

const TRANSFER_STATUSES = Object.freeze([
  'DRAFT', 'REQUESTED', 'APPROVED', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED',
]);
const TRANSFER_DIRECTIONS = Object.freeze(['OUTGOING', 'INCOMING']);

function validateTransferList(query) {
  return parseListQuery(query, [
    'search', 'status', 'direction', 'counterpartyBranchId',
    'requestedByEmployeeId', 'from', 'to',
  ], { status: TRANSFER_STATUSES, direction: TRANSFER_DIRECTIONS });
}

function validateCreateTransfer(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, ['destinationBranchId', 'notes']);
  return {
    destinationBranchId: parseId(body.destinationBranchId, 'destinationBranchId'),
    notes: parseNullableText(body.notes, 'notes', 1000) ?? null,
  };
}

function validatePatchTransfer(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, ['destinationBranchId', 'notes']);
  if (Object.keys(body).length === 0) throw new HttpError(400, 'At least one field must be supplied');
  return {
    ...(body.destinationBranchId !== undefined && {
      destinationBranchId: parseId(body.destinationBranchId, 'destinationBranchId'),
    }),
    ...(body.notes !== undefined && { notes: parseNullableText(body.notes, 'notes', 1000) }),
  };
}

function parseRequestedLots(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HttpError(400, 'lotAllocations must be an array');
  if (value.length > 100) throw new HttpError(400, 'lotAllocations must not exceed 100 entries');
  const seen = new Set();
  return value.map((entry, index) => {
    assertPlainObject(entry, `lotAllocations[${index}]`);
    assertAllowedKeys(entry, ['inventoryLotId', 'quantityRequested']);
    const inventoryLotId = parseId(entry.inventoryLotId, `lotAllocations[${index}].inventoryLotId`);
    if (seen.has(inventoryLotId)) throw new HttpError(400, 'lotAllocations must not contain duplicate lots');
    seen.add(inventoryLotId);
    return {
      inventoryLotId,
      quantityRequested: parseQuantity(
        entry.quantityRequested, `lotAllocations[${index}].quantityRequested`,
      ),
    };
  });
}

function validateCreateTransferItem(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, ['productVariantId', 'quantityRequested', 'notes', 'lotAllocations']);
  return {
    productVariantId: parseId(body.productVariantId, 'productVariantId'),
    quantityRequested: parseQuantity(body.quantityRequested, 'quantityRequested'),
    notes: parseNullableText(body.notes, 'notes', 500) ?? null,
    lotAllocations: parseRequestedLots(body.lotAllocations),
  };
}

function validatePatchTransferItem(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, ['quantityRequested', 'notes', 'lotAllocations']);
  if (Object.keys(body).length === 0) throw new HttpError(400, 'At least one field must be supplied');
  if (body.lotAllocations !== undefined && body.quantityRequested === undefined) {
    throw new HttpError(400, 'quantityRequested is required when replacing lotAllocations');
  }
  return {
    ...(body.quantityRequested !== undefined && {
      quantityRequested: parseQuantity(body.quantityRequested, 'quantityRequested'),
    }),
    ...(body.notes !== undefined && { notes: parseNullableText(body.notes, 'notes', 500) }),
    ...(body.lotAllocations !== undefined && {
      lotAllocations: parseRequestedLots(body.lotAllocations),
    }),
  };
}

function parseActionLots(value, quantityField, index) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HttpError(400, `items[${index}].lots must be an array`);
  const seen = new Set();
  return value.map((entry, lotIndex) => {
    assertPlainObject(entry, `items[${index}].lots[${lotIndex}]`);
    assertAllowedKeys(entry, ['inventoryLotId', quantityField]);
    const inventoryLotId = parseId(
      entry.inventoryLotId, `items[${index}].lots[${lotIndex}].inventoryLotId`,
    );
    if (seen.has(inventoryLotId)) throw new HttpError(400, 'An action item cannot repeat a lot');
    seen.add(inventoryLotId);
    return {
      inventoryLotId,
      [quantityField]: parseQuantity(
        entry[quantityField], `items[${index}].lots[${lotIndex}].${quantityField}`,
      ),
    };
  });
}

function validateTransferAction(body, quantityField) {
  assertPlainObject(body);
  assertAllowedKeys(body, ['items']);
  const items = parseRequiredArray(body.items, 'items');
  const seen = new Set();
  return {
    items: items.map((entry, index) => {
      assertPlainObject(entry, `items[${index}]`);
      assertAllowedKeys(entry, ['stockTransferItemId', quantityField, 'lots']);
      const stockTransferItemId = parseId(
        entry.stockTransferItemId, `items[${index}].stockTransferItemId`,
      );
      if (seen.has(stockTransferItemId)) throw new HttpError(400, 'items must not contain duplicates');
      seen.add(stockTransferItemId);
      return {
        stockTransferItemId,
        [quantityField]: parseQuantity(entry[quantityField], `items[${index}].${quantityField}`),
        lots: parseActionLots(entry.lots, quantityField, index),
      };
    }),
  };
}

const validateDispatchTransfer = (body) => validateTransferAction(body, 'quantityDispatched');
const validateReceiveTransfer = (body) => validateTransferAction(body, 'quantityReceived');

export {
  TRANSFER_DIRECTIONS,
  TRANSFER_STATUSES,
  validateCreateTransfer,
  validateCreateTransferItem,
  validateDispatchTransfer,
  validatePatchTransfer,
  validatePatchTransferItem,
  validateReceiveTransfer,
  validateTransferList,
};
