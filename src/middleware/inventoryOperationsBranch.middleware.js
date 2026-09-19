import { getBranch } from '../services/branch.service.js';
import { validateBranchId } from '../validators/admin/branch.validator.js';

async function loadInventoryOperationsBranch(request, response, next) {
  try {
    const branchId = validateBranchId(request.params.branchId);
    request.inventoryOperationsBranch = await getBranch(branchId);
    next();
  } catch (error) { next(error); }
}

export { loadInventoryOperationsBranch };
