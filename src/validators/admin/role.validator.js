import HttpError from '../../utils/httpError.js';
import {
  assertAllowedKeys,
  assertPlainObject,
  parseBoolean,
  parseId,
  parseOptionalString,
  parsePagination,
  parseSearch,
  parseString,
  requireAtLeastOneKey,
} from './common.validator.js';

const ROLE_FIELDS = ['roleCode', 'roleName', 'description', 'isActive'];
const MAX_PERMISSION_IDS = 1000;

function parseRoleCode(value) {
  const roleCode = parseString(value, 'roleCode', 50, {
    normalize: (input) => input.toUpperCase(),
  });

  if (!/^[A-Z0-9][A-Z0-9_-]*$/.test(roleCode)) {
    throw new HttpError(
      400,
      'roleCode may contain only letters, numbers, underscores, and hyphens',
    );
  }

  return roleCode;
}

function validateRoleId(value) {
  return parseId(value, 'roleId');
}

function validateRoleListQuery(query) {
  assertAllowedKeys(query, ['page', 'limit', 'isActive', 'search']);
  const pagination = parsePagination(query);
  let isActive = null;

  if (query.isActive !== undefined) {
    if (query.isActive !== 'true' && query.isActive !== 'false') {
      throw new HttpError(400, 'isActive must be true or false');
    }

    isActive = query.isActive === 'true';
  }

  return {
    ...pagination,
    isActive,
    search: parseSearch(query.search, 150),
  };
}

function validatePermissionListQuery(query) {
  assertAllowedKeys(query, ['page', 'limit', 'search']);

  return {
    ...parsePagination(query),
    search: parseSearch(query.search, 150),
  };
}

function validateCreateRole(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, ROLE_FIELDS);

  for (const field of ['roleCode', 'roleName']) {
    if (!Object.hasOwn(body, field)) {
      throw new HttpError(400, `${field} is required`);
    }
  }

  return {
    roleCode: parseRoleCode(body.roleCode),
    roleName: parseString(body.roleName, 'roleName', 100),
    description:
      body.description === undefined
        ? null
        : parseOptionalString(body.description, 'description', 500),
    isActive:
      body.isActive === undefined
        ? true
        : parseBoolean(body.isActive, 'isActive'),
  };
}

function validateUpdateRole(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, ROLE_FIELDS);
  requireAtLeastOneKey(body);

  const changes = {};

  if (Object.hasOwn(body, 'roleCode')) {
    changes.roleCode = parseRoleCode(body.roleCode);
  }
  if (Object.hasOwn(body, 'roleName')) {
    changes.roleName = parseString(body.roleName, 'roleName', 100);
  }
  if (Object.hasOwn(body, 'description')) {
    changes.description = parseOptionalString(
      body.description,
      'description',
      500,
    );
  }
  if (Object.hasOwn(body, 'isActive')) {
    changes.isActive = parseBoolean(body.isActive, 'isActive');
  }

  return changes;
}

function validateReplaceRolePermissions(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, ['permissionIds']);

  if (!Object.hasOwn(body, 'permissionIds')) {
    throw new HttpError(400, 'permissionIds is required');
  }

  if (!Array.isArray(body.permissionIds)) {
    throw new HttpError(400, 'permissionIds must be an array');
  }

  if (body.permissionIds.length > MAX_PERMISSION_IDS) {
    throw new HttpError(
      400,
      `permissionIds must not contain more than ${MAX_PERMISSION_IDS} entries`,
    );
  }

  const permissionIds = body.permissionIds.map((permissionId) =>
    parseId(permissionId, 'permissionId'),
  );

  if (new Set(permissionIds).size !== permissionIds.length) {
    throw new HttpError(400, 'permissionIds must not contain duplicates');
  }

  return { permissionIds };
}

export {
  validateCreateRole,
  validatePermissionListQuery,
  validateReplaceRolePermissions,
  validateRoleId,
  validateRoleListQuery,
  validateUpdateRole,
};
