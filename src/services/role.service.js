import {
  createRoleRecord,
  findPermissionsByRoleId,
  findRoleById,
  listPermissions as listPermissionRecords,
  listRoles as listRoleRecords,
  replaceRolePermissionsRecord,
  updateRoleRecord,
} from '../repositories/role.repository.js';
import { rethrowDuplicateAsConflict } from '../utils/databaseError.js';
import HttpError from '../utils/httpError.js';

async function listRoles(filters) {
  return listRoleRecords(filters);
}

async function getRole(roleId) {
  const role = await findRoleById(roleId);

  if (!role) {
    throw new HttpError(404, 'Role not found');
  }

  const permissions = await findPermissionsByRoleId(roleId);

  return { ...role, permissions };
}

async function listPermissions(filters) {
  return listPermissionRecords(filters);
}

async function createRole(values, auditContext) {
  try {
    const role = await createRoleRecord(values, auditContext);
    return { ...role, permissions: [] };
  } catch (error) {
    rethrowDuplicateAsConflict(error, 'Role code or role name already exists');
  }
}

async function updateRole(roleId, changes, auditContext) {
  let result;

  try {
    result = await updateRoleRecord(roleId, changes, auditContext);
  } catch (error) {
    rethrowDuplicateAsConflict(error, 'Role code or role name already exists');
  }

  switch (result.outcome) {
    case 'not_found':
      throw new HttpError(404, 'Role not found');
    case 'system_role_code_protected':
      throw new HttpError(409, 'The SYSTEM_ADMIN role code cannot be changed');
    case 'system_role_name_protected':
      throw new HttpError(409, 'The SYSTEM_ADMIN role name cannot be changed');
    case 'system_role_activation_protected':
      throw new HttpError(409, 'The SYSTEM_ADMIN role cannot be deactivated');
    default:
      return { ...result.role, permissions: result.permissions };
  }
}

async function replaceRolePermissions(roleId, permissionIds, auditContext) {
  const result = await replaceRolePermissionsRecord(
    roleId,
    permissionIds,
    auditContext,
  );

  switch (result.outcome) {
    case 'role_not_found':
      throw new HttpError(404, 'Role not found');
    case 'permission_not_found':
      throw new HttpError(404, 'One or more permissions were not found');
    case 'system_permissions_protected':
      throw new HttpError(
        409,
        'The SYSTEM_ADMIN role must retain every canonical permission',
      );
    default:
      return {
        ...result.role,
        permissions: result.permissions,
      };
  }
}

export {
  createRole,
  getRole,
  listPermissions,
  listRoles,
  replaceRolePermissions,
  updateRole,
};
