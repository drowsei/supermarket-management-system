import {
  createSalePaymentRecord,
  findSalePayment,
  listSalePaymentRecords,
  transitionSalePaymentRecord,
} from '../repositories/salePayment.repository.js';
import HttpError from '../utils/httpError.js';

const OUTCOME_ERRORS = Object.freeze({
  actor_required: [403, 'An active employee identity is required for this operation'],
  actor_not_active: [403, 'An active employee identity is required for this operation'],
  actor_not_assigned: [403, 'The employee has no current assignment at this branch'],
  cashier_not_active: [409, 'The till cashier must be an active employee'],
  cashier_not_assigned: [409, 'The till cashier has no current assignment at this branch'],
  branch_not_found: [404, 'Branch not found'],
  branch_not_active: [409, 'Payment operations require an active branch'],
  sale_not_found: [404, 'Sale not found'],
  sale_not_open: [409, 'Only an OPEN sale may accept payment operations'],
  payment_not_found: [404, 'Sale payment not found'],
  payment_method_not_found: [404, 'Payment method not found'],
  payment_method_inactive: [409, 'The selected payment method is inactive'],
  external_reference_required: [400, 'An external reference is required for this payment method'],
  duplicate_external_reference: [409, 'That external reference already exists for this payment method'],
  payment_number_conflict: [409, 'A unique payment number could not be generated; please retry'],
  payment_conflict: [409, 'The payment conflicts with existing payment data'],
  payment_overpaid: [409, 'The payment would exceed the sale total'],
  invalid_payment_transition: [409, 'Only a PENDING PAYMENT may perform this action'],
  till_not_found: [404, 'Till session not found'],
  till_not_open: [409, 'This payment operation requires an OPEN till session'],
  till_cancelled: [409, 'Payment cleanup is not allowed against a CANCELLED till session'],
  currency_mismatch: [409, 'Sale, till, and branch currencies are inconsistent'],
  concurrent_change: [409, 'Sale or related data changed concurrently; retry'],
});

function expect(result, accepted) {
  if (accepted.includes(result.outcome)) return result;
  const error = OUTCOME_ERRORS[result.outcome];
  if (!error) throw new Error(`Unknown sale payment outcome: ${result.outcome}`);
  throw new HttpError(...error);
}

async function listSalePayments(branchId, saleId, filters) {
  return expect(
    await listSalePaymentRecords(branchId, saleId, filters),
    ['found'],
  );
}

async function getSalePayment(branchId, saleId, salePaymentId) {
  return expect(
    await findSalePayment(branchId, saleId, salePaymentId),
    ['found'],
  ).payment;
}

async function createSalePayment(branchId, saleId, values, auditContext) {
  return expect(
    await createSalePaymentRecord(branchId, saleId, values, auditContext),
    ['created'],
  ).payment;
}

async function transitionSalePayment(
  branchId,
  saleId,
  salePaymentId,
  transition,
  auditContext,
) {
  return expect(
    await transitionSalePaymentRecord(
      branchId,
      saleId,
      salePaymentId,
      transition,
      auditContext,
    ),
    ['transitioned'],
  ).payment;
}

export {
  createSalePayment,
  getSalePayment,
  listSalePayments,
  transitionSalePayment,
};
