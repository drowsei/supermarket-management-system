import {
  getBranchVariantPrice,
  listBranchVariantPrices,
  putBranchVariantPrice,
} from '../services/branchVariantPrice.service.js';
import { getAuditContext } from '../utils/auditContext.js';
import { paginationMetadata } from '../validators/admin/common.validator.js';
import {
  validateBranchVariantPriceListQuery,
  validateBranchVariantPriceWrite,
  validateNoPricingQuery,
  validatePricingVariantId,
} from '../validators/pricing/branchVariantPrice.validator.js';

async function listBranchVariantPriceRecords(request, response) {
  const filters = validateBranchVariantPriceListQuery(request.query);
  const result = await listBranchVariantPrices(
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

async function getBranchVariantPriceRecord(request, response) {
  validateNoPricingQuery(request.query);
  const variantId = validatePricingVariantId(request.params.variantId);
  const branchVariantPrice = await getBranchVariantPrice(
    request.pricingBranch.branchId,
    variantId,
  );

  response.status(200).json({
    success: true,
    data: { branchVariantPrice },
  });
}

async function putBranchVariantPriceRecord(request, response) {
  validateNoPricingQuery(request.query);
  const variantId = validatePricingVariantId(request.params.variantId);
  const values = validateBranchVariantPriceWrite(request.body);
  const branchVariantPrice = await putBranchVariantPrice(
    request.pricingBranch.branchId,
    variantId,
    values,
    getAuditContext(request),
  );

  response.status(200).json({
    success: true,
    data: { branchVariantPrice },
  });
}

export {
  getBranchVariantPriceRecord,
  listBranchVariantPriceRecords,
  putBranchVariantPriceRecord,
};
