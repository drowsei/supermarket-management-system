import HttpError from '../../utils/httpError.js';
import {
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_CHARACTERS,
} from '../../utils/password.js';
import {
  assertAllowedKeys,
  assertPlainObject,
  parseBoolean,
  parseEmail,
  parseId,
  parsePagination,
  parseSearch,
  parseString,
  requireAtLeastOneKey,
} from './common.validator.js';

const USER_CREATE_FIELDS = [
  'employeeId',
  'username',
  'email',
  'temporaryPassword',
];
const USER_UPDATE_FIELDS = ['employeeId', 'username', 'email', 'isActive'];

function parseUsername(value) {
  const username = parseString(value, 'username', 100, {
    normalize: (input) => input.toLowerCase(),
  });

  if (username.length < 3 || !/^[a-z0-9][a-z0-9._-]*$/.test(username)) {
    throw new HttpError(
      400,
      'username must be 3-100 characters using letters, numbers, dots, underscores, or hyphens',
    );
  }

  return username;
}

function parseTemporaryPassword(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpError(400, 'temporaryPassword is required');
  }

  if ([...value].length < MIN_PASSWORD_CHARACTERS) {
    throw new HttpError(
      400,
      `temporaryPassword must contain at least ${MIN_PASSWORD_CHARACTERS} characters`,
    );
  }

  if (Buffer.byteLength(value, 'utf8') > MAX_PASSWORD_BYTES) {
    throw new HttpError(
      400,
      `temporaryPassword must not exceed ${MAX_PASSWORD_BYTES} UTF-8 bytes`,
    );
  }

  return value;
}

function validateCreateUser(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, USER_CREATE_FIELDS);

  for (const field of USER_CREATE_FIELDS) {
    if (!Object.hasOwn(body, field)) {
      throw new HttpError(400, `${field} is required`);
    }
  }

  return {
    employeeId: parseId(body.employeeId, 'employeeId', { nullable: true }),
    username: parseUsername(body.username),
    email: parseEmail(body.email, 'email'),
    temporaryPassword: parseTemporaryPassword(body.temporaryPassword),
  };
}

function validateUpdateUser(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, USER_UPDATE_FIELDS);
  requireAtLeastOneKey(body);

  const changes = {};

  if (Object.hasOwn(body, 'employeeId')) {
    changes.employeeId = parseId(body.employeeId, 'employeeId', {
      nullable: true,
    });
  }
  if (Object.hasOwn(body, 'username')) {
    changes.username = parseUsername(body.username);
  }
  if (Object.hasOwn(body, 'email')) {
    changes.email = parseEmail(body.email, 'email');
  }
  if (Object.hasOwn(body, 'isActive')) {
    changes.isActive = parseBoolean(body.isActive, 'isActive');
  }

  return changes;
}

function validateResetPassword(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, ['temporaryPassword']);

  if (!Object.hasOwn(body, 'temporaryPassword')) {
    throw new HttpError(400, 'temporaryPassword is required');
  }

  return { temporaryPassword: parseTemporaryPassword(body.temporaryPassword) };
}

function validateUserListQuery(query) {
  assertAllowedKeys(query, [
    'page',
    'limit',
    'isActive',
    'employeeId',
    'search',
  ]);
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
    employeeId:
      query.employeeId === undefined
        ? null
        : parseId(query.employeeId, 'employeeId'),
    search: parseSearch(query.search, 254),
  };
}

function validateUserId(value) {
  return parseId(value, 'userId');
}

function validateAssignUserRole(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, ['roleId', 'branchId']);

  for (const field of ['roleId', 'branchId']) {
    if (!Object.hasOwn(body, field)) {
      throw new HttpError(400, `${field} is required`);
    }
  }

  return {
    roleId: parseId(body.roleId, 'roleId'),
    branchId: parseId(body.branchId, 'branchId', { nullable: true }),
  };
}

function validateUserRoleId(value) {
  return parseId(value, 'userRoleId');
}

export {
  parseTemporaryPassword,
  validateAssignUserRole,
  validateCreateUser,
  validateResetPassword,
  validateUpdateUser,
  validateUserId,
  validateUserListQuery,
  validateUserRoleId,
};
