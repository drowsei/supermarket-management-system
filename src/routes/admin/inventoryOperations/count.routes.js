import { Router } from 'express';
import {
  addParticipantRecord, cancelCountRecord, completeCountRecord,
  createCountItemRecord, createCountRecord, deleteCountItemRecord,
  getCountLedgerRecord, getCountRecord, getCountVarianceRecord,
  listCountRecords, patchCountItemRecord, postCountRecord,
  removeParticipantRecord, startCountRecord, updateCountRecord,
} from '../../../controllers/stockCount.controller.js';
import { requireBranchPermission } from '../../../middleware/authorization.middleware.js';
const router = Router({ mergeParams: true });
const branch = (request) => request.inventoryOperationsBranch.branchId;
router.get('/', requireBranchPermission('stock_counts.read', branch), listCountRecords);
router.post('/', requireBranchPermission('stock_counts.manage', branch), createCountRecord);
router.post('/:stockCountId/participants', requireBranchPermission('stock_counts.manage', branch), addParticipantRecord);
router.delete('/:stockCountId/participants/:employeeId', requireBranchPermission('stock_counts.manage', branch), removeParticipantRecord);
router.post('/:stockCountId/items', requireBranchPermission('stock_counts.manage', branch), createCountItemRecord);
router.patch('/:stockCountId/items/:stockCountItemId', requireBranchPermission('stock_counts.manage', branch), patchCountItemRecord);
router.delete('/:stockCountId/items/:stockCountItemId', requireBranchPermission('stock_counts.manage', branch), deleteCountItemRecord);
router.post('/:stockCountId/start', requireBranchPermission('stock_counts.manage', branch), startCountRecord);
router.post('/:stockCountId/complete', requireBranchPermission('stock_counts.manage', branch), completeCountRecord);
router.post('/:stockCountId/post', requireBranchPermission('stock_counts.manage', branch), postCountRecord);
router.post('/:stockCountId/cancel', requireBranchPermission('stock_counts.manage', branch), cancelCountRecord);
router.get('/:stockCountId/variance', requireBranchPermission('stock_counts.read', branch), getCountVarianceRecord);
router.get('/:stockCountId/ledger', requireBranchPermission('stock_counts.read', branch), getCountLedgerRecord);
router.get('/:stockCountId', requireBranchPermission('stock_counts.read', branch), getCountRecord);
router.patch('/:stockCountId', requireBranchPermission('stock_counts.manage', branch), updateCountRecord);
export default router;
