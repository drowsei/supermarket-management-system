import HttpError from '../../utils/httpError.js';
import {
  assertAllowedKeys,
  assertPlainObject,
  parseDate,
  parseEnum,
  parseId,
  parsePagination,
  parseSearch,
  parseString,
} from '../admin/common.validator.js';
import { parseExactDecimal } from '../products/common.validator.js';

function parseSignedQuantity(value, label = 'quantity') {
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be a decimal string`);
  const normalized = value.trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!match) throw new HttpError(400, `${label} must be a signed decimal string`);
  const fraction = (match[3] ?? '').padEnd(3, '0');
  if ((match[3] ?? '').length > 3) throw new HttpError(400, `${label} must have at most 3 decimal places`);
  const whole = match[2].replace(/^0+(?=\d)/, '');
  if (whole.length > 12) throw new HttpError(400, `${label} exceeds DECIMAL(15,3)`);
  const magnitude = BigInt(`${whole}${fraction}`);
  if (magnitude === 0n) throw new HttpError(400, `${label} must not be zero`);
  return `${match[1]}${BigInt(whole)}.${fraction}`;
}

function parseQuantity(value, label = 'quantity', { allowZero = false } = {}) {
  const normalized = parseExactDecimal(value, label, { precision: 15, scale: 3 });
  if (!allowZero && normalized === '0.000') throw new HttpError(400, `${label} must be greater than zero`);
  return normalized;
}

function parseUnitCost(value, label = 'unitCost') {
  if (value === undefined || value === null) return null;
  return parseExactDecimal(value, label, { precision: 19, scale: 4 });
}

function parseNullableText(value, label, maximum) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return parseString(value, label, maximum);
}

function parseOptionalId(value, label) {
  return value === undefined ? null : parseId(value, label);
}

function parseOptionalEnum(value, label, values) {
  return value === undefined ? null : parseEnum(value, label, values);
}

function parseListQuery(query, allowedKeys, enums = {}) {
  assertAllowedKeys(query, [...allowedKeys, 'page', 'limit']);
  const result = { ...parsePagination(query) };
  for (const key of allowedKeys) {
    if (key === 'search') result.search = parseSearch(query.search, 180);
    else if (key === 'from' || key === 'to') {
      result[key] = query[key] === undefined ? null : parseDate(query[key], key);
    } else if (enums[key]) result[key] = parseOptionalEnum(query[key], key, enums[key]);
    else result[key] = parseOptionalId(query[key], key);
  }
  if (result.from && result.to && result.from > result.to) {
    throw new HttpError(400, 'from must not be later than to');
  }
  return result;
}

function parseRequiredArray(value, label, maximum = 100) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpError(400, `${label} must be a non-empty array`);
  }
  if (value.length > maximum) throw new HttpError(400, `${label} must not exceed ${maximum} entries`);
  return value;
}

function validateEmptyObject(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, []);
  return {};
}

export {
  assertAllowedKeys,
  assertPlainObject,
  parseEnum,
  parseId,
  parseListQuery,
  parseNullableText,
  parseOptionalEnum,
  parseOptionalId,
  parseQuantity,
  parseRequiredArray,
  parseSignedQuantity,
  parseString,
  parseUnitCost,
  validateEmptyObject,
};
