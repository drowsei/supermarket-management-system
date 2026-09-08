import { Router } from 'express';

import {
  createBrandRecord,
  getBrandRecord,
  listBrandRecords,
  updateBrandRecord,
} from '../../../controllers/brand.controller.js';
import { requirePermission } from '../../../middleware/authorization.middleware.js';

const router = Router();

router.get('/', requirePermission('catalog.read'), listBrandRecords);
router.get('/:brandId', requirePermission('catalog.read'), getBrandRecord);
router.post('/', requirePermission('catalog.manage'), createBrandRecord);
router.patch(
  '/:brandId',
  requirePermission('catalog.manage'),
  updateBrandRecord,
);

export default router;
