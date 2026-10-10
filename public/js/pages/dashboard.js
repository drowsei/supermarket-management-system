import { api, buildQuery } from '../api.js';
import {
  branchDisplayName,
  branchMonthRange,
  hasAuthoritativeBranchMetadata,
  METADATA_UNAVAILABLE_MESSAGE,
} from '../branchContext.js';
import { getState, isCurrentGeneration, nextRequestGeneration } from '../state.js';
import { element, pageHeader, refreshButton } from '../ui.js';
import { formatMoney, quantitiesByUnit } from '../formatters.js';
import { metricCard } from '../components/metricCard.js';
import { barChart } from '../components/chart.js';
import { loadingState } from '../components/loadingState.js';
import { errorState } from '../components/errorState.js';

export async function renderDashboard(root) {
  document.title = 'Dashboard · Supermarket Management System';
  const state = getState();
  const branch = state.branches.find((item) => String(item.branchId) === state.selectedBranchId);
  if (!state.selectedBranchId) {
    root.replaceChildren(pageHeader(
      'Select a branch',
      'Choose a branch from the selector above to view its dashboard and operations.',
    ));
    return;
  }

  const title = element('div');
  title.append(pageHeader(
    'Branch dashboard',
    `Current operational picture for ${branchDisplayName(branch)}.`,
  ));
  root.replaceChildren(title);
  if (!hasAuthoritativeBranchMetadata(branch)) {
    root.append(errorState(METADATA_UNAVAILABLE_MESSAGE));
    return;
  }

  const branchId = state.selectedBranchId;
  const currency = branch.currencyCode;
  const dates = branchMonthRange(branch);
  const filters = element('form', { className: 'filters dashboard-filters' });
  const fromField = dateField('dashboard-from', 'From', dates.from);
  const toField = dateField('dashboard-to', 'To', dates.to);
  const button = refreshButton({ type: 'submit' });
  filters.append(fromField, toField, button);
  root.append(filters);
  const content = element('div');
  root.append(content);

  async function load() {
    const generation = nextRequestGeneration();
    content.replaceChildren(loadingState('Loading dashboard…'));
    const params = {
      from: fromField.querySelector('input').value,
      to: toField.querySelector('input').value,
    };
    try {
      const [overviewResponse, trendResponse] = await Promise.all([
        api.get(`/api/admin/branches/${encodeURIComponent(branchId)}/reports/overview${buildQuery(params)}`),
        api.get(`/api/admin/branches/${encodeURIComponent(branchId)}/reports/sales/trend${buildQuery({ ...params, groupBy: 'day' })}`),
      ]);
      if (!isCurrentGeneration(generation)) return;
      const overview = overviewResponse.data;
      const trend = trendResponse.data;
      const metrics = overview;
      const grid = element('section', { className: 'metric-grid', attributes: { 'aria-label': 'Key performance indicators' } });
      const cards = [
        ['Net sales', formatMoney(metrics.netSalesAmount ?? '0.00', currency), true],
        ['Gross sales', formatMoney(metrics.grossSalesAmount ?? '0.00', currency), true],
        ['Completed sales', metrics.completedSaleCount ?? metrics.completedSalesCount ?? '0', false],
        ['Completed refunds', formatMoney(metrics.completedRefundAmount ?? '0.00', currency), false],
        ['Low stock variants', metrics.lowStockVariantCount ?? '0', false],
        ['Out of stock', metrics.outOfStockVariantCount ?? '0', false],
        ['Open till sessions', metrics.openTillSessionCount ?? '0', false],
        ['Open purchase orders', metrics.openPurchaseOrderCount ?? '0', false],
      ];
      cards.forEach(([label, value, prominent]) => grid.append(metricCard(label, String(value), '', { prominent })));
      content.replaceChildren(grid);
      const lower = element('div', { className: 'dashboard-grid' });
      lower.append(barChart(trend.items ?? [], { currency, labelKey: 'periodStart' }));
      const quantityCard = element('section', { className: 'card' }, [
        element('h2', { text: 'Stock movement by unit' }),
        element('p', { className: 'muted', text: 'Physical quantities stay separated by base unit.' }),
      ]);
      const list = element('div', { className: 'quantity-list' });
      const units = quantitiesByUnit(overview.quantitiesByUnit ?? metrics.quantitiesByUnit);
      if (units.length === 0) list.append(element('p', { className: 'muted', text: 'No unit activity for this period.' }));
      for (const unit of units) {
        list.append(element('div', { className: 'quantity-row' }, [
          element('span', { text: unit.symbol || unit.unitCode || unit.unitName }),
          element('strong', { text: `${unit.sold} sold · ${unit.returned} returned` }),
        ]));
      }
      quantityCard.append(list);
      lower.append(quantityCard);
      content.append(lower);
    } catch (failure) {
      if (failure.name === 'AbortError' || !isCurrentGeneration(generation)) return;
      content.replaceChildren(errorState(failure.message, load));
    }
  }

  filters.addEventListener('submit', (event) => {
    event.preventDefault();
    load();
  });
  await load();
}

function dateField(id, label, value) {
  const wrapper = element('div', { className: 'field' });
  wrapper.append(
    element('label', { text: label, attributes: { for: id } }),
    element('input', { attributes: { id, type: 'date', value, required: '' } }),
  );
  return wrapper;
}
