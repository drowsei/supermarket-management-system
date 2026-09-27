import HttpError from '../../utils/httpError.js';
import {
  assertAllowedKeys,
  assertPlainObject,
  parseDate,
  parseId,
  parseString,
} from '../admin/common.validator.js';
import { parseExactDecimal } from '../products/common.validator.js';

function parsePaymentId(value, label) {
  return parseId(value, label);
}

function parseNullablePaymentText(value, label, maximumLength) {
  return parseString(value, label, maximumLength, { nullable: true });
}

function parsePaymentAmount(value, label = 'amount') {
  return parseExactDecimal(value, label, {
    precision: 19,
    scale: 2,
    strictlyPositive: true,
  });
}

function parsePaymentListDates(query) {
  const from = query.from === undefined ? null : parseDate(query.from, 'from');
  const to = query.to === undefined ? null : parseDate(query.to, 'to');

  if (from !== null && to !== null && from > to) {
    throw new HttpError(400, 'from must not be later than to');
  }

  return { from, to };
}

function validateNoQuery(query) {
  assertAllowedKeys(query, []);
}

function validateEmptyActionBody(body) {
  if (body === undefined) return {};
  assertPlainObject(body);
  assertAllowedKeys(body, []);
  return {};
}

export {
  assertAllowedKeys,
  assertPlainObject,
  parseNullablePaymentText,
  parsePaymentAmount,
  parsePaymentId,
  parsePaymentListDates,
  validateEmptyActionBody,
  validateNoQuery,
};
