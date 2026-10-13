import { api, buildQuery } from '../api.js';
import { getState, isCurrentGeneration, nextRequestGeneration } from '../state.js';
import { titleCase } from '../formatters.js';
import { element, pageHeader, refreshButton } from '../ui.js';
import { hasPermission } from '../permissions.js';
import { toast } from './toast.js';
import { dataTable, displayTableValue } from './table.js';
import { paginationView } from './pagination.js';
import { emptyState } from './emptyState.js';
import { loadingState } from './loadingState.js';
import { errorState } from './errorState.js';
import { buildForm, withSubmitLock } from './form.js';
import { closeModal, openModal } from './modal.js';
import { createActionWorkflow } from './actionWorkflow.js';
import { confirmAction, showInlineConfirmation } from './confirmationDialog.js';

export async function renderResourcePage(root, config, context = {}) {
  document.title = `${config.title} · Supermarket Management System`;
  const branchId = getState().selectedBranchId;
  const branch = getState().branches.find((entry) => String(entry.branchId) === String(branchId));
  if (config.branch && !branchId) { root.replaceChildren(pageHeader(config.title, config.description), emptyState('Choose a branch', 'Select a branch before opening this module.')); return; }
  const authorization = getState().session.authorization;
  if (!hasPermission(authorization, config.readPermission, config.branch ? branchId : null)) { root.replaceChildren(errorState('You do not have permission to view this module.')); return; }
  const state = { page: 1, limit: 20, search: '', filters: {}, controller: null };
  const page = element('div'); const manage = hasPermission(authorization, config.managePermission, config.branch ? branchId : null);
  const actions = [];
  if (manage && config.create !== false) { const create = element('button', { className: 'button button-primary', text: `New ${config.singular}`, attributes: { type: 'button' } }); create.addEventListener('click', () => showForm('create')); actions.push(create); }
  const refresh = refreshButton(); refresh.addEventListener('click', load); actions.push(refresh);
  page.append(pageHeader(config.title, config.description, actions));
  if (config.notice) page.append(element('div', { className: 'notice module-notice', text: typeof config.notice === 'function' ? config.notice({ manage, branchId }) : config.notice }));
  const filters = buildFilters(config, state, () => { state.page = 1; load(); }); page.append(filters);
  const content = element('div'); page.append(content); root.replaceChildren(page);

  async function load() {
    state.controller?.abort(); state.controller = new AbortController(); const generation = nextRequestGeneration();
    content.replaceChildren(loadingState(`Loading ${config.title.toLowerCase()}…`));
    try {
      const response = await api.get(resolve(config.listPath, branchId, null, context) + buildQuery({ page: state.page, limit: state.limit, search: state.search || undefined, ...state.filters }), { signal: state.controller.signal });
      if (!isCurrentGeneration(generation)) return;
      const data = response.data ?? {}; const items = Array.isArray(data) ? data : data.items ?? [];
      if (!items.length) { content.replaceChildren(resourceEmptyState(config, state, manage)); if (data.pagination) content.append(paginationView(data.pagination, (value) => { state.page = value; load(); })); return; }
      const configuredActions = (config.actions ?? []).filter((action) => resourceActionAllowed(
        action,
        config,
        authorization,
        config.branch ? branchId : null,
      ));
      const rowActions = [
        { label: 'View', onSelect: (item) => showDetail(item) },
        ...(manage && config.update !== false ? [{
          label: 'Edit',
          show: (item) => resourceUpdateAllowed(config, item, branchId, context),
          onSelect: (item) => showForm('update', item),
        }] : []),
        ...configuredActions.map((action) => ({
          label: action.label,
          className: action.tone === 'danger' ? 'button button-quiet danger-text button-small' : undefined,
          show: (item) => resourceActionVisible(action, item, branchId, context),
          onSelect: (item, button) => runAction(action, item, button),
        })),
      ];
      content.replaceChildren(dataTable({ caption: config.tableCaption ?? config.title, columns: config.columns, items, actions: rowActions, groupBy: config.groupBy }));
      if (data.pagination) content.append(paginationView(data.pagination, (value) => { state.page = value; load(); }));
    } catch (failure) { if (failure.name === 'AbortError' || !isCurrentGeneration(generation)) return; content.replaceChildren(errorState(failure.message, load)); }
  }

  async function showDetail(item) {
    const holder = loadingState('Loading details…'); openModal({ title: config.singular, content: holder, size: 'large' });
    if (config.detailPath === false) { renderDetail(holder, item); return; }
    try {
      const response = await api.get(resolve(config.detailPath, branchId, item, context));
      renderDetail(holder, extractResourceRecord(response.data, config.detailKey));
    } catch (failure) { holder.replaceWith(errorState(failure.message)); }
  }
  async function showForm(mode, item = {}) {
    if (mode === 'update' && config.detailPath !== false) {
      const holder = loadingState(`Loading current ${config.singular}…`);
      openModal({
        title: `Edit ${config.singular}`,
        description: config.formDescription ?? '',
        content: holder,
        size: ((config.updateFields ?? config.createFields) ?? []).length > 8 ? 'large' : 'medium',
      });
      try {
        const response = await api.get(resolve(config.detailPath, branchId, item, context));
        mountForm(mode, item, extractResourceRecord(
          response.data,
          config.editKey ?? config.detailKey,
        ), holder);
      } catch (failure) {
        holder.replaceWith(errorState(failure.message));
      }
      return;
    }
    mountForm(mode, item, item);
  }
  function mountForm(mode, item, initial, holder = null) {
    const definitions = (mode === 'create' ? config.createFields : config.updateFields ?? config.createFields) ?? [];
    const built = buildForm(definitions, initial, { submitLabel: mode === 'create' ? 'Create' : 'Save changes', onCancel: closeModal, context: { ...context, branchId: String(branchId ?? ''), branch } });
    built.form.addEventListener('submit', (event) => {
      event.preventDefault();
      withSubmitLock(built.submit, async () => {
        built.error.classList.add('hidden');
        try {
          const body = built.values();
          const path = resolve(
            mode === 'create' ? config.createPath ?? config.listPath : config.updatePath ?? config.detailPath,
            branchId,
            item,
            context,
          );
          const method = mode === 'create' ? (config.createMethod ?? 'post') : (config.updateMethod ?? 'patch');
          const response = await api[method](path, body);
          closeModal();
          toast(`${config.singular} ${mode === 'create' ? 'created' : 'updated'}.`);
          const shouldReload = mode === 'create' && config.afterCreate
            ? await config.afterCreate({ response, body })
            : true;
          if (shouldReload !== false) await load();
        } catch (failure) {
          if (mode === 'update' && isStaleResourceFailure(failure)) {
            closeModal();
            toast(failure.message, 'error');
            await load();
          } else {
            built.error.textContent = failure.message;
            built.error.classList.remove('hidden');
          }
        }
      });
    });
    if (holder) holder.replaceWith(built.form);
    else openModal({ title: `${mode === 'create' ? 'New' : 'Edit'} ${config.singular}`, description: config.formDescription ?? '', content: built.form, size: definitions.length > 8 ? 'large' : 'medium' });
  }
  async function runAction(action, item, button) {
    let body = {};
    if (typeof action.fields === 'function' || action.fields?.length) {
      if (!action.prepare) {
        showActionForm(action, item);
        return;
      }
      await withSubmitLock(button, async () => {
        try {
          const prepared = await action.prepare({
            item,
            branchId: String(branchId ?? ''),
            branch,
            context,
            request: api,
          });
          if (prepared?.unavailableMessage) {
            toast(prepared.unavailableMessage, 'error');
            return;
          }
          showActionForm(action, item, prepared);
        } catch (failure) {
          toast(failure.message, 'error');
        }
      });
      return;
    }
    if (action.confirm && !(await confirmAction({ title: action.confirmTitle ?? action.label, message: action.confirm(item), confirmLabel: action.label, tone: action.tone ?? 'primary' }))) return;
    await withSubmitLock(button, async () => { try { const response = await api[action.method ?? 'post'](resolve(action.path, branchId, item, context), body); if (action.displayResponse) { const holder = element('div'); renderDetail(holder, response.data); openModal({ title: action.responseTitle ?? action.label, content: holder, size: 'large' }); } else { toast(action.successMessage ?? `${action.label} completed.`); await load(); } } catch (failure) { toast(failure.message, 'error'); if (shouldRefreshAfterActionFailure(action, failure)) await load(); } });
  }
  function showActionForm(action, item, prepared = null) {
    const actionContext = { ...context, branchId: String(branchId ?? ''), branch, item, prepared };
    const definitions = typeof action.fields === 'function'
      ? action.fields({ item, prepared, branchId: String(branchId ?? ''), branch, context })
      : action.fields;
    const built = buildForm(definitions, item, { submitLabel: action.label, onCancel: closeModal, context: actionContext });
    const summaryRows = action.summary?.({ item, prepared, branchId: String(branchId ?? ''), branch, context }) ?? [];
    if (summaryRows.length) {
      const summary = element('dl', { className: 'key-value action-summary' });
      for (const row of summaryRows) {
        summary.append(
          element('dt', { text: row.label }),
          element('dd', { text: String(row.value) }),
        );
      }
      built.form.insertBefore(summary, built.form.querySelector('.form-grid'));
    }
    let pendingWorkflow = null;
    const setFieldsLocked = (locked) => {
      for (const input of built.form.querySelectorAll('input, select, textarea')) input.disabled = locked;
      built.submit.disabled = locked;
    };
    const showFailure = (failure) => {
      built.error.textContent = failure.message;
      built.error.classList.remove('hidden');
    };
    const handleFailure = async (failure) => {
      if (action.resetOnFailure) {
        closeModal();
        toast(failure.message, 'error');
      } else if (isStaleResourceFailure(failure)) {
        closeModal();
        toast(failure.message, 'error');
      } else {
        showFailure(failure);
      }
      if (shouldRefreshAfterActionFailure(action, failure)) await load();
    };
    const execute = (workflow) => workflow.confirm(async (requestBody, pathValues) => {
      const path = resolve(action.path, branchId, item, { ...context, body: pathValues });
      return api[action.method ?? 'post'](path, requestBody);
    });
    const finish = async (outcome) => {
      if (!outcome?.submitted) return;
      closeModal();
      if (action.displayResponse) {
        const holder = element('div');
        renderDetail(holder, outcome.result.data);
        openModal({ title: action.responseTitle ?? action.label, content: holder, size: 'large' });
      } else {
        toast(action.successMessage ?? `${action.label} completed.`);
        await load();
      }
    };

    built.form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (pendingWorkflow) return;
      built.error.classList.add('hidden');
      let workflow;
      try {
        const pathValues = action.pathValues?.({ item, prepared, branchId: String(branchId ?? ''), branch, context }) ?? {};
        workflow = createActionWorkflow({ ...built.values(), ...pathValues }, action.pathOnly ?? []);
      } catch (failure) {
        showFailure(failure);
        return;
      }
      if (!action.confirm) {
        withSubmitLock(built.submit, async () => {
          try { await finish(await execute(workflow)); } catch (failure) { await handleFailure(failure); }
        });
        return;
      }

      pendingWorkflow = workflow;
      setFieldsLocked(true);
      showInlineConfirmation({
        container: built.form,
        title: action.confirmTitle ?? action.label,
        message: action.confirm(item),
        confirmLabel: action.label,
        tone: action.tone ?? 'primary',
        onCancel: () => {
          workflow.cancel();
          pendingWorkflow = null;
          setFieldsLocked(false);
          queueMicrotask(() => built.submit.focus());
        },
        onConfirm: async ({ confirmButton, cancelButton, close }) => {
          cancelButton.disabled = true;
          await withSubmitLock(confirmButton, async () => {
            built.error.classList.add('hidden');
            try {
              const outcome = await execute(workflow);
              if (outcome.submitted) close();
              await finish(outcome);
            } catch (failure) {
              await handleFailure(failure);
              if (!action.resetOnFailure) cancelButton.disabled = false;
            }
          });
        },
      });
    });
    openModal({ title: action.label, description: action.description ?? '', content: built.form, size: definitions.length > 8 ? 'large' : 'medium' });
  }
  await load();
}

