import {
  ACCESS_CONTROL_PERMISSIONS,
  SYSTEM_ADMIN_ROLE,
} from '../config/accessControl.js';
import { databaseBoolean } from '../utils/record.js';

class AccessControlSeedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AccessControlSeedError';
  }
}

async function upsertCanonicalPermissions(connection) {
  for (const permission of ACCESS_CONTROL_PERMISSIONS) {
    await connection.execute(
      `INSERT INTO permissions (
         permission_code,
         permission_name,
         description
       ) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         permission_code = ?,
         permission_name = ?,
         description = ?`,
      [
        permission.code,
        permission.name,
        permission.description,
        permission.code,
        permission.name,
        permission.description,
      ],
    );
  }

  const permissionCodes = ACCESS_CONTROL_PERMISSIONS.map(
    (permission) => permission.code,
  );
  const placeholders = permissionCodes.map(() => '?').join(', ');
  const [rows] = await connection.execute(
    `SELECT
       CAST(permission_id AS CHAR) AS permissionId,
       permission_code AS permissionCode
     FROM permissions
     WHERE permission_code IN (${placeholders})
     ORDER BY permission_code
     FOR UPDATE`,
    permissionCodes,
  );

  if (rows.length !== ACCESS_CONTROL_PERMISSIONS.length) {
    throw new AccessControlSeedError(
      'The canonical permission catalog could not be established.',
    );
  }

  return rows;
}

async function ensureSystemAdministratorRole(connection) {
  await connection.execute(
    `INSERT INTO roles (
       role_code,
       role_name,
       description,
       is_active
     ) VALUES (?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE role_id = LAST_INSERT_ID(role_id)`,
    [
      SYSTEM_ADMIN_ROLE.code,
      SYSTEM_ADMIN_ROLE.name,
      SYSTEM_ADMIN_ROLE.description,
    ],
  );

  const [rows] = await connection.execute(
    `SELECT
       CAST(role_id AS CHAR) AS roleId,
       role_code AS roleCode,
       role_name AS roleName,
       is_active AS isActive
     FROM roles
     WHERE role_code = ? OR role_name = ?
     ORDER BY role_id
     FOR UPDATE`,
    [SYSTEM_ADMIN_ROLE.code, SYSTEM_ADMIN_ROLE.name],
  );

  const canonicalCodeRows = rows.filter(
    (row) =>
      row.roleCode?.toLocaleUpperCase('en-US') === SYSTEM_ADMIN_ROLE.code,
  );
  const conflictingNameRows = rows.filter(
    (row) =>
      row.roleName?.toLocaleLowerCase('en-US') ===
        SYSTEM_ADMIN_ROLE.name.toLocaleLowerCase('en-US') &&
      row.roleCode?.toLocaleUpperCase('en-US') !== SYSTEM_ADMIN_ROLE.code,
  );

  if (canonicalCodeRows.length !== 1 || conflictingNameRows.length > 0) {
    throw new AccessControlSeedError(
      'SYSTEM_ADMIN conflicts with an existing role code or role name.',
    );
  }

  const role = canonicalCodeRows[0];

  await connection.execute(
    `UPDATE roles
     SET role_code = ?, role_name = ?, description = ?
     WHERE role_id = ?`,
    [
      SYSTEM_ADMIN_ROLE.code,
      SYSTEM_ADMIN_ROLE.name,
      SYSTEM_ADMIN_ROLE.description,
      role.roleId,
    ],
  );

  return {
    roleId: role.roleId,
    isActive: databaseBoolean(role.isActive),
  };
}

async function assignCanonicalPermissions(connection, roleId, permissions) {
  for (const permission of permissions) {
    await connection.execute(
      `INSERT INTO role_permissions (role_id, permission_id)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE granted_at = role_permissions.granted_at`,
      [roleId, permission.permissionId],
    );
  }

  const permissionCodes = ACCESS_CONTROL_PERMISSIONS.map(
    (permission) => permission.code,
  );
  const placeholders = permissionCodes.map(() => '?').join(', ');
  const [rows] = await connection.execute(
    `SELECT COUNT(*) AS assignedPermissionCount
     FROM role_permissions rp
     INNER JOIN permissions p
       ON p.permission_id = rp.permission_id
     WHERE rp.role_id = ?
       AND p.permission_code IN (${placeholders})`,
    [roleId, ...permissionCodes],
  );
  const assignedPermissionCount = Number(rows[0]?.assignedPermissionCount);

  if (assignedPermissionCount !== ACCESS_CONTROL_PERMISSIONS.length) {
    throw new AccessControlSeedError(
      'SYSTEM_ADMIN did not receive every canonical permission.',
    );
  }

  return assignedPermissionCount;
}

async function ensureAccessControl(connection) {
  const permissions = await upsertCanonicalPermissions(connection);
  const systemAdminRole = await ensureSystemAdministratorRole(connection);
  const assignedPermissionCount = await assignCanonicalPermissions(
    connection,
    systemAdminRole.roleId,
    permissions,
  );

  return {
    permissionCount: permissions.length,
    assignedPermissionCount,
    systemAdminRole,
  };
}

async function findActiveGlobalSystemAdministrator(
  executor,
  { lock = false } = {},
) {
  const lockClause = lock ? ' FOR UPDATE' : '';
  const [rows] = await executor.execute(
    `SELECT CAST(u.user_id AS CHAR) AS userId
     FROM users u
     INNER JOIN user_roles ur
       ON ur.user_id = u.user_id
      AND ur.branch_id IS NULL
     INNER JOIN roles r
       ON r.role_id = ur.role_id
      AND r.is_active = 1
     WHERE u.is_active = 1
       AND r.role_code = ?
     ORDER BY u.user_id
     LIMIT 1${lockClause}`,
    [SYSTEM_ADMIN_ROLE.code],
  );

  return rows[0]?.userId ?? null;
}

export {
  AccessControlSeedError,
  ensureAccessControl,
  findActiveGlobalSystemAdministrator,
};
