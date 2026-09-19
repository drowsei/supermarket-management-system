import { Router } from 'express';
import {
  approveAdjustmentRecord, cancelAdjustmentRecord, createAdjustmentItemRecord,
  createAdjustmentRecord, deleteAdjustmentItemRecord, getAdjustmentLedgerRecord,
  getAdjustmentRecord, listAdjustmentRecords, postAdjustmentRecord,
  updateAdjustmentItemRecord, updateAdjustmentRecord,
} from '../../../controllers/inventoryAdjustment.controller.js';
import { requireBranchPermission } from '../../../middleware/authorization.middleware.js';

const router = Router({ mergeParams: true });
const branch = (request) => request.inventoryOperationsBranch.branchId;
router.get('/', requireBranchPermission('inventory_adjustments.read', branch), listAdjustmentRecords);
router.post('/', requireBranchPermission('inventory_adjustments.manage', branch), createAdjustmentRecord);
router.post('/:inventoryAdjustmentId/items', requireBranchPermission('inventory_adjustments.manage', branch), createAdjustmentItemRecord);
router.patch('/:inventoryAdjustmentId/items/:inventoryAdjustmentItemId', requireBranchPermission('inventory_adjustments.manage', branch), updateAdjustmentItemRecord);
router.delete('/:inventoryAdjustmentId/items/:inventoryAdjustmentItemId', requireBranchPermission('inventory_adjustments.manage', branch), deleteAdjustmentItemRecord);
router.post('/:inventoryAdjustmentId/approve', requireBranchPermission('inventory_adjustments.manage', branch), approveAdjustmentRecord);
router.post('/:inventoryAdjustmentId/post', requireBranchPermission('inventory_adjustments.manage', branch), postAdjustmentRecord);
router.post('/:inventoryAdjustmentId/cancel', requireBranchPermission('inventory_adjustments.manage', branch), cancelAdjustmentRecord);
router.get('/:inventoryAdjustmentId/ledger', requireBranchPermission('inventory_adjustments.read', branch), getAdjustmentLedgerRecord);
router.get('/:inventoryAdjustmentId', requireBranchPermission('inventory_adjustments.read', branch), getAdjustmentRecord);
router.patch('/:inventoryAdjustmentId', requireBranchPermission('inventory_adjustments.manage', branch), updateAdjustmentRecord);
export default router;
