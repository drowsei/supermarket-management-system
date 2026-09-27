import HttpError from '../../utils/httpError.js';
import {
  parseBoolean,
  parseEnum,
  parsePagination,
  parseSearch,
  parseString,
  requireAtLeastOneKey,
} from '../admin/common.validator.js';
import { parseBooleanQuery } from '../products/common.validator.js';
import {
  assertAllowedKeys,
  assertPlainObject,
  parsePaymentId,
} from './common.validator.js';

const PAYMENT_METHOD_TYPES = Object.freeze([
  'CASH',
  'CARD',
  'BANK_TRANSFER',
  'MOBILE_MONEY',
  'VOUCHER',
  'OTHER',
]);
const CREATE_FIELDS = Object.freeze([
  'methodCode',
  'methodName',
  'methodType',
  'requiresReference',
  'isActive',
]);
const UPDATE_FIELDS = Object.freeze([
  'methodCode',
  'methodName',
  'requiresReference',
  'isActive',
]);

function parseMethodCode(value) {
  return parseString(value, 'methodCode', 30, {
    normalize: (input) => input.toUpperCase(),
  });
}

function parseMethodField(field, value) {
  const parsers = {
    methodCode: () => parseMethodCode(value),
    methodName: () => parseString(value, 'methodName', 100),
    requiresReference: () => parseBoolean(value, 'requiresReference'),
    isActive: () => parseBoolean(value, 'isActive'),
  };

  return parsers[field]();
}

function validatePaymentMethodId(value) {
  return parsePaymentId(value, 'paymentMethodId');
}

function validatePaymentMethodListQuery(query) {
  assertAllowedKeys(query, [
    'search',
    'methodType',
    'isActive',
    'requiresReference',
    'page',
    'limit',
  ]);

  return {
    ...parsePagination(query),
    search: parseSearch(query.search, 130),
    methodType:
      query.methodType === undefined
        ? null
        : parseEnum(query.methodType, 'methodType', PAYMENT_METHOD_TYPES),
    isActive: parseBooleanQuery(query.isActive, 'isActive'),
    requiresReference: parseBooleanQuery(
      query.requiresReference,
      'requiresReference',
    ),
  };
}

function validateCreatePaymentMethod(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, CREATE_FIELDS);

  for (const field of ['methodCode', 'methodName', 'methodType', 'requiresReference']) {
    if (!Object.hasOwn(body, field)) {
      throw new HttpError(400, `${field} is required`);
    }
  }

  return {
    methodCode: parseMethodCode(body.methodCode),
    methodName: parseString(body.methodName, 'methodName', 100),
    methodType: parseEnum(body.methodType, 'methodType', PAYMENT_METHOD_TYPES),
    requiresReference: parseBoolean(body.requiresReference, 'requiresReference'),
    isActive:
      body.isActive === undefined
        ? true
        : parseBoolean(body.isActive, 'isActive'),
  };
}

function validateUpdatePaymentMethod(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, UPDATE_FIELDS);
  requireAtLeastOneKey(body);

  return Object.fromEntries(
    Object.entries(body).map(([field, value]) => [
      field,
      parseMethodField(field, value),
    ]),
  );
}

export {
  PAYMENT_METHOD_TYPES,
  validateCreatePaymentMethod,
  validatePaymentMethodId,
  validatePaymentMethodListQuery,
  validateUpdatePaymentMethod,
};
