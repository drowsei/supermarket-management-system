import {
  findBranchPackagePrice,
  listBranchPackagePriceRecords,
  putBranchPackagePriceRecord,
} from '../repositories/branchPackagePrice.repository.js';
import { rethrowDuplicateAsConflict } from '../utils/databaseError.js';
import HttpError from '../utils/httpError.js';

async function listBranchPackagePrices(branchId, filters) {
  return listBranchPackagePriceRecords(branchId, filters);
}

async function getBranchPackagePrice(branchId, packageId) {
  const result = await findBranchPackagePrice(branchId, packageId);

  if (result.outcome === 'package_not_found') {
    throw new HttpError(404, 'Product package not found');
  }

  if (result.outcome === 'configuration_not_found') {
    throw new HttpError(404, 'Branch package price configuration not found');
  }

  return result.branchPackagePrice;
}

async function putBranchPackagePrice(branchId, packageId, values, auditContext) {
  let result;

  try {
    result = await putBranchPackagePriceRecord(
      branchId,
      packageId,
      values,
      auditContext,
    );
  } catch (error) {
    rethrowDuplicateAsConflict(
      error,
      'Branch package price changed concurrently; retry the request',
    );
  }

  if (result.outcome === 'branch_not_found') {
    throw new HttpError(404, 'Branch not found');
  }

  if (result.outcome === 'package_not_found') {
    throw new HttpError(404, 'Product package not found');
  }

  return result.branchPackagePrice;
}

export {
  getBranchPackagePrice,
  listBranchPackagePrices,
  putBranchPackagePrice,
};
