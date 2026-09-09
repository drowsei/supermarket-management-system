import { getBranch } from '../services/branch.service.js';
import { validateBranchId } from '../validators/admin/branch.validator.js';

async function loadPricingBranch(request, response, next) {
  try {
    const branchId = validateBranchId(request.params.branchId);
    const branch = await getBranch(branchId);

    request.pricingBranch = branch;
    next();
  } catch (error) {
    next(error);
  }
}

export { loadPricingBranch };
