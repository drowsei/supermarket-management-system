import {
  resolveEffectivePackagePrice,
  resolveEffectiveVariantPrice,
} from '../services/effectivePrice.service.js';
import {
  validateNoPricingQuery as validateNoPackagePricingQuery,
  validatePricingPackageId,
} from '../validators/pricing/branchPackagePrice.validator.js';
import {
  validateNoPricingQuery as validateNoVariantPricingQuery,
  validatePricingVariantId,
} from '../validators/pricing/branchVariantPrice.validator.js';

async function getEffectiveVariantPriceRecord(request, response) {
  validateNoVariantPricingQuery(request.query);
  const variantId = validatePricingVariantId(request.params.variantId);
  const effectivePrice = await resolveEffectiveVariantPrice(
    request.pricingBranch.branchId,
    variantId,
  );

  response.status(200).json({ success: true, data: { effectivePrice } });
}

async function getEffectivePackagePriceRecord(request, response) {
  validateNoPackagePricingQuery(request.query);
  const packageId = validatePricingPackageId(request.params.packageId);
  const effectivePrice = await resolveEffectivePackagePrice(
    request.pricingBranch.branchId,
    packageId,
  );

  response.status(200).json({ success: true, data: { effectivePrice } });
}

export {
  getEffectivePackagePriceRecord,
  getEffectiveVariantPriceRecord,
};
