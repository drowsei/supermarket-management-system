import { Router } from 'express';

import {
  createCategoryRecord,
  getCategoryRecord,
  listCategoryRecords,
  updateCategoryRecord,
} from '../../../controllers/category.controller.js';
import { requirePermission } from '../../../middleware/authorization.middleware.js';

const router = Router();

router.get('/', requirePermission('catalog.read'), listCategoryRecords);
router.get(
  '/:categoryId',
  requirePermission('catalog.read'),
  getCategoryRecord,
);
router.post('/', requirePermission('catalog.manage'), createCategoryRecord);
router.patch(
  '/:categoryId',
  requirePermission('catalog.manage'),
  updateCategoryRecord,
);

export default router;
