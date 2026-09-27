import {
  completeSalesReturnRecord,
  createSalesReturnItemRecord,
  createSalesReturnRecord,
  deleteSalesReturnItemRecord,
  findSalesReturn,
  listSalesReturnRecords,
  transitionSalesReturnRecord,
  updateSalesReturnItemRecord,
} from '../repositories/salesReturn.repository.js';
import HttpError from '../utils/httpError.js';

const OUTCOME_ERRORS = Object.freeze({
  actor_required: [403, 'An active employee identity is required for this operation'],
  actor_not_active: [403, 'An active employee identity is required for this operation'],
  actor_not_assigned: [403, 'The employee has no current assignment at this branch'],
  branch_not_found: [404, 'Branch not found'],
  branch_not_active: [409, 'Return operations require an active branch'],
  sale_not_found: [404, 'Sale not found'],
  sale_item_not_found: [404, 'Original sale item not found'],
  sale_not_returnable: [409, 'Only a COMPLETED sale is eligible for return'],
  return_not_found: [404, 'Sales return not found'],
  return_item_not_found: [404, 'Sales return item not found'],
  return_reason_not_found: [404, 'Return reason not found'],
  return_reason_inactive: [409, 'The selected return reason is inactive'],
  return_not_editable: [409, 'Only a DRAFT sales return may be edited'],
  return_not_submittable: [409, 'Only a DRAFT approval-required return may be submitted'],
  return_not_approvable: [409, 'Only a PENDING_APPROVAL return may be approved'],
  return_not_completable: [409, 'The sales return is not ready for completion'],
  return_not_cancellable: [409, 'This sales return can no longer be cancelled'],
  return_empty: [409, 'A sales return must contain at least one item'],
  approval_not_required: [409, 'This sales return does not require approval'],
  self_approval: [409, 'The employee who processed a return cannot approve it'],
  return_refund_active: [409, 'A return with a pending or completed refund cannot be cancelled'],
  return_item_conflict: [409, 'That original sale item already exists on this return'],
  return_quantity_exceeded: [409, 'Cumulative returned quantity exceeds the original sale quantity'],
  return_value_conflict: [409, 'Cumulative return value conflicts with the original sale value'],
  invalid_restockable_condition: [409, 'Damaged or expired items cannot be restockable'],
  fractional_quantity: [409, 'The product variant requires a whole returned quantity'],
  base_quantity_zero: [409, 'The returned package quantity converts to zero base quantity'],
  original_cost_missing: [409, 'Original sale unit cost is required to complete the return'],
  line_number_overflow: [409, 'The sales return has reached its supported line-number limit'],
  return_number_conflict: [409, 'A unique return number could not be generated; please retry'],
  concurrent_change: [409, 'Return or related data changed concurrently; retry'],
  lot_not_found: [409, 'Original lot evidence is no longer available'],
  lot_provenance_conflict: [409, 'Returned lot quantity cannot be reconciled to original sale lot evidence'],
  lots_not_allowed: [409, 'Lot evidence is not allowed for this product variant'],
  lots_required: [409, 'Complete original lot evidence is required for this product variant'],
  lot_quantity_mismatch: [409, 'Return lot quantity does not match the returned stock quantity'],
  unsafe_lot: [409, 'The original lot is not eligible to receive returned stock'],
  lot_consistency: [409, 'Completion would violate required-lot inventory consistency'],
  insufficient_stock: [409, 'Return inventory projection failed'],
  lot_insufficient_stock: [409, 'Return lot inventory projection failed'],
});

function expect(result, accepted) {
  if (accepted.includes(result.outcome)) return result;
  const error = OUTCOME_ERRORS[result.outcome];
  if (!error) throw new Error(`Unknown sales return outcome: ${result.outcome}`);
  throw new HttpError(...error);
}

async function translate(operation) {
  try {
    return await operation();
  } catch (error) {
    if (['SALES_ARITHMETIC_OVERFLOW', 'INVENTORY_QUANTITY_OVERFLOW'].includes(error?.code)) {
      throw new HttpError(409, 'Return quantity or money exceeds the supported range');
    }
    throw error;
  }
}

async function listSalesReturns(branchId, saleId, filters) {
  return expect(await listSalesReturnRecords(branchId, saleId, filters), ['found']);
}

async function getSalesReturn(branchId, saleId, salesReturnId) {
  return expect(await findSalesReturn(branchId, saleId, salesReturnId), ['found']).salesReturn;
}

async function createSalesReturn(branchId, saleId, values, auditContext) {
  return translate(async () => expect(
    await createSalesReturnRecord(branchId, saleId, values, auditContext),
    ['created'],
  ).salesReturn);
}

async function createSalesReturnItem(
  branchId, saleId, salesReturnId, values, auditContext,
) {
  return translate(async () => expect(
    await createSalesReturnItemRecord(
      branchId, saleId, salesReturnId, values, auditContext,
    ),
    ['created'],
  ));
}

async function updateSalesReturnItem(
  branchId, saleId, salesReturnId, salesReturnItemId, changes, auditContext,
) {
  return translate(async () => expect(
    await updateSalesReturnItemRecord(
      branchId, saleId, salesReturnId, salesReturnItemId, changes, auditContext,
    ),
    ['updated', 'unchanged'],
  ));
}

async function deleteSalesReturnItem(
  branchId, saleId, salesReturnId, salesReturnItemId, auditContext,
) {
  return expect(await deleteSalesReturnItemRecord(
    branchId, saleId, salesReturnId, salesReturnItemId, auditContext,
  ), ['deleted']);
}

async function transitionSalesReturn(
  branchId, saleId, salesReturnId, action, auditContext,
) {
  const accepted = action.toLowerCase();
  return expect(await transitionSalesReturnRecord(
    branchId, saleId, salesReturnId, action, auditContext,
  ), [accepted]).salesReturn;
}

async function completeSalesReturn(
  branchId, saleId, salesReturnId, auditContext,
) {
  return translate(async () => expect(await completeSalesReturnRecord(
    branchId, saleId, salesReturnId, auditContext,
  ), ['completed']).salesReturn);
}

export {
  completeSalesReturn,
  createSalesReturn,
  createSalesReturnItem,
  deleteSalesReturnItem,
  getSalesReturn,
  listSalesReturns,
  transitionSalesReturn,
  updateSalesReturnItem,
};
