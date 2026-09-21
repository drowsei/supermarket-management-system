import {
  createPosRegister,
  getPosRegister,
  listPosRegisters,
  updatePosRegister,
} from '../services/posRegister.service.js';
import { getAuditContext } from '../utils/auditContext.js';
import { paginationMetadata } from '../validators/admin/common.validator.js';
import { validateNoQuery } from '../validators/pos/common.validator.js';
import {
  validateCreatePosRegister,
  validatePosRegisterId,
  validatePosRegisterListQuery,
  validateUpdatePosRegister,
} from '../validators/pos/posRegister.validator.js';

function branchId(request) {
  return request.posBranch.branchId;
}

async function listPosRegisterRecords(request, response) {
  const filters = validatePosRegisterListQuery(request.query);
  const result = await listPosRegisters(branchId(request), filters);

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

async function getPosRegisterRecord(request, response) {
  validateNoQuery(request.query);
  const posRegisterId = validatePosRegisterId(request.params.posRegisterId);
  const posRegister = await getPosRegister(branchId(request), posRegisterId);

  response.status(200).json({ success: true, data: { posRegister } });
}

async function createPosRegisterRecord(request, response) {
  validateNoQuery(request.query);
  const values = validateCreatePosRegister(request.body);
  const posRegister = await createPosRegister(
    branchId(request),
    values,
    getAuditContext(request),
  );

  response.status(201).json({ success: true, data: { posRegister } });
}

async function updatePosRegisterRecord(request, response) {
  validateNoQuery(request.query);
  const posRegisterId = validatePosRegisterId(request.params.posRegisterId);
  const changes = validateUpdatePosRegister(request.body);
  const posRegister = await updatePosRegister(
    branchId(request),
    posRegisterId,
    changes,
    getAuditContext(request),
  );

  response.status(200).json({ success: true, data: { posRegister } });
}

export {
  createPosRegisterRecord,
  getPosRegisterRecord,
  listPosRegisterRecords,
  updatePosRegisterRecord,
};
