import { Router } from 'express';

import {
  createUnitOfMeasureRecord,
  getUnitOfMeasureRecord,
  listUnitOfMeasureRecords,
  updateUnitOfMeasureRecord,
} from '../../../controllers/unitOfMeasure.controller.js';
import { requirePermission } from '../../../middleware/authorization.middleware.js';

const router = Router();

router.get('/', requirePermission('catalog.read'), listUnitOfMeasureRecords);
router.get(
  '/:unitOfMeasureId',
  requirePermission('catalog.read'),
  getUnitOfMeasureRecord,
);
router.post(
  '/',
  requirePermission('catalog.manage'),
  createUnitOfMeasureRecord,
);
router.patch(
  '/:unitOfMeasureId',
  requirePermission('catalog.manage'),
  updateUnitOfMeasureRecord,
);

export default router;
