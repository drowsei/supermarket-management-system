import {
  createProductPackageRecord,
  findProductPackageById,
  listProductPackages as listProductPackageRecords,
  updateProductPackageRecord,
} from '../repositories/productPackage.repository.js';
import { rethrowDuplicateAsConflict } from '../utils/databaseError.js';
import HttpError from '../utils/httpError.js';

function throwPackageOutcomeError(outcome) {
  const errors = {
    variant_not_found: [404, 'Product variant not found'],
    unit_not_found: [404, 'Unit of measure not found'],
    invalid_base_conversion: [
      409,
      'A base package must have a conversion of 1.000000',
    ],
    invalid_base_unit: [
      409,
      'A base package must use the variant base unit',
    ],
    active_base_invariant: [
      409,
      'An active variant requires exactly one active base package',
    ],
    established_package_identity: [
      409,
      'Package unit, conversion, and base designation cannot change after downstream use',
    ],
    concurrent_unit_change: [
      409,
      'Package or variant unit changed concurrently; reload and try again',
    ],
  };
  const error = errors[outcome];

  if (!error) {
    throw new Error('The product-package repository returned an unknown outcome.');
  }

  throw new HttpError(...error);
}

async function listProductPackages(productVariantId, filters) {
  const result = await listProductPackageRecords(productVariantId, filters);

  if (result.outcome === 'variant_not_found') {
    throw new HttpError(404, 'Product variant not found');
  }

  return { items: result.items, totalItems: result.totalItems };
}

async function getProductPackage(productPackageId) {
  const productPackage = await findProductPackageById(productPackageId);

  if (!productPackage) {
    throw new HttpError(404, 'Product package not found');
  }

  return productPackage;
}

async function createProductPackage(
  productVariantId,
  values,
  auditContext,
) {
  let result;

  try {
    result = await createProductPackageRecord(
      productVariantId,
      values,
      auditContext,
    );
  } catch (error) {
    rethrowDuplicateAsConflict(
      error,
      'Package code or active base-package configuration already exists',
    );
  }

  if (result.outcome === 'created') {
    return result.productPackage;
  }

  return throwPackageOutcomeError(result.outcome);
}

async function updateProductPackage(
  productPackageId,
  changes,
  auditContext,
) {
  let result;

  try {
    result = await updateProductPackageRecord(
      productPackageId,
      changes,
      auditContext,
    );
  } catch (error) {
    rethrowDuplicateAsConflict(
      error,
      'Package code or active base-package configuration already exists',
    );
  }

  if (result.outcome === 'not_found') {
    throw new HttpError(404, 'Product package not found');
  }

  if (result.outcome === 'updated' || result.outcome === 'unchanged') {
    return result.productPackage;
  }

  return throwPackageOutcomeError(result.outcome);
}

export {
  createProductPackage,
  getProductPackage,
  listProductPackages,
  updateProductPackage,
};
