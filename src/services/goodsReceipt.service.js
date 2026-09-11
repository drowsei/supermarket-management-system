import {
  cancelGoodsReceipt as cancelRecord,
  createGoodsReceipt as createRecord,
  createGoodsReceiptItem as createItemRecord,
  deleteGoodsReceiptItem as deleteItemRecord,
  findGoodsReceipt,
  listGoodsReceipts as listRecords,
  updateGoodsReceipt as updateRecord,
  updateGoodsReceiptItem as updateItemRecord,
} from '../repositories/goodsReceipt.repository.js';
import { postPurchaseReceipt } from '../repositories/purchaseReceiptPosting.repository.js';
import { rethrowDuplicateAsConflict } from '../utils/databaseError.js';
import HttpError from '../utils/httpError.js';

function throwOutcome(outcome) {
  const errors = {
    actor_required: [403, 'An active employee identity is required for this operation'],
    actor_not_active: [403, 'An active employee identity is required for this operation'],
    actor_not_assigned: [403, 'The employee has no current assignment at this branch'],
    branch_not_found: [404, 'Branch not found'],
    branch_not_active: [409, 'Receiving operations require an active branch'],
    not_found: [404, 'Goods receipt not found'],
    item_not_found: [404, 'Goods receipt item not found'],
    purchase_order_not_found: [404, 'Purchase order not found'],
    purchase_order_item_not_found: [404, 'Purchase order item not found'],
    purchase_order_not_receivable: [409, 'The purchase order is not open for receiving'],
    not_draft: [409, 'Only a DRAFT goods receipt may be edited'],
    invalid_transition: [409, 'The goods receipt is not in a valid state for this transition'],
    already_posted: [409, 'The goods receipt has already been posted'],
    zero_quantities: [400, 'At least one accepted or rejected quantity is required'],
    fractional_quantity: [409, 'This product variant requires whole base quantities'],
    over_received: [409, 'Accepted quantity exceeds the remaining purchase-order quantity'],
    discount_exceeds_gross: [400, 'discountAmount cannot exceed the accepted gross amount'],
    too_many_items: [409, 'The goods receipt has reached its item limit'],
    empty_receipt: [409, 'A goods receipt must contain at least one item'],
    no_accepted_stock: [409, 'Posting requires at least one accepted stock quantity'],
    allocation_item_not_found: [404, 'Lot allocation receipt item not found'],
    lots_not_allowed: [409, 'Lot allocations are not allowed for this product variant'],
    lots_required: [409, 'Complete lot allocation is required for this product variant'],
    lot_quantity_mismatch: [409, 'Lot allocation quantity must equal the full accepted quantity'],
    lot_not_found: [404, 'Inventory lot not found'],
    lot_variant_mismatch: [409, 'Inventory lot belongs to a different product variant'],
    lot_metadata_conflict: [409, 'Lot dates conflict with the existing lot identity'],
    lot_not_receivable: [409, 'RECALLED or CLOSED lots cannot receive stock'],
    expiry_required: [409, 'An expiry date is required for this product variant'],
    duplicate_lot_allocation: [409, 'A receipt item cannot allocate the same lot twice'],
    concurrent_change: [409, 'The receipt or catalog changed concurrently; retry with fresh data'],
  };
  const error = errors[outcome];
  if (!error) throw new Error(`Unknown goods-receipt outcome: ${outcome}`);
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

async function listGoodsReceipts(branchId, filters) {
  return listRecords(branchId, filters);
}

async function getGoodsReceipt(branchId, goodsReceiptId) {
  const result = await findGoodsReceipt(branchId, goodsReceiptId);
  if (!result) throwOutcome('not_found');
  return result;
}

async function createGoodsReceipt(branchId, values, auditContext) {
  try {
    return expect(await createRecord(branchId, values, auditContext), ['created'])
      .goodsReceipt;
  } catch (error) {
    rethrowDuplicateAsConflict(
      error,
      'Supplier invoice number already exists or generated receipt number conflicts',
    );
  }
}

async function updateGoodsReceipt(branchId, goodsReceiptId, changes, auditContext) {
  try {
    return expect(
      await updateRecord(branchId, goodsReceiptId, changes, auditContext),
      ['updated', 'unchanged'],
    ).goodsReceipt;
  } catch (error) {
    rethrowDuplicateAsConflict(error, 'Supplier invoice number already exists');
  }
}

async function createGoodsReceiptItem(branchId, goodsReceiptId, values, auditContext) {
  try {
    return await withArithmeticValidation(async () =>
      expect(
        await createItemRecord(branchId, goodsReceiptId, values, auditContext),
        ['created'],
      ).item,
    );
  } catch (error) {
    rethrowDuplicateAsConflict(error, 'This purchase-order item already exists on the goods receipt');
  }
}

async function updateGoodsReceiptItem(
  branchId, goodsReceiptId, goodsReceiptItemId, changes, auditContext,
) {
  return withArithmeticValidation(async () =>
    expect(
      await updateItemRecord(
        branchId, goodsReceiptId, goodsReceiptItemId, changes, auditContext,
      ),
      ['updated', 'unchanged'],
    ).item,
  );
}

async function deleteGoodsReceiptItem(
  branchId, goodsReceiptId, goodsReceiptItemId, auditContext,
) {
  return expect(
    await deleteItemRecord(
      branchId, goodsReceiptId, goodsReceiptItemId, auditContext,
    ),
    ['deleted'],
  ).item;
}

async function cancelGoodsReceipt(branchId, goodsReceiptId, auditContext) {
  return expect(
    await cancelRecord(branchId, goodsReceiptId, auditContext),
    ['cancelled'],
  ).goodsReceipt;
}

async function postGoodsReceipt(branchId, goodsReceiptId, values, auditContext) {
  try {
    return expect(
      await postPurchaseReceipt(
        branchId, goodsReceiptId, values.lotAllocations, auditContext,
      ),
      ['posted'],
    );
  } catch (error) {
    rethrowDuplicateAsConflict(
      error,
      'Receipt posting conflicts with existing document or lot identity',
    );
  }
}

export {
  cancelGoodsReceipt,
  createGoodsReceipt,
  createGoodsReceiptItem,
  deleteGoodsReceiptItem,
  getGoodsReceipt,
  listGoodsReceipts,
  postGoodsReceipt,
  updateGoodsReceipt,
  updateGoodsReceiptItem,
};
