import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { api } from '../public/js/api.js';
import { loadAccessibleBranches } from '../public/js/branchAccess.js';
import { createInAppRouteHistory } from '../public/js/router.js';
import { getState, isCurrentGeneration, resetState, setState } from '../public/js/state.js';
import { flushEvents, installDom } from '../test-support/frontendDom.js';

// Model native fragment entries and replace/back/forward semantics, not layout.
function browserFixture(initial = '#/profile') {
  const entries = [{ hash: initial, state: { unrelated: 'preserved' } }];
  const listeners = new Map();
  let index = 0;
  let backCalls = 0;
  const signal = () => queueMicrotask(() => browser.dispatchEvent(new Event('hashchange')));
  const browser = {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) ?? []) listener(event);
    },
    location: {
      pathname: '/',
      get hash() { return entries[index].hash; },
      set hash(hash) {
        if (hash === entries[index].hash) return;
        entries.splice(index + 1);
        entries.push({ hash, state: null });
        index += 1;
        signal();
      },
      reload() { assert.fail('Navigation must not reload the document'); },
    },
    history: {
      get state() { return entries[index].state; },
      get length() { return entries.length; },
      replaceState(state, _title, hash) { entries[index] = { hash, state }; },
      back() {
        backCalls += 1;
        if (index > 0) { index -= 1; signal(); }
      },
      forward() { if (index < entries.length - 1) { index += 1; signal(); } },
      get backCalls() { return backCalls; },
    },
  };
  return browser;
}

function trackedBrowser(initial) {
  const browser = browserFixture(initial);
  const routes = createInAppRouteHistory('#/dashboard', browser);
  browser.addEventListener('hashchange', () => routes.record(browser.location.hash));
  routes.record(browser.location.hash);
  return { browser, routes };
}

test('Back traverses the existing workspace entry without pushing duplicate history', async () => {
  const { browser, routes } = trackedBrowser('#/products');
  for (const hash of ['#/products?tab=variants&productId=18446744073709551615', '#/products?tab=packages', '#/products?tab=barcodes']) {
    browser.location.hash = hash;
    await flushEvents();
  }
  const length = browser.history.length;
  assert.equal(routes.back(), '#/products?tab=packages');
  await flushEvents();
  assert.equal(browser.location.hash, '#/products?tab=packages');
  assert.equal(browser.history.backCalls, 1);
  assert.equal(browser.history.length, length);
  browser.history.forward();
  await flushEvents();
  assert.equal(browser.location.hash, '#/products?tab=barcodes');
  assert.equal(routes.entries().length, length);
});

test('native Back/Forward and a new navigation retain the correct in-app history position', async () => {
  const { browser, routes } = trackedBrowser('#/dashboard');
  browser.location.hash = '#/employees'; await flushEvents();
  browser.location.hash = '#/products'; await flushEvents();
  browser.history.back(); await flushEvents();
  browser.history.forward(); await flushEvents();
  routes.back(); await flushEvents();
  assert.equal(browser.location.hash, '#/employees');
  browser.location.hash = '#/customers'; await flushEvents();
  assert.deepEqual(routes.entries(), ['#/dashboard', '#/employees', '#/customers']);
  assert.equal(browser.history.length, 3);
  routes.back(); await flushEvents();
  assert.equal(browser.location.hash, '#/employees');
});

test('direct entry uses a safe replacement fallback and never goes to an external/login predecessor', async () => {
  const { browser, routes } = trackedBrowser('#/products?tab=barcodes');
  routes.record(browser.location.hash);
  assert.equal(browser.history.state.unrelated, 'preserved');
  assert.equal(routes.entries().length, 1, 'rerender is not a navigation');
  routes.back(); await flushEvents();
  assert.equal(browser.location.hash, '#/dashboard');
  assert.equal(browser.history.length, 1);
  assert.equal(browser.history.backCalls, 0);
  routes.back(); await flushEvents();
  assert.equal(browser.history.length, 1);
  routes.clear();
  assert.equal(routes.record('#/login'), null);
  assert.equal(routes.record('https://example.invalid/'), null);
  assert.equal(routes.record('#/unknown'), null);
  assert.deepEqual(routes.entries(), []);
});

