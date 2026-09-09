import { Router } from 'express';

import {
  getBranchPackagePriceRecord,
  listBranchPackagePriceRecords,
  putBranchPackagePriceRecord,
} from '../../../controllers/branchPackagePrice.controller.js';
import { requireBranchPermission } from '../../../middleware/authorization.middleware.js';

const router = Router({ mergeParams: true });
const resolveBranchId = (request) => request.pricingBranch.branchId;

router.get(
  '/packages',
  requireBranchPermission('pricing.read', resolveBranchId),
  listBranchPackagePriceRecords,
);
router.get(
  '/packages/:packageId',
  requireBranchPermission('pricing.read', resolveBranchId),
  getBranchPackagePriceRecord,
);
router.put(
  '/packages/:packageId',
  requireBranchPermission('pricing.manage', resolveBranchId),
  putBranchPackagePriceRecord,
);

export default router;
