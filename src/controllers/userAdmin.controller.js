import {
  assignUserRole,
  createUser,
  getUser,
  listUsers,
  resetUserPassword,
  revokeUserRole,
  updateUser,
} from '../services/userAdmin.service.js';
import { getAuditContext } from '../utils/auditContext.js';
import { paginationMetadata } from '../validators/admin/common.validator.js';
import {
  validateAssignUserRole,
  validateCreateUser,
  validateResetPassword,
  validateUpdateUser,
  validateUserId,
  validateUserListQuery,
  validateUserRoleId,
} from '../validators/admin/user.validator.js';

async function listUserRecords(request, response) {
  const filters = validateUserListQuery(request.query);
  const result = await listUsers(filters);

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

async function getUserRecord(request, response) {
  const userId = validateUserId(request.params.userId);
  const user = await getUser(userId);

  response.status(200).json({ success: true, data: { user } });
}

async function createUserRecord(request, response) {
  const values = validateCreateUser(request.body);
  const user = await createUser(values, getAuditContext(request));

  response.set('Cache-Control', 'no-store');
  response.status(201).json({ success: true, data: { user } });
}

async function updateUserRecord(request, response) {
  const userId = validateUserId(request.params.userId);
  const changes = validateUpdateUser(request.body);
  const user = await updateUser(userId, changes, getAuditContext(request));

  response.set('Cache-Control', 'no-store');
  response.status(200).json({ success: true, data: { user } });
}

async function resetUserPasswordRecord(request, response) {
  const userId = validateUserId(request.params.userId);
  const { temporaryPassword } = validateResetPassword(request.body);

  await resetUserPassword(
    userId,
    temporaryPassword,
    getAuditContext(request),
  );

  response.set('Cache-Control', 'no-store');
  response.status(200).json({
    success: true,
    message: 'Temporary password set; the user must change it at next access',
  });
}

async function assignUserRoleRecord(request, response) {
  const userId = validateUserId(request.params.userId);
  const values = validateAssignUserRole(request.body);
  const userRole = await assignUserRole(
    userId,
    values,
    getAuditContext(request),
  );

  response.status(201).json({ success: true, data: { userRole } });
}

async function revokeUserRoleRecord(request, response) {
  const userId = validateUserId(request.params.userId);
  const userRoleId = validateUserRoleId(request.params.userRoleId);
  const revokedUserRole = await revokeUserRole(
    userId,
    userRoleId,
    getAuditContext(request),
  );

  response.status(200).json({
    success: true,
    message: 'User role assignment revoked',
    data: { userRole: revokedUserRole },
  });
}

export {
  assignUserRoleRecord,
  createUserRecord,
  getUserRecord,
  listUserRecords,
  resetUserPasswordRecord,
  revokeUserRoleRecord,
  updateUserRecord,
};
