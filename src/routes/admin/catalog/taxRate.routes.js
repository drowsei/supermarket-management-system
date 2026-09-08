import { Router } from 'express';

import {
  createTaxRateRecord,
  getTaxRateRecord,
  listTaxRateRecords,
  updateTaxRateRecord,
} from '../../../controllers/taxRate.controller.js';
import { requirePermission } from '../../../middleware/authorization.middleware.js';

const router = Router();

router.get('/', requirePermission('catalog.read'), listTaxRateRecords);
router.get('/:taxRateId', requirePermission('catalog.read'), getTaxRateRecord);
router.post('/', requirePermission('catalog.manage'), createTaxRateRecord);
router.patch(
  '/:taxRateId',
  requirePermission('catalog.manage'),
  updateTaxRateRecord,
);

export default router;
