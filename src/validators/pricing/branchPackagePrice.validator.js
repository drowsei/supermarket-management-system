import { parseId } from '../admin/common.validator.js';
import {
  validateNoPricingQuery,
  validatePriceListQuery,
  validatePriceWriteBody,
} from './common.validator.js';

function validatePricingPackageId(value) {
  return parseId(value, 'packageId');
}

export {
  validateNoPricingQuery,
  validatePriceListQuery as validateBranchPackagePriceListQuery,
  validatePriceWriteBody as validateBranchPackagePriceWrite,
  validatePricingPackageId,
};
