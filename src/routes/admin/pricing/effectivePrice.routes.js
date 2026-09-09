import { Router } from 'express';

import {
  getEffectivePackagePriceRecord,
  getEffectiveVariantPriceRecord,
} from '../../../controllers/effectivePrice.controller.js';
import { requireBranchPermission } from '../../../middleware/authorization.middleware.js';

const router = Router({ mergeParams: true });
const resolveBranchId = (request) => request.pricingBranch.branchId;

router.get(
  '/effective/variants/:variantId',
  requireBranchPermission('pricing.read', resolveBranchId),
  getEffectiveVariantPriceRecord,
);
router.get(
  '/effective/packages/:packageId',
  requireBranchPermission('pricing.read', resolveBranchId),
  getEffectivePackagePriceRecord,
);

export default router;
