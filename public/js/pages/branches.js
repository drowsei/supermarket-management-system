import { loadAccessibleBranches } from '../branchAccess.js';
import { renderResourcePage } from '../components/resourcePage.js';
import { branchConfig } from '../contracts.js';

const liveBranchConfig = {
  ...branchConfig,
  async afterCreate() {
    await loadAccessibleBranches({ selectFirstWhenMissing: true });
    window.dispatchEvent(new Event('branch-context-refreshed'));
    return false;
  },
};

export const renderBranches = (root, context = {}) => renderResourcePage(root, liveBranchConfig, context);
