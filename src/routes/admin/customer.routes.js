import { Router } from 'express';

import {
  createCustomerRecord,
  getCustomerRecord,
  listCustomerRecords,
  updateCustomerRecord,
} from '../../controllers/customer.controller.js';
import { requirePermission } from '../../middleware/authorization.middleware.js';

const router = Router();

router.get('/', requirePermission('customers.read'), listCustomerRecords);
router.post('/', requirePermission('customers.manage'), createCustomerRecord);
router.get(
  '/:customerId',
  requirePermission('customers.read'),
  getCustomerRecord,
);
router.patch(
  '/:customerId',
  requirePermission('customers.manage'),
  updateCustomerRecord,
);

export default router;
