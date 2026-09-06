import { Router } from 'express';

import {
  createRoleRecord,
  getRoleRecord,
  listPermissionRecords,
  listRoleRecords,
  replaceRolePermissionRecords,
  updateRoleRecord,
} from '../../controllers/role.controller.js';
import { requirePermission } from '../../middleware/authorization.middleware.js';

const roleRouter = Router();
const permissionRouter = Router();

roleRouter.get('/', requirePermission('roles.read'), listRoleRecords);
roleRouter.post('/', requirePermission('roles.manage'), createRoleRecord);
roleRouter.put(
  '/:roleId/permissions',
  requirePermission('roles.manage'),
  replaceRolePermissionRecords,
);
roleRouter.get('/:roleId', requirePermission('roles.read'), getRoleRecord);
roleRouter.patch(
  '/:roleId',
  requirePermission('roles.manage'),
  updateRoleRecord,
);

permissionRouter.get(
  '/',
  requirePermission('permissions.read'),
  listPermissionRecords,
);

export { permissionRouter };
export default roleRouter;
