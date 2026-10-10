import { api, buildQuery } from '../api.js';
import {
  branchDisplayName,
  branchMonthRange,
  hasAuthoritativeBranchMetadata,
  METADATA_UNAVAILABLE_MESSAGE,
} from '../branchContext.js';
import {
  buildReportRequestQuery,
  changeReportFilters,
  changeReportPage,
  createReportRequestState,
  isPaginatedReport,
} from '../reportState.js';
import { getState, isCurrentGeneration, nextRequestGeneration } from '../state.js';
import { hasGlobalPermission } from '../permissions.js';
import { element, pageHeader } from '../ui.js';
import { reportNavigation } from '../components/reportNavigation.js';
import { formatDecimalExact, formatMoney, quantitiesByUnit, titleCase } from '../formatters.js';
import { validateDateRange } from '../validation.js';
import { dataTable } from '../components/table.js';
import { paginationView } from '../components/pagination.js';
import { barChart } from '../components/chart.js';
import { emptyState } from '../components/emptyState.js';
import { loadingState } from '../components/loadingState.js';
import { errorState } from '../components/errorState.js';

export const REPORTS = [
  ['overview', 'Overview', 'overview'], ['sales-summary', 'Sales summary', 'sales/summary'], ['sales-trend', 'Sales trend', 'sales/trend'],
  ['products', 'Product performance', 'products'], ['returns', 'Returns', 'returns'], ['payments', 'Payments', 'payments'],
  ['inventory', 'Current inventory', 'inventory', false], ['movements', 'Inventory movements', 'inventory/movements'],
  ['purchasing', 'Purchasing', 'purchasing'], ['suppliers', 'Suppliers', 'suppliers'], ['tills', 'Tills', 'tills'], ['customers', 'Customers', 'customers'],
].map(([id, label, path, dated = true]) => ({ id, label, path, dated }));

export async function renderReports(root, context) {
  document.title = 'Reports · Supermarket Management System';
  const appState = getState();
  const branchId = appState.selectedBranchId;
  const branch = appState.branches.find((entry) => String(entry.branchId) === branchId);
  const available = [...REPORTS];
  if (hasGlobalPermission(appState.session.authorization, 'reports.read')) {
    available.push({ id: 'organization', label: 'Organization branches', path: 'organization', dated: true });
  }
  const selected = available.find((item) => item.id === context.query.report) ?? available[0];
  const page = element('div');
  page.append(pageHeader('Reports hub', 'Review sales, stock, purchasing, customers, tills, payments, and returns.'));
  page.append(reportNavigation(available, selected.id, (id) => { location.hash = `#/reports?report=${id}`; }));

  if (!branchId && selected.id !== 'organization') {
    page.append(errorState('Choose a branch to run this report.'));
    root.replaceChildren(page);
    return;
  }
  if (selected.id !== 'organization' && !hasAuthoritativeBranchMetadata(branch)) {
    page.append(errorState(METADATA_UNAVAILABLE_MESSAGE));
    root.replaceChildren(page);
    return;
  }

  const dates = hasAuthoritativeBranchMetadata(branch) ? branchMonthRange(branch) : null;
  const currency = hasAuthoritativeBranchMetadata(branch) ? branch.currencyCode : '';
  const form = element('form', { className: 'filters' });
  const from = dateField('report-from', 'From', dates?.from ?? '');
  const to = dateField('report-to', 'To', dates?.to ?? '');
  if (selected.dated) form.append(from, to);
  let groupBy;
  if (selected.id === 'sales-trend') {
    groupBy = selectField('report-group', 'Group by', ['day', 'week', 'month'], 'day');
    form.append(groupBy);
  }
  if (selected.id === 'products') {
    groupBy = selectField('report-group', 'Group by', ['variant', 'product', 'category'], 'variant');
    form.append(groupBy);
  }
  const run = element('button', { className: 'button button-primary', text: 'Run report', attributes: { type: 'submit' } });
  form.append(run);
  page.append(form);
  page.append(element('p', {
    className: 'module-context',
    text: selected.id === 'organization'
      ? 'Branch totals keep each currency separate. Dates follow each branch timezone.'
      : `${branchDisplayName(branch)} · ${branch.timezone} · ${currency}`,
  }));
  const content = element('div');
  page.append(content);
  root.replaceChildren(page);

  const readFilters = () => {
    const filters = {};
    if (selected.dated) {
      filters.from = from.querySelector('input').value;
      filters.to = to.querySelector('input').value;
    }
    if (groupBy) filters.groupBy = groupBy.querySelector('select').value;
    return filters;
  };
  let requestState = createReportRequestState(selected.id, readFilters());
  let controller;

  async function load() {
    const filters = requestState.filters;
    if (selected.dated) {
      const error = validateDateRange(filters.from, filters.to);
      if (error) {
        content.replaceChildren(errorState(error));
        return;
      }
    }
    controller?.abort();
    controller = new AbortController();
    const path = selected.id === 'organization'
      ? '/api/admin/reports/branches'
      : `/api/admin/branches/${encodeURIComponent(branchId)}/reports/${selected.path}`;
    const generation = nextRequestGeneration();
    content.replaceChildren(loadingState('Running report…'));
    try {
      const response = await api.get(path + buildQuery(buildReportRequestQuery(requestState)), { signal: controller.signal });
      if (!isCurrentGeneration(generation)) return;
      renderReport(content, response.data, selected, { currency });
      if (isPaginatedReport(selected.id) && response.data?.pagination) {
        content.append(paginationView(response.data.pagination, (nextPage) => {
          requestState = changeReportPage(requestState, nextPage);
          load();
        }));
      }
    } catch (failure) {
      if (failure.name === 'AbortError' || !isCurrentGeneration(generation)) return;
      content.replaceChildren(errorState(failure.message, load));
    }
  }

  for (const input of form.querySelectorAll('input, select')) {
    input.addEventListener('change', () => {
      requestState = changeReportFilters(requestState, readFilters());
    });
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    requestState = changeReportFilters(requestState, readFilters());
    load();
  });

  if (selected.dated && (!requestState.filters.from || !requestState.filters.to)) {
    content.replaceChildren(emptyState(
      'Choose a date range',
      'Choose calendar dates for this report. Each branch uses its configured timezone.',
    ));
    return;
  }
  await load();
}

