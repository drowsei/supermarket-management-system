import HttpError from '../../utils/httpError.js';
import {
  assertAllowedKeys,
  parseDate,
  parseEnum,
  parseId,
  parsePagination,
  parseSearch,
} from '../admin/common.validator.js';
import { inclusiveDayCount } from '../../utils/reportDateRange.js';

function optionalId(value, label) {
  return value === undefined ? null : parseId(value, label);
}

function optionalEnum(value, label, values, fallback = null) {
  return value === undefined ? fallback : parseEnum(value, label, values);
}

function requiredDateRange(query) {
  if (query.from === undefined || query.to === undefined) {
    throw new HttpError(400, 'from and to are required');
  }
  const from = parseDate(query.from, 'from');
  const to = parseDate(query.to, 'to');
  if (from > to) throw new HttpError(400, 'from must not be later than to');
  if (inclusiveDayCount(from, to) > 366) {
    throw new HttpError(400, 'Report date range must not exceed 366 days');
  }
  return { from, to };
}

function parseQueryBoolean(value, label) {
  if (value === undefined) return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new HttpError(400, `${label} must be true or false`);
}

function parseBoundedInteger(value, label, { minimum, maximum }) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new HttpError(400, `${label} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new HttpError(400, `${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function validateReportRequestBody(body) {
  if (body !== undefined && body !== null && Object.keys(body).length > 0) {
    throw new HttpError(400, 'GET report requests do not accept a request body');
  }
}

export {
  assertAllowedKeys,
  optionalEnum,
  optionalId,
  parseBoundedInteger,
  parsePagination,
  parseQueryBoolean,
  parseSearch,
  requiredDateRange,
  validateReportRequestBody,
};
