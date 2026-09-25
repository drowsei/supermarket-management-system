import { getBranch } from '../services/branch.service.js';
import { validateBranchId } from '../validators/admin/branch.validator.js';

async function loadSalesBranch(request, response, next) {
  try {
    const branchId = validateBranchId(request.params.branchId);
    request.salesBranch = await getBranch(branchId);
    next();
  } catch (error) {
    next(error);
  }
}

export { loadSalesBranch };
