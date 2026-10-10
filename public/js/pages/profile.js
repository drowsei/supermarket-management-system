import { getState } from '../state.js';
import { element, pageHeader } from '../ui.js';

export function profileAccountType(session) {
  if (session.user.employeeId) return 'Employee-linked account';
  const roles = session.authorization.globalRoles ?? [];
  return roles.some((role) => role.roleCode === 'SYSTEM_ADMIN' || role.roleName === 'System Administrator')
    ? 'System administrator'
    : 'System account';
}

export function renderProfile(root) {
  document.title = 'Profile · Supermarket Management System';
  const session = getState().session;
  const page = element('div');
  page.append(pageHeader('Your profile', 'Account details and current access summary.'));
  const card = element('section', { className: 'card' });
  const list = element('dl', { className: 'key-value' });
  const fields = [
    ['Username', session.user.username],
    ['Email', session.user.email],
    ['Account type', profileAccountType(session)],
    ['Employee profile', session.user.employeeId ? `Linked employee ${session.user.employeeId}` : 'Not linked'],
    ['Global roles', (session.authorization.globalRoles ?? []).map((role) => role.roleName).join(', ') || 'None'],
    ['Branch roles', (session.authorization.branchRoles ?? []).map((role) => `${role.roleName} · Branch ${role.branchId}`).join(', ') || 'None'],
    ['Global permissions', String(session.authorization.permissions?.global?.length ?? 0)],
  ];
  for (const [label, value] of fields) list.append(element('dt', { text: label }), element('dd', { text: value }));
  card.append(list);
  const action = element('a', { className: 'button button-secondary', text: 'Change password', attributes: { href: '#/change-password' } });
  card.append(element('hr', { className: 'divider' }), action);
  page.append(card);
  root.replaceChildren(page);
}
