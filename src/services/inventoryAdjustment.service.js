import {
  approveAdjustment as approveRecord,
  cancelAdjustment as cancelRecord,
  createAdjustment as createRecord,
  createAdjustmentItem as createItemRecord,
  deleteAdjustmentItem as deleteItemRecord,
  findAdjustment,
  findAdjustmentLedger,
  listAdjustments as listRecords,
  postAdjustment as postRecord,
  updateAdjustment as updateRecord,
  updateAdjustmentItem as updateItemRecord,
} from '../repositories/inventoryAdjustment.repository.js';
import { rethrowDuplicateAsConflict } from '../utils/databaseError.js';
import HttpError from '../utils/httpError.js';

const ERRORS = {
  actor_required: [403, 'An active employee identity is required for this operation'],
  actor_not_active: [403, 'An active employee identity is required for this operation'],
  actor_not_assigned: [403, 'The employee has no current assignment at this branch'],
  branch_not_found: [404, 'Branch not found'],
  branch_not_active: [409, 'Inventory adjustments require an active branch'],
  not_found: [404, 'Inventory adjustment not found'],
  item_not_found: [404, 'Inventory adjustment item not found'],
  variant_not_found: [404, 'Product variant not found'],
  variant_inactive: [409, 'Product variant must be active'],
  lot_not_found: [404, 'Inventory lot not found'],
  not_draft: [409, 'Only a DRAFT adjustment may be edited'],
  not_approved: [409, 'Only an APPROVED adjustment may be posted'],
  already_posted: [409, 'Inventory adjustment has already been posted'],
  not_cancellable: [409, 'Inventory adjustment cannot be cancelled in its current state'],
  empty_document: [409, 'Inventory adjustment must contain at least one item'],
  self_approval: [409, 'The creator cannot approve this inventory adjustment'],
  fractional_quantity: [409, 'This product variant requires whole base quantities'],
  lots_not_allowed: [409, 'Lot allocations are not allowed for this product variant'],
  lots_required: [409, 'Complete lot allocation is required for this product variant'],
  lot_quantity_mismatch: [409, 'Lot allocations exceed or conflict with the item quantity'],
  lot_variant_mismatch: [409, 'Inventory lot belongs to a different product variant'],
  unsafe_lot: [409, 'Inventory lot is not safe for this stock movement'],
  insufficient_stock: [409, 'Branch stock is insufficient'],
  lot_insufficient_stock: [409, 'Branch lot stock is insufficient'],
  lot_consistency: [409, 'Movement would violate required-lot inventory consistency'],
  concurrent_change: [409, 'Inventory or catalog changed concurrently; retry'],
};

function expect(result, accepted) {
  if (!accepted.includes(result.outcome)) {
    const error = ERRORS[result.outcome];
    if (!error) throw new Error(`Unknown inventory-adjustment outcome: ${result.outcome}`);
    throw new HttpError(...error);
  }
  return result;
}

async function translateQuantityOverflow(operation) {
  try { return await operation(); } catch (error) {
    if (error?.code === 'INVENTORY_QUANTITY_OVERFLOW') {
      throw new HttpError(409, 'Resulting inventory quantity exceeds the supported range');
    }
    throw error;
  }
}

const listAdjustments = (branchId, filters) => listRecords(branchId, filters);

async function getAdjustment(branchId, id) {
  const detail = await findAdjustment(branchId, id);
  if (!detail) throw new HttpError(404, 'Inventory adjustment not found');
  return detail;
}

async function getAdjustmentLedger(branchId, id) {
  const detail = await findAdjustmentLedger(branchId, id);
  if (!detail) throw new HttpError(404, 'Inventory adjustment not found');
  return detail;
}

async function withDuplicateTranslation(operation, message) {
  try { return await operation(); } catch (error) { rethrowDuplicateAsConflict(error, message); }
}

const createAdjustment = (branchId, values, audit) => withDuplicateTranslation(
  async () => expect(await createRecord(branchId, values, audit), ['created']).detail,
  'Generated adjustment number conflicts with existing data',
);
const updateAdjustment = async (branchId, id, values, audit) =>
  expect(await updateRecord(branchId, id, values, audit), ['updated', 'unchanged']).detail;
const createAdjustmentItem = (branchId, id, values, audit) => withDuplicateTranslation(
  async () => expect(await createItemRecord(branchId, id, values, audit), ['created']).item,
  'This product variant already exists on the adjustment',
);
const updateAdjustmentItem = async (branchId, id, itemId, values, audit) =>
  expect(await updateItemRecord(branchId, id, itemId, values, audit), ['updated', 'unchanged']).item;
const deleteAdjustmentItem = async (branchId, id, itemId, audit) =>
  expect(await deleteItemRecord(branchId, id, itemId, audit), ['deleted']).item;
const approveAdjustment = async (branchId, id, audit) =>
  expect(await approveRecord(branchId, id, audit), ['approved']).detail;
const postAdjustment = async (branchId, id, audit) => translateQuantityOverflow(async () =>
  expect(await postRecord(branchId, id, audit), ['posted']));
const cancelAdjustment = async (branchId, id, audit) =>
  expect(await cancelRecord(branchId, id, audit), ['cancelled']).detail;

export {
  approveAdjustment, cancelAdjustment, createAdjustment, createAdjustmentItem,
  deleteAdjustmentItem, getAdjustment, getAdjustmentLedger, listAdjustments,
  postAdjustment, updateAdjustment, updateAdjustmentItem,
};
