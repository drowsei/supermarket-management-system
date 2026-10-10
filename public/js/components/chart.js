import { element } from '../ui.js';

export function barChart(items, { valueKey = 'grossSalesAmount', labelKey = 'bucketLabel', currency = '' } = {}) {
  const section = element('section', { className: `card chart-shell${items.length ? '' : ' chart-shell-empty'}` });
  section.append(element('h2', { text: 'Sales trend' }));
  if (!items.length) {
    section.append(element('p', { className: 'muted', text: 'No sales activity is available for this period.' }));
    return section;
  }
  const values = items.map((item) => Math.max(0, Number(item[valueKey] ?? 0))).filter(Number.isFinite);
  const max = Math.max(0, ...values);
  const bars = element('div', { className: 'chart-bars', attributes: { role: 'img', 'aria-label': 'Sales trend bar chart' } });
  const labels = element('div', { className: 'chart-labels' });
  items.forEach((item) => {
    const numeric = Math.max(0, Number(item[valueKey] ?? 0));
    const height = max === 0 ? 0 : (numeric / max) * 100;
    const bar = element('div', { className: 'chart-bar', attributes: { title: `${item[labelKey] ?? ''}: ${currency} ${item[valueKey] ?? '0'}` } });
    bar.style.height = `${height}%`;
    bars.append(bar);
    labels.append(element('span', { text: item[labelKey] ?? item.bucket ?? '' }));
  });
  section.append(bars, labels);
  const details = element('details');
  details.append(element('summary', { className: 'details-summary', text: 'Accessible trend values' }));
  const list = element('ul');
  items.forEach((item) => list.append(element('li', { text: `${item[labelKey] ?? item.bucket ?? ''}: ${currency} ${item[valueKey] ?? '0'}` })));
  details.append(list); section.append(details);
  return section;
}
