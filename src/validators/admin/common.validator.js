import HttpError from '../../utils/httpError.js';
import { isUnsignedBigIntId } from '../../utils/jwt.js';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function assertPlainObject(value, label = 'Request body') {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new HttpError(400, `${label} must be a JSON object`);
  }
}

function assertAllowedKeys(object, allowedKeys) {
  const unknownKeys = Object.keys(object).filter(
    (key) => !allowedKeys.includes(key),
  );

  if (unknownKeys.length > 0) {
    throw new HttpError(400, 'Request contains unsupported fields');
  }
}

function requireAtLeastOneKey(object) {
  if (Object.keys(object).length === 0) {
    throw new HttpError(400, 'At least one field must be supplied');
  }
}

function parseId(value, label = 'ID', { nullable = false } = {}) {
  if (nullable && value === null) {
    return null;
  }

  const normalized = typeof value === 'string' ? value : '';

  if (!isUnsignedBigIntId(normalized)) {
    throw new HttpError(400, `${label} must be a positive unsigned integer string`);
  }

  return normalized;
}

function parseString(
  value,
  label,
  maximumLength,
  { nullable = false, normalize = (input) => input } = {},
) {
  if (nullable && value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new HttpError(400, `${label} must be a string`);
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new HttpError(400, `${label} is required`);
  }

  if ([...trimmed].length > maximumLength) {
    throw new HttpError(400, `${label} must not exceed ${maximumLength} characters`);
  }

  return normalize(trimmed);
}

function parseOptionalString(value, label, maximumLength) {
  return parseString(value, label, maximumLength, { nullable: true });
}

function parseEmail(value, label = 'Email', { nullable = false } = {}) {
  const email = parseString(value, label, 254, {
    nullable,
    normalize: (input) => input.toLowerCase(),
  });

  if (email !== null && !EMAIL_PATTERN.test(email)) {
    throw new HttpError(400, `${label} must be a valid email address`);
  }

  return email;
}

function parseBoolean(value, label) {
  if (typeof value !== 'boolean') {
    throw new HttpError(400, `${label} must be a boolean`);
  }

  return value;
}

function parseEnum(value, label, allowedValues) {
  if (typeof value !== 'string' || !allowedValues.includes(value)) {
    throw new HttpError(
      400,
      `${label} must be one of: ${allowedValues.join(', ')}`,
    );
  }

  return value;
}

function parseDate(value, label, { nullable = false } = {}) {
  if (nullable && value === null) {
    return null;
  }

  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    throw new HttpError(400, `${label} must use YYYY-MM-DD format`);
  }

  if (value < '1000-01-01' || value > '9999-12-31') {
    throw new HttpError(400, `${label} must be within the MySQL DATE range`);
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw new HttpError(400, `${label} must be a valid calendar date`);
  }

  return value;
}

function parsePagination(query) {
  const parsePositiveInteger = (rawValue, name, defaultValue, maximum) => {
    if (rawValue === undefined) {
      return defaultValue;
    }

    if (typeof rawValue !== 'string' || !/^[1-9]\d*$/.test(rawValue)) {
      throw new HttpError(400, `${name} must be a positive integer`);
    }

    const parsed = Number(rawValue);

    if (!Number.isSafeInteger(parsed) || (maximum && parsed > maximum)) {
      throw new HttpError(
        400,
        maximum
          ? `${name} must not exceed ${maximum}`
          : `${name} is too large`,
      );
    }

    return parsed;
  };

  const page = parsePositiveInteger(query.page, 'page', DEFAULT_PAGE);
  const limit = parsePositiveInteger(
    query.limit,
    'limit',
    DEFAULT_LIMIT,
    MAX_LIMIT,
  );
  const offset = (page - 1) * limit;

  if (!Number.isSafeInteger(offset)) {
    throw new HttpError(400, 'page is too large');
  }

  return { page, limit, offset };
}

function parseSearch(value, maximumLength = 150) {
  if (value === undefined) {
    return null;
  }

  return parseString(value, 'search', maximumLength);
}

function paginationMetadata(page, limit, totalItems) {
  return {
    page,
    limit,
    totalItems,
    totalPages: totalItems === 0 ? 0 : Math.ceil(totalItems / limit),
  };
}

export {
  MAX_LIMIT,
  assertAllowedKeys,
  assertPlainObject,
  paginationMetadata,
  parseBoolean,
  parseDate,
  parseEmail,
  parseEnum,
  parseId,
  parseOptionalString,
  parsePagination,
  parseSearch,
  parseString,
  requireAtLeastOneKey,
};
