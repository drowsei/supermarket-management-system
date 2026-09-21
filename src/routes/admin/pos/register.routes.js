import { Router } from 'express';

import {
  createPosRegisterRecord,
  getPosRegisterRecord,
  listPosRegisterRecords,
  updatePosRegisterRecord,
} from '../../../controllers/posRegister.controller.js';
import { openTillSessionRecord } from '../../../controllers/tillSession.controller.js';
import { requireBranchPermission } from '../../../middleware/authorization.middleware.js';

const router = Router({ mergeParams: true });
const branch = (request) => request.posBranch.branchId;

router.get('/', requireBranchPermission('pos_registers.read', branch), listPosRegisterRecords);
router.post('/', requireBranchPermission('pos_registers.manage', branch), createPosRegisterRecord);
router.get('/:posRegisterId', requireBranchPermission('pos_registers.read', branch), getPosRegisterRecord);
router.patch('/:posRegisterId', requireBranchPermission('pos_registers.manage', branch), updatePosRegisterRecord);
router.post('/:posRegisterId/till-sessions', requireBranchPermission('till_sessions.manage', branch), openTillSessionRecord);

export default router;
