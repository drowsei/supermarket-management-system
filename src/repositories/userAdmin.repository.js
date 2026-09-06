import pool from '../config/database.js';
import {
  USER_CREDENTIAL_LOCK_NAME,
  USER_CREDENTIAL_LOCK_TIMEOUT_SECONDS,
} from '../config/accessControl.js';
import HttpError from '../utils/httpError.js';
import { databaseBoolean, toIsoString } from '../utils/record.js';
import { insertAuditLog } from './audit.repository.js';

const USER_SELECT = `
  CAST(u.user_id AS CHAR) AS userId,
  CAST(u.employee_id AS CHAR) AS employeeId,
  u.username,
  u.email,
  u.is_active AS isActive,
  u.must_change_password AS mustChangePassword,
  u.last_login_at AS lastLoginAt,
  u.created_at AS createdAt,
  u.updated_at AS updatedAt,
  e.employee_number AS employeeNumber,
  e.first_name AS employeeFirstName,
  e.last_name AS employeeLastName,
  e.employment_status AS employeeStatus
`;

const USER_COLUMN_BY_FIELD = Object.freeze({
  employeeId: 'employee_id',
  username: 'username',
  email: 'email',
  isActive: 'is_active',
});

function normalizeUser(row) {
  if (!row) {
    return null;
  }

  return {
    userId: row.userId,
    employeeId: row.employeeId ?? null,
    username: row.username,
    email: row.email,
    isActive: databaseBoolean(row.isActive),
    mustChangePassword: databaseBoolean(row.mustChangePassword),
    lastLoginAt: toIsoString(row.lastLoginAt),
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
    employee:
      row.employeeId === null
        ? null
        : {
            employeeId: row.employeeId,
            employeeNumber: row.employeeNumber,
            firstName: row.employeeFirstName,
            lastName: row.employeeLastName,
            employmentStatus: row.employeeStatus,
          },
  };
}

function normalizeRoleGrant(row) {
  return {
    userRoleId: row.userRoleId,
    roleId: row.roleId,
    roleCode: row.roleCode,
    roleName: row.roleName,
    roleIsActive: databaseBoolean(row.roleIsActive),
    branchId: row.branchId ?? null,
    branchCode: row.branchCode ?? null,
    branchName: row.branchName ?? null,
    assignedByUserId: row.assignedByUserId ?? null,
    assignedAt: toIsoString(row.assignedAt),
  };
}

async function acquireCredentialLock(connection) {
  const [rows] = await connection.execute(
    'SELECT GET_LOCK(?, ?) AS acquired',
    [USER_CREDENTIAL_LOCK_NAME, USER_CREDENTIAL_LOCK_TIMEOUT_SECONDS],
  );

  if (!databaseBoolean(rows[0]?.acquired)) {
    throw new HttpError(503, 'Account administration is temporarily busy');
  }
}

async function releaseCredentialLock(connection) {
  const [rows] = await connection.execute(
    'SELECT RELEASE_LOCK(?) AS released',
    [USER_CREDENTIAL_LOCK_NAME],
  );

  return databaseBoolean(rows[0]?.released);
}

