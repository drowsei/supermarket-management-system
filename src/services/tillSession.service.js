import {
  cancelTillSession as cancelSessionRecord,
  closeTillSession as closeSessionRecord,
  createCashMovement as createCashMovementRecord,
  findTillSession,
  listCashMovements as listCashMovementRecords,
  listTillSessions as listSessionRecords,
  openTillSession as openSessionRecord,
  resumeTillSession as resumeSessionRecord,
  suspendTillSession as suspendSessionRecord,
} from '../repositories/tillSession.repository.js';
import HttpError from '../utils/httpError.js';

const OUTCOME_ERRORS = Object.freeze({
  actor_required: [403, 'An active employee identity is required for this operation'],
  actor_not_active: [403, 'An active employee identity is required for this operation'],
  actor_not_assigned: [403, 'The employee has no current assignment at this branch'],
  branch_not_found: [404, 'Branch not found'],
  branch_not_active: [409, 'A till session may be opened only at an active branch'],
  register_not_found: [404, 'POS register not found'],
  register_not_active: [409, 'A till session may be opened only on an active POS register'],
  cashier_not_found: [404, 'Cashier employee not found'],
  cashier_not_active: [409, 'The selected cashier must be an active employee'],
  cashier_not_assigned: [409, 'The selected cashier has no current assignment at this branch'],
  register_in_use: [409, 'The POS register already has an active till session'],
  cashier_in_use: [409, 'The cashier already has an active till session'],
  session_number_conflict: [409, 'A unique till session number could not be generated; please retry'],
  session_conflict: [409, 'The till session conflicts with existing active-session data'],
  not_found: [404, 'Till session not found'],
  invalid_transition: [409, 'The till session cannot perform this action in its current status'],
  session_not_open: [409, 'Cash movements require an OPEN till session'],
  duplicate_reference: [409, 'Cash movement reference already exists for this till session'],
  movement_conflict: [409, 'Cash movement unique data conflicts with an existing record'],
  has_activity: [409, 'A till session with cash movements or sales must be closed, not cancelled'],
  currency_mismatch: [409, 'Completed cash payment evidence uses a different currency'],
  negative_expected_cash: [409, 'Expected closing cash cannot be negative'],
  reconciliation_overflow: [409, 'Expected closing cash exceeds the supported monetary range'],
  actual_cash_out_of_range: [409, 'Actual closing cash exceeds the supported monetary range'],
});

function throwOutcome(result) {
  const error = OUTCOME_ERRORS[result.outcome];
  if (!error) {
    throw new Error(`Unknown till-session outcome: ${result.outcome}`);
  }
  throw new HttpError(...error);
}

async function listTillSessions(branchId, filters) {
  return listSessionRecords(branchId, filters);
}

async function getTillSession(branchId, tillSessionId) {
  const tillSession = await findTillSession(branchId, tillSessionId);
  if (!tillSession) {
    throw new HttpError(404, 'Till session not found');
  }
  return tillSession;
}

async function openTillSession(
  branchId,
  posRegisterId,
  values,
  auditContext,
) {
  const result = await openSessionRecord(
    branchId,
    posRegisterId,
    values,
    auditContext,
  );
  if (result.outcome === 'opened') return result.tillSession;
  return throwOutcome(result);
}

async function runSessionAction(operation, branchId, tillSessionId, auditContext) {
  const result = await operation(branchId, tillSessionId, auditContext);
  if (['suspended', 'resumed', 'cancelled'].includes(result.outcome)) {
    return result.tillSession;
  }
  return throwOutcome(result);
}

async function suspendTillSession(branchId, tillSessionId, auditContext) {
  return runSessionAction(
    suspendSessionRecord,
    branchId,
    tillSessionId,
    auditContext,
  );
}

async function resumeTillSession(branchId, tillSessionId, auditContext) {
  return runSessionAction(
    resumeSessionRecord,
    branchId,
    tillSessionId,
    auditContext,
  );
}

async function cancelTillSession(branchId, tillSessionId, auditContext) {
  return runSessionAction(
    cancelSessionRecord,
    branchId,
    tillSessionId,
    auditContext,
  );
}

async function closeTillSession(
  branchId,
  tillSessionId,
  values,
  auditContext,
) {
  const result = await closeSessionRecord(
    branchId,
    tillSessionId,
    values.actualClosingCashAmount,
    auditContext,
  );
  if (result.outcome === 'closed') return result.tillSession;
  return throwOutcome(result);
}

async function listTillCashMovements(branchId, tillSessionId, filters) {
  const result = await listCashMovementRecords(
    branchId,
    tillSessionId,
    filters,
  );
  if (result.outcome === 'listed') {
    return { items: result.items, totalItems: result.totalItems };
  }
  return throwOutcome(result);
}

async function createTillCashMovement(
  branchId,
  tillSessionId,
  values,
  auditContext,
) {
  const result = await createCashMovementRecord(
    branchId,
    tillSessionId,
    values,
    auditContext,
  );
  if (result.outcome === 'created') return result.movement;
  return throwOutcome(result);
}

export {
  cancelTillSession,
  closeTillSession,
  createTillCashMovement,
  getTillSession,
  listTillCashMovements,
  listTillSessions,
  openTillSession,
  resumeTillSession,
  suspendTillSession,
};
