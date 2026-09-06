import {
  findBranchAuthorization,
  hasGlobalPermission,
} from '../repositories/auth.repository.js';
import { isUnsignedBigIntId } from '../utils/jwt.js';

function validatePermissionCode(permissionCode) {
  if (
    typeof permissionCode !== 'string' ||
    permissionCode.trim().length === 0
  ) {
    throw new TypeError('A permission code must be configured.');
  }

  return permissionCode.trim();
}

async function userHasGlobalPermission(userId, permissionCode) {
  return hasGlobalPermission(userId, validatePermissionCode(permissionCode));
}

async function userHasBranchPermission(userId, branchId, permissionCode) {
  const normalizedBranchId = String(branchId ?? '');

  if (!isUnsignedBigIntId(normalizedBranchId)) {
    return false;
  }

  const authorization = await findBranchAuthorization(
    userId,
    normalizedBranchId,
    validatePermissionCode(permissionCode),
  );

  return Boolean(
    authorization?.branchExists &&
      authorization.hasPermission &&
      authorization.hasEmployeeAccess,
  );
}

export {
  userHasBranchPermission,
  userHasGlobalPermission,
  validatePermissionCode,
};
