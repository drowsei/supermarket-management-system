import {
  createBranch as createBranchRecord,
  findBranchById,
  listBranches as listBranchRecords,
  updateBranch as updateBranchRecord,
} from '../repositories/branch.repository.js';
import { rethrowDuplicateAsConflict } from '../utils/databaseError.js';
import HttpError from '../utils/httpError.js';

async function listBranches(filters) {
  return listBranchRecords(filters);
}

async function getBranch(branchId) {
  const branch = await findBranchById(branchId);

  if (!branch) {
    throw new HttpError(404, 'Branch not found');
  }

  return branch;
}

async function createBranch(values, auditContext) {
  try {
    return await createBranchRecord(values, auditContext);
  } catch (error) {
    rethrowDuplicateAsConflict(error, 'Branch code already exists');
  }
}

async function updateBranch(branchId, changes, auditContext) {
  try {
    const branch = await updateBranchRecord(branchId, changes, auditContext);

    if (!branch) {
      throw new HttpError(404, 'Branch not found');
    }

    return branch;
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    rethrowDuplicateAsConflict(error, 'Branch code already exists');
  }
}

export { createBranch, getBranch, listBranches, updateBranch };
