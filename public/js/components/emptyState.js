import { element } from '../ui.js';
export function emptyState(title = 'No records yet', message = 'There are no records to display.') {
  return element('div', { className: 'card state-panel' }, [element('h2', { text: title }), element('p', { className: 'muted', text: message })]);
}
