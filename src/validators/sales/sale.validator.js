import HttpError from '../../utils/httpError.js';
import {
  parseEnum,
  parsePagination,
  parseSearch,
  requireAtLeastOneKey,
} from '../admin/common.validator.js';
import {
  assertAllowedKeys,
  assertPlainObject,
  parseListDates,
  parseNullableSalesId,
  parseNullableText,
  parseSalesId,
} from './common.validator.js';

const SALE_STATUSES = Object.freeze([
  'OPEN',
  'COMPLETED',
  'CANCELLED',
  'VOIDED',
]);
const SALE_MUTABLE_FIELDS = Object.freeze(['customerId', 'notes']);

function validateSaleId(value) {
  return parseSalesId(value, 'saleId');
}

function validateSalesTillSessionId(value) {
  return parseSalesId(value, 'tillSessionId');
}

function validateSaleListQuery(query) {
  assertAllowedKeys(query, [
    'search',
    'status',
    'customerId',
    'cashierEmployeeId',
    'posRegisterId',
    'tillSessionId',
    'from',
    'to',
    'page',
    'limit',
  ]);

  return {
    ...parsePagination(query),
    ...parseListDates(query),
    search: parseSearch(query.search, 50),
    status:
      query.status === undefined
        ? null
        : parseEnum(query.status, 'status', SALE_STATUSES),
    customerId:
      query.customerId === undefined
        ? null
        : parseSalesId(query.customerId, 'customerId'),
    cashierEmployeeId:
      query.cashierEmployeeId === undefined
        ? null
        : parseSalesId(query.cashierEmployeeId, 'cashierEmployeeId'),
    posRegisterId:
      query.posRegisterId === undefined
        ? null
        : parseSalesId(query.posRegisterId, 'posRegisterId'),
    tillSessionId:
      query.tillSessionId === undefined
        ? null
        : parseSalesId(query.tillSessionId, 'tillSessionId'),
  };
}

function parseSaleMutableFields(body, { partial }) {
  assertPlainObject(body);
  assertAllowedKeys(body, SALE_MUTABLE_FIELDS);
  if (partial) requireAtLeastOneKey(body);

  const values = {};

  if (Object.hasOwn(body, 'customerId')) {
    values.customerId = parseNullableSalesId(body.customerId, 'customerId');
  } else if (!partial) {
    values.customerId = null;
  }

  if (Object.hasOwn(body, 'notes')) {
    values.notes = parseNullableText(body.notes, 'notes', 1000);
  } else if (!partial) {
    values.notes = null;
  }

  return values;
}

function validateCreateSale(body) {
  if (body === undefined) return { customerId: null, notes: null };
  return parseSaleMutableFields(body, { partial: false });
}

function validateUpdateSale(body) {
  return parseSaleMutableFields(body, { partial: true });
}

export {
  SALE_STATUSES,
  validateCreateSale,
  validateSaleId,
  validateSaleListQuery,
  validateSalesTillSessionId,
  validateUpdateSale,
};
