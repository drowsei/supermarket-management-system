import HttpError from '../../utils/httpError.js';
import {
  parseEnum,
  parsePagination,
} from '../admin/common.validator.js';
import {
  assertAllowedKeys,
  assertPlainObject,
  parseNullablePaymentText,
  parsePaymentAmount,
  parsePaymentId,
  parsePaymentListDates,
} from './common.validator.js';

const PAYMENT_STATUSES = Object.freeze([
  'PENDING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);
const PAYMENT_TYPES = Object.freeze(['PAYMENT', 'REFUND']);
const CREATE_FIELDS = Object.freeze([
  'paymentMethodId',
  'amount',
  'externalReference',
  'notes',
]);

function validateSalePaymentId(value) {
  return parsePaymentId(value, 'salePaymentId');
}

function validateSalePaymentListQuery(query) {
  assertAllowedKeys(query, [
    'status',
    'paymentMethodId',
    'paymentType',
    'from',
    'to',
    'page',
    'limit',
  ]);

  return {
    ...parsePagination(query),
    ...parsePaymentListDates(query),
    status:
      query.status === undefined
        ? null
        : parseEnum(query.status, 'status', PAYMENT_STATUSES),
    paymentMethodId:
      query.paymentMethodId === undefined
        ? null
        : parsePaymentId(query.paymentMethodId, 'paymentMethodId'),
    paymentType:
      query.paymentType === undefined
        ? null
        : parseEnum(query.paymentType, 'paymentType', PAYMENT_TYPES),
  };
}

function validateCreateSalePayment(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, CREATE_FIELDS);

  for (const field of ['paymentMethodId', 'amount']) {
    if (!Object.hasOwn(body, field)) {
      throw new HttpError(400, `${field} is required`);
    }
  }

  return {
    paymentMethodId: parsePaymentId(body.paymentMethodId, 'paymentMethodId'),
    amount: parsePaymentAmount(body.amount),
    externalReference:
      body.externalReference === undefined
        ? null
        : parseNullablePaymentText(
          body.externalReference,
          'externalReference',
          150,
        ),
    notes:
      body.notes === undefined
        ? null
        : parseNullablePaymentText(body.notes, 'notes', 500),
  };
}

export {
  PAYMENT_STATUSES,
  PAYMENT_TYPES,
  validateCreateSalePayment,
  validateSalePaymentId,
  validateSalePaymentListQuery,
};
