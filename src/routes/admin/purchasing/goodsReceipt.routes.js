import { Router } from 'express';

import {
  cancelGoodsReceiptRecord,
  createGoodsReceiptItemRecord,
  createGoodsReceiptRecord,
  deleteGoodsReceiptItemRecord,
  getGoodsReceiptRecord,
  listGoodsReceiptRecords,
  postGoodsReceiptRecord,
  updateGoodsReceiptItemRecord,
  updateGoodsReceiptRecord,
} from '../../../controllers/goodsReceipt.controller.js';
import { requireBranchPermission } from '../../../middleware/authorization.middleware.js';

const router = Router({ mergeParams: true });
const branch = (request) => request.purchasingBranch.branchId;

router.get('/goods-receipts', requireBranchPermission('receiving.read', branch), listGoodsReceiptRecords);
router.post('/goods-receipts', requireBranchPermission('receiving.manage', branch), createGoodsReceiptRecord);
router.get('/goods-receipts/:goodsReceiptId', requireBranchPermission('receiving.read', branch), getGoodsReceiptRecord);
router.patch('/goods-receipts/:goodsReceiptId', requireBranchPermission('receiving.manage', branch), updateGoodsReceiptRecord);
router.post('/goods-receipts/:goodsReceiptId/items', requireBranchPermission('receiving.manage', branch), createGoodsReceiptItemRecord);
router.patch('/goods-receipts/:goodsReceiptId/items/:goodsReceiptItemId', requireBranchPermission('receiving.manage', branch), updateGoodsReceiptItemRecord);
router.delete('/goods-receipts/:goodsReceiptId/items/:goodsReceiptItemId', requireBranchPermission('receiving.manage', branch), deleteGoodsReceiptItemRecord);
router.post('/goods-receipts/:goodsReceiptId/post', requireBranchPermission('receiving.manage', branch), postGoodsReceiptRecord);
router.post('/goods-receipts/:goodsReceiptId/cancel', requireBranchPermission('receiving.manage', branch), cancelGoodsReceiptRecord);

export default router;
