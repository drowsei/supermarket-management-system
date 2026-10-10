import { element } from '../ui.js';
import { closeModal, openModal } from './modal.js';

let inlineConfirmationSequence = 0;

export function confirmAction({ title, message, confirmLabel = 'Confirm', tone = 'danger' }) {
  return new Promise((resolve) => {
    const cancel = element('button', { className: 'button button-secondary', text: 'Cancel', attributes: { type: 'button' } });
    const confirm = element('button', { className: `button button-${tone}`, text: confirmLabel, attributes: { type: 'button' } });
    const settle = (result) => { closeModal(); resolve(result); };
    cancel.addEventListener('click', () => settle(false));
    confirm.addEventListener('click', () => settle(true));
    openModal({ title, content: element('p', { text: message }), actions: [cancel, confirm] });
  });
}

export function showInlineConfirmation({
  container,
  title,
  message,
  confirmLabel = 'Confirm',
  tone = 'danger',
  onCancel,
  onConfirm,
}) {
  const id = `inline-confirmation-${++inlineConfirmationSequence}`;
  const region = element('section', {
    className: `inline-confirmation inline-confirmation-${tone}`,
    attributes: { role: 'alertdialog', 'aria-labelledby': `${id}-title`, 'aria-describedby': `${id}-message` },
  });
  const heading = element('h3', { text: title, attributes: { id: `${id}-title` } });
  const copy = element('p', { text: message, attributes: { id: `${id}-message` } });
  const cancelButton = element('button', { className: 'button button-secondary', text: 'Cancel', attributes: { type: 'button' } });
  const confirmButton = element('button', { className: `button button-${tone}`, text: confirmLabel, attributes: { type: 'button' } });
  const actions = element('div', { className: 'inline-confirmation-actions' }, [cancelButton, confirmButton]);
  region.append(heading, copy, actions);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    region.remove();
  };
  const cancel = async () => {
    if (closed || cancelButton.disabled) return;
    const result = await onCancel?.();
    if (result === false) return;
    close();
  };
  cancelButton.addEventListener('click', cancel);
  confirmButton.addEventListener('click', () => onConfirm?.({ confirmButton, cancelButton, close }));
  region.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
  });
  container.append(region);
  queueMicrotask(() => cancelButton.focus());
  return { region, cancelButton, confirmButton, close };
}
