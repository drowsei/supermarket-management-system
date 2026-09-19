import * as repository from '../repositories/stockCount.repository.js';
import { rethrowDuplicateAsConflict } from '../utils/databaseError.js';
import HttpError from '../utils/httpError.js';

const ERRORS = {
  actor_required: [403, 'An active employee identity is required for this operation'],
  actor_not_active: [403, 'An active employee identity is required for this operation'],
  actor_not_assigned: [403, 'The employee has no current assignment at this branch'],
  branch_not_found: [404, 'Branch not found'], branch_not_active: [409, 'Stock counts require an active branch'],
  not_found: [404, 'Stock count not found'], item_not_found: [404, 'Stock count item not found'],
  participant_not_found: [404, 'Stock count participant not found'],
  participant_inactive: [409, 'Participant employee must be active'],
  participant_not_assigned: [409, 'Participant has no current assignment at this branch'],
  variant_not_found: [404, 'Product variant not found'], variant_inactive: [409, 'Product variant must be active'],
  lot_not_found: [404, 'Inventory lot not found'], lot_variant_mismatch: [409, 'Inventory lot belongs to a different product variant'],
  not_draft: [409, 'Only a DRAFT stock count may be configured'], not_started: [409, 'Count quantities may only be entered after START'],
  not_countable: [409, 'Stock count items cannot be changed in the current state'], identity_frozen: [409, 'Count item identity and notes are frozen after START'],
  empty_count: [409, 'A stock count must contain at least one item'], not_in_progress: [409, 'Only an IN_PROGRESS count may be completed'],
  uncounted_items: [409, 'Every stock count item must be counted before completion'], not_counted: [409, 'Only a COUNTED stock count may be posted'],
  already_posted: [409, 'Stock count has already been posted'], self_approval: [409, 'The creator cannot approve and post this stock count'],
  not_cancellable: [409, 'Stock count cannot be cancelled in its current state'], stale_count: [409, 'Inventory changed after the count snapshot; recount is required'],
  incomplete_lot_scope: [409, 'Required-lot count scope must include every stocked lot'], lot_reconciliation_unrepresentable: [409, 'Offsetting lot variances cannot be represented safely by the frozen adjustment schema'],
  lots_not_allowed: [409, 'Lot scope is not allowed for this product variant'], lots_required: [409, 'Lot-level count items are required for this product variant'],
  lot_quantity_mismatch: [409, 'Lot variances conflict with the aggregate count correction'],
  variance_reason_required: [400, 'varianceReason is required for a nonzero variance'], fractional_quantity: [400, 'This product variant requires whole base quantities'],
  insufficient_stock: [409, 'Count correction would make branch stock negative'], lot_insufficient_stock: [409, 'Count correction would make lot stock negative'],
  unsafe_lot: [409, 'Inventory lot is not safe for this correction'], lot_consistency: [409, 'Count correction would violate required-lot consistency'], concurrent_change: [409, 'Inventory or catalog changed concurrently; retry'],
};

function expect(result, accepted) { if (!accepted.includes(result.outcome)) { const error = ERRORS[result.outcome]; if (!error) throw new Error(`Unknown stock-count outcome: ${result.outcome}`); throw new HttpError(...error); } return result; }
async function duplicate(operation, message) { try { return await operation(); } catch (error) { rethrowDuplicateAsConflict(error, message); } }
async function quantitySafe(operation) { try { return await operation(); } catch (error) { if (error?.code === 'INVENTORY_QUANTITY_OVERFLOW') throw new HttpError(409, 'Resulting inventory quantity exceeds the supported range'); throw error; } }

const listCounts = repository.listCounts;
async function getCount(branchId, id) { const result = await repository.findCount(branchId, id); if (!result) throw new HttpError(404, 'Stock count not found'); return result; }
async function getCountVariance(branchId, id) { const result = await repository.findCountVariance(branchId, id); if (!result) throw new HttpError(404, 'Stock count not found'); return result; }
async function getCountLedger(branchId, id) { const result = await repository.findCountLedger(branchId, id); if (!result) throw new HttpError(404, 'Stock count not found'); return result; }
const createCount = (b, v, a) => duplicate(async () => expect(await repository.createCount(b, v, a), ['created']).detail, 'Generated stock count number conflicts with existing data');
const updateCount = async (b, id, v, a) => expect(await repository.updateCount(b, id, v, a), ['updated', 'unchanged']).detail;
const addParticipant = (b, id, v, a) => duplicate(async () => expect(await repository.addParticipant(b, id, v, a), ['created']).participant, 'Employee is already a participant in this stock count');
const removeParticipant = async (b, id, e, a) => expect(await repository.removeParticipant(b, id, e, a), ['deleted']);
const createCountItem = (b, id, v, a) => duplicate(async () => expect(await repository.createCountItem(b, id, v, a), ['created']).item, 'This product variant and lot scope already exists on the stock count');
const patchCountItem = async (b, id, item, v, a) => expect(await repository.patchCountItem(b, id, item, v, a), ['updated', 'unchanged']).item;
const deleteCountItem = async (b, id, item, a) => expect(await repository.deleteCountItem(b, id, item, a), ['deleted']);
const startCount = async (b, id, a) => quantitySafe(async () => expect(await repository.startCount(b, id, a), ['started']).detail);
const completeCount = async (b, id, a) => expect(await repository.completeCount(b, id, a), ['completed']).detail;
const postCount = async (b, id, a) => quantitySafe(async () => expect(await repository.postCount(b, id, a), ['posted']).detail);
const cancelCount = async (b, id, a) => expect(await repository.cancelCount(b, id, a), ['cancelled']).detail;

export { addParticipant, cancelCount, completeCount, createCount, createCountItem, deleteCountItem, getCount, getCountLedger, getCountVariance, listCounts, patchCountItem, postCount, removeParticipant, startCount, updateCount };
