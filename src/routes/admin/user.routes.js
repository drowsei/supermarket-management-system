import { Router } from 'express';

import {
  assignUserRoleRecord,
  createUserRecord,
  getUserRecord,
  listUserRecords,
  resetUserPasswordRecord,
  revokeUserRoleRecord,
  updateUserRecord,
} from '../../controllers/userAdmin.controller.js';
import { requirePermission } from '../../middleware/authorization.middleware.js';

const router = Router();

router.get('/', requirePermission('users.read'), listUserRecords);
router.post('/', requirePermission('users.manage'), createUserRecord);
router.get('/:userId', requirePermission('users.read'), getUserRecord);
router.patch('/:userId', requirePermission('users.manage'), updateUserRecord);
router.post(
  '/:userId/reset-password',
  requirePermission('users.manage'),
  resetUserPasswordRecord,
);
router.post(
  '/:userId/roles',
  requirePermission('user_roles.manage'),
  assignUserRoleRecord,
);
router.delete(
  '/:userId/roles/:userRoleId',
  requirePermission('user_roles.manage'),
  revokeUserRoleRecord,
);

export default router;
