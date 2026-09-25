import { Router } from 'express';

import {
  cancelSaleRecord,
  completeSaleRecord,
  createSaleItemRecord,
  createSaleRecord,
  deleteSaleItemRecord,
  getSaleRecord,
  listSaleRecords,
  updateSaleItemRecord,
  updateSaleRecord,
} from '../../../controllers/sale.controller.js';
import { requireBranchPermission } from '../../../middleware/authorization.middleware.js';
import { loadSalesBranch } from '../../../middleware/salesBranch.middleware.js';

const router = Router({ mergeParams: true });
const branch = (request) => request.salesBranch.branchId;

router.use(loadSalesBranch);
router.get('/sales', requireBranchPermission('sales.read', branch), listSaleRecords);
router.post('/till-sessions/:tillSessionId/sales', requireBranchPermission('sales.manage', branch), createSaleRecord);
router.get('/sales/:saleId', requireBranchPermission('sales.read', branch), getSaleRecord);
router.patch('/sales/:saleId', requireBranchPermission('sales.manage', branch), updateSaleRecord);
router.post('/sales/:saleId/items', requireBranchPermission('sales.manage', branch), createSaleItemRecord);
router.patch('/sales/:saleId/items/:saleItemId', requireBranchPermission('sales.manage', branch), updateSaleItemRecord);
router.delete('/sales/:saleId/items/:saleItemId', requireBranchPermission('sales.manage', branch), deleteSaleItemRecord);
router.post('/sales/:saleId/complete', requireBranchPermission('sales.manage', branch), completeSaleRecord);
router.post('/sales/:saleId/cancel', requireBranchPermission('sales.manage', branch), cancelSaleRecord);

export default router;
