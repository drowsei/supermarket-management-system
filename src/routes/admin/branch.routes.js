import { Router } from 'express';

import {
  createBranchRecord,
  getBranchRecord,
  listBranchRecords,
  updateBranchRecord,
} from '../../controllers/branch.controller.js';
import { requirePermission } from '../../middleware/authorization.middleware.js';
import pricingRouter from './pricing/index.js';
import purchasingRouter from './purchasing/index.js';
import inventoryRouter from './inventory/index.js';
import inventoryOperationsRouter from './inventoryOperations/index.js';
import posRouter from './pos/index.js';
import salesRouter from './sales/index.js';
import salePaymentsRouter from './sales/payment.routes.js';
import salesReturnsRouter from './sales/return.routes.js';

const router = Router();

router.get('/', requirePermission('branches.read'), listBranchRecords);
router.use('/:branchId', salesRouter);
router.use('/:branchId', salePaymentsRouter);
router.use('/:branchId', salesReturnsRouter);
router.use('/:branchId', posRouter);
router.use('/:branchId/prices', pricingRouter);
router.use('/:branchId/inventory', inventoryRouter);
router.use('/:branchId', inventoryOperationsRouter);
router.use('/:branchId', purchasingRouter);
router.get('/:branchId', requirePermission('branches.read'), getBranchRecord);
router.post('/', requirePermission('branches.manage'), createBranchRecord);
router.patch(
  '/:branchId',
  requirePermission('branches.manage'),
  updateBranchRecord,
);

export default router;