export function resourceActionAllowed(action, config, authorization, branchId = null) {
  return hasPermission(
    authorization,
    action.permission ?? config.managePermission,
    config.branch ? branchId : null,
  );
}

export function resourceActionVisible(action, item, branchId = null, context = {}) {
  if (action.statuses && !action.statuses.includes(item[action.statusKey ?? 'status'])) return false;
  return action.visible ? Boolean(action.visible({ item, branchId: String(branchId ?? ''), context })) : true;
}

export function resourceUpdateAllowed(config, item, branchId = null, context = {}) {
  if (config.updateStatuses && !config.updateStatuses.includes(item[config.updateStatusKey ?? 'status'])) return false;
  return config.updateVisible
    ? Boolean(config.updateVisible({ item, branchId: String(branchId ?? ''), context }))
    : true;
}

export function extractResourceRecord(data, key = false) {
  if (key === false) return data;
  if (!data || typeof data !== 'object' || !Object.hasOwn(data, key) || !data[key]) {
    throw new Error(`The server response did not include the expected ${key} record.`);
  }
  return data[key];
}

export function shouldRefreshAfterActionFailure(action, failure) {
  return action.refreshOnFailure === true || isStaleResourceFailure(failure);
}

function isStaleResourceFailure(failure) {
  return [404, 409].includes(failure?.status);
}

