import {
  findBranchVariantPrice,
  listBranchVariantPriceRecords,
  putBranchVariantPriceRecord,
} from '../repositories/branchVariantPrice.repository.js';
import { rethrowDuplicateAsConflict } from '../utils/databaseError.js';
import HttpError from '../utils/httpError.js';

async function listBranchVariantPrices(branchId, filters) {
  return listBranchVariantPriceRecords(branchId, filters);
}

async function getBranchVariantPrice(branchId, variantId) {
  const result = await findBranchVariantPrice(branchId, variantId);

  if (result.outcome === 'variant_not_found') {
    throw new HttpError(404, 'Product variant not found');
  }

  if (result.outcome === 'configuration_not_found') {
    throw new HttpError(404, 'Branch variant price configuration not found');
  }

  return result.branchVariantPrice;
}

async function putBranchVariantPrice(branchId, variantId, values, auditContext) {
  let result;

  try {
    result = await putBranchVariantPriceRecord(
      branchId,
      variantId,
      values,
      auditContext,
    );
  } catch (error) {
    rethrowDuplicateAsConflict(
      error,
      'Branch variant price changed concurrently; retry the request',
    );
  }

  if (result.outcome === 'branch_not_found') {
    throw new HttpError(404, 'Branch not found');
  }

  if (result.outcome === 'variant_not_found') {
    throw new HttpError(404, 'Product variant not found');
  }

  return result.branchVariantPrice;
}

export {
  getBranchVariantPrice,
  listBranchVariantPrices,
  putBranchVariantPrice,
};
