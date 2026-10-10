import { element } from '../ui.js';
import { titleCase } from '../formatters.js';
import { buildEntitySelector } from './entitySelector.js';

export function buildForm(fields, initial = {}, { submitLabel = 'Save', onCancel, context = {} } = {}) {
  const form = element('form');
  const error = element('div', { className: 'form-error hidden', attributes: { role: 'alert' } });
  const grid = element('div', { className: 'form-grid' });
  for (const definition of fields) grid.append(buildField(definition, initial[definition.name], context));
  const submit = element('button', { className: 'button button-primary', text: submitLabel, attributes: { type: 'submit' } });
  const actions = [];
  if (onCancel) {
    const cancel = element('button', { className: 'button button-secondary', text: 'Cancel', attributes: { type: 'button' } });
    cancel.addEventListener('click', onCancel);
    actions.push(cancel);
  }
  actions.push(submit);
  form.append(error, grid, element('div', { className: 'form-actions' }, actions));
  const unavailableSelectors = new Set();
  form.addEventListener('entity-selector-availability', (event) => {
    submit.disabled = updateUnavailableSelectors(unavailableSelectors, event.detail);
  });
  return { form, error, submit, values: () => readValues(form, fields, context) };
}
export function updateUnavailableSelectors(unavailableSelectors, { fieldName, available }) {
  if (available) unavailableSelectors.delete(fieldName);
  else unavailableSelectors.add(fieldName);
  return unavailableSelectors.size > 0;
}
function buildField(definition, current, context) {
  if (definition.type === 'remote-select') return buildEntitySelector(definition, current, context);
  const id = `field-${definition.name}-${Math.random().toString(36).slice(2, 8)}`;
  if (definition.type === 'checkbox') {
    const input = element('input', { attributes: { id, name: definition.name, type: 'checkbox' } });
    input.checked = current === undefined ? Boolean(definition.default) : Boolean(current);
    return element('label', { className: 'checkbox field-full' }, [input, element('span', { text: definition.label })]);
  }
  const wrapper = element('div', { className: definition.full ? 'field field-full' : 'field' });
  let input;
  if (definition.type === 'select') {
    input = element('select', { attributes: { id, name: definition.name, required: definition.required ? '' : null } });
    if (definition.placeholder || !definition.required || definition.nullable) input.append(element('option', { text: definition.placeholder ?? 'Select…', attributes: { value: '' } }));
    const options = typeof definition.options === 'function'
      ? definition.options({ current, context })
      : definition.options ?? [];
    for (const option of options) {
      const value = typeof option === 'string' ? option : option.value; const label = typeof option === 'string' ? titleCase(option) : option.label;
      input.append(element('option', { text: label, attributes: { value: String(value) } }));
    }
  } else if (definition.type === 'textarea') {
    input = element('textarea', { attributes: { id, name: definition.name, maxlength: definition.maxlength, required: definition.required ? '' : null, placeholder: definition.placeholder } });
  } else {
    input = element('input', { attributes: { id, name: definition.name, type: definition.type ?? 'text', maxlength: definition.maxlength, required: definition.required ? '' : null, placeholder: definition.placeholder, autocomplete: 'off' } });
  }
  const displayed = definition.initialTransform && current !== undefined && current !== null
    ? definition.initialTransform(current, context)
    : current;
  if (displayed !== undefined && displayed !== null) input.value = String(displayed);
  else if (definition.default !== undefined && definition.type !== 'checkbox') input.value = String(definition.default);
  wrapper.append(element('label', { text: `${definition.label} ${definition.required ? '(required)' : '(optional)'}`, attributes: { for: id } }), input);
  if (definition.help) wrapper.append(element('small', { className: 'muted', text: typeof definition.help === 'function' ? definition.help(context) : definition.help }));
  return wrapper;
}
function readValues(form, fields, context) {
  const values = {};
  for (const definition of fields) {
    const input = form.elements.namedItem(definition.name); let value = definition.type === 'checkbox' ? input.checked : input.value;
    if (definition.type !== 'checkbox') value = value.trim();
    if (value === '' && definition.nullable) values[definition.name] = null;
    else if (value !== '' || definition.type === 'checkbox' || definition.required) values[definition.name] = definition.transform ? definition.transform(value, context) : value;
  }
  return values;
}
export function withSubmitLock(button, task) {
  if (button.dataset.busy === 'true') return Promise.resolve(undefined);
  const original = button.textContent; button.dataset.busy = 'true'; button.disabled = true; button.textContent = 'Working…';
  return Promise.resolve().then(task).finally(() => { button.dataset.busy = 'false'; button.disabled = false; button.textContent = original; });
}
