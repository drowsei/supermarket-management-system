import HttpError from '../../utils/httpError.js';
import {
  assertAllowedKeys,
  assertPlainObject,
  parseEmail,
  parseId,
  parsePagination,
  parseSearch,
  parseString,
  requireAtLeastOneKey,
} from '../admin/common.validator.js';
import {
  parseNullableSupplierString,
  parseSupplierCode,
  parseSupplierStatus,
  parseUnsignedSmallInteger,
} from './common.validator.js';

const SUPPLIER_FIELDS = Object.freeze([
  'supplierCode',
  'supplierName',
  'contactName',
  'email',
  'phone',
  'taxIdentifier',
  'addressLine1',
  'addressLine2',
  'city',
  'stateRegion',
  'postalCode',
  'countryCode',
  'paymentTermsDays',
  'status',
]);

function parseCountryCode(value) {
  const countryCode = parseNullableSupplierString(
    value,
    'countryCode',
    2,
    { normalize: (input) => input.toUpperCase() },
  );

  if (countryCode !== null && !/^[A-Z]{2}$/.test(countryCode)) {
    throw new HttpError(400, 'countryCode must contain exactly two letters');
  }

  return countryCode;
}

function parseSupplierField(field, value) {
  const parsers = {
    supplierCode: () => parseSupplierCode(value),
    supplierName: () => parseString(value, 'supplierName', 180),
    contactName: () => parseNullableSupplierString(value, 'contactName', 150),
    email: () => parseEmail(value, 'email', { nullable: true }),
    phone: () => parseNullableSupplierString(value, 'phone', 30),
    taxIdentifier: () =>
      parseNullableSupplierString(value, 'taxIdentifier', 80),
    addressLine1: () =>
      parseNullableSupplierString(value, 'addressLine1', 255),
    addressLine2: () =>
      parseNullableSupplierString(value, 'addressLine2', 255),
    city: () => parseNullableSupplierString(value, 'city', 100),
    stateRegion: () =>
      parseNullableSupplierString(value, 'stateRegion', 100),
    postalCode: () =>
      parseNullableSupplierString(value, 'postalCode', 20),
    countryCode: () => parseCountryCode(value),
    paymentTermsDays: () =>
      parseUnsignedSmallInteger(value, 'paymentTermsDays'),
    status: () => parseSupplierStatus(value),
  };

  return parsers[field]();
}

function validateSupplierId(value) {
  return parseId(value, 'supplierId');
}

function validateSupplierListQuery(query) {
  assertAllowedKeys(query, ['search', 'status', 'page', 'limit']);

  return {
    ...parsePagination(query),
    search: parseSearch(query.search, 180),
    status:
      query.status === undefined ? null : parseSupplierStatus(query.status),
  };
}

function validateCreateSupplier(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, SUPPLIER_FIELDS);

  for (const field of ['supplierCode', 'supplierName']) {
    if (!Object.hasOwn(body, field)) {
      throw new HttpError(400, `${field} is required`);
    }
  }

  return {
    supplierCode: parseSupplierCode(body.supplierCode),
    supplierName: parseString(body.supplierName, 'supplierName', 180),
    contactName:
      body.contactName === undefined
        ? null
        : parseSupplierField('contactName', body.contactName),
    email:
      body.email === undefined ? null : parseSupplierField('email', body.email),
    phone:
      body.phone === undefined ? null : parseSupplierField('phone', body.phone),
    taxIdentifier:
      body.taxIdentifier === undefined
        ? null
        : parseSupplierField('taxIdentifier', body.taxIdentifier),
    addressLine1:
      body.addressLine1 === undefined
        ? null
        : parseSupplierField('addressLine1', body.addressLine1),
    addressLine2:
      body.addressLine2 === undefined
        ? null
        : parseSupplierField('addressLine2', body.addressLine2),
    city: body.city === undefined ? null : parseSupplierField('city', body.city),
    stateRegion:
      body.stateRegion === undefined
        ? null
        : parseSupplierField('stateRegion', body.stateRegion),
    postalCode:
      body.postalCode === undefined
        ? null
        : parseSupplierField('postalCode', body.postalCode),
    countryCode:
      body.countryCode === undefined
        ? null
        : parseSupplierField('countryCode', body.countryCode),
    paymentTermsDays:
      body.paymentTermsDays === undefined
        ? 0
        : parseSupplierField('paymentTermsDays', body.paymentTermsDays),
    status:
      body.status === undefined ? 'ACTIVE' : parseSupplierField('status', body.status),
  };
}

function validateUpdateSupplier(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, SUPPLIER_FIELDS);
  requireAtLeastOneKey(body);

  return Object.fromEntries(
    Object.entries(body).map(([field, value]) => [
      field,
      parseSupplierField(field, value),
    ]),
  );
}

export {
  validateCreateSupplier,
  validateSupplierId,
  validateSupplierListQuery,
  validateUpdateSupplier,
};
