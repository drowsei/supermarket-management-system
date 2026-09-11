import { Router } from 'express';

import { loadPurchasingBranch } from '../../../middleware/purchasingBranch.middleware.js';
import goodsReceiptRouter from './goodsReceipt.routes.js';
import purchaseOrderRouter from './purchaseOrder.routes.js';

const router = Router({ mergeParams: true });

router.use(loadPurchasingBranch);
router.use(purchaseOrderRouter);
router.use(goodsReceiptRouter);

export default router;
