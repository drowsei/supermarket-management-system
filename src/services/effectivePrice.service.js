import {
  findEffectivePackagePrice,
  findEffectiveVariantPrice,
} from '../repositories/effectivePrice.repository.js';
import { multiplyMoneyByConversion } from '../utils/exactDecimal.js';
import HttpError from '../utils/httpError.js';

async function resolveEffectiveVariantPrice(branchId, variantId) {
  const result = await findEffectiveVariantPrice(branchId, variantId);

  if (!result) {
    throw new HttpError(404, 'Product variant not found');
  }

  return result;
}

async function resolveEffectivePackagePrice(branchId, packageId) {
  const candidate = await findEffectivePackagePrice(branchId, packageId);

  if (!candidate) {
    throw new HttpError(404, 'Product package not found');
  }

  if (candidate.branchPackageSellingPrice !== null) {
    return {
      branchId: candidate.branchId,
      productPackageId: candidate.productPackageId,
      productVariantId: candidate.productVariantId,
      sellingPrice: candidate.branchPackageSellingPrice,
      source: 'BRANCH_PACKAGE',
      effectiveFrom: candidate.branchPackageEffectiveFrom,
      evaluatedAt: candidate.evaluatedAt,
    };
  }

  if (candidate.packageDefaultSellingPrice !== null) {
    return {
      branchId: candidate.branchId,
      productPackageId: candidate.productPackageId,
      productVariantId: candidate.productVariantId,
      sellingPrice: candidate.packageDefaultSellingPrice,
      source: 'PACKAGE_DEFAULT',
      effectiveFrom: null,
      evaluatedAt: candidate.evaluatedAt,
    };
  }

  const variantSellingPrice =
    candidate.branchVariantSellingPrice ?? candidate.variantDefaultSellingPrice;
  const variantPriceSource =
    candidate.branchVariantSellingPrice === null
      ? 'VARIANT_DEFAULT'
      : 'BRANCH_VARIANT';

  return {
    branchId: candidate.branchId,
    productPackageId: candidate.productPackageId,
    productVariantId: candidate.productVariantId,
    sellingPrice: multiplyMoneyByConversion(
      variantSellingPrice,
      candidate.conversionToBaseQuantity,
    ),
    source: 'DERIVED_FROM_VARIANT',
    effectiveFrom:
      variantPriceSource === 'BRANCH_VARIANT'
        ? candidate.branchVariantEffectiveFrom
        : null,
    variantSellingPrice,
    variantPriceSource,
    conversionToBaseQuantity: candidate.conversionToBaseQuantity,
    evaluatedAt: candidate.evaluatedAt,
  };
}

export { resolveEffectivePackagePrice, resolveEffectiveVariantPrice };
