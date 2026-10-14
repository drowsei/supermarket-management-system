import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });
const { default: app } = await import('../src/app.js');
import { ACCESS_CONTROL_PERMISSIONS } from '../src/config/accessControl.js';
import { api, buildQuery } from '../public/js/api.js';
import {
  adjustmentConfig,
  branchConfig,
  countConfig,
  employeeAssignmentBranchLabel,
  employeeConfig,
  posRegisterConfig,
  saleConfig,
  tillConfig,
  userConfig,
  variantPriceConfig,
} from '../public/js/contracts.js';
import {
  ALREADY_PRIMARY_MESSAGE,
  NO_ACTIVE_ASSIGNMENT_MESSAGE,
  NO_PRIMARY_CANDIDATE_MESSAGE,
  activeEmployeeAssignments,
  resolveEndAssignment,
  resolveMakePrimaryAssignment,
} from '../public/js/employeeAssignments.js';
import {
  createBranchStore,
  loadAccessibleBranches,
  rememberBranch,
  resolveSelectedBranchId,
} from '../public/js/branchAccess.js';
import {
  branchLocalDateTimeToUtc,
  branchDisplayName,
  branchMetadataFromReport,
  branchMonthRange,
  createScopedBranchIdentity,
  hasAuthoritativeBranchMetadata,
  utcToBranchLocalDateTime,
} from '../public/js/branchContext.js';
import { createActionWorkflow } from '../public/js/components/actionWorkflow.js';
import { resourceActionAllowed } from '../public/js/components/resourcePage.js';
import {
  eligibleOpenTillSessions,
  exactSelectorId,
  excludeSourceBranch,
  selectorOption,
} from '../public/js/components/entitySelector.js';
import { reportNavigationIds } from '../public/js/components/reportNavigation.js';
import { displayTableValue } from '../public/js/components/table.js';
import { bootstrapAuthenticatedSession, clearSession, createTokenStore } from '../public/js/auth.js';
import { updateUnavailableSelectors, withSubmitLock } from '../public/js/components/form.js';
import {
  PAGINATED_REPORT_IDS,
  buildReportRequestQuery,
  changeReportFilters,
  changeReportPage,
  createReportRequestState,
} from '../public/js/reportState.js';
import { paginationModel } from '../public/js/components/pagination.js';
import { currencyGroups, formatDecimalExact, quantitiesByUnit, textValue } from '../public/js/formatters.js';
import { hasGlobalPermission, hasPermission, NAVIGATION, navigationFor } from '../public/js/permissions.js';
import { createInAppRouteHistory, parseHash, ROUTES } from '../public/js/router.js';
import { getState, isCurrentGeneration, nextRequestGeneration, resetState, setState } from '../public/js/state.js';
import { isDecimalString, isUnsignedId, validateDateRange } from '../public/js/validation.js';
import { REPORTS } from '../public/js/pages/reports.js';
import { setPasswordVisibility } from '../public/js/pages/login.js';
import { productWorkspaceSelector, renderProducts, variantWorkspaceSelector } from '../public/js/pages/products.js';
import { openTillSelector, saleWorkspaceSelector } from '../public/js/pages/sales.js';
import { supplierProductWorkspaceSelector, supplierWorkspaceSelector } from '../public/js/pages/suppliers.js';
import { ICON_PATHS } from '../public/js/ui.js';
import { flushEvents, installDom } from '../test-support/frontendDom.js';
import {
  DEFAULT_BRANCH_COUNTRY,
  DEFAULT_BRANCH_CURRENCY,
  countryOptions,
  currencyOptions,
} from '../public/js/regionalOptions.js';
import {
  DEFAULT_BRANCH_TIMEZONE,
  isValidTimeZone,
  supportedTimeZoneIds,
  timeZoneOptions,
} from '../public/js/timezones.js';
const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=(relative)=>fs.readFile(path.join(projectRoot,relative),'utf8');
async function withServer(run){const server=app.listen(0,'127.0.0.1');await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});const {port}=server.address();try{return await run(`http://127.0.0.1:${port}`);}finally{await new Promise((resolve,reject)=>server.close((error)=>error?reject(error):resolve()));}}
async function listFiles(directory){const output=[];for(const entry of await fs.readdir(directory,{withFileTypes:true})){if(['node_modules','.git'].includes(entry.name))continue;const target=path.join(directory,entry.name);if(entry.isDirectory())output.push(...await listFiles(target));else output.push(target);}return output;}
function createMemoryStorage(entries = []) {
  const values = new Map(entries);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}
async function withSessionStorage(storage, run) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage });
  try {
    return await run();
  } finally {
    if (original) Object.defineProperty(globalThis, 'sessionStorage', original);
    else delete globalThis.sessionStorage;
  }
}

