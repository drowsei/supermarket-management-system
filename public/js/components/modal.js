import { element } from '../ui.js';
let activeDialog = null;
let previouslyFocused = null;

export function openModal({ title, description = '', content, actions = [], size = 'medium' }) {
  closeModal();
  previouslyFocused = document.activeElement;
  const backdrop = element('div', { className: 'dialog-backdrop' });
  const dialog = element('section', {
    className: `dialog dialog-${size}`,
    attributes: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dialog-title' },
  });
  const close = element('button', {
    className: 'dialog-close', text: '×',
    attributes: { type: 'button', 'aria-label': 'Close dialog' },
  });
  close.addEventListener('click', closeModal);
  const header = element('header', { className: 'dialog-header' }, [
    element('div', {}, [
      element('h2', { text: title, attributes: { id: 'dialog-title' } }),
      description ? element('p', { className: 'muted', text: description }) : null,
    ]), close,
  ]);
  const body = element('div', { className: 'dialog-body' }, [content]);
  const footer = element('footer', { className: 'dialog-footer' }, actions);
  dialog.append(header, body);
  if (actions.length) dialog.append(footer);
  backdrop.append(dialog);
  backdrop.addEventListener('mousedown', (event) => { if (event.target === backdrop) closeModal(); });
  backdrop.addEventListener('keydown', trapFocus);
  document.addEventListener('keydown', escapeHandler);
  document.body.append(backdrop);
  document.body.classList.add('dialog-open');
  activeDialog = backdrop;
  queueMicrotask(() => (dialog.querySelector('input,select,textarea,button,a[href]') ?? dialog).focus());
  return { dialog, body, footer, close: closeModal };
}

function trapFocus(event) {
  if (event.key !== 'Tab' || !activeDialog) return;
  const focusable = [...activeDialog.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]')];
  if (!focusable.length) return;
  const first = focusable[0]; const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}
function escapeHandler(event) { if (event.key === 'Escape') closeModal(); }
export function closeModal() {
  if (!activeDialog) return;
  activeDialog.remove(); activeDialog = null;
  document.removeEventListener('keydown', escapeHandler);
  document.body.classList.remove('dialog-open');
  if (previouslyFocused?.isConnected) previouslyFocused.focus();
  previouslyFocused = null;
}
