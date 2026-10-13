import assert from 'node:assert/strict';
import test from 'node:test';
import { api } from '../public/js/api.js';
import { renderResourcePage } from '../public/js/components/resourcePage.js';
import { closeModal } from '../public/js/components/modal.js';
import { resetState, setState } from '../public/js/state.js';
import { installDom } from '../test-support/frontendDom.js';

const recordId = '18446744073709551615';
const field = { name: 'quantity', label: 'Quantity', required: true };
const config = {
  key: 'acceptance', title: 'Acceptance records', singular: 'record',
  listPath: '/acceptance', detailPath: ({ item }) => `/acceptance/${item.id}`,
  readPermission: 'records.read', managePermission: 'records.manage',
  search: false, columns: [{ key: 'status' }], createFields: [field],
  updateStatuses: ['DRAFT'],
};

async function withResource(run) {
  const dom = installDom();
  const originals = { get: api.get, post: api.post, patch: api.patch };
  setState({ session: { authorization: { permissions: { global: ['records.read', 'records.manage'] } } } });
  const root = document.createElement('main');
  dom.body.append(root);
  try { await run({ ...dom, root }); }
  finally {
    closeModal();
    Object.assign(api, originals);
    resetState();
    dom.restore();
  }
}

const buttonNamed = (root, label) => root.querySelectorAll('button').find((node) => node.textContent === label);
const modalForm = (body) => body.querySelector('.dialog-backdrop')?.querySelector('form');

for (const status of [404, 409]) {
  for (const confirmed of [false, true]) {
    test(`stale ${status} ${confirmed ? 'confirmed' : 'direct'} form action closes and refreshes without retry`, () => withResource(async ({ body, root }) => {
      let reads = 0;
      let writes = 0;
      api.get = async () => ({ data: { items: [{ id: recordId, status: ++reads === 1 ? 'DRAFT' : 'POSTED' }] } });
      api.post = async (path, payload) => {
        writes += 1;
        assert.equal(path, `/acceptance/${recordId}/apply`);
        assert.deepEqual(payload, { quantity: '1.000' });
        throw Object.assign(new Error('This record is no longer available for this action.'), { status });
      };
      const action = {
        label: 'Apply', statuses: ['DRAFT'], fields: [field],
        path: ({ item }) => `/acceptance/${item.id}/apply`,
        ...(confirmed ? { confirm: () => 'Apply this change?' } : {}),
      };
      await renderResourcePage(root, { ...config, actions: [action] });
      await buttonNamed(root, 'Apply').trigger('click');
      const form = modalForm(body);
      form.elements.namedItem('quantity').value = '1.000';
      await form.trigger('submit');
      if (confirmed) await buttonNamed(form.querySelector('.inline-confirmation'), 'Apply').trigger('click');
      assert.equal(writes, 1, 'no automatic retry');
      assert.equal(reads, 2, 'current list state is loaded');
      assert.equal(body.querySelector('.dialog-backdrop') === null, true, 'stale form is dismissed');
      assert.equal(form.isConnected, false);
      assert.equal(buttonNamed(root, 'Apply'), undefined, 'new lifecycle hides obsolete action');
      assert.equal(buttonNamed(root, 'Edit'), undefined);
    }));
  }

  test(`stale ${status} edit closes instead of retaining outdated fields`, () => withResource(async ({ body, root }) => {
    let reads = 0;
    let writes = 0;
    api.get = async (path) => {
      if (path === `/acceptance/${recordId}`) return { data: { id: recordId, status: 'DRAFT', quantity: '2.000' } };
      return { data: { items: [{ id: recordId, status: ++reads === 1 ? 'DRAFT' : 'POSTED' }] } };
    };
    api.patch = async (path, payload) => {
      writes += 1;
      assert.equal(path, `/acceptance/${recordId}`);
      assert.deepEqual(payload, { quantity: '3.000' });
      throw Object.assign(new Error('The record has changed.'), { status });
    };
    await renderResourcePage(root, config);
    await buttonNamed(root, 'Edit').trigger('click');
    const form = modalForm(body);
    assert.equal(form.elements.namedItem('quantity').value, '2.000');
    form.elements.namedItem('quantity').value = '3.000';
    await form.trigger('submit');
    assert.equal(writes, 1);
    assert.equal(reads, 2);
    assert.equal(modalForm(body), undefined);
    assert.equal(buttonNamed(root, 'Edit'), undefined);
  }));
}

test('correctable 400 action errors retain fields and allow an explicit corrected retry', () => withResource(async ({ body, root }) => {
  let reads = 0;
  const payloads = [];
  api.get = async () => { reads += 1; return { data: { items: [{ id: recordId, status: 'DRAFT' }] } }; };
  api.post = async (_path, payload) => {
    payloads.push(payload);
    if (payloads.length === 1) throw Object.assign(new Error('Quantity must be positive.'), { status: 400 });
    return { data: {} };
  };
  await renderResourcePage(root, { ...config, actions: [{
    label: 'Apply', fields: [field], path: ({ item }) => `/acceptance/${item.id}/apply`,
  }] });
  await buttonNamed(root, 'Apply').trigger('click');
  const form = modalForm(body);
  form.elements.namedItem('quantity').value = '-1.000';
  await form.trigger('submit');
  assert.equal(reads, 1);
  assert.equal(form.isConnected, true);
  assert.match(form.querySelector('.form-error').textContent, /Quantity must be positive/);
  assert.equal(buttonNamed(form, 'Apply').disabled, false);
  form.elements.namedItem('quantity').value = '1.000';
  await form.trigger('submit');
  assert.deepEqual(payloads, [{ quantity: '-1.000' }, { quantity: '1.000' }]);
  assert.equal(reads, 2);
  assert.equal(form.isConnected, false);
}));

test('create uniqueness conflicts remain correctable without dismissing a new-record form', () => withResource(async ({ body, root }) => {
  let writes = 0;
  api.get = async () => ({ data: { items: [] } });
  api.post = async () => {
    writes += 1;
    throw Object.assign(new Error('This identifier is already in use.'), { status: 409 });
  };
  await renderResourcePage(root, config);
  await buttonNamed(root, 'New record').trigger('click');
  const form = modalForm(body);
  form.elements.namedItem('quantity').value = '1.000';
  await form.trigger('submit');
  assert.equal(writes, 1);
  assert.equal(form.isConnected, true);
  assert.match(form.querySelector('.form-error').textContent, /already in use/);
  assert.equal(buttonNamed(form, 'Create').disabled, false);
}));
