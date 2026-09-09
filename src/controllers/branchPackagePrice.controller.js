import {
  getBranchPackagePrice,
  listBranchPackagePrices,
  putBranchPackagePrice,
} from '../services/branchPackagePrice.service.js';
import { getAuditContext } from '../utils/auditContext.js';
import { paginationMetadata } from '../validators/admin/common.validator.js';
import {
  validateBranchPackagePriceListQuery,
  validateBranchPackagePriceWrite,
  validateNoPricingQuery,
  validatePricingPackageId,
} from '../validators/pricing/branchPackagePrice.validator.js';

async function listBranchPackagePriceRecords(request, response) {
  const filters = validateBranchPackagePriceListQuery(request.query);
  const result = await listBranchPackagePrices(
    request.pricingBranch.branchId,
    filters,
  );

  response.status(200).json({
    success: true,
    data: {
      items: result.items,
      pagination: paginationMetadata(
        filters.page,
        filters.limit,
        result.totalItems,
      ),
    },
  });
}

async function getBranchPackagePriceRecord(request, response) {
  validateNoPricingQuery(request.query);
  const packageId = validatePricingPackageId(request.params.packageId);
  const branchPackagePrice = await getBranchPackagePrice(
    request.pricingBranch.branchId,
    packageId,
  );

  response.status(200).json({
    success: true,
    data: { branchPackagePrice },
  });
}

async function putBranchPackagePriceRecord(request, response) {
  validateNoPricingQuery(request.query);
  const packageId = validatePricingPackageId(request.params.packageId);
  const values = validateBranchPackagePriceWrite(request.body);
  const branchPackagePrice = await putBranchPackagePrice(
    request.pricingBranch.branchId,
    packageId,
    values,
    getAuditContext(request),
  );

  response.status(200).json({
    success: true,
    data: { branchPackagePrice },
  });
}

export {
  getBranchPackagePriceRecord,
  listBranchPackagePriceRecords,
  putBranchPackagePriceRecord,
};
