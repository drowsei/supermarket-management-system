import {
  createProductVariantRecord,
  findProductVariantById,
  listProductVariants as listProductVariantRecords,
  updateProductVariantRecord,
} from '../repositories/productVariant.repository.js';
import { rethrowDuplicateAsConflict } from '../utils/databaseError.js';
import HttpError from '../utils/httpError.js';

function throwVariantOutcomeError(outcome) {
  const errors = {
    product_not_found: [404, 'Product not found'],
    unit_not_found: [404, 'Unit of measure not found'],
    fractional_unit_conflict: [
      409,
      'A fractional variant requires a unit of measure that allows fractions',
    ],
    invalid_lot_configuration: [
      409,
      'Expiry tracking requires OPTIONAL or REQUIRED lot tracking',
    ],
    inactive_parent_product: [
      409,
      'An active variant requires an active parent product',
    ],
    missing_active_base_package: [
      409,
      'An active variant requires exactly one active base package',
    ],
    established_base_unit: [
      409,
      'The base unit cannot be changed after package or operational use',
    ],
    established_lot_configuration: [
      409,
      'Lot configuration cannot be changed after operational inventory history exists',
    ],
    concurrent_unit_change: [
      409,
      'Variant unit changed concurrently; reload and try again',
    ],
  };
  const error = errors[outcome];

  if (!error) {
    throw new Error('The product-variant repository returned an unknown outcome.');
  }

  throw new HttpError(...error);
}

async function listProductVariants(productId, filters) {
  const result = await listProductVariantRecords(productId, filters);

  if (result.outcome === 'product_not_found') {
    throw new HttpError(404, 'Product not found');
  }

  return { items: result.items, totalItems: result.totalItems };
}

async function getProductVariant(variantId) {
  const productVariant = await findProductVariantById(variantId);

  if (!productVariant) {
    throw new HttpError(404, 'Product variant not found');
  }

  return productVariant;
}

async function createProductVariant(productId, values, auditContext) {
  let result;

  try {
    result = await createProductVariantRecord(
      productId,
      values,
      auditContext,
    );
  } catch (error) {
    rethrowDuplicateAsConflict(
      error,
      'SKU, variant name, or base package code already exists',
    );
  }

  if (result.outcome === 'created') {
    return result.productVariant;
  }

  return throwVariantOutcomeError(result.outcome);
}

async function updateProductVariant(
  variantId,
  changes,
  auditContext,
) {
  let result;

  try {
    result = await updateProductVariantRecord(
      variantId,
      changes,
      auditContext,
    );
  } catch (error) {
    rethrowDuplicateAsConflict(
      error,
      'SKU or variant name already exists',
    );
  }

  if (result.outcome === 'not_found') {
    throw new HttpError(404, 'Product variant not found');
  }

  if (result.outcome === 'updated' || result.outcome === 'unchanged') {
    return result.productVariant;
  }

  return throwVariantOutcomeError(result.outcome);
}

export {
  createProductVariant,
  getProductVariant,
  listProductVariants,
  updateProductVariant,
};
