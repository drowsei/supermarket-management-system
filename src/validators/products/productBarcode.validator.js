import HttpError from '../../utils/httpError.js';
import { barcodeValidationMessage } from '../../utils/barcode.js';
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
  parseBarcodeType,
  parseBoolean,
  parseBooleanQuery,
  parseNullableIdQuery,
} from './common.validator.js';

const PRODUCT_BARCODE_FIELDS = Object.freeze([
  'productPackageId',
  'barcode',
  'barcodeType',
  'isPrimary',
]);

function parseNullablePackageId(value) {
  return parseId(value, 'productPackageId', { nullable: true });
}

function parseBarcode(value) {
  return parseString(value, 'barcode', 64);
}

function parseExactBarcode(value) {
  if (typeof value !== 'string') {
    throw new HttpError(400, 'barcode must be a string');
  }

  if (value.trim().length === 0) {
    throw new HttpError(400, 'barcode is required');
  }

  if ([...value].length > 64) {
    throw new HttpError(400, 'barcode must not exceed 64 characters');
  }

  return value;
}

function assertBarcodeFormat(barcode, barcodeType) {
  const message = barcodeValidationMessage(barcode, barcodeType);

  if (message) {
    throw new HttpError(400, message);
  }
}

function parseProductBarcodeField(field, value) {
  const parsers = {
    productPackageId: () => parseNullablePackageId(value),
    barcode: () => parseBarcode(value),
    barcodeType: () => parseBarcodeType(value),
    isPrimary: () => parseBoolean(value, 'isPrimary'),
  };

  return parsers[field]();
}

function validateBarcodeId(value) {
  return parseId(value, 'barcodeId');
}

function validateProductBarcodeListQuery(query) {
  assertAllowedKeys(query, [
    'search',
    'barcodeType',
    'productPackageId',
    'isPrimary',
    'page',
    'limit',
  ]);

  return {
    ...parsePagination(query),
    search: parseSearch(query.search, 64),
    barcodeType:
      query.barcodeType === undefined
        ? null
        : parseBarcodeType(query.barcodeType),
    productPackageId: parseNullableIdQuery(
      query.productPackageId,
      'productPackageId',
    ),
    isPrimary: parseBooleanQuery(query.isPrimary, 'isPrimary'),
  };
}

function validateProductBarcodeLookupQuery(query) {
  assertAllowedKeys(query, ['barcode']);

  if (!Object.hasOwn(query, 'barcode')) {
    throw new HttpError(400, 'barcode is required');
  }

  return { barcode: parseExactBarcode(query.barcode) };
}

function validateCreateProductBarcode(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, PRODUCT_BARCODE_FIELDS);

  if (!Object.hasOwn(body, 'barcode')) {
    throw new HttpError(400, 'barcode is required');
  }

  const productBarcode = {
    productPackageId:
      body.productPackageId === undefined
        ? null
        : parseNullablePackageId(body.productPackageId),
    barcode: parseBarcode(body.barcode),
    barcodeType:
      body.barcodeType === undefined
        ? 'OTHER'
        : parseBarcodeType(body.barcodeType),
    isPrimary:
      body.isPrimary === undefined
        ? false
        : parseBoolean(body.isPrimary, 'isPrimary'),
  };

  assertBarcodeFormat(productBarcode.barcode, productBarcode.barcodeType);
  return productBarcode;
}

function validateUpdateProductBarcode(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, PRODUCT_BARCODE_FIELDS);
  requireAtLeastOneKey(body);

  const changes = Object.fromEntries(
    Object.entries(body).map(([field, value]) => [
      field,
      parseProductBarcodeField(field, value),
    ]),
  );

  if (
    Object.hasOwn(changes, 'barcode') &&
    Object.hasOwn(changes, 'barcodeType')
  ) {
    assertBarcodeFormat(changes.barcode, changes.barcodeType);
  }

  return changes;
}

export {
  assertBarcodeFormat,
  validateBarcodeId,
  validateCreateProductBarcode,
  validateProductBarcodeLookupQuery,
  validateProductBarcodeListQuery,
  validateUpdateProductBarcode,
};
