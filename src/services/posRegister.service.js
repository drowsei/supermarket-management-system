import {
  createRegister,
  findRegister,
  listRegisters,
  updateRegister,
} from '../repositories/posRegister.repository.js';
import HttpError from '../utils/httpError.js';

const OUTCOME_ERRORS = Object.freeze({
  branch_not_found: [404, 'Branch not found'],
  not_found: [404, 'POS register not found'],
  duplicate_code: [409, 'Register code already exists at this branch'],
  duplicate_terminal: [409, 'Terminal identifier already exists'],
  duplicate_register: [409, 'POS register unique data conflicts with an existing record'],
  active_session: [409, 'A register with an active till session must remain ACTIVE'],
});

function requireOutcome(result, acceptedOutcomes) {
  if (acceptedOutcomes.includes(result.outcome)) {
    return result.register;
  }

  const error = OUTCOME_ERRORS[result.outcome];
  if (!error) {
    throw new Error(`Unknown POS-register outcome: ${result.outcome}`);
  }

  throw new HttpError(...error);
}

async function listPosRegisters(branchId, filters) {
  return listRegisters(branchId, filters);
}

async function getPosRegister(branchId, posRegisterId) {
  const register = await findRegister(branchId, posRegisterId);
  if (!register) {
    throw new HttpError(404, 'POS register not found');
  }
  return register;
}

async function createPosRegister(branchId, values, auditContext) {
  const result = await createRegister(branchId, values, auditContext);
  return requireOutcome(result, ['created']);
}

async function updatePosRegister(
  branchId,
  posRegisterId,
  changes,
  auditContext,
) {
  const result = await updateRegister(
    branchId,
    posRegisterId,
    changes,
    auditContext,
  );
  return requireOutcome(result, ['updated', 'unchanged']);
}

export {
  createPosRegister,
  getPosRegister,
  listPosRegisters,
  updatePosRegister,
};
