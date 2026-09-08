import { Router } from 'express';

import {
  createProductPackageRecord,
  getProductPackageRecord,
  listProductPackageRecords,
  updateProductPackageRecord,
} from '../../../controllers/productPackage.controller.js';
import { requirePermission } from '../../../middleware/authorization.middleware.js';

const router = Router();

router.get(
  '/variants/:variantId/packages',
  requirePermission('products.read'),
  listProductPackageRecords,
);
router.post(
  '/variants/:variantId/packages',
  requirePermission('products.manage'),
  createProductPackageRecord,
);
router.get(
  '/packages/:packageId',
  requirePermission('products.read'),
  getProductPackageRecord,
);
router.patch(
  '/packages/:packageId',
  requirePermission('products.manage'),
  updateProductPackageRecord,
);

export default router;
