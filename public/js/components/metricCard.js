import { element } from '../ui.js';

export function metricCard(label, value, detail = '', { prominent = false } = {}) {
  const children = [
    element('div', { className: 'metric-label', text: label }),
    element('div', { className: 'metric-value', text: value }),
  ];
  if (detail) children.push(element('div', { className: 'metric-detail', text: detail }));
  return element('article', { className: `card metric-card${prominent ? ' metric-card-prominent' : ''}` }, children);
}
