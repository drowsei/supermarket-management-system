import { Router } from 'express';

import {
  createProductVariantRecord,
  getProductVariantRecord,
  listProductVariantRecords,
  updateProductVariantRecord,
} from '../../../controllers/productVariant.controller.js';
import { requirePermission } from '../../../middleware/authorization.middleware.js';

const router = Router();

router.get(
  '/products/:productId/variants',
  requirePermission('products.read'),
  listProductVariantRecords,
);
router.post(
  '/products/:productId/variants',
  requirePermission('products.manage'),
  createProductVariantRecord,
);
router.get(
  '/variants/:variantId',
  requirePermission('products.read'),
  getProductVariantRecord,
);
router.patch(
  '/variants/:variantId',
  requirePermission('products.manage'),
  updateProductVariantRecord,
);

export default router;
