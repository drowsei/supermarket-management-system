import pool from '../config/database.js';

const SAFE_USER_COLUMNS = `
  CAST(u.user_id AS CHAR) AS userId,
  CAST(u.employee_id AS CHAR) AS employeeId,
  u.username,
  u.email,
  u.is_active AS isActive,
  u.must_change_password AS mustChangePassword,
  u.last_login_at AS lastLoginAt
`;

function databaseBoolean(value) {
  return value === true || value === 1 || value === '1';
}

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
    lastLoginAt: row.lastLoginAt ?? null,
  };
}

async function findUsersByIdentifier(identifier) {
  const [rows] = await pool.execute(
    `SELECT
       ${SAFE_USER_COLUMNS},
       u.password_hash AS passwordHash
     FROM users u
     WHERE u.username = ? OR u.email = ?
     LIMIT 2`,
    [identifier, identifier],
  );

  return rows.map((row) => ({
    ...normalizeUser(row),
    passwordHash: row.passwordHash,
  }));
}

async function findUserById(userId) {
  const [rows] = await pool.execute(
    `SELECT ${SAFE_USER_COLUMNS}
     FROM users u
     WHERE u.user_id = ?
     LIMIT 1`,
    [userId],
  );

  return normalizeUser(rows[0]);
}

async function findPasswordStateByUserId(userId) {
  const [rows] = await pool.execute(
    `SELECT
       ${SAFE_USER_COLUMNS},
       u.password_hash AS passwordHash
     FROM users u
     WHERE u.user_id = ?
     LIMIT 1`,
    [userId],
  );
  const row = rows[0];

  if (!row) {
    return null;
  }

  return {
    ...normalizeUser(row),
    passwordHash: row.passwordHash,
  };
}

async function recordSuccessfulLogin(userId, expectedPasswordHash) {
  const [result] = await pool.execute(
    `UPDATE users
     SET last_login_at = CURRENT_TIMESTAMP(6)
     WHERE user_id = ?
       AND BINARY password_hash = BINARY ?
       AND is_active = 1`,
    [userId, expectedPasswordHash],
  );

  if (result.affectedRows !== 1) {
    return null;
  }

  return findUserById(userId);
}

async function findAuthorizationRows(userId) {
  const [roleResult, permissionResult] = await Promise.all([
    pool.execute(
      `SELECT
         r.role_code AS roleCode,
         r.role_name AS roleName,
         CAST(ur.branch_id AS CHAR) AS branchId
       FROM user_roles ur
       INNER JOIN roles r
         ON r.role_id = ur.role_id
        AND r.is_active = 1
       WHERE ur.user_id = ?`,
      [userId],
    ),
    pool.execute(
      `SELECT DISTINCT
         CAST(ur.branch_id AS CHAR) AS branchId,
         p.permission_code AS permissionCode
       FROM user_roles ur
       INNER JOIN roles r
         ON r.role_id = ur.role_id
        AND r.is_active = 1
       INNER JOIN role_permissions rp
         ON rp.role_id = r.role_id
       INNER JOIN permissions p
         ON p.permission_id = rp.permission_id
       WHERE ur.user_id = ?`,
      [userId],
    ),
  ]);

  return {
    roles: roleResult[0],
    permissions: permissionResult[0],
  };
}

async function hasGlobalPermission(userId, permissionCode) {
  const [rows] = await pool.execute(
    `SELECT 1 AS allowed
     FROM users u
     INNER JOIN user_roles ur
       ON ur.user_id = u.user_id
     INNER JOIN roles r
       ON r.role_id = ur.role_id
      AND r.is_active = 1
     INNER JOIN role_permissions rp
       ON rp.role_id = r.role_id
     INNER JOIN permissions p
       ON p.permission_id = rp.permission_id
     WHERE u.user_id = ?
       AND u.is_active = 1
       AND ur.branch_id IS NULL
       AND p.permission_code = ?
     LIMIT 1`,
    [userId, permissionCode],
  );

  return rows.length === 1;
}

