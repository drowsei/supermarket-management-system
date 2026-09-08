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
  parseLotTrackingMode,
  parseMoneyDecimal,
  parseOptionalIdQuery,
  parseProductStatus,
  parseSizeDecimal,
} from './common.validator.js';
import { validateEmbeddedBasePackage } from './productPackage.validator.js';

const PRODUCT_VARIANT_CREATE_FIELDS = Object.freeze([
  'unitOfMeasureId',
  'sku',
  'variantName',
  'sizeValue',
  'unitsPerPack',
  'isFractional',
  'lotTrackingMode',
  'requiresExpiryDate',
  'defaultSellingPrice',
  'status',
  'basePackage',
]);
const PRODUCT_VARIANT_UPDATE_FIELDS = Object.freeze(
  PRODUCT_VARIANT_CREATE_FIELDS.filter((field) => field !== 'basePackage'),
);

function parseNullableSize(value) {
  return parseSizeDecimal(value, 'sizeValue', {
    nullable: true,
    strictlyPositive: true,
  });
}

function parseProductVariantField(field, value) {
  const parsers = {
    unitOfMeasureId: () => parseId(value, 'unitOfMeasureId'),
    sku: () => parseCode(value, 'sku', 64),
    variantName: () => parseString(value, 'variantName', 120),
    sizeValue: () => parseNullableSize(value),
    unitsPerPack: () =>
      parseSizeDecimal(value, 'unitsPerPack', { strictlyPositive: true }),
    isFractional: () => parseBoolean(value, 'isFractional'),
    lotTrackingMode: () => parseLotTrackingMode(value),
    requiresExpiryDate: () =>
      parseBoolean(value, 'requiresExpiryDate'),
    defaultSellingPrice: () =>
      parseMoneyDecimal(value, 'defaultSellingPrice'),
    status: () => parseProductStatus(value),
  };

  return parsers[field]();
}

function assertCompatibleLotFields(values) {
  if (
    values.requiresExpiryDate === true &&
    values.lotTrackingMode === 'NONE'
  ) {
    throw new HttpError(
      400,
      'requiresExpiryDate requires lotTrackingMode OPTIONAL or REQUIRED',
    );
  }
}

function validateVariantId(value) {
  return parseId(value, 'variantId');
}

function validateProductVariantListQuery(query) {
  assertAllowedKeys(query, [
    'search',
    'status',
    'unitOfMeasureId',
    'isFractional',
    'lotTrackingMode',
    'requiresExpiryDate',
    'page',
    'limit',
  ]);

  return {
    ...parsePagination(query),
    search: parseSearch(query.search, 120),
    status:
      query.status === undefined ? null : parseProductStatus(query.status),
    unitOfMeasureId: parseOptionalIdQuery(
      query.unitOfMeasureId,
      'unitOfMeasureId',
    ),
    isFractional: parseBooleanQuery(query.isFractional, 'isFractional'),
    lotTrackingMode:
      query.lotTrackingMode === undefined
        ? null
        : parseLotTrackingMode(query.lotTrackingMode),
    requiresExpiryDate: parseBooleanQuery(
      query.requiresExpiryDate,
      'requiresExpiryDate',
    ),
  };
}

function validateCreateProductVariant(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, PRODUCT_VARIANT_CREATE_FIELDS);

  for (const field of [
    'unitOfMeasureId',
    'sku',
    'variantName',
    'defaultSellingPrice',
  ]) {
    if (!Object.hasOwn(body, field)) {
      throw new HttpError(400, `${field} is required`);
    }
  }

  const status =
    body.status === undefined ? 'ACTIVE' : parseProductStatus(body.status);

  if (status === 'ACTIVE' && !Object.hasOwn(body, 'basePackage')) {
    throw new HttpError(
      400,
      'basePackage is required when creating an ACTIVE variant',
    );
  }

  const productVariant = {
    unitOfMeasureId: parseId(body.unitOfMeasureId, 'unitOfMeasureId'),
    sku: parseCode(body.sku, 'sku', 64),
    variantName: parseString(body.variantName, 'variantName', 120),
    sizeValue:
      body.sizeValue === undefined ? null : parseNullableSize(body.sizeValue),
    unitsPerPack:
      body.unitsPerPack === undefined
        ? '1.000'
        : parseSizeDecimal(body.unitsPerPack, 'unitsPerPack', {
            strictlyPositive: true,
          }),
    isFractional:
      body.isFractional === undefined
        ? false
        : parseBoolean(body.isFractional, 'isFractional'),
    lotTrackingMode:
      body.lotTrackingMode === undefined
        ? 'NONE'
        : parseLotTrackingMode(body.lotTrackingMode),
    requiresExpiryDate:
      body.requiresExpiryDate === undefined
        ? false
        : parseBoolean(body.requiresExpiryDate, 'requiresExpiryDate'),
    defaultSellingPrice: parseMoneyDecimal(
      body.defaultSellingPrice,
      'defaultSellingPrice',
    ),
    status,
    basePackage:
      body.basePackage === undefined
        ? null
        : validateEmbeddedBasePackage(body.basePackage),
  };

  assertCompatibleLotFields(productVariant);
  return productVariant;
}

function validateUpdateProductVariant(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, PRODUCT_VARIANT_UPDATE_FIELDS);
  requireAtLeastOneKey(body);

  const changes = Object.fromEntries(
    Object.entries(body).map(([field, value]) => [
      field,
      parseProductVariantField(field, value),
    ]),
  );

  // Full resulting-state validation still belongs in the service because one
  // half of this pair may be omitted from PATCH.
  assertCompatibleLotFields(changes);
  return changes;
}

export {
  validateCreateProductVariant,
  validateProductVariantListQuery,
  validateUpdateProductVariant,
  validateVariantId,
};
