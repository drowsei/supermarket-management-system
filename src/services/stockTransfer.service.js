import * as repository from '../repositories/stockTransfer.repository.js';
import { rethrowDuplicateAsConflict } from '../utils/databaseError.js';
import HttpError from '../utils/httpError.js';

const ERRORS = {
  actor_required: [403, 'An active employee identity is required for this operation'], actor_not_active: [403, 'An active employee identity is required for this operation'], actor_not_assigned: [403, 'The employee has no current assignment at the operation branch'],
  branch_not_found: [404, 'Branch not found'], branch_not_active: [409, 'Both transfer branches must be active'], not_found: [404, 'Stock transfer not found'], item_not_found: [404, 'Stock transfer item not found'],
  same_branch: [409, 'Source and destination branches must differ'], not_draft: [409, 'Only a DRAFT transfer may be edited'], not_requested: [409, 'Only a REQUESTED transfer may be approved'], not_approved: [409, 'Only an APPROVED transfer may be dispatched'], not_in_transit: [409, 'Only an IN_TRANSIT transfer may be received'],
  already_dispatched: [409, 'Stock transfer has already been dispatched'], already_received: [409, 'Stock transfer has already been received'], not_cancellable: [409, 'Stock transfer cannot be cancelled after dispatch'], empty_transfer: [409, 'Stock transfer must contain at least one item'],
  variant_not_found: [404, 'Product variant not found'], variant_inactive: [409, 'Product variant must be active'], lot_not_found: [404, 'Inventory lot not found'], lot_variant_mismatch: [409, 'Inventory lot belongs to a different product variant'],
  lots_not_allowed: [409, 'Lot allocations are not allowed for this product variant'], lots_required: [409, 'Complete lot allocation is required for this product variant'], lot_quantity_mismatch: [409, 'Lot allocation exceeds or conflicts with the item quantity'],
  incomplete_action_items: [400, 'Action must supply every transfer item exactly once'], quantity_exceeds_limit: [409, 'Action quantity exceeds its requested or dispatched limit'], invalid_lot_action: [409, 'Action lot was not planned or exceeds its permitted quantity'],
  fractional_quantity: [400, 'This product variant requires whole base quantities'], insufficient_stock: [409, 'Source branch stock is insufficient'], lot_insufficient_stock: [409, 'Source branch lot stock is insufficient'], unsafe_lot: [409, 'Lot is not eligible for transfer'], lot_consistency: [409, 'Transfer would violate required-lot inventory consistency'], concurrent_change: [409, 'Transfer, inventory, or catalog changed concurrently; retry'],
};
function expect(result, accepted) { if (!accepted.includes(result.outcome)) { const error = ERRORS[result.outcome]; if (!error) throw new Error(`Unknown stock-transfer outcome: ${result.outcome}`); throw new HttpError(...error); } return result; }
async function duplicate(operation, message) { try { return await operation(); } catch (error) { rethrowDuplicateAsConflict(error, message); } }
async function quantitySafe(operation) { try { return await operation(); } catch (error) { if (error?.code === 'INVENTORY_QUANTITY_OVERFLOW') throw new HttpError(409, 'Resulting inventory quantity exceeds the supported range'); throw error; } }

const listTransfers = repository.listTransfers;
async function getTransfer(branchId, id) { const detail = await repository.findTransfer(branchId, id); if (!detail) throw new HttpError(404, 'Stock transfer not found'); return detail; }
const createTransfer = (b, v, a) => duplicate(async () => expect(await repository.createTransfer(b, v, a), ['created']).detail, 'Generated stock transfer number conflicts with existing data');
const updateTransfer = async (b, id, v, a) => expect(await repository.updateTransfer(b, id, v, a), ['updated', 'unchanged']).detail;
const createTransferItem = (b, id, v, a) => duplicate(async () => expect(await repository.createTransferItem(b, id, v, a), ['created']).item, 'This product variant already exists on the stock transfer');
const updateTransferItem = async (b, id, item, v, a) => expect(await repository.updateTransferItem(b, id, item, v, a), ['updated', 'unchanged']).item;
const deleteTransferItem = async (b, id, item, a) => expect(await repository.deleteTransferItem(b, id, item, a), ['deleted']);
const requestTransfer = async (b, id, a) => expect(await repository.requestTransfer(b, id, a), ['requested']).detail;
const approveTransfer = async (b, id, a) => expect(await repository.approveTransfer(b, id, a), ['approved']).detail;
const dispatchTransfer = async (b, id, v, a) => quantitySafe(async () => expect(await repository.dispatchTransfer(b, id, v, a), ['dispatched']).detail);
const receiveTransfer = async (b, id, v, a) => quantitySafe(async () => expect(await repository.receiveTransfer(b, id, v, a), ['received']).detail);
const cancelTransfer = async (b, id, a) => expect(await repository.cancelTransfer(b, id, a), ['cancelled']).detail;
export { approveTransfer, cancelTransfer, createTransfer, createTransferItem, deleteTransferItem, dispatchTransfer, getTransfer, listTransfers, receiveTransfer, requestTransfer, updateTransfer, updateTransferItem };
