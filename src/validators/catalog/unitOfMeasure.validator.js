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

const UNIT_OF_MEASURE_FIELDS = [
  'unitCode',
  'unitName',
  'symbol',
  'allowsFraction',
];

function parseUnitCode(value) {
  return parseString(value, 'unitCode', 20, {
    normalize: (input) => input.toUpperCase(),
  });
}

function parseUnitField(field, value) {
  const parsers = {
    unitCode: () => parseUnitCode(value),
    unitName: () => parseString(value, 'unitName', 80),
    symbol: () => parseString(value, 'symbol', 20),
    allowsFraction: () => parseBoolean(value, 'allowsFraction'),
  };

  return parsers[field]();
}

function validateCreateUnitOfMeasure(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, UNIT_OF_MEASURE_FIELDS);

  for (const field of ['unitCode', 'unitName', 'symbol']) {
    if (!Object.hasOwn(body, field)) {
      throw new HttpError(400, `${field} is required`);
    }
  }

  return {
    unitCode: parseUnitCode(body.unitCode),
    unitName: parseString(body.unitName, 'unitName', 80),
    symbol: parseString(body.symbol, 'symbol', 20),
    allowsFraction:
      body.allowsFraction === undefined
        ? false
        : parseBoolean(body.allowsFraction, 'allowsFraction'),
  };
}

function validateUpdateUnitOfMeasure(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, UNIT_OF_MEASURE_FIELDS);
  requireAtLeastOneKey(body);

  return Object.fromEntries(
    Object.entries(body).map(([field, value]) => [
      field,
      parseUnitField(field, value),
    ]),
  );
}

function validateUnitOfMeasureListQuery(query) {
  assertAllowedKeys(query, ['search', 'allowsFraction', 'page', 'limit']);
  let allowsFraction = null;

  if (query.allowsFraction !== undefined) {
    if (
      query.allowsFraction !== 'true' &&
      query.allowsFraction !== 'false'
    ) {
      throw new HttpError(400, 'allowsFraction must be true or false');
    }

    allowsFraction = query.allowsFraction === 'true';
  }

  return {
    ...parsePagination(query),
    search: parseSearch(query.search, 80),
    allowsFraction,
  };
}

function validateUnitOfMeasureId(value) {
  return parseId(value, 'unitOfMeasureId');
}

export {
  validateCreateUnitOfMeasure,
  validateUnitOfMeasureId,
  validateUnitOfMeasureListQuery,
  validateUpdateUnitOfMeasure,
};
