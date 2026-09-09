import HttpError from '../../utils/httpError.js';
import {
  assertAllowedKeys,
  assertPlainObject,
  parseBoolean,
  parseEnum,
  parsePagination,
  parseSearch,
} from '../admin/common.validator.js';
import {
  parseBooleanQuery,
  parseMoneyDecimal,
} from '../products/common.validator.js';

const EFFECTIVE_STATUSES = Object.freeze([
  'EFFECTIVE',
  'FUTURE',
  'INACTIVE',
]);
const UTC_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;
const PRICE_WRITE_FIELDS = Object.freeze([
  'sellingPrice',
  'effectiveFrom',
  'isActive',
]);

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year, month) {
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days[month - 1] ?? 0;
}

function parseEffectiveFrom(value) {
  if (typeof value !== 'string') {
    throw new HttpError(400, 'effectiveFrom must be a UTC date-time string');
  }

  const match = value.match(UTC_DATE_TIME_PATTERN);

  if (!match) {
    throw new HttpError(
      400,
      'effectiveFrom must use YYYY-MM-DDTHH:mm:ss[.ffffff]Z format',
    );
  }

  const [, rawYear, rawMonth, rawDay, rawHour, rawMinute, rawSecond, rawFraction = ''] = match;
  const year = Number(rawYear);
  const month = Number(rawMonth);
  const day = Number(rawDay);
  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  const second = Number(rawSecond);

  if (
    year < 1000 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new HttpError(400, 'effectiveFrom must be a valid MySQL date-time');
  }

  const fraction = rawFraction.padEnd(6, '0');
  const isoValue = `${rawYear}-${rawMonth}-${rawDay}T${rawHour}:${rawMinute}:${rawSecond}.${fraction}Z`;

  return {
    isoValue,
    databaseValue: `${rawYear}-${rawMonth}-${rawDay} ${rawHour}:${rawMinute}:${rawSecond}.${fraction}`,
  };
}

function validatePriceWriteBody(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, PRICE_WRITE_FIELDS);

  for (const field of PRICE_WRITE_FIELDS) {
    if (!Object.hasOwn(body, field)) {
      throw new HttpError(400, `${field} is required`);
    }
  }

  const effectiveFrom = parseEffectiveFrom(body.effectiveFrom);

  return {
    sellingPrice: parseMoneyDecimal(body.sellingPrice, 'sellingPrice'),
    effectiveFrom: effectiveFrom.isoValue,
    effectiveFromDatabase: effectiveFrom.databaseValue,
    isActive: parseBoolean(body.isActive, 'isActive'),
  };
}

function validatePriceListQuery(query) {
  assertAllowedKeys(query, [
    'search',
    'isActive',
    'effectiveStatus',
    'page',
    'limit',
  ]);

  return {
    ...parsePagination(query),
    search: parseSearch(query.search, 180),
    isActive: parseBooleanQuery(query.isActive, 'isActive'),
    effectiveStatus:
      query.effectiveStatus === undefined
        ? null
        : parseEnum(
            query.effectiveStatus,
            'effectiveStatus',
            EFFECTIVE_STATUSES,
          ),
  };
}

function validateNoPricingQuery(query) {
  assertAllowedKeys(query, []);
}

export {
  EFFECTIVE_STATUSES,
  parseEffectiveFrom,
  validateNoPricingQuery,
  validatePriceListQuery,
  validatePriceWriteBody,
};
