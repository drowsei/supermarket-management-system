import { buildForm } from '../components/form.js';
import { tabBar } from '../components/tabs.js';
import { element, pageHeader } from '../ui.js';

export async function renderWorkspace(root, { tabs, active, context = {}, banner = null }) {
  const selected = tabs.some((tab) => tab.id === active) ? active : tabs[0]?.id;
  const shell = element('div');
  if (banner) shell.append(typeof banner === 'string'
    ? element('div', { className: 'module-context context-banner', text: banner })
    : banner);
  const pane = element('div');
  shell.append(tabBar(tabs, selected, (id) => {
    const params = new URLSearchParams(context.query ?? {});
    params.set('tab', id);
    location.hash = `#/${context.route}?${params}`;
  }), pane);
  root.replaceChildren(shell);
  const tab = tabs.find((item) => item.id === selected);
  if (tab) await tab.render(pane, context);
}

export function selectionGate(root, {
  title, message, selector, route, query = {}, submitLabel = 'Continue', guidance = '',
}) {
  const wrapper = element('div');
  const card = element('section', { className: 'card selection-gate' });
  const built = buildForm([selector], {}, { submitLabel });
  built.form.addEventListener('submit', (event) => {
    event.preventDefault();
    const values = built.values();
    const selectedId = String(values[selector.name] ?? '');
    if (!selectedId) return;
    const params = new URLSearchParams(query);
    params.set(selector.name, selectedId);
    location.hash = `#/${route}?${params}`;
  });
  card.append(built.form);
  if (guidance) card.append(element('p', { className: 'muted selection-guidance', text: guidance }));
  wrapper.append(pageHeader(title, message), card);
  root.replaceChildren(wrapper);
}

export function contextGate(root, { title, message, field, label, route, query = {} }) {
  const wrapper = element('div');
  const heading = pageHeader(title, message);
  const card = element('section', { className: 'card' });
  const form = element('form', { className: 'filters' });
  const group = element('div', { className: 'field search-field' });
  const input = element('input', { attributes: { id: field, name: field, required: '', inputmode: 'numeric', pattern: '[1-9][0-9]*' } });
  group.append(element('label', { text: label, attributes: { for: field } }), input);
  const submit = element('button', { className: 'button button-primary', text: 'Open workspace', attributes: { type: 'submit' } });
  form.append(group, submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const params = new URLSearchParams(query);
    params.set(field, input.value.trim());
    location.hash = `#/${route}?${params}`;
  });
  card.append(form);
  wrapper.append(heading, card);
  root.replaceChildren(wrapper);
}
