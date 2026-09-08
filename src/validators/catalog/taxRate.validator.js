import HttpError from '../../utils/httpError.js';
import {
  assertAllowedKeys,
  assertPlainObject,
  parseBoolean,
  parseId,
  parsePagination,
  parseSearch,
  parseString,
  requireAtLeastOneKey,
} from '../admin/common.validator.js';

const TAX_RATE_FIELDS = [
  'taxCode',
  'taxName',
  'ratePercent',
  'isInclusive',
  'isActive',
];
const DECIMAL_PATTERN = /^\d{1,3}(?:\.\d{1,4})?$/;
const MAX_RATE_SCALED = 1_000_000n;

function parseTaxCode(value) {
  return parseString(value, 'taxCode', 30, {
    normalize: (input) => input.toUpperCase(),
  });
}

function parseRatePercent(value) {
  if (typeof value !== 'string') {
    throw new HttpError(400, 'ratePercent must be a decimal string');
  }

  const normalized = value.trim();

  if (!DECIMAL_PATTERN.test(normalized)) {
    throw new HttpError(
      400,
      'ratePercent must be a non-negative decimal with at most four decimal places',
    );
  }

  const [wholePart, fractionPart = ''] = normalized.split('.');
  const canonicalWholePart = BigInt(wholePart);
  const paddedFraction = fractionPart.padEnd(4, '0');
  const scaledRate = canonicalWholePart * 10_000n + BigInt(paddedFraction);

  if (scaledRate > MAX_RATE_SCALED) {
    throw new HttpError(400, 'ratePercent must be between 0 and 100');
  }

  return `${canonicalWholePart}.${paddedFraction}`;
}

function parseTaxRateField(field, value) {
  const parsers = {
    taxCode: () => parseTaxCode(value),
    taxName: () => parseString(value, 'taxName', 100),
    ratePercent: () => parseRatePercent(value),
    isInclusive: () => parseBoolean(value, 'isInclusive'),
    isActive: () => parseBoolean(value, 'isActive'),
  };

  return parsers[field]();
}

function parseBooleanFilter(value, field) {
  if (value === undefined) {
    return null;
  }

  if (value !== 'true' && value !== 'false') {
    throw new HttpError(400, `${field} must be true or false`);
  }

  return value === 'true';
}

function validateTaxRateId(value) {
  return parseId(value, 'taxRateId');
}

function validateTaxRateListQuery(query) {
  assertAllowedKeys(query, [
    'search',
    'isActive',
    'isInclusive',
    'page',
    'limit',
  ]);

  return {
    ...parsePagination(query),
    search: parseSearch(query.search, 150),
    isActive: parseBooleanFilter(query.isActive, 'isActive'),
    isInclusive: parseBooleanFilter(query.isInclusive, 'isInclusive'),
  };
}

function validateCreateTaxRate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, TAX_RATE_FIELDS);

  for (const field of ['taxCode', 'taxName']) {
    if (!Object.hasOwn(body, field)) {
      throw new HttpError(400, `${field} is required`);
    }
  }

  return {
    taxCode: parseTaxCode(body.taxCode),
    taxName: parseString(body.taxName, 'taxName', 100),
    ratePercent:
      body.ratePercent === undefined
        ? '0.0000'
        : parseRatePercent(body.ratePercent),
    isInclusive:
      body.isInclusive === undefined
        ? false
        : parseBoolean(body.isInclusive, 'isInclusive'),
    isActive:
      body.isActive === undefined
        ? true
        : parseBoolean(body.isActive, 'isActive'),
  };
}

function validateUpdateTaxRate(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, TAX_RATE_FIELDS);
  requireAtLeastOneKey(body);

  return Object.fromEntries(
    Object.entries(body).map(([field, value]) => [
      field,
      parseTaxRateField(field, value),
    ]),
  );
}

export {
  validateCreateTaxRate,
  validateTaxRateId,
  validateTaxRateListQuery,
  validateUpdateTaxRate,
};
