import { Router } from 'express';

import {
  getLotRecord,
  getTransactionRecord,
  getVariantInventoryRecord,
  listInventoryRecords,
  listLotRecords,
  listTransactionRecords,
  patchLotStatusRecord,
  putInventorySettingsRecord,
} from '../../../controllers/inventory.controller.js';
import { requireBranchPermission } from '../../../middleware/authorization.middleware.js';
import { loadInventoryBranch } from '../../../middleware/inventoryBranch.middleware.js';

const router = Router({ mergeParams: true });
const branch = (request) => request.inventoryBranch.branchId;

router.use(loadInventoryBranch);
router.get('/', requireBranchPermission('inventory.read', branch), listInventoryRecords);
router.get('/variants/:variantId', requireBranchPermission('inventory.read', branch), getVariantInventoryRecord);
router.put('/variants/:variantId/settings', requireBranchPermission('inventory.manage', branch), putInventorySettingsRecord);
router.get('/lots', requireBranchPermission('inventory.read', branch), listLotRecords);
router.get('/lots/:inventoryLotId', requireBranchPermission('inventory.read', branch), getLotRecord);
router.patch('/lots/:inventoryLotId/status', requireBranchPermission('inventory.manage', branch), patchLotStatusRecord);
router.get('/transactions', requireBranchPermission('inventory.read', branch), listTransactionRecords);
router.get('/transactions/:inventoryTransactionId', requireBranchPermission('inventory.read', branch), getTransactionRecord);

export default router;
