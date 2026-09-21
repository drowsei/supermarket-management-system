import {
  cancelTillSession,
  closeTillSession,
  createTillCashMovement,
  getTillSession,
  listTillCashMovements,
  listTillSessions,
  openTillSession,
  resumeTillSession,
  suspendTillSession,
} from '../services/tillSession.service.js';
import { getAuditContext } from '../utils/auditContext.js';
import { paginationMetadata } from '../validators/admin/common.validator.js';
import {
  validateEmptyActionBody,
  validateNoQuery,
} from '../validators/pos/common.validator.js';
import { validatePosRegisterId } from '../validators/pos/posRegister.validator.js';
import {
  validateCashMovementListQuery,
  validateCloseTillSession,
  validateCreateCashMovement,
  validateOpenTillSession,
  validateTillSessionId,
  validateTillSessionListQuery,
} from '../validators/pos/tillSession.validator.js';

function branchId(request) {
  return request.posBranch.branchId;
}

function sessionId(request) {
  return validateTillSessionId(request.params.tillSessionId);
}

async function listTillSessionRecords(request, response) {
  const filters = validateTillSessionListQuery(request.query);
  const result = await listTillSessions(branchId(request), filters);

  response.status(200).json({
    success: true,
    data: {
      items: result.items,
      pagination: paginationMetadata(
        filters.page,
        filters.limit,
        result.totalItems,
      ),
    },
  });
}

async function getTillSessionRecord(request, response) {
  validateNoQuery(request.query);
  const tillSession = await getTillSession(
    branchId(request),
    sessionId(request),
  );

  response.status(200).json({ success: true, data: { tillSession } });
}

async function openTillSessionRecord(request, response) {
  validateNoQuery(request.query);
  const posRegisterId = validatePosRegisterId(request.params.posRegisterId);
  const values = validateOpenTillSession(request.body);
  const tillSession = await openTillSession(
    branchId(request),
    posRegisterId,
    values,
    getAuditContext(request),
  );

  response.status(201).json({ success: true, data: { tillSession } });
}

async function runEmptyTillAction(request, response, operation) {
  validateNoQuery(request.query);
  validateEmptyActionBody(request.body);
  const tillSession = await operation(
    branchId(request),
    sessionId(request),
    getAuditContext(request),
  );

  response.status(200).json({ success: true, data: { tillSession } });
}

async function suspendTillSessionRecord(request, response) {
  await runEmptyTillAction(request, response, suspendTillSession);
}

async function resumeTillSessionRecord(request, response) {
  await runEmptyTillAction(request, response, resumeTillSession);
}

async function cancelTillSessionRecord(request, response) {
  await runEmptyTillAction(request, response, cancelTillSession);
}

async function closeTillSessionRecord(request, response) {
  validateNoQuery(request.query);
  const values = validateCloseTillSession(request.body);
  const tillSession = await closeTillSession(
    branchId(request),
    sessionId(request),
    values,
    getAuditContext(request),
  );

  response.status(200).json({ success: true, data: { tillSession } });
}

async function listTillCashMovementRecords(request, response) {
  const filters = validateCashMovementListQuery(request.query);
  const result = await listTillCashMovements(
    branchId(request),
    sessionId(request),
    filters,
  );

  response.status(200).json({
    success: true,
    data: {
      items: result.items,
      pagination: paginationMetadata(
        filters.page,
        filters.limit,
        result.totalItems,
      ),
    },
  });
}

async function createTillCashMovementRecord(request, response) {
  validateNoQuery(request.query);
  const values = validateCreateCashMovement(request.body);
  const cashMovement = await createTillCashMovement(
    branchId(request),
    sessionId(request),
    values,
    getAuditContext(request),
  );

  response.status(201).json({ success: true, data: { cashMovement } });
}

export {
  cancelTillSessionRecord,
  closeTillSessionRecord,
  createTillCashMovementRecord,
  getTillSessionRecord,
  listTillCashMovementRecords,
  listTillSessionRecords,
  openTillSessionRecord,
  resumeTillSessionRecord,
  suspendTillSessionRecord,
};
