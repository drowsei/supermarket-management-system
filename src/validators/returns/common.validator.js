import HttpError from '../../utils/httpError.js';
import {
  assertAllowedKeys,
  assertPlainObject,
  parseDate,
  parseId,
  parseString,
} from '../admin/common.validator.js';

function parseReturnId(value, label = 'salesReturnId') {
  return parseId(value, label);
}

function parseReturnItemId(value) {
  return parseId(value, 'salesReturnItemId');
}

function parseRefundId(value) {
  return parseId(value, 'salePaymentId');
}

function parseNullableReturnText(value, label, maximumLength) {
  return parseString(value, label, maximumLength, { nullable: true });
}

function parseReturnListDates(query) {
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
  assertPlainObject(body ?? {});
  assertAllowedKeys(body ?? {}, []);
  return {};
}

export {
  assertAllowedKeys,
  assertPlainObject,
  parseNullableReturnText,
  parseRefundId,
  parseReturnId,
  parseReturnItemId,
  parseReturnListDates,
  validateEmptyActionBody,
  validateNoQuery,
};
