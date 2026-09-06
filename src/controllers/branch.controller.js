import {
  createBranch,
  getBranch,
  listBranches,
  updateBranch,
} from '../services/branch.service.js';
import { getAuditContext } from '../utils/auditContext.js';
import { paginationMetadata } from '../validators/admin/common.validator.js';
import {
  validateBranchId,
  validateBranchListQuery,
  validateCreateBranch,
  validateUpdateBranch,
} from '../validators/admin/branch.validator.js';

async function listBranchRecords(request, response) {
  const filters = validateBranchListQuery(request.query);
  const result = await listBranches(filters);

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

async function getBranchRecord(request, response) {
  const branchId = validateBranchId(request.params.branchId);
  const branch = await getBranch(branchId);

  response.status(200).json({ success: true, data: { branch } });
}

async function createBranchRecord(request, response) {
  const values = validateCreateBranch(request.body);
  const branch = await createBranch(values, getAuditContext(request));

  response.status(201).json({ success: true, data: { branch } });
}

async function updateBranchRecord(request, response) {
  const branchId = validateBranchId(request.params.branchId);
  const changes = validateUpdateBranch(request.body);
  const branch = await updateBranch(
    branchId,
    changes,
    getAuditContext(request),
  );

  response.status(200).json({ success: true, data: { branch } });
}

export {
  createBranchRecord,
  getBranchRecord,
  listBranchRecords,
  updateBranchRecord,
};
