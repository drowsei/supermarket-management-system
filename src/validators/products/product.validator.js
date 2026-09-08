import HttpError from '../../utils/httpError.js';
import {
  assertAllowedKeys,
  assertPlainObject,
  parseId,
  parsePagination,
  parseSearch,
  parseString,
  requireAtLeastOneKey,
} from '../admin/common.validator.js';
import {
  parseCode,
  parseNullableIdQuery,
  parseNullableText,
  parseOptionalIdQuery,
  parseProductStatus,
} from './common.validator.js';

const PRODUCT_FIELDS = Object.freeze([
  'categoryId',
  'brandId',
  'taxRateId',
  'productCode',
  'productName',
  'description',
  'status',
]);

function parseNullableId(value, label) {
  return parseId(value, label, { nullable: true });
}

function parseProductField(field, value) {
  const parsers = {
    categoryId: () => parseId(value, 'categoryId'),
    brandId: () => parseNullableId(value, 'brandId'),
    taxRateId: () => parseNullableId(value, 'taxRateId'),
    productCode: () => parseCode(value, 'productCode', 50),
    productName: () => parseString(value, 'productName', 180),
    description: () => parseNullableText(value, 'description'),
    status: () => parseProductStatus(value),
  };

  return parsers[field]();
}

function validateProductId(value) {
  return parseId(value, 'productId');
}

function validateProductListQuery(query) {
  assertAllowedKeys(query, [
    'search',
    'status',
    'categoryId',
    'brandId',
    'taxRateId',
    'page',
    'limit',
  ]);

  return {
    ...parsePagination(query),
    search: parseSearch(query.search, 180),
    status:
      query.status === undefined ? null : parseProductStatus(query.status),
    categoryId: parseOptionalIdQuery(query.categoryId, 'categoryId'),
    // Undefined means no filter; null means SQL IS NULL.
    brandId: parseNullableIdQuery(query.brandId, 'brandId'),
    taxRateId: parseNullableIdQuery(query.taxRateId, 'taxRateId'),
  };
}

function validateCreateProduct(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, PRODUCT_FIELDS);

  for (const field of ['categoryId', 'productCode', 'productName']) {
    if (!Object.hasOwn(body, field)) {
      throw new HttpError(400, `${field} is required`);
    }
  }

  return {
    categoryId: parseId(body.categoryId, 'categoryId'),
    brandId:
      body.brandId === undefined
        ? null
        : parseNullableId(body.brandId, 'brandId'),
    taxRateId:
      body.taxRateId === undefined
        ? null
        : parseNullableId(body.taxRateId, 'taxRateId'),
    productCode: parseCode(body.productCode, 'productCode', 50),
    productName: parseString(body.productName, 'productName', 180),
    description:
      body.description === undefined
        ? null
        : parseNullableText(body.description, 'description'),
    status:
      body.status === undefined ? 'ACTIVE' : parseProductStatus(body.status),
  };
}

function validateUpdateProduct(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, PRODUCT_FIELDS);
  requireAtLeastOneKey(body);

  return Object.fromEntries(
    Object.entries(body).map(([field, value]) => [
      field,
      parseProductField(field, value),
    ]),
  );
}

export {
  validateCreateProduct,
  validateProductId,
  validateProductListQuery,
  validateUpdateProduct,
};
