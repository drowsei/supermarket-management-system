import HttpError from '../../utils/httpError.js';
import {
  assertAllowedKeys,
  assertPlainObject,
  parseDate,
  parseEmail,
  parseEnum,
  parseId,
  parsePagination,
  parseSearch,
  parseString,
  requireAtLeastOneKey,
} from '../admin/common.validator.js';

const CUSTOMER_TYPES = Object.freeze(['INDIVIDUAL', 'BUSINESS']);
const CUSTOMER_STATUSES = Object.freeze(['ACTIVE', 'INACTIVE', 'BLOCKED']);
const CUSTOMER_FIELDS = Object.freeze([
  'customerType',
  'firstName',
  'lastName',
  'businessName',
  'email',
  'phone',
  'loyaltyNumber',
  'dateOfBirth',
  'status',
]);

function parseCustomerType(value) {
  return parseEnum(value, 'customerType', CUSTOMER_TYPES);
}

function parseCustomerStatus(value) {
  return parseEnum(value, 'status', CUSTOMER_STATUSES);
}

function parseNullableString(value, label, maximumLength) {
  return parseString(value, label, maximumLength, { nullable: true });
}

function parseCustomerField(field, value) {
  const parsers = {
    customerType: () => parseCustomerType(value),
    firstName: () => parseNullableString(value, 'firstName', 100),
    lastName: () => parseNullableString(value, 'lastName', 100),
    businessName: () => parseNullableString(value, 'businessName', 180),
    email: () => parseEmail(value, 'email', { nullable: true }),
    phone: () => parseNullableString(value, 'phone', 30),
    loyaltyNumber: () => parseNullableString(value, 'loyaltyNumber', 50),
    dateOfBirth: () => parseDate(value, 'dateOfBirth', { nullable: true }),
    status: () => parseCustomerStatus(value),
  };

  return parsers[field]();
}

function validateCustomerState(customer) {
  if (customer.customerType === 'INDIVIDUAL') {
    const hasFirstName =
      typeof customer.firstName === 'string' &&
      customer.firstName.trim().length > 0;
    const hasLastName =
      typeof customer.lastName === 'string' &&
      customer.lastName.trim().length > 0;

    if (!hasFirstName || !hasLastName) {
      throw new HttpError(
        400,
        'INDIVIDUAL customers require firstName and lastName',
      );
    }

    return customer;
  }

  const hasBusinessName =
    typeof customer.businessName === 'string' &&
    customer.businessName.trim().length > 0;

  if (!hasBusinessName) {
    throw new HttpError(400, 'BUSINESS customers require businessName');
  }

  return customer;
}

function validateCustomerId(value) {
  return parseId(value, 'customerId');
}

function validateCustomerListQuery(query) {
  assertAllowedKeys(query, [
    'search',
    'customerType',
    'status',
    'loyaltyNumber',
    'email',
    'phone',
    'page',
    'limit',
  ]);

  return {
    ...parsePagination(query),
    search: parseSearch(query.search, 254),
    customerType:
      query.customerType === undefined
        ? null
        : parseCustomerType(query.customerType),
    status:
      query.status === undefined ? null : parseCustomerStatus(query.status),
    loyaltyNumber:
      query.loyaltyNumber === undefined
        ? null
        : parseNullableString(query.loyaltyNumber, 'loyaltyNumber', 50),
    email:
      query.email === undefined
        ? null
        : parseEmail(query.email, 'email'),
    phone:
      query.phone === undefined
        ? null
        : parseNullableString(query.phone, 'phone', 30),
  };
}

function validateCreateCustomer(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, CUSTOMER_FIELDS);

  if (!Object.hasOwn(body, 'customerType')) {
    throw new HttpError(400, 'customerType is required');
  }

  const values = {
    customerType: parseCustomerType(body.customerType),
    firstName:
      body.firstName === undefined
        ? null
        : parseCustomerField('firstName', body.firstName),
    lastName:
      body.lastName === undefined
        ? null
        : parseCustomerField('lastName', body.lastName),
    businessName:
      body.businessName === undefined
        ? null
        : parseCustomerField('businessName', body.businessName),
    email:
      body.email === undefined ? null : parseCustomerField('email', body.email),
    phone:
      body.phone === undefined ? null : parseCustomerField('phone', body.phone),
    loyaltyNumber:
      body.loyaltyNumber === undefined
        ? null
        : parseCustomerField('loyaltyNumber', body.loyaltyNumber),
    dateOfBirth:
      body.dateOfBirth === undefined
        ? null
        : parseCustomerField('dateOfBirth', body.dateOfBirth),
    status:
      body.status === undefined ? 'ACTIVE' : parseCustomerField('status', body.status),
  };

  return validateCustomerState(values);
}

function validateUpdateCustomer(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, CUSTOMER_FIELDS);
  requireAtLeastOneKey(body);

  return Object.fromEntries(
    Object.entries(body).map(([field, value]) => [
      field,
      parseCustomerField(field, value),
    ]),
  );
}

function validateNoCustomerQuery(query) {
  if (Object.keys(query).length > 0) {
    throw new HttpError(400, 'This endpoint does not accept query parameters');
  }
}

export {
  CUSTOMER_STATUSES,
  CUSTOMER_TYPES,
  validateCreateCustomer,
  validateCustomerId,
  validateCustomerListQuery,
  validateCustomerState,
  validateNoCustomerQuery,
  validateUpdateCustomer,
};
