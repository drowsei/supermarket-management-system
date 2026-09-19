import * as service from '../services/inventoryAdjustment.service.js';
import { getAuditContext } from '../utils/auditContext.js';
import { parseId, paginationMetadata } from '../validators/admin/common.validator.js';
import { validateNoQuery } from '../validators/purchasing/common.validator.js';
import { validateEmptyObject } from '../validators/inventoryOperations/common.validator.js';
import {
  validateAdjustmentList, validateCreateAdjustment, validateCreateAdjustmentItem,
  validatePatchAdjustment, validatePatchAdjustmentItem,
} from '../validators/inventoryOperations/inventoryAdjustment.validator.js';

const branch = (request) => request.inventoryOperationsBranch.branchId;
const adjustmentId = (request) => parseId(request.params.inventoryAdjustmentId, 'inventoryAdjustmentId');

async function listAdjustmentRecords(request, response) {
  const filters = validateAdjustmentList(request.query);
  const result = await service.listAdjustments(branch(request), filters);
  response.status(200).json({ success: true, data: { items: result.items,
    pagination: paginationMetadata(filters.page, filters.limit, result.totalItems) } });
}
async function createAdjustmentRecord(request, response) {
  validateNoQuery(request.query);
  const data = await service.createAdjustment(branch(request), validateCreateAdjustment(request.body), getAuditContext(request));
  response.status(201).json({ success: true, data });
}
async function getAdjustmentRecord(request, response) {
  validateNoQuery(request.query);
  response.status(200).json({ success: true, data: await service.getAdjustment(branch(request), adjustmentId(request)) });
}
async function updateAdjustmentRecord(request, response) {
  validateNoQuery(request.query);
  const data = await service.updateAdjustment(branch(request), adjustmentId(request), validatePatchAdjustment(request.body), getAuditContext(request));
  response.status(200).json({ success: true, data });
}
async function createAdjustmentItemRecord(request, response) {
  validateNoQuery(request.query);
  const item = await service.createAdjustmentItem(branch(request), adjustmentId(request), validateCreateAdjustmentItem(request.body), getAuditContext(request));
  response.status(201).json({ success: true, data: { item } });
}
async function updateAdjustmentItemRecord(request, response) {
  validateNoQuery(request.query);
  const itemId = parseId(request.params.inventoryAdjustmentItemId, 'inventoryAdjustmentItemId');
  const item = await service.updateAdjustmentItem(branch(request), adjustmentId(request), itemId, validatePatchAdjustmentItem(request.body), getAuditContext(request));
  response.status(200).json({ success: true, data: { item } });
}
async function deleteAdjustmentItemRecord(request, response) {
  validateNoQuery(request.query);
  const itemId = parseId(request.params.inventoryAdjustmentItemId, 'inventoryAdjustmentItemId');
  await service.deleteAdjustmentItem(branch(request), adjustmentId(request), itemId, getAuditContext(request));
  response.status(204).send();
}
async function action(request, response, operation) {
  validateNoQuery(request.query); validateEmptyObject(request.body);
  response.status(200).json({ success: true, data: await operation(branch(request), adjustmentId(request), getAuditContext(request)) });
}
const approveAdjustmentRecord = (req, res) => action(req, res, service.approveAdjustment);
const postAdjustmentRecord = (req, res) => action(req, res, service.postAdjustment);
const cancelAdjustmentRecord = (req, res) => action(req, res, service.cancelAdjustment);
async function getAdjustmentLedgerRecord(request, response) {
  validateNoQuery(request.query);
  response.status(200).json({ success: true, data: await service.getAdjustmentLedger(branch(request), adjustmentId(request)) });
}

export {
  approveAdjustmentRecord, cancelAdjustmentRecord, createAdjustmentItemRecord,
  createAdjustmentRecord, deleteAdjustmentItemRecord, getAdjustmentLedgerRecord,
  getAdjustmentRecord, listAdjustmentRecords, postAdjustmentRecord,
  updateAdjustmentItemRecord, updateAdjustmentRecord,
};
