import {
  createSupplierProductRecord,
  findSupplierProduct,
  listSupplierProducts as listSupplierProductRecords,
  updateSupplierProductRecord,
} from '../repositories/supplierProduct.repository.js';
import { rethrowDuplicateAsConflict } from '../utils/databaseError.js';
import HttpError from '../utils/httpError.js';

function throwSupplierProductOutcome(outcome) {
  const errors = {
    supplier_not_found: [404, 'Supplier not found'],
    variant_not_found: [404, 'Product variant not found'],
    not_found: [404, 'Supplier product relationship not found'],
    duplicate_relationship: [409, 'Supplier product relationship already exists'],
    preferred_conflict: [409, 'The product variant already has a preferred supplier'],
    inactive_catalog_identity: [
      409,
      'New or preferred supplier relationships require an active supplier, product, and variant',
    ],
  };
  const error = errors[outcome];

  if (!error) {
    throw new Error('The supplier-product repository returned an unknown outcome.');
  }

  throw new HttpError(...error);
}

async function listSupplierProducts(supplierId, filters) {
  const result = await listSupplierProductRecords(supplierId, filters);

  if (result.outcome !== 'found') {
    return throwSupplierProductOutcome(result.outcome);
  }

  return { items: result.items, totalItems: result.totalItems };
}

async function getSupplierProduct(supplierId, productVariantId) {
  const result = await findSupplierProduct(supplierId, productVariantId);

  if (result.outcome !== 'found') {
    return throwSupplierProductOutcome(result.outcome);
  }

  return result.supplierProduct;
}

async function createSupplierProduct(supplierId, values, auditContext) {
  let result;

  try {
    result = await createSupplierProductRecord(
      supplierId,
      values,
      auditContext,
    );
  } catch (error) {
    rethrowDuplicateAsConflict(
      error,
      'Supplier relationship, supplier SKU, or preferred supplier already exists',
    );
  }

  if (result.outcome !== 'created') {
    return throwSupplierProductOutcome(result.outcome);
  }

  return result.supplierProduct;
}

async function updateSupplierProduct(
  supplierId,
  productVariantId,
  changes,
  auditContext,
) {
  let result;

  try {
    result = await updateSupplierProductRecord(
      supplierId,
      productVariantId,
      changes,
      auditContext,
    );
  } catch (error) {
    rethrowDuplicateAsConflict(
      error,
      'Supplier SKU or preferred supplier already exists',
    );
  }

  if (!['updated', 'unchanged'].includes(result.outcome)) {
    return throwSupplierProductOutcome(result.outcome);
  }

  return result.supplierProduct;
}

export {
  createSupplierProduct,
  getSupplierProduct,
  listSupplierProducts,
  updateSupplierProduct,
};
