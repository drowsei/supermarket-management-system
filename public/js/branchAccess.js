import { api } from './api.js';
import {
  branchMetadataFromReport,
  createScopedBranchIdentity,
  hasAuthoritativeBranchMetadata,
  normalizeBranchMetadata,
} from './branchContext.js';
import { hasPermission } from './permissions.js';
import {
  getState,
  isCurrentGeneration,
  nextRequestGeneration,
  setState,
} from './state.js';

const BRANCH_KEY = 'supermarket.branchId';
const BRANCH_CONTEXT_PERMISSIONS = [
  'reports.read',
  'pricing.read',
  'purchasing.read',
  'receiving.read',
  'inventory.read',
  'inventory_adjustments.read',
  'stock_counts.read',
  'stock_transfers.read',
  'pos_registers.read',
  'till_sessions.read',
  'sales.read',
  'payments.read',
  'returns.read',
];

export function resolveSelectedBranchId(branches, storedBranchId = null, { selectFirst = false } = {}) {
  const stored = storedBranchId === null || storedBranchId === undefined
    ? null
    : String(storedBranchId);
  if (stored && branches.some((branch) => String(branch.branchId) === stored)) return stored;
  if (selectFirst && branches[0]) return String(branches[0].branchId);
  return null;
}

export function createBranchStore(storage) {
  return {
    get: () => storage.getItem(BRANCH_KEY),
    set(branchId) {
      if (branchId === null || branchId === undefined || branchId === '') {
        storage.removeItem(BRANCH_KEY);
      } else {
        storage.setItem(BRANCH_KEY, String(branchId));
      }
    },
    clear: () => storage.removeItem(BRANCH_KEY),
  };
}

function browserBranchStore() {
  return createBranchStore(sessionStorage);
}

async function loadBranchCatalog(request, generation) {
  const branches = new Map();
  let lastPage = null;
  for (let page = 1; lastPage === null || page <= lastPage; page += 1) {
    const response = await request.get(`/api/admin/branches?limit=100${page > 1 ? `&page=${page}` : ''}`);
    if (!isCurrentGeneration(generation)) return null;
    const items = response.data?.items;
    const pagination = response.data?.pagination;
    if (!Array.isArray(items) || items.length > 100) {
      throw new Error('Unable to load the complete branch list. Please refresh.');
    }
    if (pagination) {
      if (!Number.isSafeInteger(pagination.totalPages) || pagination.totalPages < 0
        || pagination.page !== page
        || (lastPage !== null && pagination.totalPages !== lastPage)
        || (pagination.totalPages === 0 && items.length > 0)) {
        throw new Error('The branch list changed or its pagination is invalid. Please refresh.');
      }
      lastPage = pagination.totalPages;
    } else if (page === 1 && items.length < 100) {
      lastPage = 1;
    } else {
      throw new Error('Unable to load the complete branch list. Please refresh.');
    }
    const previousSize = branches.size;
    for (const item of items) {
      const branch = normalizeBranchMetadata(item);
      if (!branch.branchId) throw new Error('The branch list contains an invalid record. Please refresh.');
      branches.set(branch.branchId, branch);
    }
    if ((page > 1 || page < lastPage) && branches.size === previousSize) {
      throw new Error('The branch list did not advance. Please refresh.');
    }
  }
  return [...branches.values()];
}

export function rememberBranch(branchId) {
  const value = branchId === null || branchId === undefined || branchId === ''
    ? null
    : String(branchId);
  if (getState().selectedBranchId !== value) nextRequestGeneration();
  browserBranchStore().set(value);
  setState({ selectedBranchId: value });
}

export function restoreBranch() {
  return browserBranchStore().get();
}

export function clearRememberedBranch() {
  browserBranchStore().clear();
}

export async function loadAccessibleBranches({
  session = getState().session,
  request = api,
  storedBranchId = restoreBranch(),
  persistSelection = true,
  selectFirstWhenMissing = false,
} = {}) {
  if (!session) {
    setState({ branches: [], selectedBranchId: null });
    if (persistSelection) browserBranchStore().clear();
    return { branches: [], selectedBranchId: null };
  }

  const generation = nextRequestGeneration();
  let branches = [];
  if (hasPermission(session.authorization, 'branches.read')) {
    branches = await loadBranchCatalog(request, generation);
    if (branches === null) {
      return { branches: getState().branches, selectedBranchId: getState().selectedBranchId, stale: true };
    }
  }

  const scopedIds = Object.keys(session.authorization.permissions?.byBranch ?? {});
  for (const branchId of scopedIds) {
    if (!branches.some((branch) => String(branch.branchId) === branchId)) {
      branches.push(createScopedBranchIdentity(branchId));
    }
  }

  const allowed = branches.filter((branch) => BRANCH_CONTEXT_PERMISSIONS.some(
    (permission) => hasPermission(session.authorization, permission, String(branch.branchId)),
  ));
  const hydrated = await Promise.all(allowed.map(async (branch) => {
    const branchId = String(branch.branchId);
    if (hasAuthoritativeBranchMetadata(branch)
      || !hasPermission(session.authorization, 'reports.read', branchId)) return branch;
    try {
      const response = await request.get(
        `/api/admin/branches/${encodeURIComponent(branchId)}/reports/inventory?page=1&limit=1`,
      );
      return branchMetadataFromReport(response.data, branch);
    } catch {
      return branch;
    }
  }));

  if (!isCurrentGeneration(generation)) {
    return {
      branches: getState().branches,
      selectedBranchId: getState().selectedBranchId,
      stale: true,
    };
  }

  const selectedBranchId = resolveSelectedBranchId(hydrated, storedBranchId, {
    selectFirst: selectFirstWhenMissing,
  });
  setState({ branches: hydrated, selectedBranchId });
  if (persistSelection) browserBranchStore().set(selectedBranchId);
  return { branches: hydrated, selectedBranchId };
}

export { BRANCH_CONTEXT_PERMISSIONS };