function renderReport(root, data, report, { currency }) {
  root.replaceChildren();
  if (report.id === 'sales-trend') {
    root.append(barChart(data.items ?? [], { currency, labelKey: 'periodStart' }));
    root.append(reportTable(data.items ?? [], 'Sales trend'));
    return;
  }
  const scalarEntries = Object.entries(data ?? {}).filter(([, value]) => !Array.isArray(value) && !(value && typeof value === 'object'));
  if (scalarEntries.length) {
    const grid = element('section', { className: 'metric-grid' });
    for (const [key, value] of scalarEntries.slice(0, 12)) {
      const shown = value === null
        ? (key.toLowerCase().includes('profit') ? 'Unavailable — incomplete historical cost' : 'N/A')
        : looksMonetary(key) ? formatMoney(value, data.currencyCode ?? currency) : formatDecimalExact(String(value));
      grid.append(element('article', { className: 'card metric-card' }, [
        element('div', { className: 'metric-label', text: titleCase(key.replace(/([A-Z])/g, ' $1')) }),
        element('div', { className: 'metric-value', text: shown }),
      ]));
    }
    root.append(grid);
  }
  renderQuantities(root, data.quantitiesByUnit);
  if (data.summary) {
    root.append(element('h2', { text: 'Summary' }));
    renderObject(root, data.summary, currency);
  }
  if (Array.isArray(data.items)) root.append(reportTable(data.items, report.label));
  if (!scalarEntries.length && !data.summary && !data.items) renderObject(root, data, currency);
}

function renderObject(root, value, currency) {
  renderQuantities(root, value?.quantitiesByUnit);
  if (Array.isArray(value?.totalsByCurrency)) {
    const region = element('section', { className: 'card stack' }, [element('h3', { text: 'Totals by currency' })]);
    for (const total of value.totalsByCurrency) region.append(keyValues(total, total.currencyCode));
    root.append(region);
  }
  const entries = Object.entries(value ?? {}).filter(([key, item]) => key !== 'quantitiesByUnit' && key !== 'totalsByCurrency' && !Array.isArray(item) && !(item && typeof item === 'object'));
  if (entries.length) root.append(keyValues(Object.fromEntries(entries), currency));
}

function renderQuantities(root, values) {
  const units = quantitiesByUnit(values);
  if (!units.length) return;
  const card = element('section', { className: 'card' }, [
    element('h2', { text: 'Quantities by base unit' }),
    element('p', { className: 'muted', text: 'Incompatible physical units are never combined.' }),
  ]);
  const list = element('div', { className: 'quantity-list' });
  for (const unit of units) {
    const label = unit.symbol || unit.unitCode || unit.unitName;
    list.append(element('div', { className: 'quantity-row' }, [
      element('strong', { text: label }),
      element('span', { text: `Sold ${unit.sold} · Returned ${unit.returned} · Restockable ${unit.restockable} · Non-restockable ${unit.nonRestockable}` }),
    ]));
  }
  card.append(list);
  root.append(card);
}

function reportTable(items, caption) {
  if (!items.length) {
    return element('div', { className: 'card state-panel' }, [
      element('h2', { text: 'No activity for selected period' }),
      element('p', { className: 'muted', text: 'The report completed successfully with no rows.' }),
    ]);
  }
  const keys = [...new Set(items.flatMap((item) => Object.keys(item)))]
    .filter((key) => key !== 'quantitiesByUnit')
    .slice(0, 10);
  const columns = keys.map((key) => ({
    key,
    label: titleCase(key.replace(/([A-Z])/g, ' $1')),
    render: (value, item) => {
      if (value === null) return element('span', { text: key.toLowerCase().includes('profit') ? 'N/A — incomplete cost' : 'N/A' });
      if (looksMonetary(key)) return element('span', { text: formatMoney(value, item.currencyCode) });
      return element('span', { text: String(value ?? '—') });
    },
  }));
  return dataTable({ caption, columns, items });
}

function keyValues(value, currency) {
  const list = element('dl', { className: 'card key-value' });
  for (const [key, item] of Object.entries(value)) {
    if (Array.isArray(item) || item && typeof item === 'object') continue;
    list.append(
      element('dt', { text: titleCase(key.replace(/([A-Z])/g, ' $1')) }),
      element('dd', { text: item === null ? 'N/A' : looksMonetary(key) ? formatMoney(item, currency) : String(item) }),
    );
  }
  return list;
}

function looksMonetary(key) {
  return /(amount|sales|revenue|cost|profit|value|cash|refund|payment)/i.test(key) && !/count/i.test(key);
}

function dateField(id, label, value) {
  const wrapper = element('div', { className: 'field' });
  wrapper.append(
    element('label', { text: label, attributes: { for: id } }),
    element('input', { attributes: { id, type: 'date', value, required: '' } }),
  );
  return wrapper;
}

function selectField(id, label, options, current) {
  const wrapper = element('div', { className: 'field' });
  const select = element('select', { attributes: { id } });
  for (const option of options) {
    select.append(element('option', { text: titleCase(option), attributes: { value: option, selected: option === current ? '' : null } }));
  }
  wrapper.append(element('label', { text: label, attributes: { for: id } }), select);
  return wrapper;
}
