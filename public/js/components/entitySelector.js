import { api, buildQuery } from '../api.js';
import { element } from '../ui.js';

const SELECTOR_LIMIT = 20;
const SEARCH_DELAY_MS = 320;

export function exactSelectorId(value) {
  return value === null || value === undefined || value === '' ? '' : String(value);
}

export function excludeSourceBranch(items, sourceBranchId) {
  const source = exactSelectorId(sourceBranchId);
  return items.filter((item) => exactSelectorId(item.branchId) !== source);
}

export function eligibleOpenTillSessions(items) {
  return items.filter((item) => item.status === 'OPEN');
}

export function remoteSelect(name, label, remote, required = false, extra = {}) {
  return { name, label, type: 'remote-select', remote, required, ...extra };
}

export function selectorOption(item, remote) {
  return {
    value: exactSelectorId(item?.[remote.valueKey]),
    label: String(remote.label(item)),
    item,
  };
}

export function buildEntitySelector(definition, current, context = {}) {
  const id = `field-${definition.name}-${Math.random().toString(36).slice(2, 8)}`;
  const wrapper = element('div', {
    className: definition.full ? 'field field-full entity-selector' : 'field entity-selector',
  });
  const labelText = `${definition.label} ${definition.required ? '(required)' : '(optional)'}`;
  const select = element('select', {
    attributes: {
      id,
      name: definition.name,
      required: definition.required ? '' : null,
      'aria-describedby': `${id}-status`,
    },
  });
  const search = definition.remote.searchable === false
    ? null
    : element('input', {
      className: 'selector-search',
      attributes: {
        type: 'search',
        placeholder: definition.remote.searchPlaceholder ?? `Search ${definition.label.toLowerCase()}`,
        autocomplete: 'off',
        'aria-label': `Search ${definition.label.toLowerCase()}`,
      },
    });
  const status = element('small', {
    className: 'muted selector-status',
    attributes: { id: `${id}-status`, role: 'status', 'aria-live': 'polite' },
  });
  const more = element('button', {
    className: 'button button-secondary button-small',
    text: 'Load more',
    attributes: { type: 'button' },
  });
  const showMore = (visible) => {
    more.hidden = !visible;
    // The shared button display rule needs the existing hidden utility as well.
    if (visible) more.classList.remove('hidden');
    else more.classList.add('hidden');
  };
  showMore(false);
  wrapper.append(element('label', { text: labelText, attributes: { for: id } }));
  if (search) wrapper.append(search);
  wrapper.append(select, status, more);
  if (definition.help) wrapper.append(element('small', {
    className: 'muted',
    text: typeof definition.help === 'function' ? definition.help(context) : definition.help,
  }));

  let selectedId = exactSelectorId(current ?? definition.default);
  let selectedOption = null;
  let controller = null;
  let requestVersion = 0;
  let timer = null;
  let loadedItems = [];
  let loadedPage = 0;
  let searchTerm = '';
  let hasMore = false;

  const optionFor = (item) => selectorOption(item, definition.remote);
  const reportAvailability = (available) => {
    if (!definition.disableSubmitWhenUnavailable) return;
    wrapper.dispatchEvent(new CustomEvent('entity-selector-availability', {
      bubbles: true,
      detail: { fieldName: definition.name, available },
    }));
  };

  function showOptions(items) {
    const options = (definition.remote.filter
      ? definition.remote.filter(items, context)
      : items).map(optionFor).filter((option) => option.value);
    if (selectedOption && selectedId && !options.some((option) => option.value === selectedId)) {
      options.unshift(selectedOption);
    }
    select.replaceChildren();
    if (definition.placeholder || !definition.required || definition.nullable) {
      select.append(element('option', {
        text: definition.placeholder ?? `No ${definition.label.toLowerCase()}`,
        attributes: { value: '' },
      }));
    }
    for (const option of options) {
      select.append(element('option', {
        text: option.label,
        attributes: { value: option.value },
      }));
    }
    select.value = selectedId;
    if (selectedId && select.value !== selectedId && selectedOption) {
      select.append(element('option', {
        text: selectedOption.label,
        attributes: { value: selectedOption.value },
      }));
      select.value = selectedId;
    }
    status.textContent = options.length
      ? `${options.length} option${options.length === 1 ? '' : 's'} available.${hasMore ? ' More results are available.' : ''}`
      : (definition.remote.emptyMessage ?? `No ${definition.label.toLowerCase()} are available.`);
    if (!options.length && hasMore) status.textContent += ' More results are available.';
    select.disabled = options.length === 0;
    reportAvailability(options.length > 0);
  }

  async function loadSelected() {
    if (!selectedId || !definition.remote.detailPath) return;
    try {
      const response = await api.get(resolve(definition.remote.detailPath, context, selectedId));
      const item = definition.remote.detailKey
        ? response.data?.[definition.remote.detailKey]
        : response.data;
      if (item) selectedOption = optionFor(item);
    } catch {
      selectedOption = null;
    }
  }

  async function load(term = '', append = false) {
    controller?.abort();
    controller = new AbortController();
    const version = ++requestVersion;
    const page = append ? loadedPage + 1 : 1;
    searchTerm = term;
    select.disabled = true;
    more.disabled = true;
    if (!append) showMore(false);
    reportAvailability(false);
    status.textContent = `Loading ${definition.label.toLowerCase()}…`;
    try {
      const query = {
        ...(typeof definition.remote.query === 'function'
          ? definition.remote.query(context)
          : definition.remote.query ?? {}),
        page,
        limit: definition.remote.limit ?? SELECTOR_LIMIT,
      };
      if (definition.remote.searchable !== false && term) query.search = term;
      const response = await api.get(
        `${resolve(definition.remote.path, context)}${buildQuery(query)}`,
        { signal: controller.signal },
      );
      if (version !== requestVersion) return;
      const items = Array.isArray(response.data) ? response.data : response.data?.items ?? [];
      // Keep requests bounded and let the user reach records beyond the first page.
      loadedItems = [...new Map([
        ...(append ? loadedItems : []),
        ...items,
      ].map((item) => [exactSelectorId(item?.[definition.remote.valueKey]), item])).values()];
      loadedPage = page;
      hasMore = page < (response.data?.pagination?.totalPages ?? page);
      showMore(hasMore);
      more.disabled = false;
      more.textContent = 'Load more';
      showOptions(loadedItems);
    } catch (failure) {
      if (failure.name === 'AbortError' || version !== requestVersion) return;
      if (append) {
        showOptions(loadedItems);
        showMore(true);
        more.disabled = false;
        more.textContent = 'Retry loading more';
      } else {
        select.replaceChildren();
        select.disabled = true;
        reportAvailability(false);
      }
      status.textContent = failure.status === 403
        ? (definition.remote.unauthorizedMessage ?? `You do not have access to list ${definition.label.toLowerCase()}.`)
        : `Unable to load ${definition.label.toLowerCase()}. ${failure.message}`;
    }
  }

  select.addEventListener('change', () => {
    selectedId = exactSelectorId(select.value);
    selectedOption = selectedId
      ? { value: selectedId, label: select.selectedOptions[0]?.textContent ?? selectedId }
      : null;
  });
  search?.addEventListener('input', () => {
    clearTimeout(timer);
    // Invalidate immediately: the prior page may finish during the debounce delay.
    controller?.abort();
    requestVersion += 1;
    showMore(false);
    select.disabled = true;
    reportAvailability(false);
    timer = setTimeout(() => load(search.value.trim()), SEARCH_DELAY_MS);
  });
  more.addEventListener('click', () => load(searchTerm, true));
  const initialVersion = requestVersion;
  Promise.resolve(loadSelected()).then(() => {
    if (requestVersion === initialVersion) return load();
    return undefined;
  });
  return wrapper;
}

function resolve(value, context, id) {
  return typeof value === 'function' ? value({ ...context, id: exactSelectorId(id) }) : value;
}
