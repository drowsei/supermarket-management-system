import {
  createSupplierProductPackageRecord,
  findSupplierProductPackage,
  listSupplierProductPackages as listSupplierProductPackageRecords,
  updateSupplierProductPackageRecord,
} from '../repositories/supplierProductPackage.repository.js';
import { rethrowDuplicateAsConflict } from '../utils/databaseError.js';
import HttpError from '../utils/httpError.js';

function throwSupplierPackageOutcome(outcome) {
  const errors = {
    supplier_not_found: [404, 'Supplier not found'],
    supplier_product_not_found: [
      404,
      'Supplier product relationship not found',
    ],
    package_not_found: [404, 'Product package not found'],
    not_found: [404, 'Supplier product package relationship not found'],
    package_variant_mismatch: [
      409,
      'Product package does not belong to the supplier product variant',
    ],
    duplicate_relationship: [
      409,
      'Supplier product package relationship already exists',
    ],
    inactive_catalog_identity: [
      409,
      'An active supplier package requires an active supplier, product, variant, and purchasable package',
    ],
  };
  const error = errors[outcome];

  if (!error) {
    throw new Error('The supplier-package repository returned an unknown outcome.');
  }

  throw new HttpError(...error);
}

async function listSupplierProductPackages(
  supplierId,
  productVariantId,
  filters,
) {
  const result = await listSupplierProductPackageRecords(
    supplierId,
    productVariantId,
    filters,
  );

  if (result.outcome !== 'found') {
    return throwSupplierPackageOutcome(result.outcome);
  }

  return { items: result.items, totalItems: result.totalItems };
}

async function getSupplierProductPackage(supplierId, productPackageId) {
  const result = await findSupplierProductPackage(supplierId, productPackageId);

  if (result.outcome !== 'found') {
    return throwSupplierPackageOutcome(result.outcome);
  }

  return result.supplierProductPackage;
}

async function createSupplierProductPackage(
  supplierId,
  productVariantId,
  values,
  auditContext,
) {
  let result;

  try {
    result = await createSupplierProductPackageRecord(
      supplierId,
      productVariantId,
      values,
      auditContext,
    );
  } catch (error) {
    rethrowDuplicateAsConflict(
      error,
      'Supplier package relationship or supplier package SKU already exists',
    );
  }

  if (result.outcome !== 'created') {
    return throwSupplierPackageOutcome(result.outcome);
  }

  return result.supplierProductPackage;
}

async function updateSupplierProductPackage(
  supplierId,
  productPackageId,
  changes,
  auditContext,
) {
  let result;

  try {
    result = await updateSupplierProductPackageRecord(
      supplierId,
      productPackageId,
      changes,
      auditContext,
    );
  } catch (error) {
    rethrowDuplicateAsConflict(
      error,
      'Supplier package SKU already exists for this supplier',
    );
  }

  if (!['updated', 'unchanged'].includes(result.outcome)) {
    return throwSupplierPackageOutcome(result.outcome);
  }

  return result.supplierProductPackage;
}

export {
  createSupplierProductPackage,
  getSupplierProductPackage,
  listSupplierProductPackages,
  updateSupplierProductPackage,
};
