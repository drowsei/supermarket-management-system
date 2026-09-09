import HttpError from '../../utils/httpError.js';
import {
  parseBoolean,
  parseEnum,
  parseId,
  parseString,
} from '../admin/common.validator.js';
import {
  parseBooleanQuery,
  parseExactDecimal,
} from '../products/common.validator.js';

const SUPPLIER_STATUSES = Object.freeze(['ACTIVE', 'INACTIVE', 'BLOCKED']);

function parseSupplierStatus(value, label = 'status') {
  return parseEnum(value, label, SUPPLIER_STATUSES);
}

function parseSupplierCode(value, label = 'supplierCode', maximumLength = 32) {
  return parseString(value, label, maximumLength, {
    normalize: (input) => input.toUpperCase(),
  });
}

function parseNullableSupplierString(value, label, maximumLength, options = {}) {
  return parseString(value, label, maximumLength, {
    nullable: true,
    ...options,
  });
}

function parseUnsignedSmallInteger(
  value,
  label,
  { nullable = false } = {},
) {
  if (nullable && value === null) {
    return null;
  }

  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new HttpError(
      400,
      `${label} must be an integer from 0 through 65535${nullable ? ' or null' : ''}`,
    );
  }

  return value;
}

function parseSupplierQuantity(value, label) {
  return parseExactDecimal(value, label, {
    precision: 15,
    scale: 3,
    strictlyPositive: true,
  });
}

function parseOptionalIdQuery(value, label) {
  return value === undefined ? undefined : parseId(value, label);
}

function validateNoSupplierQuery(query) {
  if (Object.keys(query).length > 0) {
    throw new HttpError(400, 'This endpoint does not accept query parameters');
  }
}

export {
  SUPPLIER_STATUSES,
  parseBoolean,
  parseBooleanQuery,
  parseNullableSupplierString,
  parseOptionalIdQuery,
  parseSupplierCode,
  parseSupplierQuantity,
  parseSupplierStatus,
  parseUnsignedSmallInteger,
  validateNoSupplierQuery,
};
