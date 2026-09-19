import HttpError from '../../utils/httpError.js';
import {
  assertAllowedKeys,
  assertPlainObject,
  parseEnum,
  parseId,
  parseListQuery,
  parseNullableText,
  parseQuantity,
} from './common.validator.js';

const COUNT_TYPES = Object.freeze(['FULL', 'CYCLE', 'SPOT']);
const COUNT_STATUSES = Object.freeze([
  'DRAFT', 'IN_PROGRESS', 'COUNTED', 'APPROVED', 'POSTED', 'CANCELLED',
]);
const PARTICIPANT_ROLES = Object.freeze(['COUNTER', 'SUPERVISOR', 'OBSERVER']);

function validateCountList(query) {
  return parseListQuery(query, [
    'search', 'status', 'countType', 'createdByEmployeeId',
    'approvedByEmployeeId', 'from', 'to',
  ], { status: COUNT_STATUSES, countType: COUNT_TYPES });
}

function validateCreateCount(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, ['countType', 'notes']);
  return {
    countType: body.countType === undefined
      ? 'FULL' : parseEnum(body.countType, 'countType', COUNT_TYPES),
    notes: parseNullableText(body.notes, 'notes', 1000) ?? null,
  };
}

function validatePatchCount(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, ['countType', 'notes']);
  if (Object.keys(body).length === 0) throw new HttpError(400, 'At least one field must be supplied');
  return {
    ...(body.countType !== undefined && {
      countType: parseEnum(body.countType, 'countType', COUNT_TYPES),
    }),
    ...(body.notes !== undefined && { notes: parseNullableText(body.notes, 'notes', 1000) }),
  };
}

function validateParticipant(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, ['employeeId', 'participantRole']);
  return {
    employeeId: parseId(body.employeeId, 'employeeId'),
    participantRole: body.participantRole === undefined
      ? 'COUNTER' : parseEnum(body.participantRole, 'participantRole', PARTICIPANT_ROLES),
  };
}

function validateCreateCountItem(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, ['productVariantId', 'inventoryLotId', 'notes']);
  return {
    productVariantId: parseId(body.productVariantId, 'productVariantId'),
    inventoryLotId: body.inventoryLotId === undefined || body.inventoryLotId === null
      ? null : parseId(body.inventoryLotId, 'inventoryLotId'),
    notes: parseNullableText(body.notes, 'notes', 500) ?? null,
  };
}

function validatePatchCountItem(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, ['countedQuantity', 'varianceReason', 'notes']);
  if (Object.keys(body).length === 0) throw new HttpError(400, 'At least one field must be supplied');
  return {
    ...(body.countedQuantity !== undefined && {
      countedQuantity: parseQuantity(body.countedQuantity, 'countedQuantity', { allowZero: true }),
    }),
    ...(body.varianceReason !== undefined && {
      varianceReason: parseNullableText(body.varianceReason, 'varianceReason', 500),
    }),
    ...(body.notes !== undefined && { notes: parseNullableText(body.notes, 'notes', 500) }),
  };
}

export {
  COUNT_STATUSES,
  COUNT_TYPES,
  PARTICIPANT_ROLES,
  validateCountList,
  validateCreateCount,
  validateCreateCountItem,
  validateParticipant,
  validatePatchCount,
  validatePatchCountItem,
};
