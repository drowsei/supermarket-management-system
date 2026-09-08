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
  parseBoolean,
  parseBooleanQuery,
  parseCode,
  parseConversionDecimal,
  parseMoneyDecimal,
  parseOptionalIdQuery,
  parseProductStatus,
} from './common.validator.js';

const PRODUCT_PACKAGE_CREATE_FIELDS = Object.freeze([
  'packageUnitOfMeasureId',
  'packageCode',
  'packageName',
  'conversionToBaseQuantity',
  'isBaseUnit',
  'isPurchasable',
  'isSellable',
  'defaultSellingPrice',
  'status',
]);
const PRODUCT_PACKAGE_UPDATE_FIELDS = PRODUCT_PACKAGE_CREATE_FIELDS;
const EMBEDDED_BASE_PACKAGE_FIELDS = Object.freeze([
  'packageCode',
  'packageName',
  'isPurchasable',
  'isSellable',
  'defaultSellingPrice',
]);

function parseNullablePackagePrice(value) {
  return parseMoneyDecimal(value, 'defaultSellingPrice', { nullable: true });
}

function parseProductPackageField(field, value) {
  const parsers = {
    packageUnitOfMeasureId: () =>
      parseId(value, 'packageUnitOfMeasureId'),
    packageCode: () => parseCode(value, 'packageCode', 50),
    packageName: () => parseString(value, 'packageName', 120),
    conversionToBaseQuantity: () =>
      parseConversionDecimal(value, 'conversionToBaseQuantity', {
        strictlyPositive: true,
      }),
    isBaseUnit: () => parseBoolean(value, 'isBaseUnit'),
    isPurchasable: () => parseBoolean(value, 'isPurchasable'),
    isSellable: () => parseBoolean(value, 'isSellable'),
    defaultSellingPrice: () => parseNullablePackagePrice(value),
    status: () => parseProductStatus(value),
  };

  return parsers[field]();
}

function validateProductPackageId(value) {
  return parseId(value, 'packageId');
}

function validateProductPackageListQuery(query) {
  assertAllowedKeys(query, [
    'search',
    'status',
    'packageUnitOfMeasureId',
    'isBaseUnit',
    'isPurchasable',
    'isSellable',
    'page',
    'limit',
  ]);

  return {
    ...parsePagination(query),
    search: parseSearch(query.search, 120),
    status:
      query.status === undefined ? null : parseProductStatus(query.status),
    packageUnitOfMeasureId: parseOptionalIdQuery(
      query.packageUnitOfMeasureId,
      'packageUnitOfMeasureId',
    ),
    isBaseUnit: parseBooleanQuery(query.isBaseUnit, 'isBaseUnit'),
    isPurchasable: parseBooleanQuery(
      query.isPurchasable,
      'isPurchasable',
    ),
    isSellable: parseBooleanQuery(query.isSellable, 'isSellable'),
  };
}

function validateCreateProductPackage(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, PRODUCT_PACKAGE_CREATE_FIELDS);

  for (const field of [
    'packageUnitOfMeasureId',
    'packageCode',
    'packageName',
    'conversionToBaseQuantity',
  ]) {
    if (!Object.hasOwn(body, field)) {
      throw new HttpError(400, `${field} is required`);
    }
  }

  const productPackage = {
    packageUnitOfMeasureId: parseId(
      body.packageUnitOfMeasureId,
      'packageUnitOfMeasureId',
    ),
    packageCode: parseCode(body.packageCode, 'packageCode', 50),
    packageName: parseString(body.packageName, 'packageName', 120),
    conversionToBaseQuantity: parseConversionDecimal(
      body.conversionToBaseQuantity,
      'conversionToBaseQuantity',
      { strictlyPositive: true },
    ),
    isBaseUnit:
      body.isBaseUnit === undefined
        ? false
        : parseBoolean(body.isBaseUnit, 'isBaseUnit'),
    isPurchasable:
      body.isPurchasable === undefined
        ? true
        : parseBoolean(body.isPurchasable, 'isPurchasable'),
    isSellable:
      body.isSellable === undefined
        ? true
        : parseBoolean(body.isSellable, 'isSellable'),
    defaultSellingPrice:
      body.defaultSellingPrice === undefined
        ? null
        : parseNullablePackagePrice(body.defaultSellingPrice),
    status:
      body.status === undefined ? 'ACTIVE' : parseProductStatus(body.status),
  };

  return productPackage;
}

function validateUpdateProductPackage(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, PRODUCT_PACKAGE_UPDATE_FIELDS);
  requireAtLeastOneKey(body);

  return Object.fromEntries(
    Object.entries(body).map(([field, value]) => [
      field,
      parseProductPackageField(field, value),
    ]),
  );
}

function validateEmbeddedBasePackage(value) {
  assertPlainObject(value, 'basePackage');
  assertAllowedKeys(value, EMBEDDED_BASE_PACKAGE_FIELDS);

  for (const field of ['packageCode', 'packageName']) {
    if (!Object.hasOwn(value, field)) {
      throw new HttpError(400, `basePackage.${field} is required`);
    }
  }

  return {
    packageCode: parseCode(value.packageCode, 'basePackage.packageCode', 50),
    packageName: parseString(
      value.packageName,
      'basePackage.packageName',
      120,
    ),
    isPurchasable:
      value.isPurchasable === undefined
        ? true
        : parseBoolean(value.isPurchasable, 'basePackage.isPurchasable'),
    isSellable:
      value.isSellable === undefined
        ? true
        : parseBoolean(value.isSellable, 'basePackage.isSellable'),
    defaultSellingPrice:
      value.defaultSellingPrice === undefined
        ? null
        : parseMoneyDecimal(
            value.defaultSellingPrice,
            'basePackage.defaultSellingPrice',
            { nullable: true },
          ),
  };
}

export {
  validateCreateProductPackage,
  validateEmbeddedBasePackage,
  validateProductPackageId,
  validateProductPackageListQuery,
  validateUpdateProductPackage,
};
