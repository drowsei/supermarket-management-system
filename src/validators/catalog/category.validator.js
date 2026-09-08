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

const CATEGORY_FIELDS = [
  'parentCategoryId',
  'categoryCode',
  'categoryName',
  'description',
  'isActive',
];

function parseCategoryCode(value) {
  return parseString(value, 'categoryCode', 50, {
    normalize: (input) => input.toUpperCase(),
  });
}

function parseParentCategoryId(value) {
  return parseId(value, 'parentCategoryId', { nullable: true });
}

function parseCategoryField(field, value) {
  const parsers = {
    parentCategoryId: () => parseParentCategoryId(value),
    categoryCode: () => parseCategoryCode(value),
    categoryName: () => parseString(value, 'categoryName', 120),
    description: () => parseOptionalString(value, 'description', 500),
    isActive: () => parseBoolean(value, 'isActive'),
  };

  return parsers[field]();
}

function validateCreateCategory(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, CATEGORY_FIELDS);

  for (const field of ['categoryCode', 'categoryName']) {
    if (!Object.hasOwn(body, field)) {
      throw new HttpError(400, `${field} is required`);
    }
  }

  return {
    parentCategoryId:
      body.parentCategoryId === undefined
        ? null
        : parseParentCategoryId(body.parentCategoryId),
    categoryCode: parseCategoryCode(body.categoryCode),
    categoryName: parseString(body.categoryName, 'categoryName', 120),
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

function validateUpdateCategory(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, CATEGORY_FIELDS);
  requireAtLeastOneKey(body);

  return Object.fromEntries(
    Object.entries(body).map(([field, value]) => [
      field,
      parseCategoryField(field, value),
    ]),
  );
}

function validateCategoryListQuery(query) {
  assertAllowedKeys(query, [
    'search',
    'isActive',
    'parentCategoryId',
    'page',
    'limit',
  ]);

  let isActive = null;

  if (query.isActive !== undefined) {
    if (query.isActive !== 'true' && query.isActive !== 'false') {
      throw new HttpError(400, 'isActive must be true or false');
    }

    isActive = query.isActive === 'true';
  }

  let parentCategoryId;

  if (query.parentCategoryId === 'null') {
    parentCategoryId = null;
  } else if (query.parentCategoryId !== undefined) {
    parentCategoryId = parseId(
      query.parentCategoryId,
      'parentCategoryId',
    );
  }

  return {
    ...parsePagination(query),
    search: parseSearch(query.search, 150),
    isActive,
    parentCategoryId,
  };
}

function validateCategoryId(value) {
  return parseId(value, 'categoryId');
}

export {
  validateCategoryId,
  validateCategoryListQuery,
  validateCreateCategory,
  validateUpdateCategory,
};
