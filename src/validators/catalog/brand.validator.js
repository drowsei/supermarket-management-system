import HttpError from '../../utils/httpError.js';
import {
  assertAllowedKeys,
  assertPlainObject,
  parseBoolean,
  parseId,
  parseOptionalString,
  parsePagination,
  parseSearch,
  parseString,
  requireAtLeastOneKey,
} from '../admin/common.validator.js';

const BRAND_FIELDS = ['brandCode', 'brandName', 'description', 'isActive'];

function parseBrandCode(value) {
  return parseString(value, 'brandCode', 50, {
    normalize: (input) => input.toUpperCase(),
  });
}

function parseBrandField(field, value) {
  const parsers = {
    brandCode: () => parseBrandCode(value),
    brandName: () => parseString(value, 'brandName', 120),
    description: () => parseOptionalString(value, 'description', 500),
    isActive: () => parseBoolean(value, 'isActive'),
  };

  return parsers[field]();
}

function validateBrandId(value) {
  return parseId(value, 'brandId');
}

function validateBrandListQuery(query) {
  assertAllowedKeys(query, ['search', 'isActive', 'page', 'limit']);
  const pagination = parsePagination(query);
  let isActive = null;

  if (query.isActive !== undefined) {
    if (query.isActive !== 'true' && query.isActive !== 'false') {
      throw new HttpError(400, 'isActive must be true or false');
    }

    isActive = query.isActive === 'true';
  }

  return {
    ...pagination,
    search: parseSearch(query.search, 150),
    isActive,
  };
}

function validateCreateBrand(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, BRAND_FIELDS);

  for (const field of ['brandCode', 'brandName']) {
    if (!Object.hasOwn(body, field)) {
      throw new HttpError(400, `${field} is required`);
    }
  }

  return {
    brandCode: parseBrandCode(body.brandCode),
    brandName: parseString(body.brandName, 'brandName', 120),
    description:
      body.description === undefined
        ? null
        : parseOptionalString(body.description, 'description', 500),
    isActive:
      body.isActive === undefined
        ? true
        : parseBoolean(body.isActive, 'isActive'),
  };
}

function validateUpdateBrand(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, BRAND_FIELDS);
  requireAtLeastOneKey(body);

  return Object.fromEntries(
    Object.entries(body).map(([field, value]) => [
      field,
      parseBrandField(field, value),
    ]),
  );
}

export {
  validateBrandId,
  validateBrandListQuery,
  validateCreateBrand,
  validateUpdateBrand,
};
