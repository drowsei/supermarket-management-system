import {
  listInventory as listInventoryRows,
  listLots as listLotRows,
  listLotTransactions,
  listTransactions as listTransactionRows,
  listVariantLots,
  selectInventory,
  selectLot,
  selectTransaction,
} from '../repositories/inventoryRead.repository.js';
import {
  patchBranchLotStatus as patchLotStatusRow,
  putInventorySettings as putSettingsRow,
} from '../repositories/inventoryWrite.repository.js';
import pool from '../config/database.js';
import HttpError from '../utils/httpError.js';

function throwOutcome(outcome) {
  const errors = {
    actor_required: [403, 'An active employee identity is required for this operation'],
    actor_not_active: [403, 'An active employee identity is required for this operation'],
    actor_not_assigned: [403, 'The employee has no current assignment at this branch'],
    branch_not_found: [404, 'Branch not found'],
    branch_not_active: [409, 'Inventory configuration requires an active branch'],
    variant_not_found: [404, 'Product variant not found'],
    lot_not_found: [404, 'Branch lot not found'],
    unsafe_available: [409, 'Lot cannot be made available in its current state'],
    fractional_quantity: [400, 'This product variant requires whole base quantities'],
    concurrent_change: [409, 'Catalog or lot identity changed concurrently; retry'],
  };
  if (!errors[outcome]) throw new Error(`Unknown inventory outcome: ${outcome}`);
  throw new HttpError(...errors[outcome]);
}

async function getVariantInventory(branchId, variantId) {
  const branchInventory = await selectInventory(pool, branchId, variantId);
  if (!branchInventory) throw new HttpError(404, 'Branch inventory not found');
  return { branchInventory, lots: await listVariantLots(branchId, variantId) };
}

async function getBranchLot(branchId, lotId) {
  const branchLot = await selectLot(pool, branchId, lotId);
  if (!branchLot) throw new HttpError(404, 'Branch lot not found');
  return { branchLot, recentTransactions: await listLotTransactions(branchId, lotId) };
}

async function getInventoryTransaction(branchId, transactionId) {
  const result = await selectTransaction(branchId, transactionId);
  if (!result) throw new HttpError(404, 'Inventory transaction not found');
  return result;
}

async function putInventorySettings(branchId, variantId, values, auditContext) {
  const result = await putSettingsRow(branchId, variantId, values, auditContext);
  if (!['created', 'updated', 'unchanged'].includes(result.outcome)) {
    throwOutcome(result.outcome);
  }
  return result.branchInventory;
}

async function patchBranchLotStatus(branchId, lotId, status, auditContext) {
  const result = await patchLotStatusRow(branchId, lotId, status, auditContext);
  if (!['updated', 'unchanged'].includes(result.outcome)) {
    throwOutcome(result.outcome);
  }
  return result.branchLot;
}

export {
  getBranchLot,
  getInventoryTransaction,
  getVariantInventory,
  listInventoryRows as listInventory,
  listLotRows as listLots,
  listTransactionRows as listTransactions,
  patchBranchLotStatus,
  putInventorySettings,
};
