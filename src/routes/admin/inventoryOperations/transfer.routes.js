import { Router } from 'express';
import {
  approveTransferRecord, cancelTransferRecord, createTransferItemRecord,
  createTransferRecord, deleteTransferItemRecord, dispatchTransferRecord,
  getTransferRecord, listTransferRecords, receiveTransferRecord,
  requestTransferRecord, updateTransferItemRecord, updateTransferRecord,
} from '../../../controllers/stockTransfer.controller.js';
import { requireBranchPermission } from '../../../middleware/authorization.middleware.js';
const router = Router({ mergeParams: true });
const branch = (request) => request.inventoryOperationsBranch.branchId;
router.get('/', requireBranchPermission('stock_transfers.read', branch), listTransferRecords);
router.post('/', requireBranchPermission('stock_transfers.manage', branch), createTransferRecord);
router.post('/:stockTransferId/items', requireBranchPermission('stock_transfers.manage', branch), createTransferItemRecord);
router.patch('/:stockTransferId/items/:stockTransferItemId', requireBranchPermission('stock_transfers.manage', branch), updateTransferItemRecord);
router.delete('/:stockTransferId/items/:stockTransferItemId', requireBranchPermission('stock_transfers.manage', branch), deleteTransferItemRecord);
router.post('/:stockTransferId/request', requireBranchPermission('stock_transfers.manage', branch), requestTransferRecord);
router.post('/:stockTransferId/approve', requireBranchPermission('stock_transfers.manage', branch), approveTransferRecord);
router.post('/:stockTransferId/dispatch', requireBranchPermission('stock_transfers.manage', branch), dispatchTransferRecord);
router.post('/:stockTransferId/receive', requireBranchPermission('stock_transfers.manage', branch), receiveTransferRecord);
router.post('/:stockTransferId/cancel', requireBranchPermission('stock_transfers.manage', branch), cancelTransferRecord);
router.get('/:stockTransferId', requireBranchPermission('stock_transfers.read', branch), getTransferRecord);
router.patch('/:stockTransferId', requireBranchPermission('stock_transfers.manage', branch), updateTransferRecord);
export default router;