test('a rapid second Back click cannot traverse twice before the route event', async () => {
  const { browser, routes } = trackedBrowser('#/dashboard');
  browser.location.hash = '#/employees'; await flushEvents();
  browser.location.hash = '#/products'; await flushEvents();
  routes.back(); routes.back();
  assert.equal(browser.history.backCalls, 1);
  await flushEvents();
  assert.equal(browser.location.hash, '#/employees');
});

const branchA = '18446744073709551615';
const branchB = '9007199254740993';
const branch = (branchId, branchName) => ({
  branchId, branchName, currencyCode: 'NGN', timezone: 'Africa/Lagos', metadataAvailable: true,
});
let shellInstance = 0;
async function withShell(run, branches = [branch(branchA, 'SG Square'), branch(branchB, 'SG Square Elelenwo')]) {
  const dom = installDom();
  const browser = browserFixture();
  const originals = new Map(['window', 'location', 'sessionStorage'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const savedGet = api.get;
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) };
  let requests = 0;
  Object.defineProperties(globalThis, {
    window: { value: browser, configurable: true },
    location: { value: browser.location, configurable: true },
    sessionStorage: { value: storage, configurable: true },
  });
  api.get = async () => { requests += 1; return { data: { items: [] } }; };
  const root = document.createElement('div'); root.setAttribute('id', 'app'); dom.body.append(root);
  resetState();
  setState({ session: { user: { username: 'Acceptance', mustChangePassword: false }, authorization: { permissions: { global: [], byBranch: {} } } }, branches, selectedBranchId: branches[0]?.branchId ?? null });
  try {
    await import(`../public/js/app.js?mobileAcceptance=${++shellInstance}`);
    await flushEvents();
    await run({ root, browser, storage, requests: () => requests });
  } finally {
    api.get = savedGet;
    resetState();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.restore();
  }
}

test('rendered header Back uses router traversal and retains usable menu/profile controls', () => withShell(async ({ root, browser }) => {
  const back = root.querySelector('.topbar-back-control');
  assert.equal(back.attributes['aria-label'], 'Go back');
  assert.equal(back.attributes.title, 'Go back');
  assert.equal(back.attributes.type, 'button');
  assert.ok(back.querySelector('svg'));
  browser.location.hash = '#/products'; await flushEvents();
  await root.querySelector('.topbar-back-control').trigger('click');
  assert.equal(browser.location.hash, '#/profile');
  assert.equal(browser.history.length, 2);
  browser.history.forward(); await flushEvents();
  assert.equal(browser.location.hash, '#/products');
  const menu = root.querySelector('.mobile-menu');
  await menu.trigger('click');
  assert.equal(menu.attributes['aria-expanded'], 'true');
  assert.equal(root.querySelector('.sidebar').classList.contains('is-open'), true);
  await root.querySelector('.sidebar-backdrop').trigger('click');
  assert.equal(menu.attributes['aria-expanded'], 'false');
  assert.ok(root.querySelector('.account-button'));
}));

test('shared Branch control has a meaningful label and switches exact A → B → A state without fetching metadata', () => withShell(async ({ root, browser, storage, requests }) => {
  const originalLength = browser.history.length;
  const initial = root.querySelector('.branch-context');
  assert.equal(root.querySelector('.branch-switcher-label').textContent, 'Branch');
  assert.equal(root.querySelector('.branch-switcher-label').attributes.for, initial.id);
  assert.equal(initial.attributes.title, 'SG Square');
  assert.deepEqual(initial.children.map((option) => option.value), ['', branchA, branchB]);
  for (const [id, name] of [[branchB, 'SG Square Elelenwo'], [branchA, 'SG Square']]) {
    const generation = getState().requestGeneration;
    const select = root.querySelector('.branch-context'); select.value = id;
    await select.trigger('change');
    assert.equal(getState().selectedBranchId, id);
    assert.equal(typeof getState().selectedBranchId, 'string');
    assert.equal(storage.getItem('supermarket.branchId'), id);
    assert.equal(isCurrentGeneration(generation), false);
    assert.equal(root.querySelector('.branch-context').value, id);
    assert.equal(root.querySelector('.branch-context').attributes.title, name);
  }
  assert.equal(browser.history.length, originalLength);
  assert.equal(requests(), 0);
}));

