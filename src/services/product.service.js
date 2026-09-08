import {
  createProductRecord,
  findProductById,
  listProducts as listProductRecords,
  updateProductRecord,
} from '../repositories/product.repository.js';
import { rethrowDuplicateAsConflict } from '../utils/databaseError.js';
import HttpError from '../utils/httpError.js';

function throwProductOutcomeError(outcome) {
  const errors = {
    category_not_found: [404, 'Category not found'],
    brand_not_found: [404, 'Brand not found'],
    tax_rate_not_found: [404, 'Tax rate not found'],
    inactive_category: [
      409,
      'An active product requires an active category',
    ],
    inactive_brand: [409, 'An active product requires an active brand'],
    inactive_tax_rate: [
      409,
      'An active product requires an active tax rate',
    ],
    active_variant_dependency: [
      409,
      'Product cannot be deactivated or discontinued while it has an active variant',
    ],
    concurrent_reference_change: [
      409,
      'Product references changed concurrently; reload and try again',
    ],
  };
  const error = errors[outcome];

  if (!error) {
    throw new Error('The product repository returned an unknown outcome.');
  }

  throw new HttpError(...error);
}

async function listProducts(filters) {
  return listProductRecords(filters);
}

async function getProduct(productId) {
  const product = await findProductById(productId);

  if (!product) {
    throw new HttpError(404, 'Product not found');
  }

  return product;
}

async function createProduct(values, auditContext) {
  let result;

  try {
    result = await createProductRecord(values, auditContext);
  } catch (error) {
    rethrowDuplicateAsConflict(error, 'Product code already exists');
  }

  if (result.outcome === 'created') {
    return result.product;
  }

  return throwProductOutcomeError(result.outcome);
}

async function updateProduct(productId, changes, auditContext) {
  let result;

  try {
    result = await updateProductRecord(productId, changes, auditContext);
  } catch (error) {
    rethrowDuplicateAsConflict(error, 'Product code already exists');
  }

  if (result.outcome === 'not_found') {
    throw new HttpError(404, 'Product not found');
  }

  if (result.outcome === 'updated' || result.outcome === 'unchanged') {
    return result.product;
  }

  return throwProductOutcomeError(result.outcome);
}

export { createProduct, getProduct, listProducts, updateProduct };
