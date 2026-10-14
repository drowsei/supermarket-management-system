import { api } from '../api.js';
import { bootstrapAuthenticatedSession } from '../auth.js';
import { toast } from '../components/toast.js';
import { setPasswordVisibility } from './login.js';
import { element, pageHeader } from '../ui.js';

export function renderChangePassword(root) {
  document.title = 'Change password · Supermarket Management System';

  const main = element('main', {
    className: 'auth-page auth-page-change-password',
    attributes: { id: 'main-content' },
  });
  const story = element('section', { className: 'auth-story change-password-story' }, [
    element('div', { className: 'brand' }, [
      element('span', {
        className: 'brand-mark',
        text: 'SM',
        attributes: { 'aria-hidden': 'true' },
      }),
      element('span', { text: 'Supermarket Management' }),
    ]),
    element('div', { className: 'change-password-story-copy' }, [
      element('h1', { text: 'Protect your account.' }),
      element('p', {
        text: 'Choose a new password before continuing to operational tools.',
      }),
    ]),
  ]);

  const panel = element('section', { className: 'auth-panel change-password-panel' });
  const card = element('div', { className: 'auth-card change-password-card' });
  card.append(pageHeader('Change password', 'Your temporary password must be replaced.'));

  const form = element('form', { className: 'change-password-form' });
  const error = element('div', {
    className: 'form-error hidden',
    attributes: { id: 'change-password-error', role: 'alert' },
  });
  const current = secretField(
    'current-password',
    'Current password',
    'currentPassword',
    'current-password',
  );
  const next = secretField(
    'new-password',
    'New password',
    'newPassword',
    'new-password',
  );
  const currentInput = current.querySelector('input');
  const nextInput = next.querySelector('input');
  const visibility = element('input', {
    attributes: { id: 'show-change-passwords', type: 'checkbox' },
  });
  visibility.checked = false;
  const visibilityControl = element(
    'div',
    { className: 'checkbox change-password-toggle' },
    [
      visibility,
      element('label', {
        text: 'Show passwords',
        attributes: { for: 'show-change-passwords' },
      }),
    ],
  );
  visibility.addEventListener('change', () => {
    setPasswordVisibility([currentInput, nextInput], visibility.checked);
  });
  const submit = element('button', {
    className: 'button button-primary',
    text: 'Update password',
    attributes: { type: 'submit' },
  });

  form.append(error, current, next, visibilityControl, submit);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    try {
      const data = new FormData(form);
      await api.post('/api/auth/change-password', {
        currentPassword: String(data.get('currentPassword')),
        newPassword: String(data.get('newPassword')),
      });
      form.reset();
      await bootstrapAuthenticatedSession();
      toast('Password changed successfully.');
      location.hash = '#/dashboard';
    } catch (failure) {
      error.textContent = failure.message;
      error.classList.remove('hidden');
    } finally {
      submit.disabled = false;
    }
  });

  card.append(form);
  panel.append(card);
  main.append(story, panel);
  root.replaceChildren(main);
}

function secretField(id, label, name, autocomplete) {
  const wrapper = element('div', { className: 'field' });
  wrapper.append(
    element('label', { text: label, attributes: { for: id } }),
    element('input', {
      attributes: {
        id,
        name,
        type: 'password',
        autocomplete,
        required: '',
        minlength: '12',
        maxlength: '72',
        'aria-describedby': 'change-password-error',
      },
    }),
  );
  return wrapper;
}
