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
} from './common.validator.js';

const CREATE_FIELDS = Object.freeze([
  'productPackageId',
  'supplierPackageSku',
  'minimumPackageQuantity',
  'isActive',
]);
const UPDATE_FIELDS = Object.freeze([
  'supplierPackageSku',
  'minimumPackageQuantity',
  'isActive',
]);

function parseSupplierPackageField(field, value) {
  const parsers = {
    supplierPackageSku: () =>
      value === null
        ? null
        : parseSupplierCode(value, 'supplierPackageSku', 100),
    minimumPackageQuantity: () =>
      parseSupplierQuantity(value, 'minimumPackageQuantity'),
    isActive: () => parseBoolean(value, 'isActive'),
  };

  return parsers[field]();
}

function validateSupplierProductPackageId(value) {
  return parseId(value, 'supplierProductPackageId');
}

function validateSupplierProductPackageListQuery(query) {
  assertAllowedKeys(query, [
    'search',
    'productPackageId',
    'isActive',
    'page',
    'limit',
  ]);

  return {
    ...parsePagination(query),
    search: parseSearch(query.search, 180),
    productPackageId: parseOptionalIdQuery(
      query.productPackageId,
      'productPackageId',
    ),
    isActive: parseBooleanQuery(query.isActive, 'isActive'),
  };
}

function validateCreateSupplierProductPackage(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, CREATE_FIELDS);

  if (!Object.hasOwn(body, 'productPackageId')) {
    throw new HttpError(400, 'productPackageId is required');
  }

  return {
    productPackageId: parseId(body.productPackageId, 'productPackageId'),
    supplierPackageSku:
      body.supplierPackageSku === undefined
        ? null
        : parseSupplierPackageField(
            'supplierPackageSku',
            body.supplierPackageSku,
          ),
    minimumPackageQuantity:
      body.minimumPackageQuantity === undefined
        ? '1.000'
        : parseSupplierPackageField(
            'minimumPackageQuantity',
            body.minimumPackageQuantity,
          ),
    isActive:
      body.isActive === undefined
        ? true
        : parseSupplierPackageField('isActive', body.isActive),
  };
}

function validateUpdateSupplierProductPackage(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, UPDATE_FIELDS);
  requireAtLeastOneKey(body);

  return Object.fromEntries(
    Object.entries(body).map(([field, value]) => [
      field,
      parseSupplierPackageField(field, value),
    ]),
  );
}

export {
  validateCreateSupplierProductPackage,
  validateSupplierProductPackageId,
  validateSupplierProductPackageListQuery,
  validateUpdateSupplierProductPackage,
};
