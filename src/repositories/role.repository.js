import {
  ACCESS_CONTROL_PERMISSIONS,
  SYSTEM_ADMIN_ROLE,
} from '../config/accessControl.js';
import pool from '../config/database.js';
import { databaseBoolean, toIsoString } from '../utils/record.js';
import { insertAuditLog } from './audit.repository.js';

const ROLE_COLUMNS = `
  CAST(r.role_id AS CHAR) AS roleId,
  r.role_code AS roleCode,
  r.role_name AS roleName,
  r.description,
  r.is_active AS isActive,
  CAST((
    SELECT COUNT(*)
    FROM role_permissions permission_count
    WHERE permission_count.role_id = r.role_id
  ) AS CHAR) AS permissionCount,
  r.created_at AS createdAt,
  r.updated_at AS updatedAt
`;

const PERMISSION_COLUMNS = `
  CAST(p.permission_id AS CHAR) AS permissionId,
  p.permission_code AS permissionCode,
  p.permission_name AS permissionName,
  p.description,
  p.created_at AS createdAt,
  p.updated_at AS updatedAt
`;

const ROLE_UPDATE_COLUMNS = {
  roleCode: 'role_code',
  roleName: 'role_name',
  description: 'description',
  isActive: 'is_active',
};

function countAsSafeNumber(value, label) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error(`The ${label} count query returned an invalid result.`);
  }

  const count = BigInt(value);

  if (count > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`The ${label} count exceeds the supported API range.`);
  }

  return Number(count);
}

