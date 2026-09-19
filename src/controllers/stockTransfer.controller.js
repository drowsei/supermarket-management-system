import * as service from '../services/stockTransfer.service.js';
import { getAuditContext } from '../utils/auditContext.js';
import { parseId, paginationMetadata } from '../validators/admin/common.validator.js';
import { validateNoQuery } from '../validators/purchasing/common.validator.js';
import { validateEmptyObject } from '../validators/inventoryOperations/common.validator.js';
import { validateCreateTransfer, validateCreateTransferItem, validateDispatchTransfer, validatePatchTransfer, validatePatchTransferItem, validateReceiveTransfer, validateTransferList } from '../validators/inventoryOperations/stockTransfer.validator.js';

const branch = (request) => request.inventoryOperationsBranch.branchId;
const transferId = (request) => parseId(request.params.stockTransferId, 'stockTransferId');
async function listTransferRecords(req, res) { const filters = validateTransferList(req.query); const result = await service.listTransfers(branch(req), filters); res.status(200).json({ success: true, data: { items: result.items, pagination: paginationMetadata(filters.page, filters.limit, result.totalItems) } }); }
async function createTransferRecord(req, res) { validateNoQuery(req.query); res.status(201).json({ success: true, data: await service.createTransfer(branch(req), validateCreateTransfer(req.body), getAuditContext(req)) }); }
async function getTransferRecord(req, res) { validateNoQuery(req.query); res.status(200).json({ success: true, data: await service.getTransfer(branch(req), transferId(req)) }); }
async function updateTransferRecord(req, res) { validateNoQuery(req.query); res.status(200).json({ success: true, data: await service.updateTransfer(branch(req), transferId(req), validatePatchTransfer(req.body), getAuditContext(req)) }); }
async function createTransferItemRecord(req, res) { validateNoQuery(req.query); const item = await service.createTransferItem(branch(req), transferId(req), validateCreateTransferItem(req.body), getAuditContext(req)); res.status(201).json({ success: true, data: { item } }); }
async function updateTransferItemRecord(req, res) { validateNoQuery(req.query); const itemId = parseId(req.params.stockTransferItemId, 'stockTransferItemId'); const item = await service.updateTransferItem(branch(req), transferId(req), itemId, validatePatchTransferItem(req.body), getAuditContext(req)); res.status(200).json({ success: true, data: { item } }); }
async function deleteTransferItemRecord(req, res) { validateNoQuery(req.query); const itemId = parseId(req.params.stockTransferItemId, 'stockTransferItemId'); await service.deleteTransferItem(branch(req), transferId(req), itemId, getAuditContext(req)); res.status(204).send(); }
async function emptyAction(req, res, operation) { validateNoQuery(req.query); validateEmptyObject(req.body); res.status(200).json({ success: true, data: await operation(branch(req), transferId(req), getAuditContext(req)) }); }
const requestTransferRecord = (req, res) => emptyAction(req, res, service.requestTransfer);
const approveTransferRecord = (req, res) => emptyAction(req, res, service.approveTransfer);
const cancelTransferRecord = (req, res) => emptyAction(req, res, service.cancelTransfer);
async function dispatchTransferRecord(req, res) { validateNoQuery(req.query); res.status(200).json({ success: true, data: await service.dispatchTransfer(branch(req), transferId(req), validateDispatchTransfer(req.body), getAuditContext(req)) }); }
async function receiveTransferRecord(req, res) { validateNoQuery(req.query); res.status(200).json({ success: true, data: await service.receiveTransfer(branch(req), transferId(req), validateReceiveTransfer(req.body), getAuditContext(req)) }); }
export { approveTransferRecord, cancelTransferRecord, createTransferItemRecord, createTransferRecord, deleteTransferItemRecord, dispatchTransferRecord, getTransferRecord, listTransferRecords, receiveTransferRecord, requestTransferRecord, updateTransferItemRecord, updateTransferRecord };
