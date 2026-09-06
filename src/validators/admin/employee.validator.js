import HttpError from '../../utils/httpError.js';
import {
  assertAllowedKeys,
  assertPlainObject,
  parseBoolean,
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

const EMPLOYEE_FIELDS = [
  'employeeNumber',
  'firstName',
  'lastName',
  'email',
  'phone',
  'hireDate',
  'employmentStatus',
];
const ASSIGNMENT_FIELDS = ['branchId', 'jobTitle', 'startedOn', 'isPrimary'];
const EDITABLE_EMPLOYMENT_STATUSES = ['ACTIVE', 'ON_LEAVE'];
const ALL_EMPLOYMENT_STATUSES = [
  ...EDITABLE_EMPLOYMENT_STATUSES,
  'TERMINATED',
];

function parseEmployeeNumber(value) {
  return parseString(value, 'employeeNumber', 32, {
    normalize: (input) => input.toUpperCase(),
  });
}

function parseEmploymentStatus(value) {
  if (value === 'TERMINATED') {
    throw new HttpError(
      400,
      'Use the termination endpoint to set employmentStatus to TERMINATED',
    );
  }

  return parseEnum(
    value,
    'employmentStatus',
    EDITABLE_EMPLOYMENT_STATUSES,
  );
}

function validateEmployeeId(value, label = 'employeeId') {
  return parseId(value, label);
}

function validateEmployeeListQuery(query) {
  assertAllowedKeys(query, [
    'page',
    'limit',
    'employmentStatus',
    'branchId',
    'search',
  ]);
  const { page, limit, offset } = parsePagination(query);

  if (!Number.isSafeInteger(offset)) {
    throw new HttpError(400, 'page is too large');
  }

  return {
    page,
    limit,
    offset,
    employmentStatus:
      query.employmentStatus === undefined
        ? null
        : parseEnum(
            query.employmentStatus,
            'employmentStatus',
            ALL_EMPLOYMENT_STATUSES,
          ),
    branchId:
      query.branchId === undefined
        ? null
        : parseId(query.branchId, 'branchId'),
    search: parseSearch(query.search, 100),
  };
}

function validateCreateEmployeeInput(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, EMPLOYEE_FIELDS);

  return {
    employeeNumber: parseEmployeeNumber(body.employeeNumber),
    firstName: parseString(body.firstName, 'firstName', 100),
    lastName: parseString(body.lastName, 'lastName', 100),
    email:
      body.email === undefined
        ? null
        : parseEmail(body.email, 'email', { nullable: true }),
    phone:
      body.phone === undefined
        ? null
        : parseOptionalString(body.phone, 'phone', 30),
    hireDate: parseDate(body.hireDate, 'hireDate'),
    employmentStatus:
      body.employmentStatus === undefined
        ? 'ACTIVE'
        : parseEmploymentStatus(body.employmentStatus),
  };
}

function validateUpdateEmployeeInput(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, EMPLOYEE_FIELDS);
  requireAtLeastOneKey(body);

  const update = {};

  if (Object.hasOwn(body, 'employeeNumber')) {
    update.employeeNumber = parseEmployeeNumber(body.employeeNumber);
  }

  if (Object.hasOwn(body, 'firstName')) {
    update.firstName = parseString(body.firstName, 'firstName', 100);
  }

  if (Object.hasOwn(body, 'lastName')) {
    update.lastName = parseString(body.lastName, 'lastName', 100);
  }

  if (Object.hasOwn(body, 'email')) {
    update.email = parseEmail(body.email, 'email', { nullable: true });
  }

  if (Object.hasOwn(body, 'phone')) {
    update.phone = parseOptionalString(body.phone, 'phone', 30);
  }

  if (Object.hasOwn(body, 'hireDate')) {
    update.hireDate = parseDate(body.hireDate, 'hireDate');
  }

  if (Object.hasOwn(body, 'employmentStatus')) {
    update.employmentStatus = parseEmploymentStatus(body.employmentStatus);
  }

  return update;
}

function validateTerminateEmployeeInput(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, ['terminationDate']);

  return {
    terminationDate: parseDate(body.terminationDate, 'terminationDate'),
  };
}

function validateCreateAssignmentInput(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, ASSIGNMENT_FIELDS);

  return {
    branchId: parseId(body.branchId, 'branchId'),
    jobTitle: parseString(body.jobTitle, 'jobTitle', 100),
    startedOn: parseDate(body.startedOn, 'startedOn'),
    isPrimary:
      body.isPrimary === undefined
        ? false
        : parseBoolean(body.isPrimary, 'isPrimary'),
  };
}

function validateEndAssignmentInput(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, ['endedOn']);

  return { endedOn: parseDate(body.endedOn, 'endedOn') };
}

function validateEmptyInput(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, []);
}

export {
  validateCreateAssignmentInput,
  validateCreateEmployeeInput,
  validateEmployeeId,
  validateEmployeeListQuery,
  validateEmptyInput,
  validateEndAssignmentInput,
  validateTerminateEmployeeInput,
  validateUpdateEmployeeInput,
};
