import { eligibleOpenTillSessions, remoteSelect } from '../components/entitySelector.js';
import { renderResourcePage } from '../components/resourcePage.js';
import { saleConfig, salePaymentConfig } from '../contracts.js';
import { getState } from '../state.js';
import { element } from '../ui.js';
import { renderWorkspace, selectionGate } from './workspace.js';

export function openTillSelector(branchId) {
  return remoteSelect('tillSessionId', 'Open till session', {
    path: `/api/admin/branches/${encodeURIComponent(String(branchId))}/till-sessions`,
    valueKey: 'tillSessionId',
    label: (item) => `${item.sessionNumber} · Opened ${displayDate(item.openedAt)} · Register ${item.posRegisterId} · Cashier ${item.cashierEmployeeId}`,
    query: { status: 'OPEN' },
    searchable: false,
    filter: eligibleOpenTillSessions,
    emptyMessage: 'No open till session is available for this branch.',
    unauthorizedMessage: 'You need till-session access to choose an open till.',
  }, true);
}

export function saleWorkspaceSelector(branchId, { completedOnly = false } = {}) {
  return remoteSelect('saleId', completedOnly ? 'Completed sale' : 'Sale', {
    path: `/api/admin/branches/${encodeURIComponent(String(branchId))}/sales`,
    valueKey: 'saleId',
    label: (item) => `${item.saleNumber} · ${displayDate(item.soldAt ?? item.createdAt)} · ${item.currencyCode} ${item.totalAmount} · ${String(item.status).replaceAll('_', ' ')}`,
    query: completedOnly ? { status: 'COMPLETED' } : {},
    searchPlaceholder: 'Search by sale number',
    emptyMessage: completedOnly ? 'No completed sales are available.' : 'No sales are available for this branch.',
  }, true);
}

export function renderSales(root, context) {
  const tab = context.query.tab ?? 'sales';
  const branchId = getState().selectedBranchId;
  if (context.query.new === 'true' && !context.query.tillSessionId) {
    selectionGate(root, {
      title: 'New checkout',
      message: 'Choose an open till session before starting a sale.',
      selector: openTillSelector(branchId),
      route: 'sales',
      query: { new: 'true' },
      submitLabel: 'Continue to checkout',
      guidance: 'No open till? Go to POS & tills, open the Registers tab, and use Open till on an active register.',
    });
    return;
  }
  if (tab === 'payments' && !context.query.saleId) {
    selectionGate(root, {
      title: 'Payment attempts',
      message: 'Search for a sale to review or record its payment attempts.',
      selector: saleWorkspaceSelector(branchId),
      route: 'sales',
      query: { tab: 'payments' },
      submitLabel: 'Open payments',
    });
    return;
  }
  const config = context.query.new === 'true' ? saleConfig : { ...saleConfig, create: false };
  return renderWorkspace(root, {
    active: tab,
    context: { ...context, route: 'sales' },
    tabs: [
      { id: 'sales', label: 'Sales', render: async (pane) => {
        if (context.query.new !== 'true') {
          const action = element('a', { className: 'button button-primary', text: 'Start checkout', attributes: { href: '#/sales?new=true' } });
          pane.append(element('div', { className: 'toolbar' }, [action]));
          const list = element('div'); pane.append(list);
          await renderResourcePage(list, config, { tillSessionId: context.query.tillSessionId });
        } else await renderResourcePage(pane, config, { tillSessionId: String(context.query.tillSessionId) });
      } },
      { id: 'payments', label: 'Payment attempts', render: (pane) => renderResourcePage(pane, salePaymentConfig, { saleId: String(context.query.saleId) }) },
    ],
  });
}

function displayDate(value) {
  if (!value) return 'date unavailable';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString();
}
