import HttpError from '../../utils/httpError.js';
import { parseId, parsePagination } from '../admin/common.validator.js';
import { parsePaymentAmount } from '../payments/common.validator.js';
import {
  assertAllowedKeys,
  assertPlainObject,
  parseNullableReturnText,
  parseRefundId,
} from './common.validator.js';

const CREATE_FIELDS = Object.freeze([
  'paymentMethodId',
  'amount',
  'externalReference',
  'notes',
]);

function validateSaleRefundId(value) {
  return parseRefundId(value);
}

function validateSaleRefundListQuery(query) {
  assertAllowedKeys(query, ['page', 'limit']);
  return parsePagination(query);
}

function validateCreateSaleRefund(body) {
  assertPlainObject(body);
  assertAllowedKeys(body, CREATE_FIELDS);
  for (const field of ['paymentMethodId', 'amount']) {
    if (!Object.hasOwn(body, field)) {
      throw new HttpError(400, `${field} is required`);
    }
  }
  return {
    paymentMethodId: parseId(body.paymentMethodId, 'paymentMethodId'),
    amount: parsePaymentAmount(body.amount),
    externalReference: body.externalReference === undefined
      ? null
      : parseNullableReturnText(body.externalReference, 'externalReference', 150),
    notes: body.notes === undefined
      ? null
      : parseNullableReturnText(body.notes, 'notes', 500),
  };
}

export {
  validateCreateSaleRefund,
  validateSaleRefundId,
  validateSaleRefundListQuery,
};
