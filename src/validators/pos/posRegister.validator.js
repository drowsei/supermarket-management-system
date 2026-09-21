import HttpError from '../../utils/httpError.js';
import {
  parseEnum,
  parsePagination,
  parseSearch,
  requireAtLeastOneKey,
} from '../admin/common.validator.js';
import {
  assertAllowedKeys,
  assertPlainObject,
  parseNullableText,
  parsePosId,
  parseString,
} from './common.validator.js';

const POS_REGISTER_STATUSES = Object.freeze([
  'ACTIVE',
  'INACTIVE',
  'MAINTENANCE',
]);
const POS_REGISTER_FIELDS = Object.freeze([
  'registerCode',
  'registerName',
  'terminalIdentifier',
  'status',
]);

function parseRegisterField(field, value) {
  const parsers = {
    registerCode: () => parseString(value, 'registerCode', 30),
    registerName: () => parseString(value, 'registerName', 100),
    terminalIdentifier: () =>
      parseNullableText(value, 'terminalIdentifier', 150),
    status: () => parseEnum(value, 'status', POS_REGISTER_STATUSES),
  };

  return parsers[field]();
}

function validatePosRegisterId(value) {
  return parsePosId(value, 'posRegisterId');
}

function validatePosRegisterListQuery(query) {
  assertAllowedKeys(query, ['search', 'status', 'page', 'limit']);

  return {
    ...parsePagination(query),
    search: parseSearch(query.search, 180),
    status:
      query.status === undefined
        ? null
        : parseEnum(query.status, 'status', POS_REGISTER_STATUSES),
  };
}

function validateCreatePosRegister(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, POS_REGISTER_FIELDS);

  for (const field of ['registerCode', 'registerName']) {
    if (!Object.hasOwn(body, field)) {
      throw new HttpError(400, `${field} is required`);
    }
  }

  return {
    registerCode: parseRegisterField('registerCode', body.registerCode),
    registerName: parseRegisterField('registerName', body.registerName),
    terminalIdentifier:
      body.terminalIdentifier === undefined
        ? null
        : parseRegisterField('terminalIdentifier', body.terminalIdentifier),
    status:
      body.status === undefined
        ? 'ACTIVE'
        : parseRegisterField('status', body.status),
  };
}

function validateUpdatePosRegister(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, POS_REGISTER_FIELDS);
  requireAtLeastOneKey(body);

  return Object.fromEntries(
    Object.entries(body).map(([field, value]) => [
      field,
      parseRegisterField(field, value),
    ]),
  );
}

export {
  POS_REGISTER_STATUSES,
  validateCreatePosRegister,
  validatePosRegisterId,
  validatePosRegisterListQuery,
  validateUpdatePosRegister,
};
