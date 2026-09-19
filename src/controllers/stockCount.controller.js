import * as service from '../services/stockCount.service.js';
import { getAuditContext } from '../utils/auditContext.js';
import { parseId, paginationMetadata } from '../validators/admin/common.validator.js';
import { validateNoQuery } from '../validators/purchasing/common.validator.js';
import { validateEmptyObject } from '../validators/inventoryOperations/common.validator.js';
import { validateCountList, validateCreateCount, validateCreateCountItem, validateParticipant, validatePatchCount, validatePatchCountItem } from '../validators/inventoryOperations/stockCount.validator.js';

const branch = (request) => request.inventoryOperationsBranch.branchId;
const countId = (request) => parseId(request.params.stockCountId, 'stockCountId');
async function listCountRecords(req, res) { const filters = validateCountList(req.query); const result = await service.listCounts(branch(req), filters); res.status(200).json({ success: true, data: { items: result.items, pagination: paginationMetadata(filters.page, filters.limit, result.totalItems) } }); }
async function createCountRecord(req, res) { validateNoQuery(req.query); const data = await service.createCount(branch(req), validateCreateCount(req.body), getAuditContext(req)); res.status(201).json({ success: true, data }); }
async function getCountRecord(req, res) { validateNoQuery(req.query); res.status(200).json({ success: true, data: await service.getCount(branch(req), countId(req)) }); }
async function updateCountRecord(req, res) { validateNoQuery(req.query); res.status(200).json({ success: true, data: await service.updateCount(branch(req), countId(req), validatePatchCount(req.body), getAuditContext(req)) }); }
async function addParticipantRecord(req, res) { validateNoQuery(req.query); const participant = await service.addParticipant(branch(req), countId(req), validateParticipant(req.body), getAuditContext(req)); res.status(201).json({ success: true, data: { participant } }); }
async function removeParticipantRecord(req, res) { validateNoQuery(req.query); const employeeId = parseId(req.params.employeeId, 'employeeId'); await service.removeParticipant(branch(req), countId(req), employeeId, getAuditContext(req)); res.status(204).send(); }
async function createCountItemRecord(req, res) { validateNoQuery(req.query); const item = await service.createCountItem(branch(req), countId(req), validateCreateCountItem(req.body), getAuditContext(req)); res.status(201).json({ success: true, data: { item } }); }
async function patchCountItemRecord(req, res) { validateNoQuery(req.query); const itemId = parseId(req.params.stockCountItemId, 'stockCountItemId'); const item = await service.patchCountItem(branch(req), countId(req), itemId, validatePatchCountItem(req.body), getAuditContext(req)); res.status(200).json({ success: true, data: { item } }); }
async function deleteCountItemRecord(req, res) { validateNoQuery(req.query); const itemId = parseId(req.params.stockCountItemId, 'stockCountItemId'); await service.deleteCountItem(branch(req), countId(req), itemId, getAuditContext(req)); res.status(204).send(); }
async function action(req, res, operation) { validateNoQuery(req.query); validateEmptyObject(req.body); res.status(200).json({ success: true, data: await operation(branch(req), countId(req), getAuditContext(req)) }); }
const startCountRecord = (req, res) => action(req, res, service.startCount);
const completeCountRecord = (req, res) => action(req, res, service.completeCount);
const postCountRecord = (req, res) => action(req, res, service.postCount);
const cancelCountRecord = (req, res) => action(req, res, service.cancelCount);
async function getCountVarianceRecord(req, res) { validateNoQuery(req.query); res.status(200).json({ success: true, data: await service.getCountVariance(branch(req), countId(req)) }); }
async function getCountLedgerRecord(req, res) { validateNoQuery(req.query); res.status(200).json({ success: true, data: await service.getCountLedger(branch(req), countId(req)) }); }

export { addParticipantRecord, cancelCountRecord, completeCountRecord, createCountItemRecord, createCountRecord, deleteCountItemRecord, getCountLedgerRecord, getCountRecord, getCountVarianceRecord, listCountRecords, patchCountItemRecord, postCountRecord, removeParticipantRecord, startCountRecord, updateCountRecord };
