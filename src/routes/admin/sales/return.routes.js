import { Router } from 'express';

import {
  approveSalesReturnRecord,
  cancelSaleRefundRecord,
  cancelSalesReturnRecord,
  completeSaleRefundRecord,
  completeSalesReturnRecord,
  createSaleRefundRecord,
  createSalesReturnItemRecord,
  createSalesReturnRecord,
  deleteSalesReturnItemRecord,
  failSaleRefundRecord,
  getSalesReturnRecord,
  listSaleRefundRecords,
  listSalesReturnRecords,
  submitSalesReturnRecord,
  updateSalesReturnItemRecord,
} from '../../../controllers/salesReturn.controller.js';
import { requireBranchPermission } from '../../../middleware/authorization.middleware.js';
import { loadSalesBranch } from '../../../middleware/salesBranch.middleware.js';

const router = Router({ mergeParams: true });
const branch = (request) => request.salesBranch.branchId;
const read = requireBranchPermission('returns.read', branch);
const manage = requireBranchPermission('returns.manage', branch);

router.use(loadSalesBranch);
router.get('/sales/:saleId/returns', read, listSalesReturnRecords);
router.post('/sales/:saleId/returns', manage, createSalesReturnRecord);
router.get('/sales/:saleId/returns/:salesReturnId', read, getSalesReturnRecord);
router.post('/sales/:saleId/returns/:salesReturnId/items', manage, createSalesReturnItemRecord);
router.patch('/sales/:saleId/returns/:salesReturnId/items/:salesReturnItemId', manage, updateSalesReturnItemRecord);
router.delete('/sales/:saleId/returns/:salesReturnId/items/:salesReturnItemId', manage, deleteSalesReturnItemRecord);
router.post('/sales/:saleId/returns/:salesReturnId/submit', manage, submitSalesReturnRecord);
router.post('/sales/:saleId/returns/:salesReturnId/approve', manage, approveSalesReturnRecord);
router.post('/sales/:saleId/returns/:salesReturnId/complete', manage, completeSalesReturnRecord);
router.post('/sales/:saleId/returns/:salesReturnId/cancel', manage, cancelSalesReturnRecord);
router.get('/sales/:saleId/returns/:salesReturnId/refunds', read, listSaleRefundRecords);
router.post('/sales/:saleId/returns/:salesReturnId/refunds', manage, createSaleRefundRecord);
router.post('/sales/:saleId/returns/:salesReturnId/refunds/:salePaymentId/complete', manage, completeSaleRefundRecord);
router.post('/sales/:saleId/returns/:salesReturnId/refunds/:salePaymentId/fail', manage, failSaleRefundRecord);
router.post('/sales/:saleId/returns/:salesReturnId/refunds/:salePaymentId/cancel', manage, cancelSaleRefundRecord);

export default router;
