import { Router } from 'express';

import {
  approvePurchaseOrderRecord,
  cancelPurchaseOrderRecord,
  createPurchaseOrderItemRecord,
  createPurchaseOrderRecord,
  deletePurchaseOrderItemRecord,
  getPurchaseOrderRecord,
  listPurchaseOrderRecords,
  submitPurchaseOrderRecord,
  updatePurchaseOrderItemRecord,
  updatePurchaseOrderRecord,
} from '../../../controllers/purchaseOrder.controller.js';
import { requireBranchPermission } from '../../../middleware/authorization.middleware.js';

const router = Router({ mergeParams: true });
const branch = (request) => request.purchasingBranch.branchId;

router.get('/purchase-orders', requireBranchPermission('purchasing.read', branch), listPurchaseOrderRecords);
router.post('/purchase-orders', requireBranchPermission('purchasing.manage', branch), createPurchaseOrderRecord);
router.get('/purchase-orders/:purchaseOrderId', requireBranchPermission('purchasing.read', branch), getPurchaseOrderRecord);
router.patch('/purchase-orders/:purchaseOrderId', requireBranchPermission('purchasing.manage', branch), updatePurchaseOrderRecord);
router.post('/purchase-orders/:purchaseOrderId/items', requireBranchPermission('purchasing.manage', branch), createPurchaseOrderItemRecord);
router.patch('/purchase-orders/:purchaseOrderId/items/:purchaseOrderItemId', requireBranchPermission('purchasing.manage', branch), updatePurchaseOrderItemRecord);
router.delete('/purchase-orders/:purchaseOrderId/items/:purchaseOrderItemId', requireBranchPermission('purchasing.manage', branch), deletePurchaseOrderItemRecord);
router.post('/purchase-orders/:purchaseOrderId/submit', requireBranchPermission('purchasing.manage', branch), submitPurchaseOrderRecord);
router.post('/purchase-orders/:purchaseOrderId/approve', requireBranchPermission('purchasing.manage', branch), approvePurchaseOrderRecord);
router.post('/purchase-orders/:purchaseOrderId/cancel', requireBranchPermission('purchasing.manage', branch), cancelPurchaseOrderRecord);

export default router;
