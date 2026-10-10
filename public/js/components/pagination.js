import { element } from '../ui.js';
export function paginationView(pagination, onChange) {
  const page = Number(pagination?.page ?? 1); const totalPages = Number(pagination?.totalPages ?? 0); const totalItems = Number(pagination?.totalItems ?? 0);
  const region = element('nav', { className: 'pagination', attributes: { 'aria-label': 'Pagination' } });
  region.append(element('span', { className: 'muted', text: `${totalItems} item${totalItems === 1 ? '' : 's'} · Page ${page} of ${Math.max(totalPages, 1)}` }));
  const controls = element('div', { className: 'pagination-controls' });
  const previous = element('button', { text: 'Previous', attributes: { type: 'button', disabled: page <= 1 ? '' : null } });
  const next = element('button', { text: 'Next', attributes: { type: 'button', disabled: totalPages === 0 || page >= totalPages ? '' : null } });
  previous.addEventListener('click', () => onChange(page - 1)); next.addEventListener('click', () => onChange(page + 1));
  controls.append(previous, next); region.append(controls); return region;
}
export function paginationModel(page, limit, totalItems) {
  const safePage = Math.max(1, Number(page) || 1); const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  return { page: safePage, limit: safeLimit, totalItems: Number(totalItems) || 0, totalPages: Math.ceil((Number(totalItems) || 0) / safeLimit) };
}
