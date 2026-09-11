import {
  createPurchaseOrder as createRecord,
  createPurchaseOrderItem as createItemRecord,
  deletePurchaseOrderItem as deleteItemRecord,
  findPurchaseOrder,
  listPurchaseOrders as listRecords,
  transitionPurchaseOrder as transitionRecord,
  updatePurchaseOrder as updateRecord,
  updatePurchaseOrderItem as updateItemRecord,
} from '../repositories/purchaseOrder.repository.js';
import { rethrowDuplicateAsConflict } from '../utils/databaseError.js';
import HttpError from '../utils/httpError.js';

function throwOutcome(outcome) {
  const errors = {
    actor_required: [403, 'An active employee identity is required for this operation'],
    actor_not_active: [403, 'An active employee identity is required for this operation'],
    actor_not_assigned: [403, 'The employee has no current assignment at this branch'],
    branch_not_found: [404, 'Branch not found'],
    branch_not_active: [409, 'Purchasing operations require an active branch'],
    supplier_not_found: [404, 'Supplier not found'],
    supplier_not_active: [409, 'Purchasing requires an active supplier'],
    not_found: [404, 'Purchase order not found'],
    item_not_found: [404, 'Purchase order item not found'],
    variant_not_found: [404, 'Product variant not found'],
    package_not_found: [404, 'Product package not found'],
    inactive_product: [409, 'Purchasing requires an active product and variant'],
    package_not_purchasable: [409, 'The product package is not active and purchasable'],
    supplier_relationship_missing: [409, 'The supplier is not configured for this product variant'],
    supplier_package_missing: [409, 'The supplier is not configured for this active product package'],
    minimum_order_quantity: [409, 'The supplier minimum base order quantity is not satisfied'],
    minimum_package_quantity: [409, 'The supplier minimum package quantity is not satisfied'],
    fractional_quantity: [409, 'This product variant requires a whole base quantity'],
    discount_exceeds_gross: [400, 'discountAmount cannot exceed the gross line amount'],
    not_draft: [409, 'Only a DRAFT purchase order may be edited'],
    empty_order: [409, 'A purchase order must contain at least one item'],
    invalid_totals: [409, 'Purchase order totals are inconsistent'],
    invalid_transition: [409, 'The purchase order is not in a valid state for this transition'],
    dependent_receipt: [409, 'Cancel non-cancelled goods receipts before cancelling this purchase order'],
    concurrent_change: [409, 'The purchase order changed concurrently; retry with fresh data'],
    too_many_items: [409, 'The purchase order has reached its item limit'],
    expected_in_past: [409, 'expectedAt must not be earlier than the order workflow time'],
  };
  const error = errors[outcome];
  if (!error) throw new Error(`Unknown purchase-order outcome: ${outcome}`);
  throw new HttpError(...error);
}

function expect(result, accepted) {
  if (!accepted.includes(result.outcome)) throwOutcome(result.outcome);
  return result;
}

function translateArithmeticOverflow(error) {
  if (error?.code === 'PURCHASING_ARITHMETIC_OVERFLOW') {
    throw new HttpError(400, 'Calculated quantity or monetary value exceeds the supported range');
  }
  throw error;
}

async function withArithmeticValidation(operation) {
  try {
    return await operation();
  } catch (error) {
    translateArithmeticOverflow(error);
  }
}

async function listPurchaseOrders(branchId, filters) {
  return listRecords(branchId, filters);
}

async function getPurchaseOrder(branchId, purchaseOrderId) {
  const result = await findPurchaseOrder(branchId, purchaseOrderId);
  if (!result) throwOutcome('not_found');
  return result;
}

async function createPurchaseOrder(branchId, values, auditContext) {
  try {
    return await withArithmeticValidation(async () =>
      expect(await createRecord(branchId, values, auditContext), ['created'])
        .purchaseOrder,
    );
  } catch (error) {
    rethrowDuplicateAsConflict(error, 'A generated purchase order number conflicts; retry the request');
  }
}

async function updatePurchaseOrder(branchId, purchaseOrderId, changes, auditContext) {
  return withArithmeticValidation(async () =>
    expect(
      await updateRecord(branchId, purchaseOrderId, changes, auditContext),
      ['updated', 'unchanged'],
    ).purchaseOrder,
  );
}

async function createPurchaseOrderItem(branchId, purchaseOrderId, values, auditContext) {
  try {
    return await withArithmeticValidation(async () =>
      expect(
        await createItemRecord(branchId, purchaseOrderId, values, auditContext),
        ['created'],
      ),
    );
  } catch (error) {
    rethrowDuplicateAsConflict(error, 'This product/package line already exists on the purchase order');
  }
}

async function updatePurchaseOrderItem(
  branchId, purchaseOrderId, purchaseOrderItemId, changes, auditContext,
) {
  return withArithmeticValidation(async () =>
    expect(
      await updateItemRecord(
        branchId, purchaseOrderId, purchaseOrderItemId, changes, auditContext,
      ),
      ['updated', 'unchanged'],
    ),
  );
}

async function deletePurchaseOrderItem(
  branchId, purchaseOrderId, purchaseOrderItemId, auditContext,
) {
  return withArithmeticValidation(async () =>
    expect(
      await deleteItemRecord(
        branchId, purchaseOrderId, purchaseOrderItemId, auditContext,
      ),
      ['deleted'],
    ),
  );
}

async function transitionPurchaseOrder(
  branchId, purchaseOrderId, action, reason, auditContext,
) {
  return withArithmeticValidation(async () =>
    expect(
      await transitionRecord(
        branchId, purchaseOrderId, action, reason, auditContext,
      ),
      [action === 'cancel' ? 'cancelled' : action === 'submit' ? 'submitted' : 'approved'],
    ).purchaseOrder,
  );
}

export {
  createPurchaseOrder,
  createPurchaseOrderItem,
  deletePurchaseOrderItem,
  getPurchaseOrder,
  listPurchaseOrders,
  transitionPurchaseOrder,
  updatePurchaseOrder,
  updatePurchaseOrderItem,
};
