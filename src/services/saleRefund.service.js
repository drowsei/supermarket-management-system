import {
  createSaleRefundRecord,
  listSaleRefundRecords,
  transitionSaleRefundRecord,
} from '../repositories/saleRefund.repository.js';
import HttpError from '../utils/httpError.js';

const OUTCOME_ERRORS = Object.freeze({
  actor_required: [403, 'An active employee identity is required for this operation'],
  actor_not_active: [403, 'An active employee identity is required for this operation'],
  actor_not_assigned: [403, 'The employee has no current assignment at this branch'],
  branch_not_found: [404, 'Branch not found'],
  branch_not_active: [409, 'Refund operations require an active branch'],
  sale_not_found: [404, 'Sale not found'],
  sale_not_returnable: [409, 'Only a COMPLETED sale may have return refunds'],
  return_not_found: [404, 'Sales return not found'],
  return_not_refundable: [409, 'Only a COMPLETED sales return may be refunded'],
  refund_not_found: [404, 'Sale refund not found'],
  payment_method_not_found: [404, 'Payment method not found'],
  payment_method_inactive: [409, 'The selected payment method is inactive'],
  external_reference_required: [400, 'An external reference is required for this payment method'],
  duplicate_external_reference: [409, 'That external reference already exists for this payment method'],
  payment_number_conflict: [409, 'A unique refund number could not be generated; please retry'],
  payment_conflict: [409, 'The refund conflicts with existing payment data'],
  return_refund_exceeded: [409, 'The refund would exceed this return total'],
  sale_payment_refund_exceeded: [409, 'The refund would exceed completed payment collected for the sale'],
  sale_return_refund_exceeded: [409, 'The refund would exceed completed return entitlement for the sale'],
  invalid_refund_transition: [409, 'Only a PENDING REFUND may perform this action'],
  till_not_found: [404, 'Original sale till session not found'],
  till_cancelled: [409, 'The original sale till session is cancelled'],
  cash_till_not_open: [409, 'Cash refund requires the original sale till session to remain OPEN'],
  currency_mismatch: [409, 'Sale, branch, till, and refund currencies are inconsistent'],
  concurrent_change: [409, 'Refund or related data changed concurrently; retry'],
});

function expect(result, accepted) {
  if (accepted.includes(result.outcome)) return result;
  const error = OUTCOME_ERRORS[result.outcome];
  if (!error) throw new Error(`Unknown sale refund outcome: ${result.outcome}`);
  throw new HttpError(...error);
}

async function listSaleRefunds(branchId, saleId, salesReturnId, filters) {
  return expect(
    await listSaleRefundRecords(branchId, saleId, salesReturnId, filters),
    ['found'],
  );
}

async function createSaleRefund(
  branchId, saleId, salesReturnId, values, auditContext,
) {
  return expect(await createSaleRefundRecord(
    branchId, saleId, salesReturnId, values, auditContext,
  ), ['created']).payment;
}

async function transitionSaleRefund(
  branchId,
  saleId,
  salesReturnId,
  salePaymentId,
  transition,
  auditContext,
) {
  return expect(await transitionSaleRefundRecord(
    branchId, saleId, salesReturnId, salePaymentId, transition, auditContext,
  ), ['transitioned']).payment;
}

export { createSaleRefund, listSaleRefunds, transitionSaleRefund };
