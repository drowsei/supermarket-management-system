import { parseId } from '../admin/common.validator.js';
import {
  validateNoPricingQuery,
  validatePriceListQuery,
  validatePriceWriteBody,
} from './common.validator.js';

function validatePricingVariantId(value) {
  return parseId(value, 'variantId');
}

export {
  validateNoPricingQuery,
  validatePriceListQuery as validateBranchVariantPriceListQuery,
  validatePriceWriteBody as validateBranchVariantPriceWrite,
  validatePricingVariantId,
};
