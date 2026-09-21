import HttpError from '../../utils/httpError.js';
import {
  parseEnum,
  parsePagination,
} from '../admin/common.validator.js';
import {
  assertAllowedKeys,
  assertPlainObject,
  parseDateRange,
  parseMoney,
  parseNullableText,
  parsePosId,
  parseString,
} from './common.validator.js';

const TILL_SESSION_STATUSES = Object.freeze([
  'OPEN',
  'SUSPENDED',
  'CLOSED',
  'CANCELLED',
]);
const CASH_MOVEMENT_TYPES = Object.freeze([
  'CASH_IN',
  'CASH_OUT',
  'CASH_DROP',
  'PAYOUT',
]);

function validateTillSessionId(value) {
  return parsePosId(value, 'tillSessionId');
}

function validateOpenTillSession(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, [
    'cashierEmployeeId',
    'openingCashAmount',
    'notes',
  ]);

  for (const field of ['cashierEmployeeId', 'openingCashAmount']) {
    if (!Object.hasOwn(body, field)) {
      throw new HttpError(400, `${field} is required`);
    }
  }

  return {
    cashierEmployeeId: parsePosId(
      body.cashierEmployeeId,
      'cashierEmployeeId',
    ),
    openingCashAmount: parseMoney(
      body.openingCashAmount,
      'openingCashAmount',
    ),
    notes:
      body.notes === undefined
        ? null
        : parseNullableText(body.notes, 'notes', 1000),
  };
}

function validateTillSessionListQuery(query) {
  assertAllowedKeys(query, [
    'status',
    'posRegisterId',
    'cashierEmployeeId',
    'openedByEmployeeId',
    'closedByEmployeeId',
    'from',
    'to',
    'page',
    'limit',
  ]);

  return {
    ...parsePagination(query),
    ...parseDateRange(query),
    status:
      query.status === undefined
        ? null
        : parseEnum(query.status, 'status', TILL_SESSION_STATUSES),
    posRegisterId:
      query.posRegisterId === undefined
        ? null
        : parsePosId(query.posRegisterId, 'posRegisterId'),
    cashierEmployeeId:
      query.cashierEmployeeId === undefined
        ? null
        : parsePosId(query.cashierEmployeeId, 'cashierEmployeeId'),
    openedByEmployeeId:
      query.openedByEmployeeId === undefined
        ? null
        : parsePosId(query.openedByEmployeeId, 'openedByEmployeeId'),
    closedByEmployeeId:
      query.closedByEmployeeId === undefined
        ? null
        : parsePosId(query.closedByEmployeeId, 'closedByEmployeeId'),
  };
}

function validateCloseTillSession(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, ['actualClosingCashAmount']);

  if (!Object.hasOwn(body, 'actualClosingCashAmount')) {
    throw new HttpError(400, 'actualClosingCashAmount is required');
  }

  return {
    actualClosingCashAmount: parseMoney(
      body.actualClosingCashAmount,
      'actualClosingCashAmount',
    ),
  };
}

function validateCreateCashMovement(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, [
    'movementType',
    'amount',
    'reason',
    'referenceNumber',
  ]);

  for (const field of ['movementType', 'amount', 'reason']) {
    if (!Object.hasOwn(body, field)) {
      throw new HttpError(400, `${field} is required`);
    }
  }

  return {
    movementType: parseEnum(
      body.movementType,
      'movementType',
      CASH_MOVEMENT_TYPES,
    ),
    amount: parseMoney(body.amount, 'amount', { strictlyPositive: true }),
    reason: parseString(body.reason, 'reason', 500),
    referenceNumber:
      body.referenceNumber === undefined
        ? null
        : parseNullableText(body.referenceNumber, 'referenceNumber', 100),
  };
}

function validateCashMovementListQuery(query) {
  assertAllowedKeys(query, [
    'movementType',
    'recordedByEmployeeId',
    'from',
    'to',
    'page',
    'limit',
  ]);

  return {
    ...parsePagination(query),
    ...parseDateRange(query),
    movementType:
      query.movementType === undefined
        ? null
        : parseEnum(query.movementType, 'movementType', CASH_MOVEMENT_TYPES),
    recordedByEmployeeId:
      query.recordedByEmployeeId === undefined
        ? null
        : parsePosId(
            query.recordedByEmployeeId,
            'recordedByEmployeeId',
          ),
  };
}

export {
  CASH_MOVEMENT_TYPES,
  TILL_SESSION_STATUSES,
  validateCashMovementListQuery,
  validateCloseTillSession,
  validateCreateCashMovement,
  validateOpenTillSession,
  validateTillSessionId,
  validateTillSessionListQuery,
};
