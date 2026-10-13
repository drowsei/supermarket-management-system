import assert from 'node:assert/strict';
import test from 'node:test';
import { api } from '../public/js/api.js';
import { buildEntitySelector, remoteSelect } from '../public/js/components/entitySelector.js';
import { buildForm } from '../public/js/components/form.js';
import { resourceActionVisible } from '../public/js/components/resourcePage.js';
import { transferConfig } from '../public/js/contracts.js';
import { completedReturnSelector } from '../public/js/pages/returns.js';
import { openTillSelector } from '../public/js/pages/sales.js';
import { loadAccessibleBranches } from '../public/js/branchAccess.js';
import { getState, nextRequestGeneration, resetState } from '../public/js/state.js';
import { flushEvents, installDom } from '../test-support/frontendDom.js';

async function withSelectorDom(run) {
  const dom = installDom();
  const originalGet = api.get;
  try { await run(dom); } finally { api.get = originalGet; dom.restore(); }
}

const optionValues = (tree) => tree.querySelector('select').children.map((option) => option.value);

test('open till selector reaches page two with bounded requests, exact IDs, and retained selection', () => withSelectorDom(async () => {
  const calls = [];
  const firstId = '18446744073709551401';
  const lastId = '18446744073709551501';
  const items = Array.from({ length: 101 }, (_, index) => ({
    tillSessionId: String(BigInt(firstId) + BigInt(index)),
    sessionNumber: `Acceptance till ${index + 1}`,
    status: 'OPEN',
  }));
  api.get = async (path) => {
    calls.push(path);
    const page = new URL(path, 'http://test.invalid').searchParams.get('page');
    return { data: {
      items: page === '1' ? items.slice(0, 100) : items.slice(99),
      pagination: { page: Number(page), limit: 100, totalItems: 101, totalPages: 2 },
    } };
  };
  const tree = buildEntitySelector(openTillSelector('18446744073709551615'));
  await flushEvents();
  assert.equal(calls.length, 1);
  assert.equal(optionValues(tree).length, 100);
  assert.match(tree.querySelector('small').textContent, /More results/);
  assert.equal(tree.querySelector('button').classList.contains('hidden'), false);
  const select = tree.querySelector('select');
  select.value = firstId;
  await select.trigger('change');
  await tree.querySelector('button').trigger('click');
  assert.equal(calls.length, 2);
  assert.match(calls[1], /page=2&limit=100/);
  assert.equal(optionValues(tree).length, 101);
  assert.ok(optionValues(tree).includes(lastId));
  assert.equal(select.value, firstId);
  assert.equal(tree.querySelector('button').hidden, true);
  assert.equal(tree.querySelector('button').classList.contains('hidden'), true);
  select.value = lastId;
  await select.trigger('change');
  assert.equal(select.value, lastId);
}));

test('completed return selector exposes record 101 without search or synthetic options', () => withSelectorDom(async () => {
  api.get = async (path) => ({ data: {
    items: new URL(path, 'http://test.invalid').searchParams.get('page') === '1'
      ? Array.from({ length: 100 }, (_, index) => ({ salesReturnId: String(index + 1), returnNumber: `R-${index + 1}`, status: 'COMPLETED' }))
      : [{ salesReturnId: '18446744073709551615', returnNumber: 'R-101', status: 'COMPLETED' }],
    pagination: { totalPages: 2 },
  } });
  const tree = buildEntitySelector(completedReturnSelector('1', '2'));
  await flushEvents();
  assert.equal(tree.querySelector('input'), null);
  await tree.querySelector('button').trigger('click');
  assert.equal(optionValues(tree).length, 101);
  assert.equal(optionValues(tree).at(-1), '18446744073709551615');
  assert.match(tree.querySelector('select').children.at(-1).textContent, /R-101/);
}));

test('selector next-page failure preserves selections and retries only the failed page', () => withSelectorDom(async () => {
  const calls = [];
  api.get = async (path) => {
    calls.push(path);
    if (calls.length === 2) throw Object.assign(new Error('Network unavailable'), { status: 0 });
    return { data: { items: [{ id: calls.length === 1 ? '1' : '2', name: `Option ${calls.length}` }], pagination: { totalPages: 2 } } };
  };
  const tree = buildEntitySelector(remoteSelect('recordId', 'Record', {
    path: '/records', valueKey: 'id', label: (item) => item.name, searchable: false,
  }));
  await flushEvents();
  const select = tree.querySelector('select');
  select.value = '1';
  await select.trigger('change');
  await tree.querySelector('button').trigger('click');
  assert.equal(select.value, '1');
  assert.equal(select.disabled, false);
  assert.match(tree.querySelector('small').textContent, /Unable to load.*Network unavailable/);
  assert.equal(tree.querySelector('button').textContent, 'Retry loading more');
  await tree.querySelector('button').trigger('click');
  assert.deepEqual(calls.slice(1), ['/records?page=2&limit=20', '/records?page=2&limit=20']);
  assert.deepEqual(optionValues(tree), ['', '1', '2']);
}));

