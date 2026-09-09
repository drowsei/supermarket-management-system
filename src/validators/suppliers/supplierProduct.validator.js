import HttpError from '../../utils/httpError.js';
import {
  assertAllowedKeys,
  assertPlainObject,
  parseId,
  parsePagination,
  parseSearch,
  requireAtLeastOneKey,
} from '../admin/common.validator.js';
import {
  parseBoolean,
  parseBooleanQuery,
  parseOptionalIdQuery,
  parseSupplierCode,
  parseSupplierQuantity,
  parseUnsignedSmallInteger,
} from './common.validator.js';

const CREATE_FIELDS = Object.freeze([
  'productVariantId',
  'supplierSku',
  'isPreferred',
  'leadTimeDays',
  'minimumOrderQuantity',
]);
const UPDATE_FIELDS = Object.freeze([
  'supplierSku',
  'isPreferred',
  'leadTimeDays',
  'minimumOrderQuantity',
]);

function parseSupplierProductField(field, value) {
  const parsers = {
    supplierSku: () =>
      value === null
        ? null
        : parseSupplierCode(value, 'supplierSku', 100),
    isPreferred: () => parseBoolean(value, 'isPreferred'),
    leadTimeDays: () =>
      parseUnsignedSmallInteger(value, 'leadTimeDays', { nullable: true }),
    minimumOrderQuantity: () =>
      parseSupplierQuantity(value, 'minimumOrderQuantity'),
  };

  return parsers[field]();
}

function validateSupplierProductId(value) {
  return parseId(value, 'supplierProductId');
}

function validateSupplierProductListQuery(query) {
  assertAllowedKeys(query, [
    'search',
    'productVariantId',
    'isPreferred',
    'page',
    'limit',
  ]);

  return {
    ...parsePagination(query),
    search: parseSearch(query.search, 180),
    productVariantId: parseOptionalIdQuery(
      query.productVariantId,
      'productVariantId',
    ),
    isPreferred: parseBooleanQuery(query.isPreferred, 'isPreferred'),
  };
}

function validateCreateSupplierProduct(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, CREATE_FIELDS);

  if (!Object.hasOwn(body, 'productVariantId')) {
    throw new HttpError(400, 'productVariantId is required');
  }

  return {
    productVariantId: parseId(body.productVariantId, 'productVariantId'),
    supplierSku:
      body.supplierSku === undefined
        ? null
        : parseSupplierProductField('supplierSku', body.supplierSku),
    isPreferred:
      body.isPreferred === undefined
        ? false
        : parseSupplierProductField('isPreferred', body.isPreferred),
    leadTimeDays:
      body.leadTimeDays === undefined
        ? null
        : parseSupplierProductField('leadTimeDays', body.leadTimeDays),
    minimumOrderQuantity:
      body.minimumOrderQuantity === undefined
        ? '1.000'
        : parseSupplierProductField(
            'minimumOrderQuantity',
            body.minimumOrderQuantity,
          ),
  };
}

function validateUpdateSupplierProduct(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, UPDATE_FIELDS);
  requireAtLeastOneKey(body);

  return Object.fromEntries(
    Object.entries(body).map(([field, value]) => [
      field,
      parseSupplierProductField(field, value),
    ]),
  );
}

export {
  validateCreateSupplierProduct,
  validateSupplierProductId,
  validateSupplierProductListQuery,
  validateUpdateSupplierProduct,
};
