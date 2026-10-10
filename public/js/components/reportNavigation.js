import { element } from '../ui.js';

const GROUPS = [
  ['Sales', ['overview', 'sales-summary', 'sales-trend', 'products']],
  ['Money & returns', ['returns', 'payments']],
  ['Stock & supply', ['inventory', 'movements', 'purchasing', 'suppliers']],
  ['Operations', ['tills', 'customers']],
  ['Organization', ['organization']],
];

export function reportNavigation(reports, selectedId, onSelect) {
  const wrapper = element('div', { className: 'field report-navigation' });
  const select = element('select', { attributes: { id: 'report-navigation', 'aria-label': 'Choose report' } });
  for (const [label, ids] of GROUPS) {
    const available = reports.filter((report) => ids.includes(report.id));
    if (!available.length) continue;
    const group = element('optgroup', { attributes: { label } });
    for (const report of available) {
      group.append(element('option', {
        text: report.label,
        attributes: { value: report.id, selected: report.id === selectedId ? '' : null },
      }));
    }
    select.append(group);
  }
  select.addEventListener('change', () => onSelect(select.value));
  wrapper.append(element('label', { text: 'Report', attributes: { for: 'report-navigation' } }), select);
  return wrapper;
}

export function reportNavigationIds(reports) {
  return GROUPS.flatMap(([, ids]) => ids).filter((id) => reports.some((report) => report.id === id));
}