function resourceEmptyState(config, state, manage) {
  const filtered = Boolean(state.search || Object.values(state.filters).some(Boolean));
  if (filtered) return emptyState('No matching records', 'Try changing or clearing the current search and filters.');
  const configured = typeof config.emptyState === 'function'
    ? config.emptyState({ manage })
    : config.emptyState;
  return emptyState(
    configured?.title ?? `No ${config.title.toLowerCase()} yet`,
    configured?.message ?? (manage ? `Create the first ${config.singular} when you are ready.` : 'No records are available yet.'),
  );
}
function resolve(value, branchId, item, context) { return typeof value === 'function' ? value({ branchId: String(branchId ?? ''), item, context }) : value; }
function buildFilters(config, state, onChange) {
  const form = element('form', { className: 'filters', attributes: { role: 'search' } }); let timer;
  if (config.search !== false) { const wrapper = element('div', { className: 'field search-field' }); const input = element('input', { attributes: { id: `search-${config.key}`, type: 'search', placeholder: config.searchPlaceholder ?? `Search ${config.title.toLowerCase()}`, autocomplete: 'off' } }); wrapper.append(element('label', { text: 'Search', attributes: { for: input.id } }), input); input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { state.search = input.value.trim(); onChange(); }, 320); }); form.append(wrapper); }
  for (const filter of config.filters ?? []) { const wrapper = element('div', { className: 'field' }); const select = element('select', { attributes: { id: `filter-${config.key}-${filter.name}` } }); select.append(element('option', { text: filter.allLabel ?? `All ${filter.label.toLowerCase()}`, attributes: { value: '' } })); for (const option of filter.options) select.append(element('option', { text: titleCase(option), attributes: { value: option } })); select.addEventListener('change', () => { state.filters[filter.name] = select.value || undefined; onChange(); }); wrapper.append(element('label', { text: filter.label, attributes: { for: select.id } }), select); form.append(wrapper); }
  return form;
}
function renderDetail(holder, data) { const list = element('dl', { className: 'key-value' }); for (const [key, value] of Object.entries(data ?? {})) { list.append(element('dt', { text: key.replace(/([A-Z])/g, ' $1').replace(/^./, (letter) => letter.toUpperCase()) })); const cell = element('dd'); if (Array.isArray(value)) { const nested = element('div', { className: 'nested-list' }); for (const entry of value) nested.append(element('pre', { className: 'data-block', text: JSON.stringify(entry, null, 2) })); cell.append(nested); } else if (value && typeof value === 'object') cell.append(element('pre', { className: 'data-block', text: JSON.stringify(value, null, 2) })); else cell.textContent = displayTableValue(value, { key }); list.append(cell); } holder.replaceWith(list); }
