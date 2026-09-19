import HttpError from '../../utils/httpError.js';
import {
  assertAllowedKeys,
  assertPlainObject,
  parseEnum,
  parseId,
  parseListQuery,
  parseNullableText,
  parseRequiredArray,
  parseSignedQuantity,
  parseString,
  parseUnitCost,
} from './common.validator.js';

const ADJUSTMENT_TYPES = Object.freeze([
  'COUNT_CORRECTION', 'DAMAGE', 'EXPIRY', 'THEFT', 'SUPPLIER_RETURN', 'OTHER',
]);
const ADJUSTMENT_STATUSES = Object.freeze(['DRAFT', 'APPROVED', 'POSTED', 'CANCELLED']);

function validateAdjustmentList(query) {
  return parseListQuery(query, [
    'search', 'status', 'adjustmentType', 'createdByEmployeeId',
    'approvedByEmployeeId', 'from', 'to',
  ], { status: ADJUSTMENT_STATUSES, adjustmentType: ADJUSTMENT_TYPES });
}

function validateCreateAdjustment(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, ['adjustmentType', 'reason']);
  return {
    adjustmentType: parseEnum(body.adjustmentType, 'adjustmentType', ADJUSTMENT_TYPES),
    reason: parseString(body.reason, 'reason', 1000),
  };
}

function validatePatchAdjustment(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, ['adjustmentType', 'reason']);
  if (Object.keys(body).length === 0) throw new HttpError(400, 'At least one field must be supplied');
  return {
    ...(body.adjustmentType !== undefined && {
      adjustmentType: parseEnum(body.adjustmentType, 'adjustmentType', ADJUSTMENT_TYPES),
    }),
    ...(body.reason !== undefined && { reason: parseString(body.reason, 'reason', 1000) }),
  };
}

function parseLotAllocations(value, quantityChange) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new HttpError(400, 'lotAllocations must be an array');
  if (value.length > 100) throw new HttpError(400, 'lotAllocations must not exceed 100 entries');
  const seen = new Set();
  return value.map((entry, index) => {
    assertPlainObject(entry, `lotAllocations[${index}]`);
    assertAllowedKeys(entry, ['inventoryLotId', 'quantityChange', 'unitCost']);
    const inventoryLotId = parseId(entry.inventoryLotId, `lotAllocations[${index}].inventoryLotId`);
    if (seen.has(inventoryLotId)) throw new HttpError(400, 'lotAllocations must not contain duplicate lots');
    seen.add(inventoryLotId);
    const movement = parseSignedQuantity(entry.quantityChange, `lotAllocations[${index}].quantityChange`);
    if ((movement.startsWith('-')) !== (quantityChange.startsWith('-'))) {
      throw new HttpError(400, 'Lot allocation signs must match quantityChange');
    }
    return {
      inventoryLotId,
      quantityChange: movement,
      unitCost: parseUnitCost(entry.unitCost, `lotAllocations[${index}].unitCost`),
    };
  });
}

function validateCreateAdjustmentItem(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, [
    'productVariantId', 'quantityChange', 'unitCost', 'reason', 'lotAllocations',
  ]);
  const quantityChange = parseSignedQuantity(body.quantityChange, 'quantityChange');
  return {
    productVariantId: parseId(body.productVariantId, 'productVariantId'),
    quantityChange,
    unitCost: parseUnitCost(body.unitCost),
    reason: parseNullableText(body.reason, 'reason', 500) ?? null,
    lotAllocations: parseLotAllocations(body.lotAllocations, quantityChange) ?? [],
  };
}

function validatePatchAdjustmentItem(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, ['quantityChange', 'unitCost', 'reason', 'lotAllocations']);
  if (Object.keys(body).length === 0) throw new HttpError(400, 'At least one field must be supplied');
  if (body.lotAllocations !== undefined && body.quantityChange === undefined) {
    throw new HttpError(400, 'quantityChange is required when replacing lotAllocations');
  }
  const quantityChange = body.quantityChange === undefined
    ? undefined : parseSignedQuantity(body.quantityChange, 'quantityChange');
  return {
    ...(quantityChange !== undefined && { quantityChange }),
    ...(body.unitCost !== undefined && { unitCost: parseUnitCost(body.unitCost) }),
    ...(body.reason !== undefined && { reason: parseNullableText(body.reason, 'reason', 500) }),
    ...(body.lotAllocations !== undefined && {
      lotAllocations: parseLotAllocations(body.lotAllocations, quantityChange),
    }),
  };
}

export {
  ADJUSTMENT_STATUSES,
  ADJUSTMENT_TYPES,
  validateAdjustmentList,
  validateCreateAdjustment,
  validateCreateAdjustmentItem,
  validatePatchAdjustment,
  validatePatchAdjustmentItem,
};
