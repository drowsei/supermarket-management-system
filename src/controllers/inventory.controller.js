import {
  getBranchLot,
  getInventoryTransaction,
  getVariantInventory,
  listInventory,
  listLots,
  listTransactions,
  patchBranchLotStatus,
  putInventorySettings,
} from '../services/inventory.service.js';
import { getAuditContext } from '../utils/auditContext.js';
import { parseId, paginationMetadata } from '../validators/admin/common.validator.js';
import { validateNoQuery } from '../validators/purchasing/common.validator.js';
import {
  validateInventoryListQuery,
  validateInventorySettings,
  validateLotListQuery,
  validateLotStatus,
  validateTransactionListQuery,
} from '../validators/inventory/inventory.validator.js';

const branchId = (request) => request.inventoryBranch.branchId;

function sendPage(response, filters, result) {
  response.status(200).json({
    success: true,
    data: {
      items: result.items,
      pagination: paginationMetadata(filters.page, filters.limit, result.totalItems),
    },
  });
}

async function listInventoryRecords(request, response) {
  const filters = validateInventoryListQuery(request.query);
  sendPage(response, filters, await listInventory(branchId(request), filters));
}

async function getVariantInventoryRecord(request, response) {
  validateNoQuery(request.query);
  const variantId = parseId(request.params.variantId, 'variantId');
  response.status(200).json({
    success: true,
    data: await getVariantInventory(branchId(request), variantId),
  });
}

async function putInventorySettingsRecord(request, response) {
  validateNoQuery(request.query);
  const variantId = parseId(request.params.variantId, 'variantId');
  const values = validateInventorySettings(request.body);
  const branchInventory = await putInventorySettings(
    branchId(request), variantId, values, getAuditContext(request),
  );
  response.status(200).json({ success: true, data: { branchInventory } });
}

async function listLotRecords(request, response) {
  const filters = validateLotListQuery(request.query);
  sendPage(response, filters, await listLots(branchId(request), filters));
}

async function getLotRecord(request, response) {
  validateNoQuery(request.query);
  const lotId = parseId(request.params.inventoryLotId, 'inventoryLotId');
  response.status(200).json({
    success: true,
    data: await getBranchLot(branchId(request), lotId),
  });
}

async function patchLotStatusRecord(request, response) {
  validateNoQuery(request.query);
  const lotId = parseId(request.params.inventoryLotId, 'inventoryLotId');
  const { status } = validateLotStatus(request.body);
  const branchLot = await patchBranchLotStatus(
    branchId(request), lotId, status, getAuditContext(request),
  );
  response.status(200).json({ success: true, data: { branchLot } });
}

async function listTransactionRecords(request, response) {
  const filters = validateTransactionListQuery(request.query);
  sendPage(response, filters, await listTransactions(branchId(request), filters));
}

async function getTransactionRecord(request, response) {
  validateNoQuery(request.query);
  const id = parseId(request.params.inventoryTransactionId, 'inventoryTransactionId');
  response.status(200).json({
    success: true,
    data: await getInventoryTransaction(branchId(request), id),
  });
}

export {
  getLotRecord,
  getTransactionRecord,
  getVariantInventoryRecord,
  listInventoryRecords,
  listLotRecords,
  listTransactionRecords,
  patchLotStatusRecord,
  putInventorySettingsRecord,
};
