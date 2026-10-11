import { remoteSelect } from '../components/entitySelector.js';
import { renderResourcePage } from '../components/resourcePage.js';
import { refundConfig, returnConfig } from '../contracts.js';
import { getState } from '../state.js';
import { saleWorkspaceSelector } from './sales.js';
import { renderWorkspace, selectionGate } from './workspace.js';

export function completedReturnSelector(branchId, saleId) {
  return remoteSelect('salesReturnId', 'Completed return', {
    path: `/api/admin/branches/${encodeURIComponent(String(branchId))}/sales/${encodeURIComponent(String(saleId))}/returns`,
    valueKey: 'salesReturnId',
    label: (item) => `${item.returnNumber} · ${item.currencyCode ?? ''} ${item.refundTotalAmount} · ${String(item.status).replaceAll('_', ' ')}`.trim(),
    query: { status: 'COMPLETED' },
    limit: 100,
    searchable: false,
    emptyMessage: 'This sale has no completed return available for refund.',
  }, true);
}

export function renderReturns(root, context) {
  const tab = context.query.tab ?? 'returns';
  const branchId = getState().selectedBranchId;
  if (!context.query.saleId) {
    selectionGate(root, {
      title: 'Sales returns & refunds',
      message: 'Choose an eligible completed sale to start or review a return.',
      selector: saleWorkspaceSelector(branchId, { completedOnly: true }),
      route: 'returns',
      query: tab === 'refunds' ? { tab: 'refunds' } : {},
      submitLabel: 'Start return',
    });
    return;
  }
  if (tab === 'refunds' && !context.query.salesReturnId) {
    selectionGate(root, {
      title: 'Refund attempts',
      message: 'Choose a completed return to review or record its refund attempts.',
      selector: completedReturnSelector(branchId, context.query.saleId),
      route: 'returns',
      query: { tab: 'refunds', saleId: String(context.query.saleId) },
      submitLabel: 'Open refunds',
    });
    return;
  }
  return renderWorkspace(root, {
    active: tab,
    context: { ...context, route: 'returns' },
    tabs: [
      { id: 'returns', label: 'Returns', render: (pane) => renderResourcePage(pane, returnConfig, { saleId: String(context.query.saleId) }) },
      { id: 'refunds', label: 'Refund attempts', render: (pane) => renderResourcePage(pane, refundConfig, { saleId: String(context.query.saleId), salesReturnId: String(context.query.salesReturnId) }) },
    ],
  });
}
