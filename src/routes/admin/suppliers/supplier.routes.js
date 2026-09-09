import { Router } from 'express';

import {
  createSupplierRecord,
  getSupplierRecord,
  listSupplierRecords,
  updateSupplierRecord,
} from '../../../controllers/supplier.controller.js';
import { requirePermission } from '../../../middleware/authorization.middleware.js';

const router = Router({ mergeParams: true });

router.get('/', requirePermission('suppliers.read'), listSupplierRecords);
router.get(
  '/:supplierId',
  requirePermission('suppliers.read'),
  getSupplierRecord,
);
router.post('/', requirePermission('suppliers.manage'), createSupplierRecord);
router.patch(
  '/:supplierId',
  requirePermission('suppliers.manage'),
  updateSupplierRecord,
);

export default router;