test('header consumes all authorized branch pages including branch 101 without additional list requests', async () => {
  const calls = [];
  const session = { authorization: { permissions: { global: ['branches.read', 'inventory.read'], byBranch: {} } } };
  let result;
  try {
    result = await loadAccessibleBranches({ session, storedBranchId: null, persistSelection: false, request: { get: async (path) => {
      calls.push(path);
      const page = path.includes('page=2') ? 2 : 1;
      return { data: { items: page === 1 ? Array.from({ length: 100 }, (_, index) => branch(String(index + 1), `Accessible ${index + 1}`)) : [branch(branchA, 'SG Square')], pagination: { page, totalPages: 2 } } };
    } } });
  } finally { resetState(); }
  await withShell(async ({ root, requests }) => {
    const select = root.querySelector('.branch-context');
    assert.equal(select.children.length, 102);
    assert.equal(select.children.at(-1).value, branchA);
    assert.equal(select.children.at(-1).textContent, 'SG Square');
    assert.equal(select.children.some((option) => option.value === '999999999999999999'), false);
    select.value = branchA; await select.trigger('change');
    assert.equal(getState().selectedBranchId, branchA);
    assert.equal(requests(), 0);
    assert.equal(calls.length, 2);
  }, result.branches);
});

test('a branch removed from accessible state cannot be selected using an old header control', () => withShell(async ({ root }) => {
  const select = root.querySelector('.branch-context');
  setState({ branches: [branch(branchA, 'SG Square')] });
  select.value = branchB; await select.trigger('change');
  assert.equal(getState().selectedBranchId, branchA);
}));

test('empty branch access stays visibly labelled and disabled', () => withShell(async ({ root }) => {
  const select = root.querySelector('.branch-context');
  assert.equal(select.disabled, true);
  assert.equal(select.children[0].textContent, 'No accessible branches');
  assert.equal(root.querySelector('.branch-switcher-label').textContent, 'Branch');
}, []));

test('mobile header uses bounded two-row responsive structure while desktop controls stay unchanged', async () => {
  const css = await readFile(new URL('../public/css/ux.css', import.meta.url), 'utf8');
  const mobile = css.slice(css.indexOf('@media (max-width: 800px)'));
  assert.match(css, /\.back-icon, \.branch-switcher-label \{ display: none; \}/);
  assert.match(css, /\.branch-switcher \{ display: contents; \}/);
  assert.match(mobile, /grid-template-columns: 2\.75rem 2\.75rem minmax\(0, 1fr\) 2\.75rem/);
  assert.match(mobile, /\.back-label \{ display: none; \}/);
  assert.match(mobile, /\.back-icon \{ display: inline-flex; \}/);
  assert.match(mobile, /\.branch-switcher \{[^}]*grid-column: 1 \/ -1;[^}]*min-width: 0/);
  assert.match(mobile, /\.branch-switcher \.branch-context \{[^}]*max-width: 100%; width: 100%/);
  assert.doesNotMatch(mobile, /\.topbar-back-control\s*\{[^}]*display:\s*none/);
  // CSS invariants only; real 375px/440px layout remains a manual retest.
});

test('rendered mobile header has no inline handlers or styles and preserves CSP module delivery', () => withShell(async ({ root }) => {
  function inspect(node) {
    assert.equal(Object.keys(node.attributes).some((attribute) => /^on/i.test(attribute) || attribute === 'style'), false);
    for (const child of node.children) inspect(child);
  }
  inspect(root.querySelector('.topbar'));
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /type="module" src="\/js\/app\.js"/);
  assert.doesNotMatch(html, /on(?:click|change|submit)=/i);
}));
