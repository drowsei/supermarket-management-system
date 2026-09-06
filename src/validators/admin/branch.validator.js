import HttpError from '../../utils/httpError.js';
import {
  assertAllowedKeys,
  assertPlainObject,
  parseDate,
  parseEmail,
  parseEnum,
  parseId,
  parseOptionalString,
  parsePagination,
  parseSearch,
  parseString,
  requireAtLeastOneKey,
} from './common.validator.js';

const BRANCH_STATUSES = ['ACTIVE', 'INACTIVE', 'CLOSED'];
const BRANCH_FIELDS = [
  'branchCode',
  'branchName',
  'phone',
  'email',
  'addressLine1',
  'addressLine2',
  'city',
  'stateRegion',
  'postalCode',
  'countryCode',
  'currencyCode',
  'timezone',
  'openedOn',
  'status',
];

function parseBusinessCode(value) {
  const code = parseString(value, 'branchCode', 20, {
    normalize: (input) => input.toUpperCase(),
  });

  if (!/^[A-Z0-9][A-Z0-9_-]*$/.test(code)) {
    throw new HttpError(
      400,
      'branchCode may contain only letters, numbers, underscores, and hyphens',
    );
  }

  return code;
}

function parseCountryCode(value) {
  const code = parseString(value, 'countryCode', 2, {
    normalize: (input) => input.toUpperCase(),
  });

  if (!/^[A-Z]{2}$/.test(code)) {
    throw new HttpError(400, 'countryCode must contain exactly two letters');
  }

  return code;
}

function parseCurrencyCode(value) {
  const code = parseString(value, 'currencyCode', 3, {
    normalize: (input) => input.toUpperCase(),
  });

  if (!/^[A-Z]{3}$/.test(code)) {
    throw new HttpError(400, 'currencyCode must contain exactly three letters');
  }

  return code;
}

function parseBranchField(field, value) {
  const parsers = {
    branchCode: () => parseBusinessCode(value),
    branchName: () => parseString(value, 'branchName', 150),
    phone: () => parseOptionalString(value, 'phone', 30),
    email: () => parseEmail(value, 'email', { nullable: true }),
    addressLine1: () => parseString(value, 'addressLine1', 255),
    addressLine2: () => parseOptionalString(value, 'addressLine2', 255),
    city: () => parseString(value, 'city', 100),
    stateRegion: () => parseOptionalString(value, 'stateRegion', 100),
    postalCode: () => parseOptionalString(value, 'postalCode', 20),
    countryCode: () => parseCountryCode(value),
    currencyCode: () => parseCurrencyCode(value),
    timezone: () => parseString(value, 'timezone', 64),
    openedOn: () => parseDate(value, 'openedOn', { nullable: true }),
    status: () => parseEnum(value, 'status', BRANCH_STATUSES),
  };

  return parsers[field]();
}

function validateCreateBranch(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, BRANCH_FIELDS);

  const required = [
    'branchCode',
    'branchName',
    'addressLine1',
    'city',
    'countryCode',
    'currencyCode',
  ];

  for (const field of required) {
    if (!Object.hasOwn(body, field)) {
      throw new HttpError(400, `${field} is required`);
    }
  }

  const result = {};
  for (const field of BRANCH_FIELDS) {
    if (Object.hasOwn(body, field)) {
      result[field] = parseBranchField(field, body[field]);
    }
  }

  return {
    phone: null,
    email: null,
    addressLine2: null,
    stateRegion: null,
    postalCode: null,
    timezone: 'UTC',
    openedOn: null,
    status: 'ACTIVE',
    ...result,
  };
}

function validateUpdateBranch(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, BRANCH_FIELDS);
  requireAtLeastOneKey(body);

  return Object.fromEntries(
    Object.entries(body).map(([field, value]) => [
      field,
      parseBranchField(field, value),
    ]),
  );
}

function validateBranchListQuery(query) {
  assertAllowedKeys(query, ['page', 'limit', 'status', 'search']);
  const pagination = parsePagination(query);

  return {
    ...pagination,
    status:
      query.status === undefined
        ? null
        : parseEnum(query.status, 'status', BRANCH_STATUSES),
    search: parseSearch(query.search),
  };
}

function validateBranchId(value) {
  return parseId(value, 'branchId');
}

export {
  validateBranchId,
  validateBranchListQuery,
  validateCreateBranch,
  validateUpdateBranch,
};