test('static entry, login, CSS, and module assets are served',()=>withServer(async(base)=>{for(const [target,type] of [['/','text/html'],['/login.html','text/html'],['/css/base.css','text/css'],['/js/app.js','text/javascript']]){const response=await fetch(base+target);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),new RegExp(type));}}));
test('static delivery preserves JSON API 404',()=>withServer(async(base)=>{const response=await fetch(base+'/api/definitely-not-real');assert.equal(response.status,404);assert.match(response.headers.get('content-type'),/application\/json/);assert.deepEqual(await response.json(),{success:false,message:'Route not found'});}));
test('HTML entries use CSP-friendly external modules',async()=>{for(const file of ['public/index.html','public/login.html']){const html=await read(file);assert.match(html,/type="module" src="\/js\/app\.js"/);assert.doesNotMatch(html,/on(click|change|submit)=/i);assert.doesNotMatch(html,/<script(?![^>]*src=)/i);}});
test('login uses a password field and an explicitly associated checkbox label', async () => {
  const source = await read('public/js/pages/login.js');
  assert.match(source, /field\('password', 'Password', 'password', 'current-password'\)/);
  assert.match(source, /id: 'show-password', type: 'checkbox'/);
  assert.match(source, /visibility\.checked = false/);
  assert.match(source, /text: 'Show password', attributes: \{ for: 'show-password' \}/);
  assert.match(source, /visibility\.addEventListener\('change'/);
});
test('password checkbox reveals and hides without changing the entered value', () => {
  const input = { type: 'password', value: 'kept-only-in-the-form' };
  setPasswordVisibility(input, true);
  assert.equal(input.type, 'text');
  assert.equal(input.value, 'kept-only-in-the-form');
  setPasswordVisibility(input, false);
  assert.equal(input.type, 'password');
  assert.equal(input.value, 'kept-only-in-the-form');
});
test('shared password visibility helper toggles both change-password values without modifying them', () => {
  const current = { type: 'password', value: 'current-kept-only-in-the-form' };
  const next = { type: 'password', value: 'new-kept-only-in-the-form' };

  setPasswordVisibility([current, next], true);
  assert.equal(current.type, 'text');
  assert.equal(next.type, 'text');
  assert.equal(current.value, 'current-kept-only-in-the-form');
  assert.equal(next.value, 'new-kept-only-in-the-form');

  setPasswordVisibility([current, next], false);
  assert.equal(current.type, 'password');
  assert.equal(next.type, 'password');
  assert.equal(current.value, 'current-kept-only-in-the-form');
  assert.equal(next.value, 'new-kept-only-in-the-form');
});
test('login password stays out of browser storage and uses no inline handlers', async () => {
  const source = await read('public/js/pages/login.js');
  assert.doesNotMatch(source, /localStorage|\.setItem\s*\(/);
  assert.doesNotMatch(source, /\bon(?:click|change|input|submit)\s*:/i);
  assert.match(source, /addEventListener\('change'/);
  assert.match(source, /addEventListener\('submit'/);
});
test('login keeps the existing authentication route, loading state, and failure messages', async () => {
  const login = await read('public/js/pages/login.js');
  const auth = await read('public/js/auth.js');
  assert.match(auth, /api\.post\('\/api\/auth\/login',\{identifier,password\}\)/);
  assert.match(login, /await authenticate\(/);
  assert.match(login, /submit\.disabled = true/);
  assert.match(login, /submit\.textContent = 'Signing in…'/);
  assert.match(login, /Too many sign-in attempts\. Please wait and try again\./);
  assert.match(login, /Sign-in failed\. Check your credentials and try again\./);
});
test('login action row has deliberate spacing and responsive wrapping', async () => {
  const source = await read('public/js/pages/login.js');
  const css = await read('public/css/ux.css');
  assert.match(source, /className: 'login-actions'/);
  assert.match(source, /className: 'button button-primary'/);
  assert.match(css, /\.login-actions \{[\s\S]*?align-items: center;[\s\S]*?gap: 1rem;[\s\S]*?margin-top: 1\.5rem;[\s\S]*?flex-wrap: wrap;/);
  assert.match(css, /\.login-password-toggle \{ min-height: 2\.65rem; \}/);
  assert.match(css, /@media \(max-width: 520px\)[\s\S]*?\.login-actions \.button \{ width: 100%; margin-left: 0; \}/);
});
test('change-password page uses the shared responsive auth design with a focused form card', async () => {
  const source = await read('public/js/pages/changePassword.js');
  const css = await read('public/css/ux.css');

  assert.match(source, /className: 'auth-page auth-page-change-password'/);
  assert.match(source, /className: 'auth-story change-password-story'/);
  assert.match(source, /className: 'auth-card change-password-card'/);
  assert.match(source, /className: 'change-password-form'/);
  assert.match(css, /\.auth-page-change-password \{[\s\S]*?42%[\s\S]*?58%/);
  assert.match(css, /\.change-password-card \{[\s\S]*?width: min\(100%, 28rem\);[\s\S]*?border-radius: 1\.1rem;[\s\S]*?box-shadow: var\(--shadow-md\);/);
  assert.match(css, /\.change-password-form \.button \{[\s\S]*?width: 100%;[\s\S]*?min-height: 3rem;[\s\S]*?margin-top: 1\.75rem;/);
  assert.match(css, /@media \(max-width: 800px\)[\s\S]*?\.auth-page-change-password \{ grid-template-columns: 1fr; \}/);
  assert.match(css, /@media \(max-width: 520px\)[\s\S]*?\.change-password-panel/);
});
test('change-password fields preserve password semantics and existing API behavior', async () => {
  const source = await read('public/js/pages/changePassword.js');

  assert.match(source, /type: 'password'/);
  assert.match(source, /'current-password'/);
  assert.match(source, /'new-password'/);
  assert.match(source, /'aria-describedby': 'change-password-error'/);
  assert.match(source, /api\.post\('\/api\/auth\/change-password'/);
  assert.match(source, /attributes: \{ id: 'show-change-passwords', type: 'checkbox' \}/);
  assert.match(source, /text: 'Show passwords'/);
  assert.match(source, /attributes: \{ for: 'show-change-passwords' \}/);
  assert.match(source, /visibility\.addEventListener\('change'/);
  assert.match(source, /setPasswordVisibility\(\[currentInput, nextInput\], visibility\.checked\)/);
  assert.match(source, /currentPassword: String\(data\.get\('currentPassword'\)\),\s*newPassword: String\(data\.get\('newPassword'\)\),/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|\.setItem\s*\(/);
  assert.doesNotMatch(source, /\bon(?:click|change|input|submit)\s*:/i);
});
test('app shell supports desktop collapse and a mobile drawer',async()=>{const appSource=await read('public/js/app.js');const layout=await read('public/css/layout.css');const responsive=await read('public/css/responsive.css');assert.match(appSource,/desktop-sidebar-toggle/);assert.match(appSource,/sidebar-collapsed/);assert.match(layout,/app-shell.sidebar-collapsed/);assert.match(responsive,/desktop-sidebar-toggle/);});
test('permission helper honors global, exact branch, missing, and unrelated grants',()=>{const auth={permissions:{global:['products.read'],byBranch:{'9007199254740993':['inventory.read'],'9007199254740995':['reports.read']}}};assert.equal(hasPermission(auth,'products.read','18446744073709551615'),true);assert.equal(hasPermission(auth,'inventory.read','9007199254740993'),true);assert.equal(hasPermission(auth,'inventory.read','9007199254740995'),false);assert.equal(hasPermission(auth,'sales.read','9007199254740993'),false);assert.equal(hasGlobalPermission(auth,'products.read'),true);});
test('authorization navigation keeps branch grants exact',()=>{const auth={permissions:{global:['customers.read'],byBranch:{'42':['inventory.read'],'43':['reports.read']}}};const a=navigationFor(auth,'42').map((item)=>item.route);assert.ok(a.includes('inventory'));assert.ok(a.includes('customers'));assert.ok(!a.includes('dashboard'));const b=navigationFor(auth,'43').map((item)=>item.route);assert.ok(b.includes('dashboard'));assert.ok(!b.includes('inventory'));});
test('BIGINT identifiers remain exact strings',()=>{const id='18446744073709551615';assert.equal(isUnsignedId(id),true);assert.equal(buildQuery({branchId:id}),`?branchId=${id}`);assert.equal(textValue(id),id);});
test('decimal strings remain exact',()=>{assert.equal(isDecimalString('999999999999.1234'),true);assert.equal(formatDecimalExact('999999999999.1234'),'999,999,999,999.1234');assert.equal(buildQuery({amount:'100000000000.009'}),'?amount=100000000000.009');});
test('query construction encodes search and omits empty values',()=>assert.equal(buildQuery({search:'milk & tea/50%',status:'',page:2}),'?search=milk+%26+tea%2F50%25&page=2'));
test('branch code stays required, user-entered, exact, and clearly documented', () => {
  const field = branchConfig.createFields.find((definition) => definition.name === 'branchCode');
  assert.equal(field.type, 'text');
  assert.equal(field.required, true);
  assert.equal(field.default, undefined);
  assert.equal(field.placeholder, 'PHC-001');
  assert.match(field.help, /permanent internal identifier/i);
  const entered = 'PhC-001-West';
  assert.equal(field.transform ? field.transform(entered) : entered, entered);
});
test('new branch uses comprehensive standards selectors with Nigerian defaults', () => {
  const country = branchConfig.createFields.find((definition) => definition.name === 'countryCode');
  const currency = branchConfig.createFields.find((definition) => definition.name === 'currencyCode');
  const timezone = branchConfig.createFields.find((definition) => definition.name === 'timezone');

  assert.equal(country.type, 'select');
  assert.equal(country.label, 'Country');
  assert.equal(country.required, true);
  assert.equal(country.default, DEFAULT_BRANCH_COUNTRY);
  assert.equal(country.default, 'NG');
  assert.equal(currency.type, 'select');
  assert.equal(currency.label, 'Currency');
  assert.equal(currency.required, true);
  assert.equal(currency.default, DEFAULT_BRANCH_CURRENCY);
  assert.equal(currency.default, 'NGN');
  assert.equal(timezone.default, 'Africa/Lagos');

  const countries = country.options({ current: null, context: {} });
  const currencies = currency.options({ current: null, context: {} });
  assert.equal(countries.length, 249);
  assert.ok(currencies.length >= 160);
  assert.equal(new Set(countries.map((option) => option.value)).size, countries.length);
  assert.equal(new Set(currencies.map((option) => option.value)).size, currencies.length);
  assert.deepEqual(countries.find((option) => option.value === 'NG'), { value: 'NG', label: 'Nigeria (NG)' });
  assert.deepEqual(currencies.find((option) => option.value === 'NGN'), { value: 'NGN', label: 'Nigerian Naira (NGN)' });
  assert.deepEqual(countries.find((option) => option.value === 'AF'), { value: 'AF', label: 'Afghanistan (AF)' });
  assert.deepEqual(countries.find((option) => option.value === 'ZW'), { value: 'ZW', label: 'Zimbabwe (ZW)' });
  assert.deepEqual(currencies.find((option) => option.value === 'JPY'), { value: 'JPY', label: 'Japanese Yen (JPY)' });
  for (const code of ['NG', 'GH', 'GB', 'US', 'CA', 'ZA', 'KE', 'IN', 'AU', 'FR', 'DE', 'JP', 'CN', 'BR']) {
    assert.ok(countries.some((option) => option.value === code), code);
  }
  for (const code of ['NGN', 'GHS', 'GBP', 'USD', 'CAD', 'EUR', 'ZAR', 'KES', 'INR', 'AUD', 'JPY', 'CNY', 'BRL']) {
    assert.ok(currencies.some((option) => option.value === code), code);
  }
  assert.equal(countries.every((option) => /^[A-Z]{2}$/.test(option.value)), true);
  assert.equal(currencies.every((option) => /^[A-Z]{3}$/.test(option.value)), true);
  assert.equal(countries.every((option) => option.label.endsWith(`(${option.value})`)), true);
  assert.equal(currencies.every((option) => option.label.endsWith(`(${option.value})`)), true);
});
test('branch edit selectors preserve saved non-default country, currency, and timezone values', async () => {
  const saved = { countryCode: 'GB', currencyCode: 'GBP', timezone: 'Europe/London' };
  const country = branchConfig.updateFields.find((definition) => definition.name === 'countryCode');
  const currency = branchConfig.updateFields.find((definition) => definition.name === 'currencyCode');
  const timezone = branchConfig.updateFields.find((definition) => definition.name === 'timezone');

  assert.deepEqual(countryOptions({ current: saved.countryCode }).find((option) => option.value === saved.countryCode), { value: 'GB', label: 'United Kingdom (GB)' });
  assert.deepEqual(currencyOptions({ current: saved.currencyCode }).find((option) => option.value === saved.currencyCode), { value: 'GBP', label: 'Pound Sterling (GBP)' });
  assert.ok(timezone.options({ current: saved.timezone }).some((option) => option.value === saved.timezone));

  const formSource = await read('public/js/components/form.js');
  assert.match(formSource, /if \(displayed !== undefined && displayed !== null\) input\.value = String\(displayed\)/);
  assert.match(formSource, /else if \(definition\.default !== undefined/);
});
test('branch selectors preserve the existing payload field names and backend-compatible codes', async () => {
  const names = branchConfig.createFields.map((field) => field.name);
  assert.ok(names.includes('countryCode'));
  assert.ok(names.includes('currencyCode'));
  assert.ok(names.includes('timezone'));
  assert.equal(countryOptions({ current: 'GB' }).find((option) => option.value === 'GB').value, 'GB');
  assert.equal(currencyOptions({ current: 'GBP' }).find((option) => option.value === 'GBP').value, 'GBP');

  const validator = await read('src/validators/admin/branch.validator.js');
  assert.match(validator, /countryCode: \(\) => parseCountryCode\(value\)/);
  assert.match(validator, /currencyCode: \(\) => parseCurrencyCode\(value\)/);
  assert.match(validator, /timezone: \(\) => parseString\(value, 'timezone', 64\)/);
});
test('branch timezone is a required standards-based selector with exact IANA values', () => {
  const field = branchConfig.createFields.find((definition) => definition.name === 'timezone');
  assert.equal(field.type, 'select');
  assert.equal(field.label, 'Timezone');
  assert.equal(field.required, true);
  assert.equal(field.default, DEFAULT_BRANCH_TIMEZONE);
  assert.equal(typeof field.options, 'function');

  const options = field.options({ current: null, context: {} });
  const values = options.map((option) => option.value);
  assert.ok(values.length > 100);
  assert.ok(values.includes('Africa/Lagos'));
  assert.ok(values.includes('Africa/Accra'));
  assert.ok(values.includes('Africa/Nairobi'));
  assert.ok(values.includes('Europe/London'));
  assert.ok(values.includes('America/New_York'));
  assert.equal(values.every((value) => isValidTimeZone(value)), true);
  assert.equal(options.every((option) => option.label === option.value), true);
  assert.equal(values.some((value) => ['WAT', 'GMT', 'EST'].includes(value)), false);

  const selected = 'America/New_York';
  assert.equal(field.transform ? field.transform(selected) : selected, selected);
});
test('branch edit options retain and preselect the exact saved timezone', async () => {
  const field = branchConfig.updateFields.find((definition) => definition.name === 'timezone');
  const saved = 'Pacific/Auckland';
  const values = timeZoneOptions({ current: saved }).map((option) => option.value);
  assert.ok(values.includes(saved));
  assert.deepEqual(supportedTimeZoneIds(saved), [...supportedTimeZoneIds(saved)].sort());
  assert.equal(branchConfig.updateFields, branchConfig.createFields);

  const formSource = await read('public/js/components/form.js');
  assert.match(formSource, /typeof definition\.options === 'function'/);
  assert.match(formSource, /definition\.options\(\{ current, context \}\)/);
  assert.match(formSource, /if \(displayed !== undefined && displayed !== null\) input\.value = String\(displayed\)/);
});
test('branch timezone UX keeps the existing API contract and adds no timezone dependency', async () => {
  assert.equal(branchConfig.listPath, '/api/admin/branches');
  assert.equal(branchConfig.detailPath({ item: { branchId: '18446744073709551615' } }), '/api/admin/branches/18446744073709551615');
  assert.ok(branchConfig.createFields.some((field) => field.name === 'branchCode'));
  assert.ok(branchConfig.createFields.some((field) => field.name === 'timezone'));

  const packageJson = JSON.parse(await read('package.json'));
  const packages = [...Object.keys(packageJson.dependencies), ...Object.keys(packageJson.devDependencies)];
  assert.equal(packages.some((name) => /moment|luxon|date-fns|timezone|\btz\b/i.test(name)), false);
});
test('employee table displays current primary branch and job title from list fields', () => {
  assert.deepEqual(
    employeeConfig.columns.map((column) => column.key),
    ['employeeNumber', 'firstName', 'lastName', 'email', 'primaryBranchName', 'primaryJobTitle', 'employmentStatus'],
  );
  assert.equal(employeeConfig.columns[4].label, 'Branch');
  assert.equal(employeeConfig.columns[5].label, 'Job title');

  const current = {
    employeeId: '18446744073709551615',
    primaryBranchName: 'SG Square Elelenwo',
    primaryJobTitle: 'Cashier',
  };
  assert.equal(displayTableValue(current.primaryBranchName, employeeConfig.columns[4]), 'SG Square Elelenwo');
  assert.equal(displayTableValue(current.primaryJobTitle, employeeConfig.columns[5]), 'Cashier');
  assert.equal(typeof current.employeeId, 'string');
  assert.equal(Object.hasOwn(current, 'branchId'), false);
  assert.equal(Object.hasOwn(current, 'assignmentId'), false);
});
test('employee forms use backend-generated immutable numbers and require phone', () => {
  for (const fields of [employeeConfig.createFields, employeeConfig.updateFields]) {
    assert.equal(fields.some((field) => field.name === 'employeeNumber'), false);
    const phone = fields.find((field) => field.name === 'phone');
    assert.ok(phone);
    assert.equal(phone.required, true);
    assert.notEqual(phone.nullable, true);
  }
  assert.ok(employeeConfig.columns.some((column) => column.key === 'employeeNumber'));
});
test('employee table shows dashes when no current primary assignment is present', () => {
  for (const employee of [
    { employmentStatus: 'ACTIVE', primaryBranchName: null, primaryJobTitle: null },
    { employmentStatus: 'TERMINATED', primaryBranchName: null, primaryJobTitle: null },
  ]) {
    assert.equal(displayTableValue(employee.primaryBranchName, employeeConfig.columns[4]), '—');
    assert.equal(displayTableValue(employee.primaryJobTitle, employeeConfig.columns[5]), '—');
  }
});
test('employee list columns consume one list payload without per-row detail requests', async () => {
  const branchColumn = employeeConfig.columns.find((column) => column.key === 'primaryBranchName');
  const jobTitleColumn = employeeConfig.columns.find((column) => column.key === 'primaryJobTitle');
  assert.equal(branchColumn.render, undefined);
  assert.equal(jobTitleColumn.render, undefined);
  assert.equal(employeeConfig.listPath, '/api/admin/employees');

  const employeesPage = await read('public/js/pages/employees.js');
  assert.doesNotMatch(employeesPage, /api\.get|fetch\s*\(/);
});
test('employee assignment replaces raw Branch ID with an authorized branch selector', () => {
  const action = employeeConfig.actions.find((item) => item.label === 'Assign branch');
  const branchField = action.fields.find((field) => field.name === 'branchId');
  assert.equal(branchField.type, 'remote-select');
  assert.equal(branchField.label, 'Branch');
  assert.equal(branchField.required, true);
  assert.equal(branchField.placeholder, 'Select a branch');
  assert.equal(branchField.remote.path, '/api/admin/branches');
  assert.deepEqual(branchField.remote.query, { status: 'ACTIVE' });
  assert.equal(branchField.remote.valueKey, 'branchId');
  assert.equal(branchField.disableSubmitWhenUnavailable, true);
  assert.equal(action.fields.some((field) => field.label === 'Branch ID' && field.type === 'text'), false);
  assert.deepEqual(action.fields.slice(1).map((field) => field.name), ['jobTitle', 'startedOn', 'isPrimary']);
});
test('employee assignment branch options show real names and codes without fabrication', () => {
  assert.equal(
    employeeAssignmentBranchLabel({ branchName: 'SG Square Elelenwo', branchCode: 'PHC-001' }),
    'SG Square Elelenwo — PHC-001',
  );
  assert.equal(
    employeeAssignmentBranchLabel({ branchName: 'SG Square Elelenwo' }),
    'SG Square Elelenwo',
  );
  assert.equal(employeeAssignmentBranchLabel({ branchId: '18446744073709551615' }), '');
});
test('employee assignment selector preserves exact BIGINT branch IDs without coercion', async () => {
  const action = employeeConfig.actions.find((item) => item.label === 'Assign branch');
  const branchField = action.fields.find((field) => field.name === 'branchId');
  const branchId = '18446744073709551615';
  const option = selectorOption({
    branchId,
    branchName: 'SG Square Elelenwo',
    branchCode: 'PHC-001',
  }, branchField.remote);
  assert.equal(option.value, branchId);
  assert.equal(typeof option.value, 'string');

  const contracts = await read('public/js/contracts.js');
  const selectors = await read('public/js/components/entitySelector.js');
  assert.doesNotMatch(contracts, /(?:Number|parseInt|parseFloat)\([^\n]*branchId/);
  assert.doesNotMatch(selectors, /(?:Number|parseInt|parseFloat)\([^\n]*(?:branchId|value)/);
});
test('unavailable assignment branches disable submission and preserve the API route', () => {
  const unavailable = new Set();
  assert.equal(updateUnavailableSelectors(unavailable, { fieldName: 'branchId', available: false }), true);
  assert.deepEqual([...unavailable], ['branchId']);
  assert.equal(updateUnavailableSelectors(unavailable, { fieldName: 'branchId', available: true }), false);

  const action = employeeConfig.actions.find((item) => item.label === 'Assign branch');
  const branchField = action.fields.find((field) => field.name === 'branchId');
  assert.equal(branchField.remote.emptyMessage, 'No accessible branches available.');
  assert.equal(branchField.remote.unauthorizedMessage, 'No accessible branches available.');
  assert.equal(
    action.path({ item: { employeeId: '18446744073709551614' } }),
    '/api/admin/employees/18446744073709551614/assignments',
  );
});
test('end assignment resolves the employee detail and hides the technical assignment ID', async () => {
  const employeeId = '18446744073709551614';
  const activeAssignmentId = '18446744073709551613';
  const action = employeeConfig.actions.find((item) => item.label === 'End assignment');
  const requestedPaths = [];
  const prepared = await action.prepare({
    item: { employeeId },
    request: {
      async get(requestPath) {
        requestedPaths.push(requestPath);
        return {
          data: {
            employee: {
              employeeId,
              employeeNumber: 'EMP-001',
              firstName: 'Frank',
              lastName: 'Nwosu',
              assignments: [
                {
                  assignmentId: '18446744073709551612',
                  branchName: 'Old Branch',
                  branchCode: 'OLD-01',
                  startedOn: '2025-01-01',
                  endedOn: '2025-12-31',
                  isPrimary: false,
                },
                {
                  assignmentId: activeAssignmentId,
                  branchName: 'SG Square Elelenwo',
                  branchCode: 'PHC-001',
                  startedOn: '2026-01-02',
                  endedOn: null,
                  isPrimary: true,
                },
              ],
            },
          },
        };
      },
    },
  });

  assert.deepEqual(requestedPaths, [`/api/admin/employees/${employeeId}`]);
  assert.equal(prepared.selectedAssignment.assignmentId, activeAssignmentId);
  assert.equal(typeof prepared.selectedAssignment.assignmentId, 'string');
  assert.deepEqual(action.fields({ prepared }).map((field) => field.name), ['endedOn']);
  assert.equal(action.fields({ prepared }).some((field) => /assignment id/i.test(field.label)), false);
  assert.deepEqual(action.pathValues({ prepared }), { employeeBranchAssignmentId: activeAssignmentId });
  assert.deepEqual(action.summary({ prepared }), [
    { label: 'Employee', value: 'Frank Nwosu' },
    { label: 'Employee no.', value: 'EMP-001' },
    { label: 'Branch', value: 'SG Square Elelenwo — PHC-001' },
    { label: 'Started on', value: '2026-01-02' },
    { label: 'Primary', value: 'Yes' },
  ]);
});

test('end assignment sends the exact existing route and endedOn-only body', async () => {
  const employeeId = '18446744073709551614';
  const assignmentId = '18446744073709551613';
  const action = employeeConfig.actions.find((item) => item.label === 'End assignment');
  const prepared = resolveEndAssignment({
    employeeId,
    assignments: [{ assignmentId, endedOn: null }],
  });
  const workflow = createActionWorkflow({
    endedOn: '2026-10-07',
    ...action.pathValues({ prepared }),
  }, action.pathOnly);
  let sent;

  const outcome = await workflow.confirm(async (body, pathValues) => {
    sent = {
      method: action.method,
      path: action.path({ item: { employeeId }, context: { body: pathValues } }),
      body,
    };
    return { data: { assignment: { assignmentId, endedOn: body.endedOn } } };
  });

  assert.deepEqual(sent, {
    method: 'post',
    path: `/api/admin/employees/${employeeId}/assignments/${assignmentId}/end`,
    body: { endedOn: '2026-10-07' },
  });
  assert.equal(outcome.submitted, true);
  assert.equal(workflow.status, 'submitted');
});

test('multiple active employee assignments require a readable exact-ID selection', () => {
  const firstId = '18446744073709551615';
  const secondId = '9007199254740993';
  const action = employeeConfig.actions.find((item) => item.label === 'End assignment');
  const prepared = resolveEndAssignment({
    employeeId: '7',
    firstName: 'Ada',
    lastName: 'Okafor',
    assignments: [
      { assignmentId: firstId, branchName: 'GRA Central', branchCode: 'GRA-001', startedOn: '2026-01-01', endedOn: null, isPrimary: true },
      { assignmentId: secondId, branchName: 'Airport Road', branchCode: 'AIR-002', startedOn: '2026-04-01', endedOn: null, isPrimary: false },
      { assignmentId: '6', branchName: 'Closed', startedOn: '2025-01-01', endedOn: '2025-12-31', isPrimary: false },
    ],
  });
  const fields = action.fields({ prepared });
  const assignmentField = fields.find((field) => field.name === 'employeeBranchAssignmentId');

  assert.equal(prepared.requiresSelection, true);
  assert.equal(prepared.selectedAssignment, null);
  assert.equal(assignmentField.type, 'select');
  assert.equal(assignmentField.label, 'Active assignment');
  assert.equal(assignmentField.required, true);
  assert.deepEqual(assignmentField.options, [
    { value: firstId, label: 'GRA Central — GRA-001 · Started 2026-01-01 · Primary: Yes' },
    { value: secondId, label: 'Airport Road — AIR-002 · Started 2026-04-01 · Primary: No' },
  ]);
  assert.equal(assignmentField.options.every((option) => typeof option.value === 'string'), true);
  assert.equal(fields.some((field) => /assignment id/i.test(field.label)), false);
});

test('no active assignment stops before a mutation form can be submitted', async () => {
  const action = employeeConfig.actions.find((item) => item.label === 'End assignment');
  let reads = 0;
  let mutations = 0;
  const prepared = await action.prepare({
    item: { employeeId: '10' },
    request: {
      async get() {
        reads += 1;
        return { data: { employee: { employeeId: '10', assignments: [{ assignmentId: '11', endedOn: '2026-01-01' }] } } };
      },
      async post() { mutations += 1; },
    },
  });

  assert.equal(reads, 1);
  assert.equal(activeEmployeeAssignments(prepared.employee).length, 0);
  assert.equal(prepared.unavailableMessage, NO_ACTIVE_ASSIGNMENT_MESSAGE);
  assert.equal(mutations, 0);

  const resourcePage = await read('public/js/components/resourcePage.js');
  assert.match(resourcePage, /if \(prepared\?\.unavailableMessage\)[\s\S]*?toast\(prepared\.unavailableMessage, 'error'\);[\s\S]*?return;/);
});

test('unresolved employee assignment data fails safely before opening the action form', async () => {
  const action = employeeConfig.actions.find((item) => item.label === 'End assignment');
  await assert.rejects(
    action.prepare({
      item: { employeeId: '18446744073709551614' },
      request: {
        async get() {
          return { data: { employee: { employeeId: '18446744073709551614' } } };
        },
      },
    }),
    /assignment information could not be resolved/i,
  );
});

test('cancelled and failed end-assignment workflows cannot leak stale employee state', async () => {
  const first = resolveEndAssignment({ assignments: [{ assignmentId: '101', endedOn: null }] });
  const second = resolveEndAssignment({ assignments: [{ assignmentId: '202', endedOn: null }] });
  const firstWorkflow = createActionWorkflow({ endedOn: '2026-10-07', employeeBranchAssignmentId: first.selectedAssignment.assignmentId }, ['employeeBranchAssignmentId']);
  const secondWorkflow = createActionWorkflow({ endedOn: '2026-10-08', employeeBranchAssignmentId: second.selectedAssignment.assignmentId }, ['employeeBranchAssignmentId']);

  assert.equal(firstWorkflow.cancel().submitted, false);
  assert.equal(firstWorkflow.status, 'cancelled');
  assert.equal(secondWorkflow.pathValues.employeeBranchAssignmentId, '202');
  await assert.rejects(secondWorkflow.confirm(async () => { throw new Error('Assignment is no longer active'); }), /no longer active/);
  assert.equal(secondWorkflow.status, 'pending');

  const action = employeeConfig.actions.find((item) => item.label === 'End assignment');
  const resourcePage = await read('public/js/components/resourcePage.js');
  assert.equal(action.refreshOnFailure, true);
  assert.match(resourcePage, /if \(shouldRefreshAfterActionFailure\(action, failure\)\) await load\(\)/);
  assert.match(resourcePage, /closeModal\(\);[\s\S]*?await load\(\);/);
});

test('make primary resolves one non-primary assignment and preserves the exact endpoint', async () => {
  const employeeId = '18446744073709551614';
  const assignmentId = '18446744073709551613';
  const action = employeeConfig.actions.find((item) => item.label === 'Make primary');
  const requestedPaths = [];
  const prepared = await action.prepare({
    item: { employeeId },
    request: {
      async get(requestPath) {
        requestedPaths.push(requestPath);
        return {
          data: {
            employee: {
              employeeId,
              employeeNumber: 'EMP-002',
              firstName: 'John',
              lastName: 'Francis',
              assignments: [{
                assignmentId,
                branchName: 'SG Square Elelenwo',
                branchCode: 'PHC-001',
                startedOn: '2026-10-01',
                endedOn: null,
                isPrimary: false,
              }],
            },
          },
        };
      },
    },
  });

  assert.deepEqual(requestedPaths, [`/api/admin/employees/${employeeId}`]);
  assert.deepEqual(action.fields({ prepared }), []);
  assert.deepEqual(action.pathValues({ prepared }), { employeeBranchAssignmentId: assignmentId });
  assert.deepEqual(action.summary({ prepared }), [
    { label: 'Employee', value: 'John Francis' },
    { label: 'Employee no.', value: 'EMP-002' },
    { label: 'Branch', value: 'SG Square Elelenwo — PHC-001' },
    { label: 'Started on', value: '2026-10-01' },
    { label: 'Primary', value: 'No' },
  ]);

  const workflow = createActionWorkflow(action.pathValues({ prepared }), action.pathOnly);
  let sent;
  await workflow.confirm(async (body, pathValues) => {
    sent = {
      method: action.method,
      path: action.path({ item: { employeeId }, context: { body: pathValues } }),
      body,
    };
    return { data: { assignment: { assignmentId, isPrimary: true } } };
  });
  assert.deepEqual(sent, {
    method: 'post',
    path: `/api/admin/employees/${employeeId}/assignments/${assignmentId}/make-primary`,
    body: {},
  });
});

test('make primary stops safely when no active assignment exists', async () => {
  const action = employeeConfig.actions.find((item) => item.label === 'Make primary');
  let reads = 0;
  let mutations = 0;
  const prepared = await action.prepare({
    item: { employeeId: '301' },
    request: {
      async get() {
        reads += 1;
        return { data: { employee: { employeeId: '301', assignments: [{ assignmentId: '401', endedOn: '2026-09-01', isPrimary: false }] } } };
      },
      async post() { mutations += 1; },
    },
  });

  assert.equal(reads, 1);
  assert.equal(prepared.unavailableMessage, NO_PRIMARY_CANDIDATE_MESSAGE);
  assert.equal(prepared.selectedAssignment, null);
  assert.equal(mutations, 0);
});

test('make primary stops safely when the only active assignment is already primary', async () => {
  const action = employeeConfig.actions.find((item) => item.label === 'Make primary');
  let mutations = 0;
  const prepared = await action.prepare({
    item: { employeeId: '302' },
    request: {
      async get() {
        return { data: { employee: { employeeId: '302', assignments: [{ assignmentId: '402', endedOn: null, isPrimary: true }] } } };
      },
      async post() { mutations += 1; },
    },
  });

  assert.equal(prepared.unavailableMessage, ALREADY_PRIMARY_MESSAGE);
  assert.equal(prepared.selectedAssignment, null);
  assert.equal(mutations, 0);
});

test('make primary presents readable multiple-assignment options with exact string IDs', () => {
  const employeeId = '18446744073709551610';
  const primaryId = '18446744073709551611';
  const candidateId = '9007199254740993';
  const action = employeeConfig.actions.find((item) => item.label === 'Make primary');
  const prepared = resolveMakePrimaryAssignment({
    employeeId,
    firstName: 'Ada',
    lastName: 'Okafor',
    assignments: [
      { assignmentId: primaryId, branchName: 'SG Square Elelenwo', branchCode: 'PHC-001', startedOn: '2026-01-02', endedOn: null, isPrimary: true },
      { assignmentId: candidateId, branchName: 'SG Square Rumuokoro', branchCode: 'PHC-002', startedOn: '2026-07-01', endedOn: null, isPrimary: false },
    ],
  });
  const fields = action.fields({ prepared });
  const selector = fields[0];

  assert.equal(selector.type, 'select');
  assert.equal(selector.label, 'Active assignment');
  assert.equal(selector.required, true);
  assert.deepEqual(selector.options, [
    { value: primaryId, label: 'SG Square Elelenwo — PHC-001 · Started 2026-01-02 · Primary: Yes' },
    { value: candidateId, label: 'SG Square Rumuokoro — PHC-002 · Started 2026-07-01 · Primary: No' },
  ]);
  assert.equal(selector.options.every((option) => typeof option.value === 'string'), true);
  assert.equal(selector.transform(candidateId, { prepared }), candidateId);
  assert.throws(() => selector.transform(primaryId, { prepared }), /already primary/i);
  assert.equal(fields.some((field) => /assignment id/i.test(field.label)), false);

  const workflow = createActionWorkflow({ employeeBranchAssignmentId: selector.transform(candidateId, { prepared }) }, action.pathOnly);
  assert.equal(
    action.path({ item: { employeeId }, context: { body: workflow.pathValues } }),
    `/api/admin/employees/${employeeId}/assignments/${candidateId}/make-primary`,
  );
  assert.deepEqual(workflow.requestBody, {});
});

test('make primary cancel, reopen, and failure paths do not reuse stale assignment state', async () => {
  const first = resolveMakePrimaryAssignment({ assignments: [{ assignmentId: '501', endedOn: null, isPrimary: false }] });
  const second = resolveMakePrimaryAssignment({ assignments: [{ assignmentId: '502', endedOn: null, isPrimary: false }] });
  const firstWorkflow = createActionWorkflow({ employeeBranchAssignmentId: first.selectedAssignment.assignmentId }, ['employeeBranchAssignmentId']);
  const secondWorkflow = createActionWorkflow({ employeeBranchAssignmentId: second.selectedAssignment.assignmentId }, ['employeeBranchAssignmentId']);

  assert.equal(firstWorkflow.cancel().submitted, false);
  assert.equal(firstWorkflow.status, 'cancelled');
  assert.equal(secondWorkflow.pathValues.employeeBranchAssignmentId, '502');
  await assert.rejects(secondWorkflow.confirm(async () => { throw new Error('Assignment is no longer active'); }), /no longer active/);
  assert.equal(secondWorkflow.status, 'pending');

  const action = employeeConfig.actions.find((item) => item.label === 'Make primary');
  assert.equal(action.refreshOnFailure, true);
  assert.equal(action.resetOnFailure, true);
  const resourcePage = await read('public/js/components/resourcePage.js');
  assert.match(resourcePage, /if \(action\.resetOnFailure\)[\s\S]*?closeModal\(\);[\s\S]*?toast\(failure\.message, 'error'\)/);
  assert.match(resourcePage, /if \(shouldRefreshAfterActionFailure\(action, failure\)\) await load\(\)/);
  const helpers = await read('public/js/employeeAssignments.js');
  assert.doesNotMatch(helpers, /(?:Number|parseInt|parseFloat)\([^\n]*(?:employeeId|assignmentId)/);
});

test('employee assignment action visibility follows the approved employment lifecycle', () => {
  const visibleActions = (employmentStatus) => employeeConfig.actions
    .filter((action) => !action.statuses || action.statuses.includes(employmentStatus))
    .map((action) => action.label);

  assert.deepEqual(visibleActions('TERMINATED'), []);
  assert.deepEqual(visibleActions('ACTIVE'), ['Assign branch', 'Terminate', 'End assignment', 'Make primary']);
  assert.deepEqual(visibleActions('ON_LEAVE'), ['Assign branch', 'Terminate', 'End assignment', 'Make primary']);
});

test('employee termination contract remains unchanged', () => {
  const employeeId = '18446744073709551614';
  const terminate = employeeConfig.actions.find((item) => item.label === 'Terminate');

  assert.equal(
    terminate.path({ item: { employeeId } }),
    `/api/admin/employees/${employeeId}/terminate`,
  );
  assert.deepEqual(terminate.fields.map((field) => field.name), ['terminationDate']);
});
test('report dates preserve calendar strings and enforce 366 days',()=>{assert.equal(validateDateRange('2026-01-01','2026-12-31'),null);assert.match(validateDateRange('2025-01-01','2026-01-02'),/366/);assert.match(validateDateRange('2026-03-02','2026-03-01'),/after/);});
test('mixed UOM rendering keeps EACH and KG separate',()=>{const rows=quantitiesByUnit([{unitOfMeasureId:'1',unitCode:'EACH',soldBaseQuantity:'3.000'},{unitOfMeasureId:'2',unitCode:'KG',soldBaseQuantity:'2.500'}]);assert.deepEqual(rows.map((row)=>[row.unitCode,row.sold]),[['EACH','3.000'],['KG','2.500']]);assert.ok(!rows.some((row)=>row.sold==='5.500'));});
test('organization currencies stay in distinct groups',()=>{const groups=currencyGroups([{currencyCode:'NGN',grossSalesAmount:'100.00'},{currencyCode:'GBP',grossSalesAmount:'2.00'}]);assert.deepEqual(groups.map((item)=>[item.currencyCode,item.grossSalesAmount]),[['NGN','100.00'],['GBP','2.00']]);});
test('pagination is bounded',()=>{assert.deepEqual(paginationModel(2,20,45),{page:2,limit:20,totalItems:45,totalPages:3});assert.equal(paginationModel(1,999,1).limit,100);});
test('hash router preserves exact detail query state',()=>{assert.deepEqual(parseHash('#/products?id=18446744073709551615'),{route:'products',known:true,query:{id:'18446744073709551615'}});assert.equal(parseHash('#/not-real').known,false);for(const route of ['login','change-password','dashboard','branches','employees','users','roles','catalog','products','pricing','suppliers','purchasing','inventory','inventory-operations','customers','pos','sales','returns','reports','profile'])assert.ok(ROUTES.has(route));});
test('session token store sets, gets, and clears without transformation',()=>{const values=new Map();const storage={setItem:(k,v)=>values.set(k,v),getItem:(k)=>values.get(k)??null,removeItem:(k)=>values.delete(k)};const store=createTokenStore(storage);store.set('secret-test-token');assert.equal(store.get(),'secret-test-token');store.clear();assert.equal(store.get(),null);});
test('submit lock prevents duplicate mutations',async()=>{const button={dataset:{},disabled:false,textContent:'Save'};let release;const held=new Promise((resolve)=>{release=resolve;});let calls=0;const first=withSubmitLock(button,async()=>{calls+=1;await held;});await Promise.resolve();const second=withSubmitLock(button,async()=>{calls+=1;});assert.equal(calls,1);release();await Promise.all([first,second]);assert.equal(button.disabled,false);assert.equal(calls,1);});
test('request generation rejects late Branch A results',()=>{const a=nextRequestGeneration();const b=nextRequestGeneration();assert.equal(isCurrentGeneration(b),true);assert.equal(isCurrentGeneration(a),false);});
test('API strings have no raw HTML injection sink',async()=>{assert.equal(textValue('<img src=x onerror=alert(1)>'),'<img src=x onerror=alert(1)>');for(const file of (await listFiles(path.join(projectRoot,'public/js'))).filter((entry)=>entry.endsWith('.js'))){const source=await fs.readFile(file,'utf8');assert.doesNotMatch(source,/\.innerHTML\s*=|insertAdjacentHTML|\.outerHTML\s*=/);}});
test('public assets contain no credentials or hard-coded local API base',async()=>{for(const file of await listFiles(path.join(projectRoot,'public'))){const source=await fs.readFile(file,'utf8');assert.doesNotMatch(source,/JWT_SECRET|DB_PASSWORD|DB_USER|Bearer\s+[A-Za-z0-9._-]{12,}|http:\/\/localhost:5000/);}});
test('major frontend workspaces use mounted API namespaces',async()=>{const source=await read('public/js/contracts.js');for(const namespace of ['/api/admin/branches','/api/admin/employees','/api/admin/users','/api/admin/catalog','/api/admin/suppliers','/inventory-adjustments','/stock-counts','/stock-transfers','/pos-registers','/till-sessions','/sales/'])assert.ok(source.includes(namespace),namespace);});
test('reports stay exactly 13 GET routes and zero mutations',async()=>{const source=(await read('src/routes/admin/report.routes.js'))+(await read('src/routes/admin/reports/index.js'));assert.equal((source.match(/router\.get\(/g)??[]).length,13);assert.equal((source.match(/router\.(post|put|patch|delete)\(/g)??[]).length,0);});
test('all locked modules are real navigation entries',async()=>{const source=await read('public/js/permissions.js');for(const route of ['branches','employees','users','roles','catalog','products','pricing','suppliers','purchasing','inventory','inventory-operations','customers','pos','sales','returns','reports'])assert.ok(source.includes(`route:'${route}'`));const all=(await Promise.all((await listFiles(path.join(projectRoot,'public'))).map((file)=>fs.readFile(file,'utf8')))).join('\n');assert.doesNotMatch(all,/coming soon/i);});
test('no Phase 17 or deployment artifacts exist',async()=>{const files=(await listFiles(projectRoot)).map((file)=>path.relative(projectRoot,file));assert.equal(files.some((file)=>/postman|\.postman_collection\.json/i.test(file)),false);assert.equal(files.includes('Dockerfile'),false);assert.equal(files.includes('docker-compose.yml'),false);});

test('scoped branch identity never fabricates display, currency, or timezone metadata', () => {
  const branch = createScopedBranchIdentity('18446744073709551615');
  assert.deepEqual(branch, { branchId: '18446744073709551615', metadataAvailable: false });
  assert.equal(hasAuthoritativeBranchMetadata(branch), false);
  assert.equal(branchMonthRange(branch), null);
  assert.equal(branchDisplayName(branch), 'Branch 18446744073709551615 (metadata unavailable)');
  assert.equal(Object.hasOwn(branch, 'branchName'), false);
  assert.equal(Object.hasOwn(branch, 'currencyCode'), false);
  assert.equal(Object.hasOwn(branch, 'timezone'), false);
});

test('report metadata hydration preserves authoritative branch values and timezone dates', () => {
  const branch = branchMetadataFromReport({
    branch: { branchId: '9007199254740993', branchCode: 'GRA', branchName: 'GRA Central' },
    currencyCode: 'NGN',
    timezone: 'Africa/Lagos',
  }, createScopedBranchIdentity('9007199254740993'));
  assert.equal(hasAuthoritativeBranchMetadata(branch), true);
  assert.deepEqual(
    { branchId: branch.branchId, branchName: branch.branchName, currencyCode: branch.currencyCode, timezone: branch.timezone },
    { branchId: '9007199254740993', branchName: 'GRA Central', currencyCode: 'NGN', timezone: 'Africa/Lagos' },
  );
  assert.deepEqual(branchMonthRange(branch, new Date('2026-01-31T23:30:00.000Z')), { from: '2026-02-01', to: '2026-02-01' });
});

test('report pagination is enabled only for the eight paginated Phase 15 contracts', () => {
  assert.deepEqual(PAGINATED_REPORT_IDS, [
    'organization', 'products', 'returns', 'inventory', 'movements', 'suppliers', 'tills', 'customers',
  ]);
  const products = createReportRequestState('products', { from: '2026-09-01', to: '2026-09-30', groupBy: 'variant' }, { page: 2, limit: 20 });
  assert.deepEqual(buildReportRequestQuery(products), {
    from: '2026-09-01', to: '2026-09-30', groupBy: 'variant', page: 2, limit: 20,
  });
  const summary = createReportRequestState('sales-summary', { from: '2026-09-01', to: '2026-09-30' }, { page: 7, limit: 20 });
  assert.deepEqual(buildReportRequestQuery(summary), { from: '2026-09-01', to: '2026-09-30' });
});

test('report page changes preserve filters and filter changes reset to page one', () => {
  const initial = createReportRequestState('returns', { from: '2026-08-01', to: '2026-08-31', status: 'COMPLETED' });
  const pageThree = changeReportPage(initial, 3);
  assert.deepEqual(pageThree, { ...initial, page: 3 });
  assert.deepEqual(pageThree.filters, initial.filters);
  const changed = changeReportFilters(pageThree, { from: '2026-09-01', to: '2026-09-30', status: 'COMPLETED' });
  assert.equal(changed.page, 1);
  assert.deepEqual(changed.filters, { from: '2026-09-01', to: '2026-09-30', status: 'COMPLETED' });
});

test('late paginated report generations cannot replace the latest page', () => {
  const pageOneGeneration = nextRequestGeneration();
  const pageTwoGeneration = nextRequestGeneration();
  assert.equal(isCurrentGeneration(pageOneGeneration), false);
  assert.equal(isCurrentGeneration(pageTwoGeneration), true);
});

test('cancelling a field-based action preserves its exact entered values and performs no mutation', () => {
  const entered = { stockTransferItemId: '18446744073709551615', quantityRequested: '2.500', notes: 'Handle carefully' };
  const workflow = createActionWorkflow(entered, ['stockTransferItemId']);
  let mutations = 0;
  const outcome = workflow.cancel();
  assert.deepEqual(outcome, { confirmed: false, submitted: false, values: entered });
  assert.equal(workflow.status, 'cancelled');
  assert.equal(mutations, 0);
});

test('confirming a field-based action submits exactly once and keeps path-only IDs out of the body', async () => {
  const id = '18446744073709551615';
  const workflow = createActionWorkflow({ saleItemId: id, quantity: '3.250', discountAmount: '0.00' }, ['saleItemId']);
  let mutations = 0;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const first = workflow.confirm(async (body, pathValues) => {
    mutations += 1;
    assert.deepEqual(body, { quantity: '3.250', discountAmount: '0.00' });
    assert.equal(pathValues.saleItemId, id);
    await held;
    return { success: true };
  });
  await Promise.resolve();
  const duplicate = await workflow.confirm(async () => { mutations += 1; });
  assert.equal(duplicate.submitted, false);
  assert.equal(mutations, 1);
  release();
  const outcome = await first;
  assert.equal(outcome.submitted, true);
  assert.deepEqual(outcome.result, { success: true });
  const afterSuccess = await workflow.confirm(async () => { mutations += 1; });
  assert.equal(afterSuccess.submitted, false);
  assert.equal(mutations, 1);
});

test('failed field-based action submission returns to a retryable pending state', async () => {
  const entered = {
    inventoryAdjustmentItemId: '18446744073709551615',
    quantityChange: '-1.250',
    reason: 'Damaged during handling',
  };
  const workflow = createActionWorkflow(entered, ['inventoryAdjustmentItemId']);
  let attempts = 0;

  await assert.rejects(
    workflow.confirm(async (body, pathValues) => {
      attempts += 1;
      assert.deepEqual(body, {
        quantityChange: '-1.250',
        reason: 'Damaged during handling',
      });
      assert.equal(pathValues.inventoryAdjustmentItemId, entered.inventoryAdjustmentItemId);
      throw new Error('Temporary API failure');
    }),
    /Temporary API failure/,
  );

  assert.equal(workflow.status, 'pending');
  assert.equal(attempts, 1);
  assert.equal(Object.hasOwn(workflow.requestBody, 'inventoryAdjustmentItemId'), false);

  const retried = await workflow.confirm(async (body, pathValues) => {
    attempts += 1;
    assert.deepEqual(body, {
      quantityChange: '-1.250',
      reason: 'Damaged during handling',
    });
    assert.equal(pathValues.inventoryAdjustmentItemId, entered.inventoryAdjustmentItemId);
    return { success: true };
  });

  assert.equal(retried.submitted, true);
  assert.equal(workflow.status, 'submitted');
  assert.equal(attempts, 2);
});

test('dashboard and reports visibly gate date-sensitive work on authoritative branch metadata', async () => {
  const dashboard = await read('public/js/pages/dashboard.js');
  const reports = await read('public/js/pages/reports.js');
  for (const source of [dashboard, reports]) {
    assert.match(source, /hasAuthoritativeBranchMetadata/);
    assert.match(source, /METADATA_UNAVAILABLE_MESSAGE/);
    assert.doesNotMatch(source, /timezone\s*\?\?\s*['"]UTC['"]/);
  }
});

test('report controls consume backend pagination and request the selected next page', async () => {
  const source = await read('public/js/pages/reports.js');
  assert.match(source, /paginationView\(response\.data\.pagination/);
  assert.match(source, /changeReportPage\(requestState, nextPage\)/);
  const next = changeReportPage(createReportRequestState('inventory', {}, { page: 1, limit: 20 }), 2);
  assert.deepEqual(buildReportRequestQuery(next), { page: 2, limit: 20 });
});
test('entity selector IDs remain exact strings beyond Number.MAX_SAFE_INTEGER', () => {
  const id = '18446744073709551615';
  assert.equal(exactSelectorId(id), id);
  assert.equal(typeof exactSelectorId(id), 'string');
  assert.equal(exactSelectorId(null), '');
});

test('destination selector excludes only the exact source branch', () => {
  const source = '18446744073709551614';
  const items = [
    { branchId: source },
    { branchId: '18446744073709551615' },
  ];
  assert.deepEqual(excludeSourceBranch(items, source), [items[1]]);
});

test('checkout till selector accepts only OPEN sessions', () => {
  const sessions = [
    { tillSessionId: '1', status: 'OPEN' },
    { tillSessionId: '2', status: 'SUSPENDED' },
    { tillSessionId: '3', status: 'CLOSED' },
  ];
  assert.deepEqual(eligibleOpenTillSessions(sessions), [sessions[0]]);
  const definition = openTillSelector('18446744073709551615');
  assert.deepEqual(definition.remote.filter(sessions), [sessions[0]]);
  assert.equal(definition.remote.query.status, 'OPEN');
});

test('supplier and sale selectors preserve exact string IDs', () => {
  const supplierId = '18446744073709551615';
  const supplierDefinition = supplierWorkspaceSelector();
  const supplier = selectorOption({
    supplierId,
    supplierName: 'City Wholesale',
    supplierCode: 'CITY',
  }, supplierDefinition.remote);
  assert.equal(supplier.value, supplierId);
  assert.equal(typeof supplier.value, 'string');
  assert.match(supplier.label, /City Wholesale/);

  const saleId = '18446744073709551614';
  const saleDefinition = saleWorkspaceSelector('9007199254740993');
  const sale = selectorOption({
    saleId,
    saleNumber: 'SALE-1001',
    soldAt: '2026-10-01T09:00:00.000Z',
    currencyCode: 'NGN',
    totalAmount: '12500.00',
    status: 'COMPLETED',
  }, saleDefinition.remote);
  assert.equal(sale.value, saleId);
  assert.equal(typeof sale.value, 'string');
  assert.match(sale.label, /SALE-1001/);
});

test('product workspaces use readable product and variant selectors with exact IDs', async () => {
  const productId = '18446744073709551615';
  const variantId = '18446744073709551614';
  const productDefinition = productWorkspaceSelector();
  const product = selectorOption({
    productId,
    productName: 'Peak Milk',
    productCode: 'PEAK-400G',
  }, productDefinition.remote);
  assert.equal(productDefinition.name, 'productId');
  assert.equal(product.value, productId);
  assert.equal(product.label, 'Peak Milk · PEAK-400G');

  const variantDefinition = variantWorkspaceSelector(productId);
  const variant = selectorOption({
    productVariantId: variantId,
    variantName: 'Peak Milk 400g',
    sku: 'PEAK-400G-TIN',
  }, variantDefinition.remote);
  assert.equal(
    variantDefinition.remote.path,
    '/api/admin/catalog/products/18446744073709551615/variants',
  );
  assert.equal(variantDefinition.name, 'variantId');
  assert.equal(variantDefinition.remote.valueKey, 'productVariantId');
  assert.equal(variant.value, variantId);
  assert.equal(variant.label, 'Peak Milk 400g · PEAK-400G-TIN');

  const source = await read('public/js/pages/products.js');
  assert.match(source, /selectionGate/);
  assert.doesNotMatch(source, /contextGate|label:\s*'Product ID'|label:\s*'Variant ID'/);
  assert.doesNotMatch(source, /(?:Number|parseInt|parseFloat)\([^\n]*(?:productId|variantId)/);
});

test('product workspace tabs remain available inside every parent-selection gate', async () => {
  const componentsCss = await read('public/css/components.css');
  const responsiveCss = await read('public/css/responsive.css');
  assert.match(componentsCss, /\.tabs\{[\s\S]*?overflow-x:auto/);
  assert.match(componentsCss, /\.tab\{[\s\S]*?white-space:nowrap/);
  assert.match(responsiveCss, /@media\(max-width:520px\)[\s\S]*?\.tabs\{/);

  const dom = installDom();
  const root = document.createElement('main');
  dom.body.append(root);
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const savedGet = api.get;
  const location = { hash: '' };
  Object.defineProperty(globalThis, 'location', { configurable: true, value: location });
  api.get = async () => ({ data: { items: [], pagination: { page: 1, totalPages: 1 } } });
  setState({
    session: {
      authorization: {
        permissions: { global: ['products.read', 'products.manage'], byBranch: {} },
      },
    },
  });

  const productId = '18446744073709551615';
  const cases = [
    { tab: 'variants', selector: 'productId' },
    { tab: 'packages', selector: 'productId' },
    { tab: 'packages', productId, selector: 'variantId' },
    { tab: 'barcodes', selector: 'productId' },
    { tab: 'barcodes', productId, selector: 'variantId' },
  ];

  try {
    await renderProducts(root, { query: { tab: 'products' } });
    assert.deepEqual(productTabLabels(root), ['Products', 'Variants', 'Packages', 'Barcodes']);

    for (const query of cases) {
      await renderProducts(root, { query });
      await flushEvents();
      assert.deepEqual(productTabLabels(root), ['Products', 'Variants', 'Packages', 'Barcodes']);
      assert.ok(root.querySelector('.selection-gate'));
      assert.equal(root.querySelector('select').attributes.name, query.selector);
    }

    await renderProducts(root, { query: { tab: 'variants' } });
    await tabNamed(root, 'Products').trigger('click');
    assert.equal(location.hash, '#/products?tab=products');

    await renderProducts(root, { query: { tab: 'packages', productId } });
    await tabNamed(root, 'Barcodes').trigger('click');
    assert.equal(location.hash, `#/products?tab=barcodes&productId=${productId}`);

    const variantId = '18446744073709551614';
    await renderProducts(root, { query: { tab: 'barcodes', productId, variantId } });
    await tabNamed(root, 'Variants').trigger('click');
    assert.equal(
      location.hash,
      `#/products?tab=variants&productId=${productId}&variantId=${variantId}`,
    );
    assert.equal(typeof productId, 'string');
    assert.equal(typeof variantId, 'string');
  } finally {
    api.get = savedGet;
    resetState();
    if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
    else delete globalThis.location;
    dom.restore();
  }
});

function productTabLabels(root) {
  return root.querySelectorAll('button')
    .filter((button) => button.attributes.role === 'tab')
    .map((button) => button.textContent);
}

function tabNamed(root, label) {
  return root.querySelectorAll('button')
    .find((button) => button.attributes.role === 'tab' && button.textContent === label);
}

test('resource actions follow their exact backend permission and lifecycle contracts', () => {
  const branchId = '18446744073709551615';
  const branchAuthorization = (permissions) => ({
    permissions: { global: [], byBranch: { [branchId]: permissions } },
  });
  const globalAuthorization = (permissions) => ({
    permissions: { global: permissions, byBranch: {} },
  });

  const openTill = posRegisterConfig.actions.find((action) => action.label === 'Open till');
  assert.equal(openTill.permission, 'till_sessions.manage');
  assert.deepEqual(openTill.statuses, ['ACTIVE']);
  assert.equal(resourceActionAllowed(
    openTill,
    posRegisterConfig,
    branchAuthorization(['pos_registers.manage']),
    branchId,
  ), false);
  assert.equal(resourceActionAllowed(
    openTill,
    posRegisterConfig,
    branchAuthorization(['till_sessions.manage']),
    branchId,
  ), true);

  const cashMovement = tillConfig.actions.find((action) => action.label === 'Cash movement');
  assert.deepEqual(cashMovement.statuses, ['OPEN']);
  const addPayment = saleConfig.actions.find((action) => action.label === 'Add payment');
  assert.equal(addPayment.permission, 'payments.manage');
  assert.equal(resourceActionAllowed(
    addPayment,
    saleConfig,
    branchAuthorization(['sales.manage']),
    branchId,
  ), false);
  assert.equal(resourceActionAllowed(
    addPayment,
    saleConfig,
    branchAuthorization(['payments.manage']),
    branchId,
  ), true);

  const grantRole = userConfig.actions.find((action) => action.label === 'Grant role');
  assert.equal(grantRole.permission, 'user_roles.manage');
  assert.equal(resourceActionAllowed(
    grantRole,
    userConfig,
    globalAuthorization(['users.manage']),
  ), false);
  assert.equal(resourceActionAllowed(
    grantRole,
    userConfig,
    globalAuthorization(['user_roles.manage']),
  ), true);

  const readOnlyActions = [
    [variantPriceConfig, 'Resolve effective', 'pricing.read'],
    [adjustmentConfig, 'View ledger', 'inventory_adjustments.read'],
    [countConfig, 'View variance', 'stock_counts.read'],
    [tillConfig, 'View cash movements', 'till_sessions.read'],
  ];
  for (const [config, label, permission] of readOnlyActions) {
    const action = config.actions.find((candidate) => candidate.label === label);
    assert.equal(action.permission, permission);
    assert.equal(resourceActionAllowed(
      action,
      config,
      branchAuthorization([permission]),
      branchId,
    ), true);
  }
});

test('table values present enums and booleans in business-readable text', () => {
  assert.equal(displayTableValue(true, { key: 'isActive' }), 'Active');
  assert.equal(displayTableValue(false, { key: 'isActive' }), 'Inactive');
  assert.equal(displayTableValue(true, { key: 'requiresReference' }), 'Required');
  assert.equal(displayTableValue(false, { key: 'requiresReference' }), 'Not required');
  assert.equal(displayTableValue(true, { key: 'isPrimary' }), 'Yes');
  assert.equal(displayTableValue('COUNT_CORRECTION', { key: 'status' }), 'Count Correction');
});

test('report navigation exposes all allowed report IDs and gates organization', () => {
  const branchOnly = reportNavigationIds(REPORTS);
  assert.deepEqual(branchOnly, [
    'overview', 'sales-summary', 'sales-trend', 'products', 'returns', 'payments',
    'inventory', 'movements', 'purchasing', 'suppliers', 'tills', 'customers',
  ]);
  assert.deepEqual(reportNavigationIds([
    ...REPORTS,
    { id: 'organization', label: 'Organization branches' },
  ]), [...branchOnly, 'organization']);
});

test('supplier packages use the nested supplier-product package workflow', async () => {
  const supplierId = '18446744073709551615';
  const selector = supplierProductWorkspaceSelector(supplierId);
  assert.equal(
    selector.remote.path,
    '/api/admin/suppliers/18446744073709551615/products',
  );
  assert.equal(selector.name, 'supplierProductId');
  const source = await read('public/js/pages/suppliers.js');
  assert.match(source, /title: 'Supplier packages'/);
  assert.match(source, /supplierProductWorkspaceSelector/);
  assert.match(source, /supplierPackageConfig/);
  assert.match(source, /supplierProductId/);
});

test('the UX layer is loaded after responsive styles', async () => {
  const html = await read('public/index.html');
  const responsive = html.indexOf('/css/responsive.css');
  const ux = html.indexOf('/css/ux.css');
  assert.ok(responsive >= 0);
  assert.ok(ux > responsive);
});

test('desktop Back, collapse control, and mobile Menu remain distinct and accessible', async () => {
  const source = await read('public/js/app.js');
  const ux = await read('public/css/ux.css');
  assert.match(source, /text:'← Back'/);
  assert.match(source, /'aria-label':'Go back'/);
  assert.match(source, /desktop-sidebar-toggle/);
  assert.match(source, /topbar-control-label',text:sidebarCollapsed\?'Expand menu':'Collapse menu'/);
  assert.match(source, /'aria-label':'Open navigation'/);
  assert.match(source, /topbar-control-label',text:'Menu'/);
  assert.match(ux, /\.mobile-menu \{ display: none; \}/);
  assert.match(ux, /@media \(max-width: 800px\)[\s\S]*\.mobile-menu \{ display: inline-flex; \}/);
  assert.doesNotMatch(source, /className:'icon-button mobile-menu'/);
});

test('branch-local delivery time conversion uses authoritative timezone metadata', () => {
  const utc = branchLocalDateTimeToUtc('2026-10-01T10:30', 'Africa/Lagos');
  assert.equal(utc, '2026-10-01T09:30:00.000Z');
  assert.equal(utcToBranchLocalDateTime(utc, 'Africa/Lagos'), '2026-10-01T10:30');
});
test('authenticated bootstrap waits for accessible branches before resolving', async () => {
  const events = [];
  let releaseBranches;
  const branchesReady = new Promise((resolve) => { releaseBranches = resolve; });
  const session = { user: { userId: '1' }, authorization: { permissions: {} } };
  let settled = false;
  const bootstrap = bootstrapAuthenticatedSession({
    initialize: async () => {
      events.push('session');
      return session;
    },
    loadBranches: async ({ session: received }) => {
      assert.equal(received, session);
      events.push('branches:start');
      await branchesReady;
      events.push('branches:end');
    },
  }).then((result) => {
    settled = true;
    return result;
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events, ['session', 'branches:start']);
  assert.equal(settled, false);
  releaseBranches();
  assert.equal(await bootstrap, session);
  assert.deepEqual(events, ['session', 'branches:start', 'branches:end']);
});

test('fresh login clears prior branch state and loads branches without selecting one', async () => {
  const events = [];
  const session = { user: { userId: '1' }, authorization: { permissions: {} } };
  const result = await bootstrapAuthenticatedSession({
    freshLogin: true,
    clearBranch: () => events.push('branch:cleared'),
    initialize: async () => {
      events.push('session');
      return session;
    },
    loadBranches: async (options) => {
      events.push('branches');
      assert.equal(options.session, session);
      assert.equal(options.storedBranchId, null);
    },
  });

  assert.equal(result, session);
  assert.deepEqual(events, ['branch:cleared', 'session', 'branches']);
});

test('branch selection restores accessible session IDs but does not auto-select by default', () => {
  const branches = [
    { branchId: '18446744073709551615' },
    { branchId: '9007199254740993' },
  ];
  assert.equal(
    resolveSelectedBranchId(branches, '9007199254740993'),
    '9007199254740993',
  );
  assert.equal(
    resolveSelectedBranchId(branches, '11111111111111111'),
    null,
  );
  assert.equal(resolveSelectedBranchId(branches, null), null);
  assert.equal(
    resolveSelectedBranchId(branches, null, { selectFirst: true }),
    '18446744073709551615',
  );
  assert.equal(resolveSelectedBranchId([], '9007199254740993'), null);
});

test('accessible branch loading preserves metadata while fresh login leaves selection null', async () => {
  resetState();
  const branchId = '18446744073709551615';
  const paths = [];
  const session = {
    authorization: {
      permissions: {
        global: ['branches.read', 'reports.read'],
        byBranch: {},
      },
    },
  };
  const request = {
    async get(requestPath) {
      paths.push(requestPath);
      return {
        data: {
          items: [{
            branchId,
            branchCode: 'GRA',
            branchName: 'GRA Central',
            currencyCode: 'NGN',
            timezone: 'Africa/Lagos',
          }],
        },
      };
    },
  };

  const result = await loadAccessibleBranches({
    session,
    request,
    storedBranchId: null,
    persistSelection: false,
  });
  assert.deepEqual(paths, ['/api/admin/branches?limit=100']);
  assert.equal(result.selectedBranchId, null);
  assert.equal(getState().selectedBranchId, null);
  assert.equal(result.branches[0].branchName, 'GRA Central');
  assert.equal(result.branches[0].currencyCode, 'NGN');
  assert.equal(result.branches[0].timezone, 'Africa/Lagos');

  const restored = await loadAccessibleBranches({
    session,
    request,
    storedBranchId: branchId,
    persistSelection: false,
  });
  assert.equal(restored.selectedBranchId, branchId);
  assert.equal(getState().selectedBranchId, branchId);
  resetState();
});

test('login requires explicit branch choice while restored-token boot may restore session selection', async () => {
  const auth = await read('public/js/auth.js');
  const appSource = await read('public/js/app.js');
  const branchAccess = await read('public/js/branchAccess.js');
  assert.match(auth, /setToken\(response\.data\.accessToken\); return bootstrapAuthenticatedSession\(\{ freshLogin: true \}\)/);
  assert.match(auth, /freshLogin \? \{ session, storedBranchId: null \} : \{ session \}/);
  assert.match(appSource, /await bootstrapAuthenticatedSession\(\)/);
  assert.ok(appSource.indexOf('await bootstrapAuthenticatedSession()') < appSource.indexOf('await renderRoute()'));
  assert.doesNotMatch(branchAccess, /currencyCode:\s*['"]['"]|timezone:\s*['"]UTC['"]/);
});

test('branch choice is stored exactly, survives navigation, and invalidates stale requests', async () => {
  await withSessionStorage(createMemoryStorage(), async () => {
    resetState();
    const branchId = '18446744073709551615';
    const store = createBranchStore(sessionStorage);
    const before = getState().requestGeneration;
    rememberBranch(branchId);

    assert.equal(getState().selectedBranchId, branchId);
    assert.equal(store.get(), branchId);
    assert.equal(typeof store.get(), 'string');
    assert.ok(getState().requestGeneration > before);
    assert.equal(resolveSelectedBranchId([{ branchId }], store.get()), branchId);

    const oldGeneration = getState().requestGeneration;
    rememberBranch('9007199254740993');
    assert.equal(isCurrentGeneration(oldGeneration), false);
    assert.equal(store.get(), '9007199254740993');
    resetState();
  });
});

test('logout clears token and branch so the next login starts without a selection', async () => {
  await withSessionStorage(createMemoryStorage(), async () => {
    resetState();
    const tokenStore = createTokenStore(sessionStorage);
    const branchStore = createBranchStore(sessionStorage);
    tokenStore.set('test-token');
    rememberBranch('18446744073709551615');

    clearSession();
    assert.equal(tokenStore.get(), null);
    assert.equal(branchStore.get(), null);
    assert.equal(getState().selectedBranchId, null);

    let loadOptions;
    await bootstrapAuthenticatedSession({
      freshLogin: true,
      initialize: async () => ({ user: { userId: '1' }, authorization: { permissions: {} } }),
      loadBranches: async (options) => { loadOptions = options; },
    });
    assert.equal(loadOptions.storedBranchId, null);
    assert.equal(branchStore.get(), null);
    resetState();
  });
});

test('authenticated Back history rejects login, unknown, and external destinations', () => {
  const history = createInAppRouteHistory();
  assert.equal(history.back(), '#/dashboard');
  assert.equal(history.record('#/login'), null);
  assert.equal(history.record('#/change-password'), null);
  assert.equal(history.record('https://example.com/#/branches'), null);
  assert.equal(history.record('#/not-real'), null);
  assert.equal(history.back(), '#/dashboard');

  const singleRoute = createInAppRouteHistory();
  singleRoute.record('#/branches');
  assert.equal(singleRoute.back(), '#/dashboard');
  singleRoute.clear();
  assert.deepEqual(singleRoute.entries(), []);

  history.record('#/dashboard');
  history.record('#/branches?status=ACTIVE');
  assert.equal(history.back(), '#/dashboard');
  assert.deepEqual(history.entries(), ['#/dashboard']);
  assert.equal(history.entries().includes('#/login'), false);
});

test('successful branch creation refreshes branch context without a page reload', async () => {
  const branches = await read('public/js/pages/branches.js');
  const resourcePage = await read('public/js/components/resourcePage.js');
  const appSource = await read('public/js/app.js');
  assert.match(branches, /async afterCreate\(\)/);
  assert.match(branches, /await loadAccessibleBranches\(\{ selectFirstWhenMissing: true \}\)/);
  assert.match(branches, /branch-context-refreshed/);
  assert.match(resourcePage, /await config\.afterCreate\(\{ response, body \}\)/);
  assert.match(appSource, /branch-context-refreshed/);
  assert.doesNotMatch(branches, /location\.reload|window\.location\.reload/);
});

test('branch selector distinguishes explicit selection from genuinely empty access', async () => {
  const source = await read('public/js/app.js');
  assert.match(source, /if\(branches\.length===0\)/);
  assert.match(source, /text:'No accessible branches'/);
  assert.match(source, /branchSelect\.disabled=true/);
  assert.match(source, /text:'Select a branch'/);
  assert.match(source, /value:String\(branch\.branchId\)/);
  assert.match(source, /branchSelect\.value=getState\(\)\.selectedBranchId\?\?''/);
});

test('dashboard renders the exact branch-selection state before any report request', async () => {
  const source = await read('public/js/pages/dashboard.js');
  const guard = source.indexOf('if (!state.selectedBranchId)');
  const request = source.indexOf('api.get(');
  assert.ok(guard >= 0);
  assert.ok(request > guard);
  assert.match(source, /'Select a branch'/);
  assert.match(source, /'Choose a branch from the selector above to view its dashboard and operations\.'/);
  assert.match(source, /if \(!state\.selectedBranchId\) \{[\s\S]*?return;[\s\S]*?const title/);
});

test('topbar keeps its workspace labels on two predictable aligned lines', async () => {
  const source = await read('public/js/app.js');
  const css = await read('public/css/ux.css');
  assert.match(source, /className:'topbar-title'/);
  assert.match(source, /text:'Store operations'/);
  assert.match(source, /text:'Branch management workspace'/);
  assert.match(css, /\.topbar-title \{[\s\S]*?display: grid;[\s\S]*?align-content: center;/);
  assert.match(css, /\.topbar-title strong,[\s\S]*?\.topbar-title small \{[\s\S]*?white-space: nowrap;/);
});

test('sidebar navigation centrally maps every destination to a meaningful SVG icon', () => {
  const byRoute = Object.fromEntries(NAVIGATION.map((item) => [item.route, item]));
  const expected = {
    dashboard: 'dashboard',
    branches: 'store',
    employees: 'users',
    users: 'user',
    roles: 'shield',
    catalog: 'list',
    products: 'package',
    pricing: 'tag',
    suppliers: 'truck',
    purchasing: 'cart',
    inventory: 'warehouse',
    'inventory-operations': 'activity',
    customers: 'users',
    pos: 'terminal',
    sales: 'receipt',
    returns: 'return',
    reports: 'chart',
    profile: 'user',
  };
  for (const [route, iconName] of Object.entries(expected)) {
    assert.equal(byRoute[route]?.icon, iconName, route);
    assert.ok(ICON_PATHS[iconName]?.length, `${route}: ${iconName}`);
  }
  assert.ok(new Set(NAVIGATION.map((item) => item.icon)).size >= 12);
  assert.ok(navigationFor({ permissions: { global: ['reports.read'], byBranch: {} } }, '1')
    .some((item) => item.route === 'reports'));
});

test('icon helper creates real monochrome SVG namespace elements without emoji or remote assets', async () => {
  const source = await read('public/js/ui.js');
  assert.match(source, /SVG_NAMESPACE = 'http:\/\/www\.w3\.org\/2000\/svg'/);
  assert.match(source, /document\.createElementNS\(SVG_NAMESPACE,'svg'\)/);
  assert.match(source, /document\.createElementNS\(SVG_NAMESPACE,'path'\)/);
  assert.match(source, /stroke:'currentColor'/);
  assert.doesNotMatch(source, /<img|https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
  for (const paths of Object.values(ICON_PATHS)) {
    for (const pathData of paths) assert.match(pathData, /^[\x20-\x7E]+$/);
  }
});

test('shared refresh controls are icon-only, accessible, and retain existing load behavior', async () => {
  const ui = await read('public/js/ui.js');
  const resourcePage = await read('public/js/components/resourcePage.js');
  const dashboard = await read('public/js/pages/dashboard.js');
  const packageJson = JSON.parse(await read('package.json'));

  assert.ok(ICON_PATHS.refresh?.length);
  assert.match(ui, /export function refreshButton/);
  assert.match(ui, /className:'button button-secondary icon-button'/);
  assert.match(ui, /'aria-label':'Refresh',title:'Refresh'/);
  assert.match(ui, /\[icon\('refresh',24\)\]/);
  assert.doesNotMatch(ui, /refreshButton[\s\S]*?text:\s*['"]Refresh['"]/);
  assert.match(resourcePage, /const refresh = refreshButton\(\); refresh\.addEventListener\('click', load\); actions\.push\(refresh\)/);
  assert.match(dashboard, /const button = refreshButton\(\{ type: 'submit' \}\)/);
  assert.match(dashboard, /filters\.addEventListener\('submit',[\s\S]*?event\.preventDefault\(\);[\s\S]*?load\(\)/);
  assert.match(resourcePage, /const state = \{ page: 1, limit: 20, search: '', filters: \{\}, controller: null \}/);
  assert.equal(Object.keys(packageJson.dependencies).some((name) => /icon/i.test(name)), false);
});

test('sidebar links contain separate icon and label elements with active and accessible context', async () => {
  const source = await read('public/js/app.js');
  assert.match(source, /className:'sidebar-nav-icon'/);
  assert.match(source, /className:'sidebar-nav-label'/);
  assert.match(source, /\[icon\(item\.icon\)\]/);
  assert.match(source, /\[navIcon,navLabel\]/);
  assert.match(source, /'aria-current':item\.route===activeRoute\?'page':null/);
  assert.match(source, /'aria-label':item\.label,title:item\.label/);
  assert.match(source, /className:'brand-mark',text:'SM'/);
});

test('desktop collapse hides labels but keeps centered icons and mobile restores full navigation', async () => {
  const layout = await read('public/css/layout.css');
  const css = await read('public/css/ux.css');
  assert.match(css, /\.sidebar-nav-icon \{[\s\S]*?display: inline-flex;[\s\S]*?justify-content: center;/);
  assert.match(css, /\.sidebar-nav-icon svg \{[\s\S]*?width: 1\.25rem;[\s\S]*?height: 1\.25rem;/);
  assert.match(css, /\.sidebar-collapsed \.nav-link \{[\s\S]*?min-height: 2\.75rem;[\s\S]*?justify-content: center;[\s\S]*?cursor: pointer;/);
  assert.match(css, /\.sidebar-collapsed \.nav-link \.sidebar-nav-icon \{ display: inline-flex; \}/);
  assert.match(css, /\.sidebar-collapsed \.nav-link \.sidebar-nav-label \{ display: none; \}/);
  assert.match(layout, /\.nav-link:hover,\.nav-link\[aria-current="page"\]/);
  assert.match(css, /@media \(max-width: 800px\)[\s\S]*?\.sidebar-collapsed \.nav-link \.sidebar-nav-label \{ display: inline; \}/);
  assert.match(css, /@media \(max-width: 800px\)[\s\S]*?\.sidebar-collapsed \.nav-link \{ justify-content: flex-start;/);
});

test('accessible trend disclosure retains native semantics and visible interaction states', async () => {
  const chart = await read('public/js/components/chart.js');
  const css = await read('public/css/ux.css');
  assert.match(chart, /element\('details'\)/);
  assert.match(chart, /element\('summary', \{ className: 'details-summary', text: 'Accessible trend values' \}\)/);
  assert.match(css, /\.details-summary \{[\s\S]*?cursor: pointer;/);
  assert.match(css, /\.details-summary:hover/);
  assert.match(css, /\.details-summary:focus-visible/);
});

test('frontend refinement uses local modules and the existing dependency set', async () => {
  const packageJson = JSON.parse(await read('package.json'));
  assert.deepEqual(Object.keys(packageJson.dependencies).sort(), [
    'bcrypt', 'cors', 'dotenv', 'express', 'express-rate-limit', 'helmet', 'jsonwebtoken', 'mysql2',
  ]);
  assert.deepEqual(Object.keys(packageJson.devDependencies), ['nodemon']);
  const canonicalPermissions = new Set(ACCESS_CONTROL_PERMISSIONS.map((permission) => permission.code));
  assert.equal(canonicalPermissions.size, 45);
  for (const item of NAVIGATION) {
    for (const permission of item.permissions ?? []) assert.ok(canonicalPermissions.has(permission));
  }
  for (const file of (await listFiles(path.join(projectRoot, 'public/js'))).filter((entry) => entry.endsWith('.js'))) {
    const source = await fs.readFile(file, 'utf8');
    for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      assert.match(match[1], /^\.\.?\//, `${path.relative(projectRoot, file)} imports ${match[1]}`);
    }
    assert.doesNotMatch(source, /mysql2|\.sql\b/i);
  }
});
