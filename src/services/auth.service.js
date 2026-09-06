import {
  changePasswordWithAudit,
  findAuthorizationRows,
  findPasswordStateByUserId,
  findUserById,
  findUsersByIdentifier,
  recordSuccessfulLogin,
} from '../repositories/auth.repository.js';
import HttpError from '../utils/httpError.js';
import { signAccessToken } from '../utils/jwt.js';
import { hashPassword, verifyPassword } from '../utils/password.js';

const INVALID_CREDENTIALS_MESSAGE = 'Invalid credentials';
const TIMING_ONLY_PASSWORD = 'not-a-real-account-password';
const timingOnlyHash = await hashPassword(TIMING_ONLY_PASSWORD);

function rejectInvalidCredentials() {
  throw new HttpError(401, INVALID_CREDENTIALS_MESSAGE);
}

async function performTimingComparison(password) {
  await verifyPassword(password, timingOnlyHash);
}

function buildAuthorizationSnapshot(rows) {
  const globalRoles = [];
  const branchRoles = [];
  const globalPermissionCodes = new Set();
  const branchPermissionCodes = new Map();

  for (const role of rows.roles) {
    const roleGrant = {
      roleCode: role.roleCode,
      roleName: role.roleName,
    };

    if (role.branchId === null) {
      globalRoles.push(roleGrant);
    } else {
      branchRoles.push({ branchId: role.branchId, ...roleGrant });
    }
  }

  for (const permission of rows.permissions) {
    if (permission.branchId === null) {
      globalPermissionCodes.add(permission.permissionCode);
      continue;
    }

    const branchPermissions =
      branchPermissionCodes.get(permission.branchId) ?? new Set();
    branchPermissions.add(permission.permissionCode);
    branchPermissionCodes.set(permission.branchId, branchPermissions);
  }

  globalRoles.sort((left, right) =>
    left.roleCode.localeCompare(right.roleCode),
  );
  branchRoles.sort(
    (left, right) =>
      left.branchId.localeCompare(right.branchId) ||
      left.roleCode.localeCompare(right.roleCode),
  );

  const byBranch = {};
  const sortedBranchIds = [...branchPermissionCodes.keys()].sort((left, right) =>
    left.localeCompare(right),
  );

  for (const branchId of sortedBranchIds) {
    byBranch[branchId] = [...branchPermissionCodes.get(branchId)].sort();
  }

  return {
    globalRoles,
    branchRoles,
    permissions: {
      global: [...globalPermissionCodes].sort(),
      byBranch,
    },
  };
}

async function login(identifier, password) {
  const candidates = await findUsersByIdentifier(identifier);

  if (candidates.length !== 1) {
    await performTimingComparison(password);
    rejectInvalidCredentials();
  }

  const candidate = candidates[0];
  const passwordMatches = await verifyPassword(
    password,
    candidate.passwordHash,
  );

  if (!passwordMatches || !candidate.isActive) {
    rejectInvalidCredentials();
  }

  const currentUser = await recordSuccessfulLogin(
    candidate.userId,
    candidate.passwordHash,
  );

  if (!currentUser?.isActive) {
    rejectInvalidCredentials();
  }

  const token = signAccessToken(currentUser.userId);

  return {
    ...token,
    user: {
      userId: currentUser.userId,
      username: currentUser.username,
      email: currentUser.email,
      employeeId: currentUser.employeeId,
      mustChangePassword: currentUser.mustChangePassword,
    },
  };
}

async function getCurrentUser(userId) {
  const [user, authorizationRows] = await Promise.all([
    findUserById(userId),
    findAuthorizationRows(userId),
  ]);

  if (!user?.isActive) {
    throw new HttpError(401, 'Authentication required');
  }

  return {
    user,
    authorization: buildAuthorizationSnapshot(authorizationRows),
  };
}

async function changePassword({
  userId,
  currentPassword,
  newPassword,
  auditContext = {},
}) {
  const passwordState = await findPasswordStateByUserId(userId);

  if (!passwordState?.isActive) {
    throw new HttpError(401, 'Authentication required');
  }

  const currentPasswordMatches = await verifyPassword(
    currentPassword,
    passwordState.passwordHash,
  );

  if (!currentPasswordMatches) {
    throw new HttpError(401, 'Current password is incorrect');
  }

  if (await verifyPassword(newPassword, passwordState.passwordHash)) {
    throw new HttpError(
      400,
      'New password must be different from the current password',
    );
  }

  const newPasswordHash = await hashPassword(newPassword);
  const updateStatus = await changePasswordWithAudit({
    userId,
    expectedPasswordHash: passwordState.passwordHash,
    newPasswordHash,
    auditContext,
  });

  if (updateStatus === 'inactive') {
    throw new HttpError(401, 'Authentication required');
  }

  if (updateStatus !== 'updated') {
    throw new HttpError(409, 'Account credentials changed; please retry');
  }
}

export { changePassword, getCurrentUser, login };
