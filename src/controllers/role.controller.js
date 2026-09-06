import {
  createRole,
  getRole,
  listPermissions,
  listRoles,
  replaceRolePermissions,
  updateRole,
} from '../services/role.service.js';
import { getAuditContext } from '../utils/auditContext.js';
import { paginationMetadata } from '../validators/admin/common.validator.js';
import {
  validateCreateRole,
  validatePermissionListQuery,
  validateReplaceRolePermissions,
  validateRoleId,
  validateRoleListQuery,
  validateUpdateRole,
} from '../validators/admin/role.validator.js';

async function listRoleRecords(request, response) {
  const filters = validateRoleListQuery(request.query);
  const result = await listRoles(filters);

  response.status(200).json({
    success: true,
    data: {
      items: result.items,
      pagination: paginationMetadata(
        filters.page,
        filters.limit,
        result.totalItems,
      ),
    },
  });
}

async function getRoleRecord(request, response) {
  const roleId = validateRoleId(request.params.roleId);
  const role = await getRole(roleId);

  response.status(200).json({ success: true, data: { role } });
}

async function createRoleRecord(request, response) {
  const values = validateCreateRole(request.body);
  const role = await createRole(values, getAuditContext(request));

  response.status(201).json({ success: true, data: { role } });
}

async function updateRoleRecord(request, response) {
  const roleId = validateRoleId(request.params.roleId);
  const changes = validateUpdateRole(request.body);
  const role = await updateRole(roleId, changes, getAuditContext(request));

  response.status(200).json({ success: true, data: { role } });
}

async function listPermissionRecords(request, response) {
  const filters = validatePermissionListQuery(request.query);
  const result = await listPermissions(filters);

  response.status(200).json({
    success: true,
    data: {
      items: result.items,
      pagination: paginationMetadata(
        filters.page,
        filters.limit,
        result.totalItems,
      ),
    },
  });
}

async function replaceRolePermissionRecords(request, response) {
  const roleId = validateRoleId(request.params.roleId);
  const { permissionIds } = validateReplaceRolePermissions(request.body);
  const role = await replaceRolePermissions(
    roleId,
    permissionIds,
    getAuditContext(request),
  );

  response.status(200).json({ success: true, data: { role } });
}

export {
  createRoleRecord,
  getRoleRecord,
  listPermissionRecords,
  listRoleRecords,
  replaceRolePermissionRecords,
  updateRoleRecord,
};
