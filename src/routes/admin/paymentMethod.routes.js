import { Router } from 'express';

import {
  createPaymentMethodRecord,
  getPaymentMethodRecord,
  listPaymentMethodRecords,
  updatePaymentMethodRecord,
} from '../../controllers/paymentMethod.controller.js';
import { requirePermission } from '../../middleware/authorization.middleware.js';

const router = Router();

router.get('/', requirePermission('payment_methods.read'), listPaymentMethodRecords);
router.post('/', requirePermission('payment_methods.manage'), createPaymentMethodRecord);
router.get('/:paymentMethodId', requirePermission('payment_methods.read'), getPaymentMethodRecord);
router.patch('/:paymentMethodId', requirePermission('payment_methods.manage'), updatePaymentMethodRecord);

export default router;
