import HttpError from '../../utils/httpError.js';
import {
  assertAllowedKeys,
  assertPlainObject,
  parseDate,
  parseId,
  parseString,
} from '../admin/common.validator.js';
import { parseExactDecimal } from '../products/common.validator.js';

function parseSalesId(value, label) {
  return parseId(value, label);
}

function parseNullableSalesId(value, label) {
  return parseId(value, label, { nullable: true });
}

function parseNullableText(value, label, maximumLength) {
  return parseString(value, label, maximumLength, { nullable: true });
}

function parseQuantity(value, label = 'quantity') {
  return parseExactDecimal(value, label, {
    precision: 15,
    scale: 3,
    strictlyPositive: true,
  });
}

function parseMoney(value, label) {
  return parseExactDecimal(value, label, { precision: 19, scale: 2 });
}

function parseListDates(query) {
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

function validateEmptyBody(body) {
  if (body === undefined) return {};
  assertPlainObject(body);
  assertAllowedKeys(body, []);
  return {};
}

export {
  assertAllowedKeys,
  assertPlainObject,
  parseListDates,
  parseMoney,
  parseNullableSalesId,
  parseNullableText,
  parseQuantity,
  parseSalesId,
  validateEmptyBody,
  validateNoQuery,
};
