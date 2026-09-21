import HttpError from '../../utils/httpError.js';
import {
  assertAllowedKeys,
  assertPlainObject,
  parseDate,
  parseId,
  parseString,
} from '../admin/common.validator.js';
import { parseExactDecimal } from '../products/common.validator.js';

function parsePosId(value, label) {
  return parseId(value, label);
}

function parseMoney(value, label, { strictlyPositive = false } = {}) {
  return parseExactDecimal(value, label, {
    precision: 19,
    scale: 2,
    strictlyPositive,
  });
}

function parseNullableText(value, label, maximumLength) {
  return parseString(value, label, maximumLength, { nullable: true });
}

function parseOptionalDate(value, label) {
  return value === undefined ? null : parseDate(value, label);
}

function parseDateRange(query) {
  const from = parseOptionalDate(query.from, 'from');
  const to = parseOptionalDate(query.to, 'to');

  if (from !== null && to !== null && from > to) {
    throw new HttpError(400, 'from must not be later than to');
  }

  return { from, to };
}

function validateNoQuery(query) {
  assertAllowedKeys(query, []);
}

function validateEmptyActionBody(body) {
  if (body === undefined) {
    return {};
  }

  assertPlainObject(body);
  assertAllowedKeys(body, []);
  return {};
}

export {
  assertAllowedKeys,
  assertPlainObject,
  parseDateRange,
  parseMoney,
  parseNullableText,
  parsePosId,
  parseString,
  validateEmptyActionBody,
  validateNoQuery,
};
