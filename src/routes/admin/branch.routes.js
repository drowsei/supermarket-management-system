import { Router } from 'express';

import {
  createBranchRecord,
  getBranchRecord,
  listBranchRecords,
  updateBranchRecord,
} from '../../controllers/branch.controller.js';
import { requirePermission } from '../../middleware/authorization.middleware.js';

const router = Router();

router.get('/', requirePermission('branches.read'), listBranchRecords);
router.get('/:branchId', requirePermission('branches.read'), getBranchRecord);
router.post('/', requirePermission('branches.manage'), createBranchRecord);
router.patch(
  '/:branchId',
  requirePermission('branches.manage'),
  updateBranchRecord,
);

export default router;
