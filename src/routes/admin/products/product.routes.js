import { Router } from 'express';

import {
  createProductRecord,
  getProductRecord,
  listProductRecords,
  updateProductRecord,
} from '../../../controllers/product.controller.js';
import { requirePermission } from '../../../middleware/authorization.middleware.js';

const router = Router();

router.get('/products', requirePermission('products.read'), listProductRecords);
router.post(
  '/products',
  requirePermission('products.manage'),
  createProductRecord,
);
router.get(
  '/products/:productId',
  requirePermission('products.read'),
  getProductRecord,
);
router.patch(
  '/products/:productId',
  requirePermission('products.manage'),
  updateProductRecord,
);

export default router;
