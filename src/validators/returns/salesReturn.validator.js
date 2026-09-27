import HttpError from '../../utils/httpError.js';
import {
  parseBoolean,
  parseEnum,
  parseId,
  parsePagination,
  requireAtLeastOneKey,
} from '../admin/common.validator.js';
import { parseExactDecimal } from '../products/common.validator.js';
import {
  assertAllowedKeys,
  assertPlainObject,
  parseNullableReturnText,
  parseReturnListDates,
} from './common.validator.js';

const RETURN_STATUSES = Object.freeze([
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'COMPLETED',
  'CANCELLED',
]);
const ITEM_CONDITIONS = Object.freeze([
  'UNOPENED',
  'OPENED',
  'DAMAGED',
  'EXPIRED',
  'DEFECTIVE',
  'OTHER',
]);
const ITEM_FIELDS = Object.freeze([
  'returnReasonId',
  'quantityReturned',
  'itemCondition',
  'isRestockable',
  'notes',
]);

function validateSalesReturnListQuery(query) {
  assertAllowedKeys(query, ['status', 'from', 'to', 'page', 'limit']);
  return {
    ...parsePagination(query),
    ...parseReturnListDates(query),
    status: query.status === undefined
      ? null
      : parseEnum(query.status, 'status', RETURN_STATUSES),
  };
}

function validateCreateSalesReturn(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, ['notes']);
  return {
    notes: body.notes === undefined
      ? null
      : parseNullableReturnText(body.notes, 'notes', 1000),
  };
}

function parseItemFields(body, { partial }) {
  assertPlainObject(body);
  assertAllowedKeys(body, partial
    ? ITEM_FIELDS
    : ['originalSaleItemId', ...ITEM_FIELDS]);
  if (partial) requireAtLeastOneKey(body);
  const required = partial
    ? []
    : ['originalSaleItemId', 'returnReasonId', 'quantityReturned', 'itemCondition'];
  for (const field of required) {
    if (!Object.hasOwn(body, field)) {
      throw new HttpError(400, `${field} is required`);
    }
  }
  const values = {};
  if (Object.hasOwn(body, 'originalSaleItemId')) {
    values.originalSaleItemId = parseId(body.originalSaleItemId, 'originalSaleItemId');
  }
  if (Object.hasOwn(body, 'returnReasonId')) {
    values.returnReasonId = parseId(body.returnReasonId, 'returnReasonId');
  }
  if (Object.hasOwn(body, 'quantityReturned')) {
    values.quantityReturned = parseExactDecimal(
      body.quantityReturned,
      'quantityReturned',
      { precision: 15, scale: 3, strictlyPositive: true },
    );
  }
  if (Object.hasOwn(body, 'itemCondition')) {
    values.itemCondition = parseEnum(
      body.itemCondition,
      'itemCondition',
      ITEM_CONDITIONS,
    );
  }
  if (Object.hasOwn(body, 'isRestockable')) {
    values.isRestockable = parseBoolean(body.isRestockable, 'isRestockable');
  }
  if (Object.hasOwn(body, 'notes')) {
    values.notes = parseNullableReturnText(body.notes, 'notes', 500);
  }
  return values;
}

function validateCreateSalesReturnItem(body) {
  const values = parseItemFields(body, { partial: false });
  if (
    values.isRestockable === true &&
    ['DAMAGED', 'EXPIRED'].includes(values.itemCondition)
  ) {
    throw new HttpError(400, 'Damaged or expired items cannot be restockable');
  }
  return values;
}

function validateUpdateSalesReturnItem(body) {
  return parseItemFields(body, { partial: true });
}

export {
  ITEM_CONDITIONS,
  RETURN_STATUSES,
  validateCreateSalesReturn,
  validateCreateSalesReturnItem,
  validateSalesReturnListQuery,
  validateUpdateSalesReturnItem,
};
