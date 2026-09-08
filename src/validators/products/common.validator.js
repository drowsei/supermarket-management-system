import HttpError from '../../utils/httpError.js';
import {
  parseBoolean,
  parseEnum,
  parseId,
  parseString,
} from '../admin/common.validator.js';

const PRODUCT_STATUSES = Object.freeze([
  'ACTIVE',
  'INACTIVE',
  'DISCONTINUED',
]);
const LOT_TRACKING_MODES = Object.freeze([
  'NONE',
  'OPTIONAL',
  'REQUIRED',
]);
const BARCODE_TYPES = Object.freeze([
  'EAN_8',
  'UPC_A',
  'EAN_13',
  'GTIN_14',
  'CODE_128',
  'PLU',
  'INTERNAL',
  'OTHER',
]);

function parseCode(value, label, maximumLength) {
  return parseString(value, label, maximumLength, {
    normalize: (input) => input.toUpperCase(),
  });
}

function parseProductStatus(value, label = 'status') {
  return parseEnum(value, label, PRODUCT_STATUSES);
}

function parseLotTrackingMode(value, label = 'lotTrackingMode') {
  return parseEnum(value, label, LOT_TRACKING_MODES);
}

function parseBarcodeType(value, label = 'barcodeType') {
  return parseEnum(value, label, BARCODE_TYPES);
}

function parseBooleanQuery(value, label) {
  if (value === undefined) {
    return null;
  }

  if (value !== 'true' && value !== 'false') {
    throw new HttpError(400, `${label} must be true or false`);
  }

  return value === 'true';
}

function parseOptionalIdQuery(value, label) {
  return value === undefined ? undefined : parseId(value, label);
}

function parseNullableIdQuery(value, label) {
  if (value === undefined) {
    return undefined;
  }

  if (value === 'null') {
    return null;
  }

  return parseId(value, label);
}

function parseNullableText(value, label, maximumBytes = 65_535) {
  if (value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new HttpError(400, `${label} must be a string or null`);
  }

  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new HttpError(400, `${label} must not be blank`);
  }

  if (Buffer.byteLength(normalized, 'utf8') > maximumBytes) {
    throw new HttpError(
      400,
      `${label} must not exceed ${maximumBytes} UTF-8 bytes`,
    );
  }

  return normalized;
}

function parseExactDecimal(
  value,
  label,
  {
    precision,
    scale,
    nullable = false,
    strictlyPositive = false,
  },
) {
  if (nullable && value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new HttpError(400, `${label} must be a decimal string`);
  }

  const normalized = value.trim();
  const match = normalized.match(/^(\d+)(?:\.(\d+))?$/);

  if (!match) {
    throw new HttpError(
      400,
      `${label} must be a non-negative decimal string`,
    );
  }

  const [, rawWholePart, rawFractionPart = ''] = match;

  if (rawFractionPart.length > scale) {
    throw new HttpError(
      400,
      `${label} must have at most ${scale} decimal places`,
    );
  }

  const wholePart = rawWholePart.replace(/^0+(?=\d)/, '');
  const maximumWholeDigits = precision - scale;

  if (wholePart.length > maximumWholeDigits) {
    throw new HttpError(
      400,
      `${label} exceeds DECIMAL(${precision},${scale})`,
    );
  }

  const fractionPart = rawFractionPart.padEnd(scale, '0');
  const scaledValue = BigInt(`${wholePart}${fractionPart}`);

  if (strictlyPositive && scaledValue === 0n) {
    throw new HttpError(400, `${label} must be greater than zero`);
  }

  return `${BigInt(wholePart)}.${fractionPart}`;
}

function parseSizeDecimal(value, label = 'sizeValue', options = {}) {
  return parseExactDecimal(value, label, {
    precision: 12,
    scale: 3,
    ...options,
  });
}

function parseConversionDecimal(
  value,
  label = 'conversionToBaseQuantity',
  options = {},
) {
  return parseExactDecimal(value, label, {
    precision: 18,
    scale: 6,
    ...options,
  });
}

function parseMoneyDecimal(
  value,
  label = 'defaultSellingPrice',
  options = {},
) {
  return parseExactDecimal(value, label, {
    precision: 19,
    scale: 4,
    ...options,
  });
}

export {
  BARCODE_TYPES,
  LOT_TRACKING_MODES,
  PRODUCT_STATUSES,
  parseBarcodeType,
  parseBoolean,
  parseBooleanQuery,
  parseCode,
  parseConversionDecimal,
  parseLotTrackingMode,
  parseMoneyDecimal,
  parseNullableIdQuery,
  parseNullableText,
  parseOptionalIdQuery,
  parseProductStatus,
  parseSizeDecimal,
};
