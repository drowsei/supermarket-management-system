import { Router } from 'express';

import {
  cancelTillSessionRecord,
  closeTillSessionRecord,
  createTillCashMovementRecord,
  getTillSessionRecord,
  listTillCashMovementRecords,
  listTillSessionRecords,
  resumeTillSessionRecord,
  suspendTillSessionRecord,
} from '../../../controllers/tillSession.controller.js';
import { requireBranchPermission } from '../../../middleware/authorization.middleware.js';

const router = Router({ mergeParams: true });
const branch = (request) => request.posBranch.branchId;

router.get('/', requireBranchPermission('till_sessions.read', branch), listTillSessionRecords);
router.get('/:tillSessionId', requireBranchPermission('till_sessions.read', branch), getTillSessionRecord);
router.post('/:tillSessionId/suspend', requireBranchPermission('till_sessions.manage', branch), suspendTillSessionRecord);
router.post('/:tillSessionId/resume', requireBranchPermission('till_sessions.manage', branch), resumeTillSessionRecord);
router.post('/:tillSessionId/close', requireBranchPermission('till_sessions.manage', branch), closeTillSessionRecord);
router.post('/:tillSessionId/cancel', requireBranchPermission('till_sessions.manage', branch), cancelTillSessionRecord);
router.get('/:tillSessionId/cash-movements', requireBranchPermission('till_sessions.read', branch), listTillCashMovementRecords);
router.post('/:tillSessionId/cash-movements', requireBranchPermission('till_sessions.manage', branch), createTillCashMovementRecord);

export default router;
