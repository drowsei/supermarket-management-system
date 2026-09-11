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

const PURCHASE_ORDER_STATUSES = Object.freeze([
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'CANCELLED',
]);
const GOODS_RECEIPT_STATUSES = Object.freeze(['DRAFT', 'POSTED', 'CANCELLED']);
const UTC_DATETIME_PATTERN =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;

function validateNoQuery(query) {
  if (Object.keys(query).length > 0) {
    throw new HttpError(400, 'This endpoint does not accept query parameters');
  }
}

function validateEmptyBody(body) {
  if (body === undefined) return {};
  assertPlainObject(body);
  assertAllowedKeys(body, []);
  return {};
}

function parseNullableString(value, label, maximumLength) {
  return parseString(value, label, maximumLength, { nullable: true });
}

function parseUtcDateTime(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') {
    throw new HttpError(400, `${label} must be a UTC date-time string or null`);
  }

  const match = value.match(UTC_DATETIME_PATTERN);
  if (!match) {
    throw new HttpError(
      400,
      `${label} must use an ISO 8601 UTC date-time ending in Z`,
    );
  }

  const [, date, hour, minute, second, fraction = ''] = match;
  const millisecond = fraction.padEnd(3, '0').slice(0, 3);
  const parsed = new Date(`${date}T${hour}:${minute}:${second}.${millisecond}Z`);
  if (
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 19) !== `${date}T${hour}:${minute}:${second}`
  ) {
    throw new HttpError(400, `${label} must be a valid UTC date-time`);
  }

  return `${date} ${hour}:${minute}:${second}.${fraction.padEnd(6, '0')}`;
}

function parseQuantity(value, label, { positive = false } = {}) {
  return parseExactDecimal(value, label, {
    precision: 15,
    scale: 3,
    strictlyPositive: positive,
  });
}

function parseConversion(value, label = 'packageConversionFactor') {
  return parseExactDecimal(value, label, {
    precision: 18,
    scale: 6,
    strictlyPositive: true,
  });
}

function parseUnitCost(value, label) {
  return parseExactDecimal(value, label, { precision: 19, scale: 4 });
}

function parseMoney(value, label) {
  return parseExactDecimal(value, label, { precision: 19, scale: 2 });
}

function parseTaxRate(value, label = 'taxRatePercent') {
  const normalized = parseExactDecimal(value, label, {
    precision: 7,
    scale: 4,
  });
  const [whole] = normalized.split('.');
  if (BigInt(whole) > 100n || (whole === '100' && normalized !== '100.0000')) {
    throw new HttpError(400, `${label} must be between 0 and 100`);
  }
  return normalized;
}

function parseListDates(query) {
  const from = query.from === undefined ? null : parseDate(query.from, 'from');
  const to = query.to === undefined ? null : parseDate(query.to, 'to');
  if (from && to && from > to) {
    throw new HttpError(400, 'from must not be later than to');
  }
  return { from, to };
}

function validateDocumentId(value, label) {
  return parseId(value, label);
}

export {
  GOODS_RECEIPT_STATUSES,
  PURCHASE_ORDER_STATUSES,
  assertAllowedKeys,
  assertPlainObject,
  parseConversion,
  parseEnum,
  parseId,
  parseListDates,
  parseMoney,
  parseNullableString,
  parsePagination,
  parseQuantity,
  parseSearch,
  parseTaxRate,
  parseUnitCost,
  parseUtcDateTime,
  validateDocumentId,
  validateEmptyBody,
  validateNoQuery,
};