function normalizeRole(row) {
  if (!row) {
    return null;
  }

  return {
    roleId: row.roleId,
    roleCode: row.roleCode,
    roleName: row.roleName,
    description: row.description ?? null,
    isActive: databaseBoolean(row.isActive),
    permissionCount: countAsSafeNumber(row.permissionCount, 'role permission'),
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

function normalizePermission(row) {
  return {
    permissionId: row.permissionId,
    permissionCode: row.permissionCode,
    permissionName: row.permissionName,
    description: row.description ?? null,
    ...(row.grantedAt === undefined
      ? {}
      : { grantedAt: toIsoString(row.grantedAt) }),
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

function roleAuditSnapshot(role) {
  return {
    roleId: role.roleId,
    roleCode: role.roleCode,
    roleName: role.roleName,
    description: role.description,
    isActive: role.isActive,
  };
}

async function withTransaction(work) {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    try {
      await connection.rollback();
    } catch (rollbackError) {
      error.rollbackError = rollbackError;
    }

    throw error;
  } finally {
    connection.release();
  }
}

async function getLastInsertId(connection) {
  const [rows] = await connection.execute(
    'SELECT CAST(LAST_INSERT_ID() AS CHAR) AS insertedId',
  );

  return rows[0].insertedId;
}

async function selectRole(executor, roleId, { forUpdate = false } = {}) {
  const [rows] = await executor.execute(
    `SELECT ${ROLE_COLUMNS}
     FROM roles r
     WHERE r.role_id = ?
     ${forUpdate ? 'FOR UPDATE' : ''}`,
    [roleId],
  );

  return normalizeRole(rows[0]);
}

async function selectRolePermissions(
  executor,
  roleId,
  { forUpdate = false } = {},
) {
  const [rows] = await executor.execute(
    `SELECT
       ${PERMISSION_COLUMNS},
       rp.granted_at AS grantedAt
     FROM role_permissions rp
     INNER JOIN permissions p ON p.permission_id = rp.permission_id
     WHERE rp.role_id = ?
     ORDER BY p.permission_code, p.permission_id
     ${forUpdate ? 'FOR UPDATE' : ''}`,
    [roleId],
  );

  return rows.map(normalizePermission);
}

async function listRoles({ isActive, search, limit, offset }) {
  const predicates = [];
  const parameters = [];

  if (isActive !== null) {
    predicates.push('r.is_active = ?');
    parameters.push(isActive ? 1 : 0);
  }

  if (search) {
    predicates.push(
      `LOCATE(
         ?,
         CONCAT_WS(
           ' ',
           r.role_code,
           r.role_name,
           COALESCE(r.description, '')
         )
       ) > 0`,
    );
    parameters.push(search);
  }

  const where = predicates.length === 0 ? '' : `WHERE ${predicates.join(' AND ')}`;
  const [countRows] = await pool.execute(
    `SELECT CAST(COUNT(*) AS CHAR) AS totalItems
     FROM roles r
     ${where}`,
    parameters,
  );
  const [rows] = await pool.execute(
    `SELECT ${ROLE_COLUMNS}
     FROM roles r
     ${where}
     ORDER BY r.role_name, r.role_id
     LIMIT ? OFFSET ?`,
    [...parameters, limit, offset],
  );

  return {
    items: rows.map(normalizeRole),
    totalItems: countAsSafeNumber(countRows[0].totalItems, 'role'),
  };
}

async function findRoleById(roleId) {
  return selectRole(pool, roleId);
}

async function findPermissionsByRoleId(roleId) {
  return selectRolePermissions(pool, roleId);
}

async function listPermissions({ search, limit, offset }) {
  const predicate = search
    ? `WHERE LOCATE(
         ?,
         CONCAT_WS(
           ' ',
           p.permission_code,
           p.permission_name,
           COALESCE(p.description, '')
         )
       ) > 0`
    : '';
  const parameters = search ? [search] : [];
  const [countRows] = await pool.execute(
    `SELECT CAST(COUNT(*) AS CHAR) AS totalItems
     FROM permissions p
     ${predicate}`,
    parameters,
  );
  const [rows] = await pool.execute(
    `SELECT ${PERMISSION_COLUMNS}
     FROM permissions p
     ${predicate}
     ORDER BY p.permission_code, p.permission_id
     LIMIT ? OFFSET ?`,
    [...parameters, limit, offset],
  );

  return {
    items: rows.map(normalizePermission),
    totalItems: countAsSafeNumber(countRows[0].totalItems, 'permission'),
  };
}

async function createRoleRecord(values, auditContext) {
  return withTransaction(async (connection) => {
    await connection.execute(
      `INSERT INTO roles (
         role_code,
         role_name,
         description,
         is_active
       ) VALUES (?, ?, ?, ?)`,
      [
        values.roleCode,
        values.roleName,
        values.description,
        values.isActive ? 1 : 0,
      ],
    );
    const roleId = await getLastInsertId(connection);
    const role = await selectRole(connection, roleId);

    await insertAuditLog(connection, {
      auditContext,
      actionType: 'ROLE_CREATED',
      entityType: 'roles',
      entityRecordId: roleId,
      beforeValues: null,
      afterValues: roleAuditSnapshot(role),
      notes: 'Role created through the administration API.',
    });

    return role;
  });
}

async function updateRoleRecord(roleId, changes, auditContext) {
  return withTransaction(async (connection) => {
    const currentRole = await selectRole(connection, roleId, {
      forUpdate: true,
    });

    if (!currentRole) {
      return { outcome: 'not_found' };
    }

    const isSystemAdministrator =
      currentRole.roleCode.toUpperCase() === SYSTEM_ADMIN_ROLE.code;

    if (
      isSystemAdministrator &&
      changes.roleCode !== undefined &&
      changes.roleCode !== currentRole.roleCode
    ) {
      return { outcome: 'system_role_code_protected' };
    }

    if (
      isSystemAdministrator &&
      changes.roleName !== undefined &&
      changes.roleName !== SYSTEM_ADMIN_ROLE.name
    ) {
      return { outcome: 'system_role_name_protected' };
    }

    if (isSystemAdministrator && changes.isActive === false) {
      return { outcome: 'system_role_activation_protected' };
    }

    const changedEntries = Object.entries(changes).filter(
      ([field, value]) => currentRole[field] !== value,
    );

    if (changedEntries.length === 0) {
      return {
        outcome: 'unchanged',
        role: currentRole,
        permissions: await selectRolePermissions(connection, roleId),
      };
    }

    const assignments = changedEntries.map(
      ([field]) => `${ROLE_UPDATE_COLUMNS[field]} = ?`,
    );
    await connection.execute(
      `UPDATE roles SET ${assignments.join(', ')} WHERE role_id = ?`,
      [
        ...changedEntries.map(([field, value]) =>
          field === 'isActive' ? (value ? 1 : 0) : value,
        ),
        roleId,
      ],
    );
    const role = await selectRole(connection, roleId);
    const permissions = await selectRolePermissions(connection, roleId);

    await insertAuditLog(connection, {
      auditContext,
      actionType: 'ROLE_UPDATED',
      entityType: 'roles',
      entityRecordId: roleId,
      beforeValues: roleAuditSnapshot(currentRole),
      afterValues: roleAuditSnapshot(role),
      notes: 'Role updated through the administration API.',
    });

    return { outcome: 'updated', role, permissions };
  });
}

async function replaceRolePermissionsRecord(
  roleId,
  permissionIds,
  auditContext,
) {
  return withTransaction(async (connection) => {
    const roleBefore = await selectRole(connection, roleId, {
      forUpdate: true,
    });

    if (!roleBefore) {
      return { outcome: 'role_not_found' };
    }

    const currentPermissions = await selectRolePermissions(
      connection,
      roleId,
      { forUpdate: true },
    );
    let requestedPermissions = [];

    if (permissionIds.length > 0) {
      const placeholders = permissionIds.map(() => '?').join(', ');
      const [rows] = await connection.execute(
        `SELECT ${PERMISSION_COLUMNS}
         FROM permissions p
         WHERE p.permission_id IN (${placeholders})
         ORDER BY p.permission_code, p.permission_id
         FOR UPDATE`,
        permissionIds,
      );
      requestedPermissions = rows.map(normalizePermission);
    }

    if (requestedPermissions.length !== permissionIds.length) {
      return { outcome: 'permission_not_found' };
    }

    if (roleBefore.roleCode.toUpperCase() === SYSTEM_ADMIN_ROLE.code) {
      const requestedCodes = new Set(
        requestedPermissions.map((permission) => permission.permissionCode),
      );
      const missingCanonicalPermission = ACCESS_CONTROL_PERMISSIONS.some(
        (permission) => !requestedCodes.has(permission.code),
      );

      if (missingCanonicalPermission) {
        return { outcome: 'system_permissions_protected' };
      }
    }

    const currentIds = new Set(
      currentPermissions.map((permission) => permission.permissionId),
    );
    const requestedIds = new Set(permissionIds);
    const removedIds = [...currentIds].filter(
      (permissionId) => !requestedIds.has(permissionId),
    );
    const addedIds = permissionIds.filter(
      (permissionId) => !currentIds.has(permissionId),
    );

    if (removedIds.length === 0 && addedIds.length === 0) {
      return {
        outcome: 'unchanged',
        role: roleBefore,
        permissions: currentPermissions,
      };
    }

    if (removedIds.length > 0) {
      const placeholders = removedIds.map(() => '?').join(', ');
      await connection.execute(
        `DELETE FROM role_permissions
         WHERE role_id = ? AND permission_id IN (${placeholders})`,
        [roleId, ...removedIds],
      );
    }

    if (addedIds.length > 0) {
      const placeholders = addedIds.map(() => '(?, ?)').join(', ');
      await connection.execute(
        `INSERT INTO role_permissions (role_id, permission_id)
         VALUES ${placeholders}`,
        addedIds.flatMap((permissionId) => [roleId, permissionId]),
      );
    }

    const role = await selectRole(connection, roleId);
    const permissions = await selectRolePermissions(connection, roleId);

    await insertAuditLog(connection, {
      auditContext,
      actionType: 'ROLE_PERMISSIONS_CHANGED',
      entityType: 'roles',
      entityRecordId: roleId,
      beforeValues: {
        permissionCodes: currentPermissions.map(
          (permission) => permission.permissionCode,
        ),
      },
      afterValues: {
        permissionCodes: permissions.map(
          (permission) => permission.permissionCode,
        ),
      },
      notes: 'Role permission set replaced through the administration API.',
    });

    return { outcome: 'updated', role, permissions };
  });
}

export {
  createRoleRecord,
  findPermissionsByRoleId,
  findRoleById,
  listPermissions,
  listRoles,
  replaceRolePermissionsRecord,
  updateRoleRecord,
};
