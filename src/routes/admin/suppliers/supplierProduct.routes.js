import { Router } from 'express';

import {
  createSupplierProductRecord,
  getSupplierProductRecord,
  listSupplierProductRecords,
  updateSupplierProductRecord,
} from '../../../controllers/supplierProduct.controller.js';
import { requirePermission } from '../../../middleware/authorization.middleware.js';

const router = Router({ mergeParams: true });

router.get(
  '/:supplierId/products',
  requirePermission('suppliers.read'),
  listSupplierProductRecords,
);
router.post(
  '/:supplierId/products',
  requirePermission('suppliers.manage'),
  createSupplierProductRecord,
);
router.get(
  '/:supplierId/products/:supplierProductId',
  requirePermission('suppliers.read'),
  getSupplierProductRecord,
);
router.patch(
  '/:supplierId/products/:supplierProductId',
  requirePermission('suppliers.manage'),
  updateSupplierProductRecord,
);

export default router;
