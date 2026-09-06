import {
  assignUserRole as assignUserRoleRecord,
  createUser as createUserRecord,
  findUserAdminById,
  listUsers as listUserRecords,
  resetUserPassword as resetUserPasswordRecord,
  revokeUserRole as revokeUserRoleRecord,
  updateUser as updateUserRecord,
} from '../repositories/userAdmin.repository.js';
import { rethrowDuplicateAsConflict } from '../utils/databaseError.js';
import HttpError from '../utils/httpError.js';
import { hashPassword } from '../utils/password.js';

async function listUsers(filters) {
  return listUserRecords(filters);
}

async function getUser(userId) {
  const user = await findUserAdminById(userId);

  if (!user) {
    throw new HttpError(404, 'User not found');
  }

  return user;
}

async function createUser(values, auditContext) {
  const passwordHash = await hashPassword(values.temporaryPassword);

  try {
    return await createUserRecord(values, passwordHash, auditContext);
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    rethrowDuplicateAsConflict(
      error,
      'Username, email, or employee link already exists',
    );
  }
}

async function updateUser(userId, changes, auditContext) {
  try {
    return await updateUserRecord(userId, changes, auditContext);
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    rethrowDuplicateAsConflict(
      error,
      'Username, email, or employee link already exists',
    );
  }
}

async function resetUserPassword(userId, temporaryPassword, auditContext) {
  const passwordHash = await hashPassword(temporaryPassword);
  await resetUserPasswordRecord(userId, passwordHash, auditContext);
}

async function assignUserRole(userId, values, auditContext) {
  try {
    return await assignUserRoleRecord(userId, values, auditContext);
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    rethrowDuplicateAsConflict(error, 'This role grant already exists');
  }
}

async function revokeUserRole(userId, userRoleId, auditContext) {
  return revokeUserRoleRecord(userId, userRoleId, auditContext);
}

export {
  assignUserRole,
  createUser,
  getUser,
  listUsers,
  resetUserPassword,
  revokeUserRole,
  updateUser,
};
