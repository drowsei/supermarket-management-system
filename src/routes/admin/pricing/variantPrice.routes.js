import { Router } from 'express';

import {
  getBranchVariantPriceRecord,
  listBranchVariantPriceRecords,
  putBranchVariantPriceRecord,
} from '../../../controllers/branchVariantPrice.controller.js';
import { requireBranchPermission } from '../../../middleware/authorization.middleware.js';

const router = Router({ mergeParams: true });
const resolveBranchId = (request) => request.pricingBranch.branchId;

router.get(
  '/variants',
  requireBranchPermission('pricing.read', resolveBranchId),
  listBranchVariantPriceRecords,
);
router.get(
  '/variants/:variantId',
  requireBranchPermission('pricing.read', resolveBranchId),
  getBranchVariantPriceRecord,
);
router.put(
  '/variants/:variantId',
  requireBranchPermission('pricing.manage', resolveBranchId),
  putBranchVariantPriceRecord,
);

export default router;
