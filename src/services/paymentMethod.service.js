import {
  createPaymentMethodRecord,
  findPaymentMethodById,
  listPaymentMethodRecords,
  updatePaymentMethodRecord,
} from '../repositories/paymentMethod.repository.js';
import { rethrowDuplicateAsConflict } from '../utils/databaseError.js';
import HttpError from '../utils/httpError.js';

async function listPaymentMethods(filters) {
  return listPaymentMethodRecords(filters);
}

async function getPaymentMethod(paymentMethodId) {
  const paymentMethod = await findPaymentMethodById(paymentMethodId);
  if (!paymentMethod) throw new HttpError(404, 'Payment method not found');
  return paymentMethod;
}

async function createPaymentMethod(values, auditContext) {
  try {
    return await createPaymentMethodRecord(values, auditContext);
  } catch (error) {
    rethrowDuplicateAsConflict(
      error,
      'Payment method code or name already exists',
    );
  }
}

async function updatePaymentMethod(paymentMethodId, changes, auditContext) {
  let result;

  try {
    result = await updatePaymentMethodRecord(
      paymentMethodId,
      changes,
      auditContext,
    );
  } catch (error) {
    rethrowDuplicateAsConflict(
      error,
      'Payment method code or name already exists',
    );
  }

  if (result.outcome === 'not_found') {
    throw new HttpError(404, 'Payment method not found');
  }

  return result.paymentMethod;
}

export {
  createPaymentMethod,
  getPaymentMethod,
  listPaymentMethods,
  updatePaymentMethod,
};