async function selectUser(connection, userId, lock = false) {
  const [rows] = await connection.execute(
    `SELECT ${USER_SELECT}
     FROM users u
     LEFT JOIN employees e ON e.employee_id = u.employee_id
     WHERE u.user_id = ?
     LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [userId],
  );

  return normalizeUser(rows[0]);
}

async function selectRoleGrants(connection, userId) {
  const [rows] = await connection.execute(
    `SELECT
       CAST(ur.user_role_id AS CHAR) AS userRoleId,
       CAST(ur.role_id AS CHAR) AS roleId,
       r.role_code AS roleCode,
       r.role_name AS roleName,
       r.is_active AS roleIsActive,
       CAST(ur.branch_id AS CHAR) AS branchId,
       b.branch_code AS branchCode,
       b.branch_name AS branchName,
       CAST(ur.assigned_by_user_id AS CHAR) AS assignedByUserId,
       ur.assigned_at AS assignedAt
     FROM user_roles ur
     INNER JOIN roles r ON r.role_id = ur.role_id
     LEFT JOIN branches b ON b.branch_id = ur.branch_id
     WHERE ur.user_id = ?
     ORDER BY ur.branch_id IS NOT NULL, b.branch_code, r.role_code, ur.user_role_id`,
    [userId],
  );

  return rows.map(normalizeRoleGrant);
}

async function credentialCollisionExists(
  connection,
  username,
  email,
  excludedUserId = null,
) {
  const parameters = [username, email, username, email];
  let exclusion = '';

  if (excludedUserId !== null) {
    exclusion = 'AND user_id <> ?';
    parameters.push(excludedUserId);
  }

  const [rows] = await connection.execute(
    `SELECT 1
     FROM users
     WHERE (username IN (?, ?) OR email IN (?, ?))
       ${exclusion}
     LIMIT 1`,
    parameters,
  );

  return rows.length > 0;
}

async function assertEmployeeCanBeLinked(connection, employeeId) {
  const [rows] = await connection.execute(
    `SELECT employment_status AS employmentStatus
     FROM employees
     WHERE employee_id = ?
     LIMIT 1
     FOR UPDATE`,
    [employeeId],
  );

  if (!rows[0]) {
    throw new HttpError(404, 'Employee not found');
  }

  if (rows[0].employmentStatus === 'TERMINATED') {
    throw new HttpError(409, 'A terminated employee cannot be linked to a user');
  }
}

async function listUsers({ isActive, employeeId, search, limit, offset }) {
  const predicates = [];
  const parameters = [];

  if (isActive !== null) {
    predicates.push('u.is_active = ?');
    parameters.push(isActive ? 1 : 0);
  }
  if (employeeId) {
    predicates.push('u.employee_id = ?');
    parameters.push(employeeId);
  }
  if (search) {
    predicates.push(`(
      u.username LIKE CONCAT('%', ?, '%')
      OR u.email LIKE CONCAT('%', ?, '%')
      OR e.employee_number LIKE CONCAT('%', ?, '%')
      OR CONCAT(e.first_name, ' ', e.last_name) LIKE CONCAT('%', ?, '%')
    )`);
    parameters.push(search, search, search, search);
  }

  const where = predicates.length > 0 ? `WHERE ${predicates.join(' AND ')}` : '';
  const [countRows] = await pool.execute(
    `SELECT COUNT(*) AS totalItems
     FROM users u
     LEFT JOIN employees e ON e.employee_id = u.employee_id
     ${where}`,
    parameters,
  );
  const [rows] = await pool.execute(
    `SELECT ${USER_SELECT}
     FROM users u
     LEFT JOIN employees e ON e.employee_id = u.employee_id
     ${where}
     ORDER BY u.username, u.user_id
     LIMIT ? OFFSET ?`,
    [...parameters, limit, offset],
  );

  return {
    items: rows.map(normalizeUser),
    totalItems: Number(countRows[0].totalItems),
  };
}

async function findUserAdminById(userId) {
  const user = await selectUser(pool, userId);

  if (!user) {
    return null;
  }

  return { ...user, roleGrants: await selectRoleGrants(pool, userId) };
}

async function createUser(values, passwordHash, auditContext) {
  let connection;
  let lockAcquired = false;
  let transactionStarted = false;

  try {
    connection = await pool.getConnection();
    await acquireCredentialLock(connection);
    lockAcquired = true;
    await connection.beginTransaction();
    transactionStarted = true;

    if (
      await credentialCollisionExists(
        connection,
        values.username,
        values.email,
      )
    ) {
      throw new HttpError(409, 'Username or email conflicts with an existing account');
    }

    if (values.employeeId !== null) {
      await assertEmployeeCanBeLinked(connection, values.employeeId);
    }

    await connection.execute(
      `INSERT INTO users (
         employee_id, username, email, password_hash, is_active,
         must_change_password
       ) VALUES (?, ?, ?, ?, 1, 1)`,
      [values.employeeId, values.username, values.email, passwordHash],
    );
    const [idRows] = await connection.query(
      'SELECT CAST(LAST_INSERT_ID() AS CHAR) AS userId',
    );
    const user = await selectUser(connection, idRows[0].userId);

    await insertAuditLog(connection, {
      auditContext,
      actionType: 'USER_CREATED',
      entityType: 'users',
      entityRecordId: user.userId,
      afterValues: user,
      notes: 'Internal user account created with a temporary password.',
    });
    await connection.commit();
    transactionStarted = false;
    return { ...user, roleGrants: [] };
  } catch (error) {
    if (transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        error.rollbackError = rollbackError;
      }
    }
    throw error;
  } finally {
    let canReturnConnection = true;
    if (connection && lockAcquired) {
      try {
        canReturnConnection = await releaseCredentialLock(connection);
      } catch (releaseError) {
        canReturnConnection = false;
        console.error('Failed to release the user credential lock', {
          code: releaseError.code,
          message: releaseError.message,
        });
      }
    }
    if (connection) {
      if (canReturnConnection) {
        connection.release();
      } else {
        connection.destroy();
      }
    }
  }
}

async function updateUser(userId, changes, auditContext) {
  let connection;
  let lockAcquired = false;
  let transactionStarted = false;

  try {
    connection = await pool.getConnection();
    await acquireCredentialLock(connection);
    lockAcquired = true;
    await connection.beginTransaction();
    transactionStarted = true;
    const before = await selectUser(connection, userId, true);

    if (!before) {
      throw new HttpError(404, 'User not found');
    }

    if (
      String(auditContext.actorUserId) === userId &&
      changes.isActive === false
    ) {
      throw new HttpError(409, 'You cannot deactivate your own account');
    }

    const nextUsername = changes.username ?? before.username;
    const nextEmail = changes.email ?? before.email;

    if (
      await credentialCollisionExists(
        connection,
        nextUsername,
        nextEmail,
        userId,
      )
    ) {
      throw new HttpError(409, 'Username or email conflicts with an existing account');
    }

    const employeeLinkChanged =
      Object.hasOwn(changes, 'employeeId') &&
      changes.employeeId !== before.employeeId;

    if (employeeLinkChanged) {
      const [branchGrantRows] = await connection.execute(
        `SELECT 1 FROM user_roles
         WHERE user_id = ? AND branch_id IS NOT NULL
         LIMIT 1
         FOR UPDATE`,
        [userId],
      );

      if (branchGrantRows.length > 0) {
        throw new HttpError(
          409,
          'Employee link cannot change while branch-scoped role grants exist',
        );
      }

    }

    const effectiveEmployeeId = employeeLinkChanged
      ? changes.employeeId
      : before.employeeId;
    const effectiveIsActive = Object.hasOwn(changes, 'isActive')
      ? changes.isActive
      : before.isActive;

    if (
      effectiveEmployeeId !== null &&
      (employeeLinkChanged || effectiveIsActive)
    ) {
      await assertEmployeeCanBeLinked(connection, effectiveEmployeeId);
    }

    const entries = Object.entries(changes);
    const assignments = entries.map(
      ([field]) => `${USER_COLUMN_BY_FIELD[field]} = ?`,
    );
    await connection.execute(
      `UPDATE users SET ${assignments.join(', ')} WHERE user_id = ?`,
      [
        ...entries.map(([field, value]) =>
          field === 'isActive' ? (value ? 1 : 0) : value,
        ),
        userId,
      ],
    );
    const after = await selectUser(connection, userId);

    await insertAuditLog(connection, {
      auditContext,
      actionType: 'USER_UPDATED',
      entityType: 'users',
      entityRecordId: userId,
      beforeValues: before,
      afterValues: after,
      notes: 'Internal user account updated through the administration API.',
    });
    const roleGrants = await selectRoleGrants(connection, userId);
    await connection.commit();
    transactionStarted = false;
    return { ...after, roleGrants };
  } catch (error) {
    if (transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        error.rollbackError = rollbackError;
      }
    }
    throw error;
  } finally {
    let canReturnConnection = true;
    if (connection && lockAcquired) {
      try {
        canReturnConnection = await releaseCredentialLock(connection);
      } catch (releaseError) {
        canReturnConnection = false;
        console.error('Failed to release the user credential lock', {
          code: releaseError.code,
          message: releaseError.message,
        });
      }
    }
    if (connection) {
      if (canReturnConnection) {
        connection.release();
      } else {
        connection.destroy();
      }
    }
  }
}

async function resetUserPassword(userId, passwordHash, auditContext) {
  let connection;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const user = await selectUser(connection, userId, true);

    if (!user) {
      throw new HttpError(404, 'User not found');
    }

    await connection.execute(
      `UPDATE users
       SET password_hash = ?, must_change_password = 1
       WHERE user_id = ?`,
      [passwordHash, userId],
    );

    await insertAuditLog(connection, {
      auditContext,
      actionType: 'USER_PASSWORD_RESET',
      entityType: 'users',
      entityRecordId: userId,
      beforeValues: { mustChangePassword: user.mustChangePassword },
      afterValues: { mustChangePassword: true },
      notes: 'An administrator replaced the account password with a temporary password.',
    });
    await connection.commit();
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        error.rollbackError = rollbackError;
      }
    }
    throw error;
  } finally {
    connection?.release();
  }
}

async function assignUserRole(userId, values, auditContext) {
  let connection;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const user = await selectUser(connection, userId, true);

    if (!user) {
      throw new HttpError(404, 'User not found');
    }

    const [roleRows] = await connection.execute(
      `SELECT
         CAST(role_id AS CHAR) AS roleId,
         role_code AS roleCode,
         role_name AS roleName,
         is_active AS isActive
       FROM roles
       WHERE role_id = ?
       LIMIT 1
       FOR UPDATE`,
      [values.roleId],
    );
    const role = roleRows[0];

    if (!role) {
      throw new HttpError(404, 'Role not found');
    }
    if (!databaseBoolean(role.isActive)) {
      throw new HttpError(409, 'An inactive role cannot be assigned');
    }

    let branch = null;
    if (values.branchId !== null) {
      const [branchRows] = await connection.execute(
        `SELECT branch_code AS branchCode, branch_name AS branchName
         FROM branches
         WHERE branch_id = ?
         LIMIT 1
         FOR UPDATE`,
        [values.branchId],
      );
      branch = branchRows[0];

      if (!branch) {
        throw new HttpError(404, 'Branch not found');
      }

      if (user.employeeId !== null) {
        const [assignmentRows] = await connection.execute(
          `SELECT 1
           FROM employees e
           INNER JOIN employee_branch_assignments eba
             ON eba.employee_id = e.employee_id
           WHERE e.employee_id = ?
             AND e.employment_status = 'ACTIVE'
             AND eba.branch_id = ?
             AND eba.started_on <= CURRENT_DATE()
             AND (eba.ended_on IS NULL OR eba.ended_on >= CURRENT_DATE())
           LIMIT 1
           FOR UPDATE`,
          [user.employeeId, values.branchId],
        );

        if (assignmentRows.length === 0) {
          throw new HttpError(
            409,
            'The linked employee has no current assignment at this branch',
          );
        }
      }
    }

    const [duplicateRows] = await connection.execute(
      `SELECT 1 FROM user_roles
       WHERE user_id = ? AND role_id = ? AND branch_scope_guard = COALESCE(?, 0)
       LIMIT 1
       FOR UPDATE`,
      [userId, values.roleId, values.branchId],
    );

    if (duplicateRows.length > 0) {
      throw new HttpError(409, 'This role grant already exists');
    }

    await connection.execute(
      `INSERT INTO user_roles (
         user_id, role_id, branch_id, assigned_by_user_id
       ) VALUES (?, ?, ?, ?)`,
      [userId, values.roleId, values.branchId, auditContext.actorUserId],
    );
    const [idRows] = await connection.query(
      'SELECT CAST(LAST_INSERT_ID() AS CHAR) AS userRoleId',
    );
    const grant = {
      userRoleId: idRows[0].userRoleId,
      userId,
      roleId: role.roleId,
      roleCode: role.roleCode,
      roleName: role.roleName,
      branchId: values.branchId,
      branchCode: branch?.branchCode ?? null,
      branchName: branch?.branchName ?? null,
      assignedByUserId: auditContext.actorUserId,
    };

    await insertAuditLog(connection, {
      auditContext,
      branchId: values.branchId,
      actionType: 'USER_ROLE_ASSIGNED',
      entityType: 'user_roles',
      entityRecordId: grant.userRoleId,
      afterValues: grant,
      notes: 'A global or branch-scoped role was assigned to a user.',
    });
    await connection.commit();
    return grant;
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        error.rollbackError = rollbackError;
      }
    }
    throw error;
  } finally {
    connection?.release();
  }
}

async function revokeUserRole(userId, userRoleId, auditContext) {
  if (String(auditContext.actorUserId) === userId) {
    throw new HttpError(409, 'You cannot revoke your own role assignment');
  }

  let connection;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [rows] = await connection.execute(
      `SELECT
         CAST(ur.user_role_id AS CHAR) AS userRoleId,
         CAST(ur.user_id AS CHAR) AS userId,
         CAST(ur.role_id AS CHAR) AS roleId,
         r.role_code AS roleCode,
         r.role_name AS roleName,
         CAST(ur.branch_id AS CHAR) AS branchId,
         CAST(ur.assigned_by_user_id AS CHAR) AS assignedByUserId
       FROM user_roles ur
       INNER JOIN roles r ON r.role_id = ur.role_id
       WHERE ur.user_role_id = ? AND ur.user_id = ?
       LIMIT 1
       FOR UPDATE`,
      [userRoleId, userId],
    );
    const grant = rows[0];

    if (!grant) {
      throw new HttpError(404, 'User role assignment not found');
    }

    await connection.execute('DELETE FROM user_roles WHERE user_role_id = ?', [
      userRoleId,
    ]);
    await insertAuditLog(connection, {
      auditContext,
      branchId: grant.branchId,
      actionType: 'USER_ROLE_REVOKED',
      entityType: 'user_roles',
      entityRecordId: userRoleId,
      beforeValues: grant,
      notes: 'A global or branch-scoped role was revoked from a user.',
    });
    await connection.commit();
    return grant;
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        error.rollbackError = rollbackError;
      }
    }
    throw error;
  } finally {
    connection?.release();
  }
}

export {
  assignUserRole,
  createUser,
  findUserAdminById,
  listUsers,
  resetUserPassword,
  revokeUserRole,
  updateUser,
};