async function findBranchAuthorization(userId, branchId, permissionCode) {
  const [rows] = await pool.execute(
    `SELECT
       CAST(u.employee_id AS CHAR) AS employeeId,
       EXISTS (
         SELECT 1
         FROM branches b
         WHERE b.branch_id = ?
       ) AS branchExists,
       EXISTS (
         SELECT 1
         FROM user_roles ur
         INNER JOIN roles r
           ON r.role_id = ur.role_id
          AND r.is_active = 1
         INNER JOIN role_permissions rp
           ON rp.role_id = r.role_id
         INNER JOIN permissions p
           ON p.permission_id = rp.permission_id
         WHERE ur.user_id = u.user_id
           AND p.permission_code = ?
           AND (ur.branch_id IS NULL OR ur.branch_id = ?)
       ) AS hasPermission,
       CASE
         WHEN u.employee_id IS NULL THEN 1
         ELSE EXISTS (
           SELECT 1
           FROM employees e
           INNER JOIN employee_branch_assignments eba
             ON eba.employee_id = e.employee_id
           WHERE e.employee_id = u.employee_id
             AND e.employment_status = 'ACTIVE'
             AND eba.branch_id = ?
             AND eba.started_on <= CURRENT_DATE()
             AND (eba.ended_on IS NULL OR eba.ended_on >= CURRENT_DATE())
         )
       END AS hasEmployeeAccess
     FROM users u
     WHERE u.user_id = ? AND u.is_active = 1
     LIMIT 1`,
    [branchId, permissionCode, branchId, branchId, userId],
  );
  const row = rows[0];

  if (!row) {
    return null;
  }

  return {
    branchExists: databaseBoolean(row.branchExists),
    employeeId: row.employeeId ?? null,
    hasEmployeeAccess: databaseBoolean(row.hasEmployeeAccess),
    hasPermission: databaseBoolean(row.hasPermission),
  };
}

async function changePasswordWithAudit({
  userId,
  expectedPasswordHash,
  newPasswordHash,
  auditContext,
}) {
  let connection;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [rows] = await connection.execute(
      `SELECT
         CAST(employee_id AS CHAR) AS employeeId,
         password_hash AS passwordHash,
         is_active AS isActive,
         must_change_password AS mustChangePassword
       FROM users
       WHERE user_id = ?
       FOR UPDATE`,
      [userId],
    );
    const currentState = rows[0];

    if (!currentState || !databaseBoolean(currentState.isActive)) {
      await connection.rollback();
      return 'inactive';
    }

    if (currentState.passwordHash !== expectedPasswordHash) {
      await connection.rollback();
      return 'conflict';
    }

    await connection.execute(
      `UPDATE users
       SET password_hash = ?, must_change_password = 0
       WHERE user_id = ?`,
      [newPasswordHash, userId],
    );

    await connection.execute(
      `INSERT INTO audit_logs (
         user_id,
         employee_id,
         action_type,
         entity_type,
         entity_record_id,
         before_values,
         after_values,
         ip_address,
         user_agent,
         request_id,
         notes
       ) VALUES (?, ?, 'PASSWORD_CHANGED', 'users', ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        currentState.employeeId,
        userId,
        JSON.stringify({
          mustChangePassword: databaseBoolean(currentState.mustChangePassword),
        }),
        JSON.stringify({ mustChangePassword: false }),
        auditContext.ipAddress ?? null,
        auditContext.userAgent ?? null,
        auditContext.requestId ?? null,
        'Password changed by the authenticated user.',
      ],
    );

    await connection.commit();
    return 'updated';
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
  changePasswordWithAudit,
  findAuthorizationRows,
  findBranchAuthorization,
  findPasswordStateByUserId,
  findUserById,
  findUsersByIdentifier,
  hasGlobalPermission,
  recordSuccessfulLogin,
};
