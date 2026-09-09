import { Router } from 'express';

import {
  createSupplierProductPackageRecord,
  getSupplierProductPackageRecord,
  listSupplierProductPackageRecords,
  updateSupplierProductPackageRecord,
} from '../../../controllers/supplierProductPackage.controller.js';
import { requirePermission } from '../../../middleware/authorization.middleware.js';

const router = Router({ mergeParams: true });

router.get(
  '/:supplierId/products/:supplierProductId/packages',
  requirePermission('suppliers.read'),
  listSupplierProductPackageRecords,
);
router.post(
  '/:supplierId/products/:supplierProductId/packages',
  requirePermission('suppliers.manage'),
  createSupplierProductPackageRecord,
);
router.get(
  '/:supplierId/product-packages/:supplierProductPackageId',
  requirePermission('suppliers.read'),
  getSupplierProductPackageRecord,
);
router.patch(
  '/:supplierId/product-packages/:supplierProductPackageId',
  requirePermission('suppliers.manage'),
  updateSupplierProductPackageRecord,
);

export default router;