test('selector ignores late page results immediately when a new search starts', () => withSelectorDom(async () => {
  let finishOldPage;
  const calls = [];
  api.get = async (path) => {
    calls.push(path);
    const query = new URL(path, 'http://test.invalid').searchParams;
    if (query.get('search') === 'fresh') return { data: { items: [{ id: '3', name: 'Fresh option' }], pagination: { totalPages: 1 } } };
    if (query.get('page') === '2') return new Promise((resolve) => { finishOldPage = resolve; });
    return { data: { items: [{ id: '1', name: 'Initial option' }], pagination: { totalPages: 2 } } };
  };
  const tree = buildEntitySelector(remoteSelect('recordId', 'Record', {
    path: '/records', valueKey: 'id', label: (item) => item.name,
  }));
  await flushEvents();
  const more = tree.querySelector('button');
  const pendingClick = more.trigger('click');
  const search = tree.querySelector('input');
  search.value = 'fresh';
  await search.trigger('input');
  finishOldPage({ data: { items: [{ id: '2', name: 'Stale page option' }], pagination: { totalPages: 2 } } });
  await pendingClick;
  assert.equal(optionValues(tree).includes('2'), false);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.deepEqual(optionValues(tree), ['', '3']);
  assert.match(calls.at(-1), /page=1&limit=20&search=fresh/);
  assert.equal(more.hidden, true);
}));

test('empty or unauthorized selector data keeps assignment submission disabled', () => withSelectorDom(async () => {
  for (const forbidden of [false, true]) {
    api.get = async () => {
      if (forbidden) throw Object.assign(new Error('Forbidden'), { status: 403 });
      return { data: { items: [], pagination: { totalPages: 0 } } };
    };
    const built = buildForm([remoteSelect('branchId', 'Branch', {
      path: '/branches', valueKey: 'branchId', label: (item) => item.branchName,
    }, true, { disableSubmitWhenUnavailable: true })]);
    await flushEvents();
    assert.equal(built.submit.disabled, true);
    assert.equal(built.form.querySelector('select').disabled, true);
    assert.equal(built.form.querySelector('.entity-selector').querySelector('button').hidden, true);
  }
}));

test('transfer approval confirmation and action visibility agree on source ownership', () => {
  const action = transferConfig.actions.find((entry) => entry.label === 'Approve');
  const item = { status: 'REQUESTED', sourceBranchId: '18446744073709551615', destinationBranchId: '18446744073709551614' };
  assert.match(action.confirm(item), /source branch/);
  assert.doesNotMatch(action.confirm(item), /destination branch/);
  assert.equal(resourceActionVisible(action, item, item.sourceBranchId), true);
  assert.equal(resourceActionVisible(action, item, item.destinationBranchId), false);
});

const branchSession = {
  authorization: { permissions: { global: ['branches.read', 'inventory.read'], byBranch: {} } },
};
const branchRow = (branchId) => ({
  branchId, branchName: `Acceptance branch ${branchId}`, branchCode: `B-${branchId}`,
  currencyCode: 'NGN', timezone: 'Africa/Lagos',
});

test('global branch context loads branch 101 in bounded pages without per-row requests', async () => {
  resetState();
  const calls = [];
  const lastId = '18446744073709551615';
  try {
    const result = await loadAccessibleBranches({
      session: branchSession, storedBranchId: lastId, persistSelection: false,
      request: { get: async (path) => {
        calls.push(path);
        const page = new URL(path, 'http://test.invalid').searchParams.get('page') ?? '1';
        return { data: {
          items: page === '1' ? Array.from({ length: 100 }, (_, index) => branchRow(String(index + 1))) : [branchRow(lastId)],
          pagination: { page: Number(page), limit: 100, totalItems: 101, totalPages: 2 },
        } };
      } },
    });
    assert.deepEqual(calls, ['/api/admin/branches?limit=100', '/api/admin/branches?limit=100&page=2']);
    assert.equal(result.branches.length, 101);
    assert.equal(result.selectedBranchId, lastId);
    assert.equal(result.branches.at(-1).branchId, lastId);
    assert.equal(result.branches.at(-1).timezone, 'Africa/Lagos');
  } finally { resetState(); }
});

test('failed or malformed branch pagination cannot publish a partial branch context', async () => {
  const failures = ['unavailable', 'wrong-page', 'non-finite'];
  for (const failure of failures) {
    resetState();
    let calls = 0;
    await assert.rejects(loadAccessibleBranches({
      session: branchSession, storedBranchId: null, persistSelection: false,
      request: { get: async () => {
        calls += 1;
        if (calls === 1) return { data: { items: [branchRow('1')], pagination: { page: 1, totalPages: 2 } } };
        if (failure === 'unavailable') throw new Error('Service unavailable');
        return { data: { items: [branchRow('2')], pagination: {
          page: failure === 'wrong-page' ? 1 : 2,
          totalPages: failure === 'non-finite' ? Infinity : 2,
        } } };
      } },
    }), /unavailable|pagination is invalid/);
    assert.equal(calls, 2);
    assert.deepEqual(getState().branches, []);
  }
  resetState();
});

test('branch context pagination stops when a newer request generation supersedes it', async () => {
  resetState();
  let finishPage;
  let calls = 0;
  const pending = loadAccessibleBranches({
    session: branchSession, storedBranchId: null, persistSelection: false,
    request: { get: () => { calls += 1; return new Promise((resolve) => { finishPage = resolve; }); } },
  });
  nextRequestGeneration();
  finishPage({ data: { items: [branchRow('1')], pagination: { page: 1, totalPages: 2 } } });
  const result = await pending;
  assert.equal(result.stale, true);
  assert.equal(calls, 1);
  assert.deepEqual(getState().branches, []);
  resetState();
});
