import { Router } from 'express';

import {
  cancelSalePaymentRecord,
  completeSalePaymentRecord,
  createSalePaymentRecord,
  failSalePaymentRecord,
  getSalePaymentRecord,
  listSalePaymentRecords,
} from '../../../controllers/salePayment.controller.js';
import { requireBranchPermission } from '../../../middleware/authorization.middleware.js';
import { loadSalesBranch } from '../../../middleware/salesBranch.middleware.js';

const router = Router({ mergeParams: true });
const branch = (request) => request.salesBranch.branchId;

router.use(loadSalesBranch);
router.get('/sales/:saleId/payments', requireBranchPermission('payments.read', branch), listSalePaymentRecords);
router.post('/sales/:saleId/payments', requireBranchPermission('payments.manage', branch), createSalePaymentRecord);
router.get('/sales/:saleId/payments/:salePaymentId', requireBranchPermission('payments.read', branch), getSalePaymentRecord);
router.post('/sales/:saleId/payments/:salePaymentId/complete', requireBranchPermission('payments.manage', branch), completeSalePaymentRecord);
router.post('/sales/:saleId/payments/:salePaymentId/fail', requireBranchPermission('payments.manage', branch), failSalePaymentRecord);
router.post('/sales/:saleId/payments/:salePaymentId/cancel', requireBranchPermission('payments.manage', branch), cancelSalePaymentRecord);

export default router;
