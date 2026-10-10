import { authenticate } from '../auth.js';
import { element } from '../ui.js';

export function renderLogin(root, { message = '' } = {}) {
  document.title = 'Sign in · Supermarket Management System';
  const page = element('main', { className: 'auth-page', attributes: { id: 'main-content' } });
  const story = element('section', { className: 'auth-story' });
  const brand = element('div', { className: 'brand' }, [
    element('span', { className: 'brand-mark', text: 'SM', attributes: { 'aria-hidden': 'true' } }),
    element('span', { text: 'Supermarket Management' }),
  ]);
  const copy = element('div');
  copy.append(
    element('h1', { text: 'Run every branch with clarity.' }),
    element('p', { text: 'A secure operations workspace for catalog, purchasing, stock, tills, sales, returns, and reporting.' }),
  );
  story.append(brand, copy, element('small', { text: 'Multi-branch administration' }));

  const panel = element('section', { className: 'auth-panel' });
  const card = element('div', { className: 'auth-card' });
  const header = element('header');
  header.append(
    element('h1', { text: 'Welcome back' }),
    element('p', { className: 'muted', text: 'Sign in with your internal username or email.' }),
  );

  const form = element('form', { className: 'login-form', attributes: { id: 'login-form' } });
  const error = element('div', { className: 'form-error hidden', attributes: { role: 'alert' } });
  if (message) {
    error.textContent = message;
    error.classList.remove('hidden');
  }

  const identifier = field('identifier', 'Username or email', 'text', 'username');
  const password = field('password', 'Password', 'password', 'current-password');
  const passwordInput = password.querySelector('input');
  const visibility = element('input', {
    attributes: { id: 'show-password', type: 'checkbox' },
  });
  visibility.checked = false;
  const visibilityControl = element('div', { className: 'checkbox login-password-toggle' }, [
    visibility,
    element('label', { text: 'Show password', attributes: { for: 'show-password' } }),
  ]);
  visibility.addEventListener('change', () => {
    setPasswordVisibility(passwordInput, visibility.checked);
  });

  const submit = element('button', {
    className: 'button button-primary',
    text: 'Sign in',
    attributes: { type: 'submit' },
  });
  const actions = element('div', { className: 'login-actions' }, [visibilityControl, submit]);
  form.append(error, identifier, password, actions);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    error.classList.add('hidden');
    submit.disabled = true;
    submit.textContent = 'Signing in…';
    try {
      const data = new FormData(form);
      const session = await authenticate(
        String(data.get('identifier') ?? '').trim(),
        String(data.get('password') ?? ''),
      );
      location.hash = session.user.mustChangePassword ? '#/change-password' : '#/dashboard';
    } catch (failure) {
      error.textContent = failure.status === 429
        ? 'Too many sign-in attempts. Please wait and try again.'
        : 'Sign-in failed. Check your credentials and try again.';
      error.classList.remove('hidden');
    } finally {
      submit.disabled = false;
      submit.textContent = 'Sign in';
    }
  });

  card.append(header, form);
  panel.append(card);
  page.append(story, panel);
  root.replaceChildren(page);
}

export function setPasswordVisibility(input, visible) {
  input.type = visible ? 'text' : 'password';
}

function field(id, label, type, autocomplete) {
  const wrapper = element('div', { className: 'field' });
  const input = element('input', {
    attributes: {
      id,
      name: id,
      type,
      autocomplete,
      required: '',
      maxlength: id === 'identifier' ? 254 : 72,
    },
  });
  wrapper.append(element('label', { text: label, attributes: { for: id } }), input);
  return wrapper;
}
