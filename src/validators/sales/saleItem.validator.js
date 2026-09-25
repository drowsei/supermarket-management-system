import HttpError from '../../utils/httpError.js';
import { requireAtLeastOneKey } from '../admin/common.validator.js';
import {
  assertAllowedKeys,
  assertPlainObject,
  parseMoney,
  parseNullableSalesId,
  parseQuantity,
  parseSalesId,
} from './common.validator.js';

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

function validateSaleItemId(value) {
  return parseSalesId(value, 'saleItemId');
}

function validateCreateSaleItem(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, [
    'barcode',
    'productVariantId',
    'productPackageId',
    'quantity',
    'discountAmount',
  ]);

  if (!Object.hasOwn(body, 'quantity')) {
    throw new HttpError(400, 'quantity is required');
  }

  const hasBarcode = Object.hasOwn(body, 'barcode');
  const hasVariant = Object.hasOwn(body, 'productVariantId');
  const hasPackage = Object.hasOwn(body, 'productPackageId');

  if (hasBarcode === hasVariant || (hasBarcode && hasPackage)) {
    throw new HttpError(
      400,
      'Supply exactly one item identity mode: barcode or productVariantId',
    );
  }

  return {
    mode: hasBarcode ? 'BARCODE' : 'EXPLICIT',
    barcode: hasBarcode ? parseExactBarcode(body.barcode) : null,
    productVariantId: hasVariant
      ? parseSalesId(body.productVariantId, 'productVariantId')
      : null,
    productPackageId:
      hasVariant && hasPackage
        ? parseNullableSalesId(body.productPackageId, 'productPackageId')
        : null,
    quantity: parseQuantity(body.quantity),
    discountAmount:
      body.discountAmount === undefined
        ? '0.00'
        : parseMoney(body.discountAmount, 'discountAmount'),
  };
}

function validateUpdateSaleItem(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, ['quantity', 'discountAmount']);
  requireAtLeastOneKey(body);

  const values = {};
  if (Object.hasOwn(body, 'quantity')) {
    values.quantity = parseQuantity(body.quantity);
  }
  if (Object.hasOwn(body, 'discountAmount')) {
    values.discountAmount = parseMoney(body.discountAmount, 'discountAmount');
  }
  return values;
}

export {
  validateCreateSaleItem,
  validateSaleItemId,
  validateUpdateSaleItem,
};
