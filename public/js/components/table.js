import { element, statusBadge } from '../ui.js';
import { textValue, titleCase } from '../formatters.js';

export function displayTableValue(value, column = {}) {
  if (typeof value === 'boolean') {
    if (column.key === 'isActive') return value ? 'Active' : 'Inactive';
    if (/requires/i.test(column.key)) return value ? 'Required' : 'Not required';
    return value ? 'Yes' : 'No';
  }
  if (typeof value === 'string' && /^[A-Z][A-Z0-9_]*$/.test(value)) return titleCase(value);
  return textValue(value);
}

export function dataTable({ caption, columns, items, actions = [], groupBy }) {
  const wrap = element('div', { className: 'table-wrap' }); const table = element('table');
  table.append(element('caption', { text: caption }));
  const head = element('thead'); const headerRow = element('tr');
  for (const column of columns) headerRow.append(element('th', { text: column.label ?? titleCase(column.key), attributes: { scope: 'col' } }));
  if (actions.length) headerRow.append(element('th', { text: 'Actions', attributes: { scope: 'col' } }));
  head.append(headerRow); table.append(head); const body = element('tbody');
  let currentGroup = null;
  for (const item of items) {
    const group = groupBy ? String(groupBy(item)) : null;
    if (group && group !== currentGroup) {
      currentGroup = group;
      body.append(element('tr', { className: 'table-group-row' }, [
        element('th', { text: group, attributes: { scope: 'rowgroup', colspan: columns.length + (actions.length ? 1 : 0) } }),
      ]));
    }
    const row = element('tr');
    for (const column of columns) {
      const cell = element('td'); const value = valueAt(item, column.key);
      if (column.status) cell.append(statusBadge(value));
      else if (column.render) cell.append(column.render(value, item));
      else cell.textContent = displayTableValue(value, column);
      row.append(cell);
    }
    if (actions.length) {
      const visible = actions.filter((candidate) => !candidate.show || candidate.show(item));
      const cell = element('td'); const cluster = element('div', { className: 'cell-actions' });
      const primary = visible.slice(0, 2);
      const secondary = visible.slice(2);
      for (const action of primary) cluster.append(actionButton(action, item));
      if (secondary.length) {
        const menu = element('details', { className: 'row-action-menu' });
        menu.append(element('summary', { className: 'button button-quiet button-small', text: 'More' }));
        const panel = element('div', { className: 'row-action-menu-panel', attributes: { role: 'menu' } });
        for (const action of secondary) panel.append(actionButton(action, item, menu));
        menu.append(panel); cluster.append(menu);
      }
      cell.append(cluster); row.append(cell);
    }
    body.append(row);
  }
  table.append(body); wrap.append(table); return wrap;
}

function actionButton(action, item, menu) {
  const button = element('button', {
    className: action.className ?? 'button button-quiet button-small',
    text: action.label,
    attributes: { type: 'button', role: menu ? 'menuitem' : null },
  });
  button.addEventListener('click', () => {
    if (menu) menu.open = false;
    action.onSelect(item, button);
  });
  return button;
}

function valueAt(item, key) { return String(key).split('.').reduce((value, part) => value?.[part], item); }
