import { branchLocalDateTimeToUtc, utcToBranchLocalDateTime } from './branchContext.js';
import { excludeSourceBranch, remoteSelect } from './components/entitySelector.js';
import {
  assignmentOption,
  endAssignmentPathValues,
  endAssignmentSummary,
  makePrimaryPathValues,
  makePrimarySummary,
  resolveEndAssignment,
  resolveMakePrimaryAssignment,
  validateMakePrimarySelection,
} from './employeeAssignments.js';
import { DEFAULT_BRANCH_TIMEZONE, timeZoneOptions } from './timezones.js';
import {
  DEFAULT_BRANCH_COUNTRY,
  DEFAULT_BRANCH_CURRENCY,
  countryOptions,
  currencyOptions,
} from './regionalOptions.js';
const text = (name, label, required = false, extra = {}) => ({ name, label, required, type: 'text', ...extra });
const decimal = (name, label, required = false, extra = {}) => text(name, label, required, { help: 'Use digits and a decimal point where needed.', ...extra });
const select = (name, label, options, required = false, extra = {}) => ({ name, label, type: 'select', options, required, ...extra });
const checkbox = (name, label, defaultValue = false) => ({ name, label, type: 'checkbox', default: defaultValue });
const notes = (name = 'notes', label = 'Notes') => ({ name, label, type: 'textarea', nullable: true, full: true, maxlength: 1000 });
const status = (options, value = 'ACTIVE') => select('status', 'Status', options, true, { default: value });
const active = ['ACTIVE', 'INACTIVE'];
const productStatus = ['ACTIVE', 'INACTIVE', 'DISCONTINUED'];
const branchBase = ({ branchId }) => `/api/admin/branches/${encodeURIComponent(branchId)}`;

const categoryChoice = remoteSelect('categoryId', 'Category', {
  path: '/api/admin/catalog/categories',
  detailPath: ({ id }) => `/api/admin/catalog/categories/${encodeURIComponent(id)}`,
  detailKey: 'category',
  valueKey: 'categoryId',
  label: (item) => `${item.categoryName} · ${item.categoryCode}`,
  query: { isActive: 'true' },
  emptyMessage: 'No active categories are available. Create a category in Reference catalog first.',
}, true);
const brandChoice = remoteSelect('brandId', 'Brand', {
  path: '/api/admin/catalog/brands',
  detailPath: ({ id }) => `/api/admin/catalog/brands/${encodeURIComponent(id)}`,
  detailKey: 'brand',
  valueKey: 'brandId',
  label: (item) => `${item.brandName} · ${item.brandCode}`,
  query: { isActive: 'true' },
  emptyMessage: 'No active brands are available. You may leave this optional field blank.',
}, false, { nullable: true });
const taxRateChoice = remoteSelect('taxRateId', 'Tax rate', {
  path: '/api/admin/catalog/tax-rates',
  detailPath: ({ id }) => `/api/admin/catalog/tax-rates/${encodeURIComponent(id)}`,
  detailKey: 'taxRate',
  valueKey: 'taxRateId',
  label: (item) => `${item.taxName} · ${item.ratePercent}% (${item.taxCode})`,
  query: { isActive: 'true' },
  emptyMessage: 'No active tax rates are available. You may leave this optional field blank.',
}, false, { nullable: true });
const supplierChoice = remoteSelect('supplierId', 'Supplier', {
  path: '/api/admin/suppliers',
  detailPath: ({ id }) => `/api/admin/suppliers/${encodeURIComponent(id)}`,
  detailKey: 'supplier',
  valueKey: 'supplierId',
  label: (item) => `${item.supplierName} · ${item.supplierCode}`,
  query: { status: 'ACTIVE' },
  emptyMessage: 'No active suppliers are available. Add or activate a supplier first.',
}, true);
const destinationBranchChoice = remoteSelect('destinationBranchId', 'Destination branch', {
  path: '/api/admin/branches',
  valueKey: 'branchId',
  label: (item) => `${item.branchName} · ${item.branchCode}`,
  query: { status: 'ACTIVE' },
  filter: (items, context) => excludeSourceBranch(items, context.branchId),
  emptyMessage: 'No other active branch is available for this transfer.',
}, true, {
  help: ({ branch }) => `Source branch: ${branch?.branchName ?? branch?.branchCode ?? 'selected branch'}.`,
});
export function employeeAssignmentBranchLabel(branch) {
  const name = typeof branch?.branchName === 'string' ? branch.branchName.trim() : '';
  const code = typeof branch?.branchCode === 'string' ? branch.branchCode.trim() : '';
  if (name && code) return `${name} — ${code}`;
  return name || code;
}
const employeeAssignmentBranchChoice = remoteSelect('branchId', 'Branch', {
  path: '/api/admin/branches',
  valueKey: 'branchId',
  label: employeeAssignmentBranchLabel,
  query: { status: 'ACTIVE' },
  limit: 100,
  searchPlaceholder: 'Search branches by name or code',
  emptyMessage: 'No accessible branches available.',
  unauthorizedMessage: 'No accessible branches available.',
}, true, {
  placeholder: 'Select a branch',
  disableSubmitWhenUnavailable: true,
});
async function prepareEmployeeAssignmentAction({ item, request }, resolver) {
  const response = await request.get(`/api/admin/employees/${encodeURIComponent(item.employeeId)}`);
  const employee = response.data?.employee;
  if (
    !employee
    || String(employee.employeeId) !== String(item.employeeId)
    || !Array.isArray(employee.assignments)
  ) {
    throw new Error('Employee assignment information could not be resolved. Please refresh and try again.');
  }
  return resolver(employee);
}
const expectedAtField = {
  name: 'expectedAt', label: 'Expected delivery', type: 'datetime-local', nullable: true,
  help: ({ branch }) => branch?.timezone
    ? `Date and time at the selected branch (${branch.timezone}).`
    : 'Branch timezone metadata is required before setting an expected delivery time.',
  transform: (value, { branch }) => branchLocalDateTimeToUtc(value, branch?.timezone),
  initialTransform: (value, { branch }) => utcToBranchLocalDateTime(value, branch?.timezone),
};

export const branchConfig = {
  key: 'branches', title: 'Branches', singular: 'branch', description: 'Maintain the city-wide branch network and its operating context.',
  listPath: '/api/admin/branches', detailPath: ({ item }) => `/api/admin/branches/${encodeURIComponent(item.branchId)}`, readPermission: 'branches.read', managePermission: 'branches.manage',
  columns: [{ key: 'branchCode', label: 'Code' }, { key: 'branchName', label: 'Branch' }, { key: 'city' }, { key: 'currencyCode', label: 'Currency' }, { key: 'timezone' }, { key: 'status', status: true }],
  filters: [{ name: 'status', label: 'Status', options: ['ACTIVE', 'INACTIVE', 'CLOSED'] }],
  createFields: [
    text('branchCode', 'Branch code', true, {
      placeholder: 'PHC-001',
      help: 'Permanent internal identifier for this branch.',
    }),
    text('branchName', 'Branch name', true),
    text('phone', 'Phone', false, { nullable: true }),
    text('email', 'Email', false, { type: 'email', nullable: true }),
    text('addressLine1', 'Address line 1', true),
    text('addressLine2', 'Address line 2', false, { nullable: true }),
    text('city', 'City', true),
    text('stateRegion', 'State / region', false, { nullable: true }),
    text('postalCode', 'Postal code', false, { nullable: true }),
    select('countryCode', 'Country', countryOptions, true, { default: DEFAULT_BRANCH_COUNTRY }),
    select('currencyCode', 'Currency', currencyOptions, true, { default: DEFAULT_BRANCH_CURRENCY }),
    select('timezone', 'Timezone', timeZoneOptions, true, { default: DEFAULT_BRANCH_TIMEZONE }),
    { name: 'openedOn', label: 'Opened on', type: 'date', nullable: true },
    status(['ACTIVE', 'INACTIVE', 'CLOSED']),
  ],
};
branchConfig.updateFields = branchConfig.createFields;

export const employeeConfig = {
  key: 'employees', title: 'Employees', singular: 'employee', description: 'Manage staff records and accountable branch assignments.',
  listPath: '/api/admin/employees', detailPath: ({ item }) => `/api/admin/employees/${encodeURIComponent(item.employeeId)}`, readPermission: 'employees.read', managePermission: 'employees.manage',
  columns: [{ key: 'employeeNumber', label: 'Employee no.' }, { key: 'firstName' }, { key: 'lastName' }, { key: 'email' }, { key: 'primaryBranchName', label: 'Branch' }, { key: 'primaryJobTitle', label: 'Job title' }, { key: 'employmentStatus', label: 'Status', status: true }], filters: [{ name: 'employmentStatus', label: 'Status', options: ['ACTIVE', 'ON_LEAVE', 'TERMINATED'] }],
  createFields: [text('firstName', 'First name', true), text('lastName', 'Last name', true), text('email', 'Email', false, { type: 'email', nullable: true }), text('phone', 'Phone', true), { name: 'hireDate', label: 'Hire date', type: 'date', required: true }, select('employmentStatus', 'Employment status', ['ACTIVE', 'ON_LEAVE'], true, { default: 'ACTIVE' })],
  actions: [
    { label: 'Assign branch', path: ({ item }) => `/api/admin/employees/${item.employeeId}/assignments`, fields: [employeeAssignmentBranchChoice, text('jobTitle', 'Job title', true), { name: 'startedOn', label: 'Started on', type: 'date', required: true }, checkbox('isPrimary', 'Primary assignment')], statuses: ['ACTIVE', 'ON_LEAVE'] },
    { label: 'Terminate', path: ({ item }) => `/api/admin/employees/${item.employeeId}/terminate`, fields: [{ name: 'terminationDate', label: 'Termination date', type: 'date', required: true }], statuses: ['ACTIVE', 'ON_LEAVE'], tone: 'danger', confirm: (item) => `Terminate ${item.firstName} ${item.lastName}? Current branch assignments will also end.` },
  ],
};
employeeConfig.updateFields = employeeConfig.createFields;

export const userConfig = {
  key: 'users', title: 'Internal users', singular: 'user', description: 'Provision internal accounts and review scoped access grants.',
  listPath: '/api/admin/users', detailPath: ({ item }) => `/api/admin/users/${item.userId}`, readPermission: 'users.read', managePermission: 'users.manage',
  columns: [{ key: 'username' }, { key: 'email' }, { key: 'employeeId', label: 'Employee ID' }, { key: 'isActive', label: 'Active' }, { key: 'mustChangePassword', label: 'Password change' }],
  createFields: [text('employeeId', 'Employee ID', false, { nullable: true, help: 'Leave blank only for an unlinked system account.' }), text('username', 'Username', true), text('email', 'Email', true, { type: 'email' }), text('temporaryPassword', 'Temporary password', true, { type: 'password', maxlength: 72 })],
  updateFields: [text('employeeId', 'Employee ID', false, { nullable: true }), text('username', 'Username'), text('email', 'Email', false, { type: 'email' }), checkbox('isActive', 'Active')],
  actions: [
    { label: 'Reset password', path: ({ item }) => `/api/admin/users/${item.userId}/reset-password`, fields: [text('temporaryPassword', 'Temporary password', true, { type: 'password', maxlength: 72 })], description: 'The user will be required to replace this password at next sign-in.' },
    { label: 'Grant role', permission: 'user_roles.manage', path: ({ item }) => `/api/admin/users/${item.userId}/roles`, fields: [text('roleId', 'Role ID', true), text('branchId', 'Branch ID', false, { nullable: true, help: 'Leave blank for a global grant.' })] },
  ],
};

export const roleConfig = {
  key: 'roles', title: 'Roles', singular: 'role', description: 'Maintain reusable roles and permission mappings.',
  listPath: '/api/admin/roles', detailPath: ({ item }) => `/api/admin/roles/${item.roleId}`, readPermission: 'roles.read', managePermission: 'roles.manage',
  columns: [{ key: 'roleCode', label: 'Code' }, { key: 'roleName', label: 'Role' }, { key: 'description' }, { key: 'isActive', label: 'Active' }],
  createFields: [text('roleCode', 'Role code', true), text('roleName', 'Role name', true), notes('description', 'Description'), checkbox('isActive', 'Active', true)],
  actions: [{ label: 'Replace permissions', method: 'put', path: ({ item }) => `/api/admin/roles/${item.roleId}/permissions`, fields: [text('permissionIds', 'Permission IDs', true, { help: 'Comma-separated permission IDs.', transform: (value) => value.split(',').map((entry) => entry.trim()).filter(Boolean) })], confirm: () => 'Replace this role’s complete permission set with the supplied IDs?' }],
};
roleConfig.updateFields = roleConfig.createFields;

export function permissionDomain(code) {
  const prefix = String(code ?? '').split('.')[0];
  if (['branches', 'employees', 'users', 'roles', 'permissions'].includes(prefix)) return 'Organization & administration';
  if (prefix === 'catalog') return 'Catalog';
  if (['products', 'pricing'].includes(prefix)) return 'Products & pricing';
  if (['suppliers', 'purchasing', 'receiving'].includes(prefix)) return 'Suppliers & purchasing';
  if (['inventory', 'inventory_adjustments', 'stock_counts', 'stock_transfers'].includes(prefix)) return 'Inventory';
  if (['pos_registers', 'till_sessions', 'sales', 'payment_methods'].includes(prefix)) return 'POS & sales';
  if (['payments', 'returns'].includes(prefix)) return 'Payments & returns';
  if (prefix === 'reports') return 'Reporting';
  return 'Other';
}
export const permissionConfig = { key: 'permissions', title: 'Permission catalog', singular: 'permission', description: 'Review access capabilities grouped by business area. Permission codes remain visible for administration.', listPath: '/api/admin/permissions', detailPath: false, readPermission: 'permissions.read', managePermission: 'permissions.read', create: false, update: false, groupBy: (item) => permissionDomain(item.permissionCode), columns: [{ key: 'permissionCode', label: 'Code' }, { key: 'permissionName', label: 'Permission' }, { key: 'description' }] };

export const catalogConfigs = [
  { key: 'units', title: 'Units of measure', singular: 'unit', listPath: '/api/admin/catalog/units', detailPath: ({ item }) => `/api/admin/catalog/units/${item.unitOfMeasureId}`, readPermission: 'catalog.read', managePermission: 'catalog.manage', columns: [{ key: 'unitCode' }, { key: 'unitName' }, { key: 'symbol' }, { key: 'allowsFraction' }], createFields: [text('unitCode', 'Unit code', true), text('unitName', 'Unit name', true), text('symbol', 'Symbol', true), checkbox('allowsFraction', 'Allows fractional quantities')] },
  { key: 'categories', title: 'Categories', singular: 'category', listPath: '/api/admin/catalog/categories', detailPath: ({ item }) => `/api/admin/catalog/categories/${item.categoryId}`, readPermission: 'catalog.read', managePermission: 'catalog.manage', columns: [{ key: 'categoryCode' }, { key: 'categoryName' }, { key: 'parentCategoryId', label: 'Parent ID' }, { key: 'isActive' }], createFields: [text('parentCategoryId', 'Parent category ID', false, { nullable: true }), text('categoryCode', 'Category code', true), text('categoryName', 'Category name', true), notes('description', 'Description'), checkbox('isActive', 'Active', true)] },
  { key: 'brands', title: 'Brands', singular: 'brand', listPath: '/api/admin/catalog/brands', detailPath: ({ item }) => `/api/admin/catalog/brands/${item.brandId}`, readPermission: 'catalog.read', managePermission: 'catalog.manage', columns: [{ key: 'brandCode' }, { key: 'brandName' }, { key: 'description' }, { key: 'isActive' }], createFields: [text('brandCode', 'Brand code', true), text('brandName', 'Brand name', true), notes('description', 'Description'), checkbox('isActive', 'Active', true)] },
  { key: 'tax-rates', title: 'Tax rates', singular: 'tax rate', listPath: '/api/admin/catalog/tax-rates', detailPath: ({ item }) => `/api/admin/catalog/tax-rates/${item.taxRateId}`, readPermission: 'catalog.read', managePermission: 'catalog.manage', columns: [{ key: 'taxCode' }, { key: 'taxName' }, { key: 'ratePercent', label: 'Rate %' }, { key: 'isInclusive' }, { key: 'isActive' }], createFields: [text('taxCode', 'Tax code', true), text('taxName', 'Tax name', true), decimal('ratePercent', 'Rate percent', true, { default: '0.0000' }), checkbox('isInclusive', 'Inclusive'), checkbox('isActive', 'Active', true)] },
];
for (const config of catalogConfigs) { config.description = `Manage ${config.title.toLowerCase()} used by the product catalog.`; config.updateFields = config.createFields; }

export const productConfig = { key: 'products', title: 'Products', singular: 'product', description: 'Maintain the product catalog without changing branch stock.', listPath: '/api/admin/catalog/products', detailPath: ({ item }) => `/api/admin/catalog/products/${item.productId}`, readPermission: 'products.read', managePermission: 'products.manage', columns: [{ key: 'productCode' }, { key: 'productName' }, { key: 'categoryName', label: 'Category' }, { key: 'brandName', label: 'Brand' }, { key: 'status', status: true }], filters: [{ name: 'status', label: 'Status', options: productStatus }], createFields: [categoryChoice, brandChoice, taxRateChoice, text('productCode', 'Product code', true), text('productName', 'Product name', true), notes('description', 'Description'), status(productStatus)], emptyState: { title: 'No products yet', message: 'Create reference catalog data, then add your first product.' } };
productConfig.updateFields = productConfig.createFields;

export const variantConfig = { key: 'variants', title: 'Product variants', singular: 'variant', description: 'Maintain sellable and stockable SKUs with their base unit.', listPath: ({ context }) => `/api/admin/catalog/products/${context.productId}/variants`, detailPath: ({ item }) => `/api/admin/catalog/variants/${item.productVariantId}`, readPermission: 'products.read', managePermission: 'products.manage', columns: [{ key: 'sku' }, { key: 'variantName' }, { key: 'unitCode', label: 'Base unit' }, { key: 'lotTrackingMode' }, { key: 'defaultSellingPrice' }, { key: 'status', status: true }], filters: [{ name: 'status', label: 'Status', options: productStatus }], createFields: [text('unitOfMeasureId', 'Base unit ID', true), text('sku', 'SKU', true), text('variantName', 'Variant name', true), decimal('sizeValue', 'Size value', false, { nullable: true }), decimal('unitsPerPack', 'Units per pack', true, { default: '1.000' }), checkbox('isFractional', 'Fractional sale allowed'), select('lotTrackingMode', 'Lot tracking', ['NONE', 'OPTIONAL', 'REQUIRED'], true, { default: 'NONE' }), checkbox('requiresExpiryDate', 'Expiry date required'), decimal('defaultSellingPrice', 'Default selling price', true), status(productStatus, 'INACTIVE'), { name:'basePackage', label:'Base package details (JSON)', type:'textarea', full:true, help:'Required when creating an active variant.', transform:(value)=>JSON.parse(value) }] };
variantConfig.updateFields = variantConfig.createFields.filter((field) => field.name !== 'basePackage');

export const packageConfig = { key: 'packages', title: 'Variant packages', singular: 'package', description: 'Configure base-unit conversions for purchasing and selling.', listPath: ({ context }) => `/api/admin/catalog/variants/${context.variantId}/packages`, detailPath: ({ item }) => `/api/admin/catalog/packages/${item.productPackageId ?? item.packageId}`, readPermission: 'products.read', managePermission: 'products.manage', columns: [{ key: 'packageCode' }, { key: 'packageName' }, { key: 'conversionToBaseQuantity', label: 'Base conversion' }, { key: 'isPurchasable' }, { key: 'isSellable' }, { key: 'status', status: true }], createFields: [text('packageUnitOfMeasureId', 'Package unit ID', true), text('packageCode', 'Package code', true), text('packageName', 'Package name', true), decimal('conversionToBaseQuantity', 'Conversion to base quantity', true), checkbox('isBaseUnit', 'Base package'), checkbox('isPurchasable', 'Purchasable', true), checkbox('isSellable', 'Sellable', true), decimal('defaultSellingPrice', 'Default selling price', false, { nullable: true }), status(productStatus)] };
packageConfig.updateFields = packageConfig.createFields;

export const barcodeConfig = { key: 'barcodes', title: 'Variant barcodes', singular: 'barcode', description: 'Assign barcodes to variants or configured packages.', listPath: ({ context }) => `/api/admin/catalog/variants/${context.variantId}/barcodes`, detailPath: ({ item }) => `/api/admin/catalog/barcodes/${item.barcodeId}`, readPermission: 'products.read', managePermission: 'products.manage', columns: [{ key: 'barcode' }, { key: 'barcodeType' }, { key: 'packageName' }, { key: 'isPrimary' }], createFields: [text('productPackageId', 'Package ID', false, { nullable: true }), text('barcode', 'Barcode', true), select('barcodeType', 'Barcode type', ['EAN_8', 'UPC_A', 'EAN_13', 'GTIN_14', 'CODE_128', 'PLU', 'INTERNAL', 'OTHER'], true, { default: 'OTHER' }), checkbox('isPrimary', 'Primary barcode')] };
barcodeConfig.updateFields = barcodeConfig.createFields;

export const customerConfig = { key: 'customers', title: 'Customers', singular: 'customer', description: 'Maintain individual and business customer profiles and loyalty details.', listPath: '/api/admin/customers', detailPath: ({ item }) => `/api/admin/customers/${item.customerId}`, readPermission: 'customers.read', managePermission: 'customers.manage', columns: [{ key: 'customerType', label: 'Type' }, { key: 'displayName', label: 'Customer' }, { key: 'email' }, { key: 'phone' }, { key: 'loyaltyNumber' }, { key: 'status', status: true }], filters: [{ name: 'customerType', label: 'Type', options: ['INDIVIDUAL', 'BUSINESS'] }, { name: 'status', label: 'Status', options: ['ACTIVE', 'INACTIVE', 'BLOCKED'] }], createFields: [select('customerType', 'Customer type', ['INDIVIDUAL', 'BUSINESS'], true, { default: 'INDIVIDUAL' }), text('firstName', 'First name', false, { nullable: true }), text('lastName', 'Last name', false, { nullable: true }), text('businessName', 'Business name', false, { nullable: true }), text('email', 'Email', false, { type: 'email', nullable: true }), text('phone', 'Phone', false, { nullable: true }), text('loyaltyNumber', 'Loyalty number', false, { nullable: true }), { name: 'dateOfBirth', label: 'Date of birth', type: 'date', nullable: true }, status(['ACTIVE', 'INACTIVE', 'BLOCKED'])] };
customerConfig.updateFields = customerConfig.createFields;

export const supplierConfig = { key: 'suppliers', title: 'Suppliers', singular: 'supplier', description: 'Maintain supplier master data and lifecycle.', listPath: '/api/admin/suppliers', detailPath: ({ item }) => `/api/admin/suppliers/${item.supplierId}`, readPermission: 'suppliers.read', managePermission: 'suppliers.manage', columns: [{ key: 'supplierCode' }, { key: 'supplierName' }, { key: 'contactName' }, { key: 'email' }, { key: 'paymentTermsDays', label: 'Terms (days)' }, { key: 'status', status: true }], filters: [{ name: 'status', label: 'Status', options: ['ACTIVE', 'INACTIVE', 'BLOCKED'] }], createFields: [text('supplierCode', 'Supplier code', true), text('supplierName', 'Supplier name', true), text('contactName', 'Contact name', false, { nullable: true }), text('email', 'Email', false, { type: 'email', nullable: true }), text('phone', 'Phone', false, { nullable: true }), text('taxIdentifier', 'Tax identifier', false, { nullable: true }), text('addressLine1', 'Address line 1', false, { nullable: true }), text('addressLine2', 'Address line 2', false, { nullable: true }), text('city', 'City', false, { nullable: true }), text('stateRegion', 'State / region', false, { nullable: true }), text('postalCode', 'Postal code', false, { nullable: true }), text('countryCode', 'Country code', false, { nullable: true }), text('paymentTermsDays', 'Payment terms days', true, { default: '0' }), status(['ACTIVE', 'INACTIVE', 'BLOCKED'])] };
supplierConfig.updateFields = supplierConfig.createFields;

export const supplierProductConfig = { key: 'supplier-products', title: 'Supplier catalog', singular: 'supplier product', description: 'Connect a supplier to products and maintain ordering terms.', listPath: ({ context }) => `/api/admin/suppliers/${context.supplierId}/products`, detailPath: ({ context, item }) => `/api/admin/suppliers/${context.supplierId}/products/${item.supplierProductId}`, readPermission: 'suppliers.read', managePermission: 'suppliers.manage', columns: [{ key: 'sku' }, { key: 'variantName' }, { key: 'supplierSku' }, { key: 'isPreferred' }, { key: 'minimumOrderQuantity' }], createFields: [text('productVariantId', 'Product variant ID', true), text('supplierSku', 'Supplier SKU', false, { nullable: true }), checkbox('isPreferred', 'Preferred supplier'), text('leadTimeDays', 'Lead time days', false, { nullable: true }), decimal('minimumOrderQuantity', 'Minimum order quantity', true, { default: '1.000' })], updateFields: [text('supplierSku', 'Supplier SKU', false, { nullable: true }), checkbox('isPreferred', 'Preferred supplier'), text('leadTimeDays', 'Lead time days', false, { nullable: true }), decimal('minimumOrderQuantity', 'Minimum order quantity', true)] };

export const variantPriceConfig = { key: 'variant-prices', title: 'Variant prices', singular: 'variant price', description: 'Configure dated branch overrides for individual SKUs.', branch: true, listPath: ({ branchId }) => `${branchBase({ branchId })}/prices/variants`, detailPath: ({ branchId, item }) => `${branchBase({ branchId })}/prices/variants/${item.productVariantId ?? item.variantId}`, updatePath: ({ branchId, item }) => `${branchBase({ branchId })}/prices/variants/${item.productVariantId ?? item.variantId}`, create: false, updateMethod: 'put', readPermission: 'pricing.read', managePermission: 'pricing.manage', columns: [{ key: 'sku' }, { key: 'variantName' }, { key: 'sellingPrice' }, { key: 'effectiveFrom' }, { key: 'effectiveStatus', status: true }], filters: [{ name: 'effectiveStatus', label: 'Effective state', options: ['EFFECTIVE', 'FUTURE', 'INACTIVE'] }], updateFields: [decimal('sellingPrice', 'Selling price', true), text('effectiveFrom', 'Effective from (UTC)', true, { placeholder: '2026-09-29T10:00:00Z' }), checkbox('isActive', 'Active', true)] };
export const packagePriceConfig = { ...variantPriceConfig, key: 'package-prices', title: 'Package prices', singular: 'package price', description: 'Configure dated branch overrides for sellable packages.', listPath: ({ branchId }) => `${branchBase({ branchId })}/prices/packages`, detailPath: ({ branchId, item }) => `${branchBase({ branchId })}/prices/packages/${item.productPackageId ?? item.packageId}`, updatePath: ({ branchId, item }) => `${branchBase({ branchId })}/prices/packages/${item.productPackageId ?? item.packageId}`, columns: [{ key: 'sku' }, { key: 'packageName' }, { key: 'conversionToBaseQuantity' }, { key: 'sellingPrice' }, { key: 'effectiveStatus', status: true }] };

export const inventoryConfig = { key: 'inventory', title: 'Branch inventory', singular: 'inventory record', description: 'Review current stock and configure replenishment levels for this branch.', branch: true, listPath: ({ branchId }) => `${branchBase({ branchId })}/inventory`, detailPath: ({ branchId, item }) => `${branchBase({ branchId })}/inventory/variants/${item.productVariantId ?? item.variantId}`, readPermission: 'inventory.read', managePermission: 'inventory.manage', create: false, columns: [{ key: 'sku' }, { key: 'variantName' }, { key: 'unitSymbol', label: 'Unit' }, { key: 'quantityOnHand' }, { key: 'reorderLevel' }, { key: 'stockStatus', status: true }, { key: 'inventoryVersion', label: 'Version' }], updatePath: ({ branchId, item }) => `${branchBase({ branchId })}/inventory/variants/${item.productVariantId ?? item.variantId}/settings`, updateMethod: 'put', updateFields: [decimal('reorderLevel', 'Reorder level', true), decimal('reorderQuantity', 'Reorder quantity', true)], emptyState: { title: 'No stock records yet', message: 'Stock appears after receiving, opening balance, adjustment, transfer, return, or sale activity.' } };
export const lotConfig = { key: 'lots', title: 'Inventory lots', singular: 'lot', description: 'Inspect lot, batch, expiry, and branch-level balances.', branch: true, listPath: ({ branchId }) => `${branchBase({ branchId })}/inventory/lots`, detailPath: ({ branchId, item }) => `${branchBase({ branchId })}/inventory/lots/${item.inventoryLotId}`, readPermission: 'inventory.read', managePermission: 'inventory.manage', create: false, update: false, columns: [{ key: 'lotNumber' }, { key: 'sku' }, { key: 'variantName' }, { key: 'expiresOn' }, { key: 'quantityOnHand' }, { key: 'branchStatus', status: true }], actions: [{ label: 'Change status', method: 'patch', path: ({ branchId, item }) => `${branchBase({ branchId })}/inventory/lots/${item.inventoryLotId}/status`, fields: [select('status', 'Lot status', ['AVAILABLE', 'QUARANTINED', 'BLOCKED'], true)] }] };
export const transactionConfig = { key: 'transactions', title: 'Inventory ledger', singular: 'ledger entry', description: 'Review the complete history of stock movements.', branch: true, listPath: ({ branchId }) => `${branchBase({ branchId })}/inventory/transactions`, detailPath: ({ branchId, item }) => `${branchBase({ branchId })}/inventory/transactions/${item.inventoryTransactionId}`, readPermission: 'inventory.read', managePermission: 'inventory.read', create: false, update: false, columns: [{ key: 'occurredAt' }, { key: 'transactionType' }, { key: 'sku' }, { key: 'quantityChange' }, { key: 'unitCost' }, { key: 'referenceType' }, { key: 'referenceId' }] };

export const posRegisterConfig = { key: 'pos-registers', title: 'POS registers', singular: 'register', description: 'Manage physical checkout terminals for the selected branch.', branch: true, listPath: ({ branchId }) => `${branchBase({ branchId })}/pos-registers`, detailPath: ({ branchId, item }) => `${branchBase({ branchId })}/pos-registers/${item.posRegisterId}`, readPermission: 'pos_registers.read', managePermission: 'pos_registers.manage', columns: [{ key: 'registerCode' }, { key: 'registerName' }, { key: 'terminalIdentifier' }, { key: 'status', status: true }], filters: [{ name: 'status', label: 'Status', options: ['ACTIVE', 'INACTIVE', 'MAINTENANCE'] }], createFields: [text('registerCode', 'Register code', true), text('registerName', 'Register name', true), text('terminalIdentifier', 'Terminal identifier', false, { nullable: true }), status(['ACTIVE', 'INACTIVE', 'MAINTENANCE'])], actions: [{ label: 'Open till', permission: 'till_sessions.manage', path: ({ branchId, item }) => `${branchBase({ branchId })}/pos-registers/${item.posRegisterId}/till-sessions`, fields: [text('cashierEmployeeId', 'Cashier employee ID', true), decimal('openingCashAmount', 'Opening cash amount', true), notes()], statuses: ['ACTIVE'] }] };
posRegisterConfig.updateFields = posRegisterConfig.createFields;

export const tillConfig = { key: 'tills', title: 'Till sessions', singular: 'till session', description: 'Review cashier sessions, cash movements, and drawer reconciliation.', branch: true, listPath: ({ branchId }) => `${branchBase({ branchId })}/till-sessions`, detailPath: ({ branchId, item }) => `${branchBase({ branchId })}/till-sessions/${item.tillSessionId}`, readPermission: 'till_sessions.read', managePermission: 'till_sessions.manage', create: false, update: false, search: false, notice: 'Till sessions are opened from an active register on the Registers tab.', emptyState: { title: 'No till sessions yet', message: 'Open an active register session to begin checkout.' }, columns: [{ key: 'sessionNumber', label: 'Session' }, { key: 'posRegisterId', label: 'Register' }, { key: 'cashierEmployeeId', label: 'Cashier' }, { key: 'openedAt' }, { key: 'openingCashAmount' }, { key: 'expectedClosingCashAmount' }, { key: 'status', status: true }], filters: [{ name: 'status', label: 'Status', options: ['OPEN', 'SUSPENDED', 'CLOSED', 'CANCELLED'] }], actions: [
  { label: 'Cash movement', path: ({ branchId, item }) => `${branchBase({ branchId })}/till-sessions/${item.tillSessionId}/cash-movements`, fields: [select('movementType', 'Movement type', ['CASH_IN', 'CASH_OUT', 'CASH_DROP', 'PAYOUT'], true), decimal('amount', 'Amount', true), text('reason', 'Reason', true), text('referenceNumber', 'Reference', false, { nullable: true })], statuses: ['OPEN'] },
  { label: 'Suspend', path: ({ branchId, item }) => `${branchBase({ branchId })}/till-sessions/${item.tillSessionId}/suspend`, statuses: ['OPEN'], confirm: () => 'Suspend this till session? New checkout activity will be blocked until resumed.' },
  { label: 'Resume', path: ({ branchId, item }) => `${branchBase({ branchId })}/till-sessions/${item.tillSessionId}/resume`, statuses: ['SUSPENDED'] },
  { label: 'Close', path: ({ branchId, item }) => `${branchBase({ branchId })}/till-sessions/${item.tillSessionId}/close`, fields: [decimal('actualClosingCashAmount', 'Actual closing cash', true)], statuses: ['OPEN', 'SUSPENDED'], confirm: () => 'Close and reconcile this till using the actual counted cash? Expected cash and variance will be recorded.', tone: 'danger' },
  { label: 'Cancel', path: ({ branchId, item }) => `${branchBase({ branchId })}/till-sessions/${item.tillSessionId}/cancel`, statuses: ['OPEN', 'SUSPENDED'], confirm: () => 'Cancel this unused till session? Cancellation is unavailable after financial activity.', tone: 'danger' },
] };

export const paymentMethodConfig = { key: 'payment-methods', title: 'Payment methods', singular: 'payment method', description: 'Configure supported tender types and reference requirements.', listPath: '/api/admin/payment-methods', detailPath: ({ item }) => `/api/admin/payment-methods/${item.paymentMethodId}`, readPermission: 'payment_methods.read', managePermission: 'payment_methods.manage', columns: [{ key: 'methodCode' }, { key: 'methodName' }, { key: 'methodType' }, { key: 'requiresReference' }, { key: 'isActive' }], filters: [{ name: 'methodType', label: 'Type', options: ['CASH', 'CARD', 'BANK_TRANSFER', 'MOBILE_MONEY', 'VOUCHER', 'OTHER'] }], createFields: [text('methodCode', 'Method code', true), text('methodName', 'Method name', true), select('methodType', 'Method type', ['CASH', 'CARD', 'BANK_TRANSFER', 'MOBILE_MONEY', 'VOUCHER', 'OTHER'], true), checkbox('requiresReference', 'External reference required'), checkbox('isActive', 'Active', true)], updateFields: [text('methodCode', 'Method code', true), text('methodName', 'Method name', true), checkbox('requiresReference', 'External reference required'), checkbox('isActive', 'Active', true)] };

export const purchaseOrderConfig = { key: 'purchase-orders', title: 'Purchase orders', singular: 'purchase order', description: 'Prepare supplier orders and manage their approval and receiving lifecycle.', branch: true, listPath: ({ branchId }) => `${branchBase({ branchId })}/purchase-orders`, detailPath: ({ branchId, item }) => `${branchBase({ branchId })}/purchase-orders/${item.purchaseOrderId}`, readPermission: 'purchasing.read', managePermission: 'purchasing.manage', columns: [{ key: 'purchaseOrderNumber', label: 'Order' }, { key: 'supplierName' }, { key: 'orderedAt' }, { key: 'expectedAt' }, { key: 'totalAmount' }, { key: 'status', status: true }], filters: [{ name: 'status', label: 'Status', options: ['DRAFT', 'SUBMITTED', 'APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'] }], createFields: [supplierChoice, expectedAtField, text('supplierQuoteNumber', 'Supplier quote', false, { nullable: true }), decimal('shippingAmount', 'Shipping amount', true, { default: '0.00', help: ({ branch }) => branch?.currencyCode ? `Enter the shipping charge in ${branch.currencyCode}. Order totals are calculated when saved.` : 'Enter the shipping charge using the branch currency.' }), notes()], updateFields: [expectedAtField, text('supplierQuoteNumber', 'Supplier quote', false, { nullable: true }), decimal('shippingAmount', 'Shipping amount', true, { help: ({ branch }) => branch?.currencyCode ? `Enter the shipping charge in ${branch.currencyCode}. Order totals are calculated when saved.` : 'Enter the shipping charge using the branch currency.' }), notes()], actions: [
  { label: 'Add item', path: ({ branchId, item }) => `${branchBase({ branchId })}/purchase-orders/${item.purchaseOrderId}/items`, statuses: ['DRAFT'], fields: [text('productVariantId', 'Variant ID', true), text('productPackageId', 'Package ID', false, { nullable: true }), decimal('orderedPackageQuantity', 'Package quantity', true), decimal('unitCost', 'Unit cost', true), decimal('discountAmount', 'Discount amount', true, { default: '0.00' }), decimal('taxRatePercent', 'Tax rate percent', true, { default: '0.0000' })] },
  { label: 'Submit', path: ({ branchId, item }) => `${branchBase({ branchId })}/purchase-orders/${item.purchaseOrderId}/submit`, statuses: ['DRAFT'], confirm: () => 'Submit this purchase order? Draft line editing will end.' },
  { label: 'Approve', path: ({ branchId, item }) => `${branchBase({ branchId })}/purchase-orders/${item.purchaseOrderId}/approve`, statuses: ['SUBMITTED'], confirm: () => 'Approve this submitted purchase order?' },
  { label: 'Cancel', path: ({ branchId, item }) => `${branchBase({ branchId })}/purchase-orders/${item.purchaseOrderId}/cancel`, statuses: ['DRAFT', 'SUBMITTED', 'APPROVED'], fields: [notes('reason', 'Cancellation reason')], confirm: () => 'Cancel this purchase order? Existing transaction evidence will be retained.', tone: 'danger' },
] };

export const goodsReceiptConfig = { key: 'goods-receipts', title: 'Goods receipts', singular: 'goods receipt', description: 'Record accepted and rejected deliveries, then post received stock.', branch: true, listPath: ({ branchId }) => `${branchBase({ branchId })}/goods-receipts`, detailPath: ({ branchId, item }) => `${branchBase({ branchId })}/goods-receipts/${item.goodsReceiptId}`, readPermission: 'receiving.read', managePermission: 'receiving.manage', columns: [{ key: 'goodsReceiptNumber', label: 'Receipt' }, { key: 'purchaseOrderNumber', label: 'Order' }, { key: 'supplierName' }, { key: 'receivedAt' }, { key: 'status', status: true }], filters: [{ name: 'status', label: 'Status', options: ['DRAFT', 'POSTED', 'CANCELLED'] }], createFields: [text('purchaseOrderId', 'Purchase order ID', true), text('supplierDeliveryNote', 'Delivery note', false, { nullable: true }), text('supplierInvoiceNumber', 'Supplier invoice', false, { nullable: true }), notes()], updateFields: [text('supplierDeliveryNote', 'Delivery note', false, { nullable: true }), text('supplierInvoiceNumber', 'Supplier invoice', false, { nullable: true }), notes()], actions: [
  { label: 'Add item', path: ({ branchId, item }) => `${branchBase({ branchId })}/goods-receipts/${item.goodsReceiptId}/items`, statuses: ['DRAFT'], fields: [text('purchaseOrderItemId', 'Purchase order item ID', true), decimal('packageQuantityAccepted', 'Accepted package quantity', true), decimal('packageQuantityRejected', 'Rejected package quantity', true), decimal('actualUnitCost', 'Actual unit cost', true), decimal('discountAmount', 'Discount amount', true, { default: '0.00' }), decimal('taxAmount', 'Tax amount', true, { default: '0.00' })] },
  { label: 'Post', path: ({ branchId, item }) => `${branchBase({ branchId })}/goods-receipts/${item.goodsReceiptId}/post`, statuses: ['DRAFT'], confirm: () => 'Post this goods receipt? Accepted quantities will update stock and movement history. Lot-tracked items require allocations.', tone: 'danger' },
  { label: 'Cancel', path: ({ branchId, item }) => `${branchBase({ branchId })}/goods-receipts/${item.goodsReceiptId}/cancel`, statuses: ['DRAFT'], confirm: () => 'Cancel this draft goods receipt?', tone: 'danger' },
] };

export const adjustmentConfig = { key: 'adjustments', title: 'Inventory adjustments', singular: 'adjustment', description: 'Correct stock through reviewed, auditable adjustment documents.', branch: true, listPath: ({ branchId }) => `${branchBase({ branchId })}/inventory-adjustments`, detailPath: ({ branchId, item }) => `${branchBase({ branchId })}/inventory-adjustments/${item.inventoryAdjustmentId}`, readPermission: 'inventory_adjustments.read', managePermission: 'inventory_adjustments.manage', columns: [{ key: 'adjustmentNumber' }, { key: 'adjustmentType' }, { key: 'reason' }, { key: 'createdAt' }, { key: 'status', status: true }], filters: [{ name: 'status', label: 'Status', options: ['DRAFT', 'APPROVED', 'POSTED', 'CANCELLED'] }], createFields: [select('adjustmentType', 'Adjustment type', ['COUNT_CORRECTION', 'DAMAGE', 'EXPIRY', 'THEFT', 'SUPPLIER_RETURN', 'OTHER'], true), text('reason', 'Reason', true, { full: true })], actions: [
  { label: 'Add item', path: ({ branchId, item }) => `${branchBase({ branchId })}/inventory-adjustments/${item.inventoryAdjustmentId}/items`, statuses: ['DRAFT'], fields: [text('productVariantId', 'Variant ID', true), decimal('quantityChange', 'Signed quantity change', true), decimal('unitCost', 'Unit cost', false, { nullable: true }), text('reason', 'Item reason', false, { nullable: true })] },
  { label: 'Approve', path: ({ branchId, item }) => `${branchBase({ branchId })}/inventory-adjustments/${item.inventoryAdjustmentId}/approve`, statuses: ['DRAFT'], confirm: () => 'Approve this adjustment for posting?' },
  { label: 'Post', path: ({ branchId, item }) => `${branchBase({ branchId })}/inventory-adjustments/${item.inventoryAdjustmentId}/post`, statuses: ['APPROVED'], confirm: () => 'Post this approved adjustment? Current stock and movement history will be updated together.', tone: 'danger' },
  { label: 'Cancel', path: ({ branchId, item }) => `${branchBase({ branchId })}/inventory-adjustments/${item.inventoryAdjustmentId}/cancel`, statuses: ['DRAFT', 'APPROVED'], confirm: () => 'Cancel this adjustment document?', tone: 'danger' },
] };
adjustmentConfig.updateFields = adjustmentConfig.createFields;

export const countConfig = { key: 'counts', title: 'Physical stock counts', singular: 'stock count', description: 'Capture expected and counted quantities before approved variance posting.', branch: true, listPath: ({ branchId }) => `${branchBase({ branchId })}/stock-counts`, detailPath: ({ branchId, item }) => `${branchBase({ branchId })}/stock-counts/${item.stockCountId}`, readPermission: 'stock_counts.read', managePermission: 'stock_counts.manage', columns: [{ key: 'countNumber' }, { key: 'countType' }, { key: 'countedAt' }, { key: 'createdAt' }, { key: 'status', status: true }], filters: [{ name: 'status', label: 'Status', options: ['DRAFT', 'IN_PROGRESS', 'COUNTED', 'APPROVED', 'POSTED', 'CANCELLED'] }], createFields: [select('countType', 'Count type', ['FULL', 'CYCLE', 'SPOT'], true), notes()], actions: [
  { label: 'Add item', path: ({ branchId, item }) => `${branchBase({ branchId })}/stock-counts/${item.stockCountId}/items`, statuses: ['DRAFT'], fields: [text('productVariantId', 'Variant ID', true), text('inventoryLotId', 'Inventory lot ID', false, { nullable: true }), notes()] },
  { label: 'Add participant', path: ({ branchId, item }) => `${branchBase({ branchId })}/stock-counts/${item.stockCountId}/participants`, statuses: ['DRAFT', 'IN_PROGRESS'], fields: [text('employeeId', 'Employee ID', true), select('participantRole', 'Role', ['COUNTER', 'SUPERVISOR', 'OBSERVER'], true)] },
  { label: 'Start', path: ({ branchId, item }) => `${branchBase({ branchId })}/stock-counts/${item.stockCountId}/start`, statuses: ['DRAFT'], confirm: () => 'Start this count? Expected quantities and inventory versions will be captured.' },
  { label: 'Complete count', path: ({ branchId, item }) => `${branchBase({ branchId })}/stock-counts/${item.stockCountId}/complete`, statuses: ['IN_PROGRESS'], confirm: () => 'Mark counting complete? Every count line must have a physical quantity.' },
  { label: 'Post', path: ({ branchId, item }) => `${branchBase({ branchId })}/stock-counts/${item.stockCountId}/post`, statuses: ['COUNTED'], confirm: () => 'Approve and post this stock count? Stale inventory versions will be rejected.', tone: 'danger' },
  { label: 'Cancel', path: ({ branchId, item }) => `${branchBase({ branchId })}/stock-counts/${item.stockCountId}/cancel`, statuses: ['DRAFT', 'IN_PROGRESS', 'COUNTED', 'APPROVED'], confirm: () => 'Cancel this stock count?', tone: 'danger' },
] };
countConfig.updateFields = countConfig.createFields;

export const transferConfig = { key: 'transfers', title: 'Stock transfers', singular: 'stock transfer', description: 'Move stock between branches through request, dispatch, and receipt.', branch: true, listPath: ({ branchId }) => `${branchBase({ branchId })}/stock-transfers`, detailPath: ({ branchId, item }) => `${branchBase({ branchId })}/stock-transfers/${item.stockTransferId}`, readPermission: 'stock_transfers.read', managePermission: 'stock_transfers.manage', columns: [{ key: 'transferNumber' }, { key: 'sourceBranchName' }, { key: 'destinationBranchName' }, { key: 'requestedAt' }, { key: 'status', status: true }], filters: [{ name: 'status', label: 'Status', options: ['DRAFT', 'REQUESTED', 'APPROVED', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED'] }], createFields: [destinationBranchChoice, notes()], actions: [
  { label: 'Add item', path: ({ branchId, item }) => `${branchBase({ branchId })}/stock-transfers/${item.stockTransferId}/items`, statuses: ['DRAFT'], fields: [text('productVariantId', 'Variant ID', true), decimal('quantityRequested', 'Quantity requested', true), notes()] },
  { label: 'Request', path: ({ branchId, item }) => `${branchBase({ branchId })}/stock-transfers/${item.stockTransferId}/request`, statuses: ['DRAFT'], confirm: () => 'Submit this transfer request to the destination branch?' },
  { label: 'Approve', path: ({ branchId, item }) => `${branchBase({ branchId })}/stock-transfers/${item.stockTransferId}/approve`, statuses: ['REQUESTED'], confirm: () => 'Approve this transfer at the destination branch?' },
  { label: 'Dispatch', path: ({ branchId, item }) => `${branchBase({ branchId })}/stock-transfers/${item.stockTransferId}/dispatch`, statuses: ['APPROVED'], confirm: () => 'Dispatch this transfer? The quantities will leave source stock.', tone: 'danger' },
  { label: 'Receive', path: ({ branchId, item }) => `${branchBase({ branchId })}/stock-transfers/${item.stockTransferId}/receive`, statuses: ['IN_TRANSIT'], confirm: () => 'Receive this transfer? The accepted quantities will enter destination stock.', tone: 'danger' },
  { label: 'Cancel', path: ({ branchId, item }) => `${branchBase({ branchId })}/stock-transfers/${item.stockTransferId}/cancel`, statuses: ['DRAFT', 'REQUESTED', 'APPROVED'], confirm: () => 'Cancel this transfer?', tone: 'danger' },
] };
transferConfig.updateFields = transferConfig.createFields;

export const saleConfig = { key: 'sales', title: 'Sales & checkout', singular: 'sale', description: 'Create sales, collect payments, and complete checkout for the selected branch.', branch: true, listPath: ({ branchId }) => `${branchBase({ branchId })}/sales`, createPath: ({ branchId, context }) => `${branchBase({ branchId })}/till-sessions/${encodeURIComponent(context.tillSessionId)}/sales`, detailPath: ({ branchId, item }) => `${branchBase({ branchId })}/sales/${item.saleId}`, readPermission: 'sales.read', managePermission: 'sales.manage', columns: [{ key: 'saleNumber' }, { key: 'soldAt' }, { key: 'customerName' }, { key: 'cashierName' }, { key: 'totalAmount' }, { key: 'status', status: true }], filters: [{ name: 'status', label: 'Status', options: ['OPEN', 'COMPLETED', 'CANCELLED', 'VOIDED'] }], createFields: [text('customerId', 'Customer ID', false, { nullable: true }), notes()], updateFields: [text('customerId', 'Customer ID', false, { nullable: true }), notes()], actions: [
  { label: 'Add item', path: ({ branchId, item }) => `${branchBase({ branchId })}/sales/${item.saleId}/items`, statuses: ['OPEN'], fields: [text('barcode', 'Barcode', false, { help: 'Use barcode, or leave blank and supply a variant ID.' }), text('productVariantId', 'Variant ID'), text('productPackageId', 'Package ID'), decimal('quantity', 'Quantity', true), decimal('discountAmount', 'Discount amount', true, { default: '0.00' })] },
  { label: 'Add payment', permission: 'payments.manage', path: ({ branchId, item }) => `${branchBase({ branchId })}/sales/${item.saleId}/payments`, statuses: ['OPEN'], fields: [text('paymentMethodId', 'Payment method ID', true), decimal('amount', 'Amount', true), text('externalReference', 'External reference', false, { nullable: true }), notes()] },
  { label: 'Complete sale', path: ({ branchId, item }) => `${branchBase({ branchId })}/sales/${item.saleId}/complete`, statuses: ['OPEN'], confirm: () => 'Complete this sale? Payments, totals, and stock movements will be finalized.', tone: 'danger' },
  { label: 'Cancel sale', path: ({ branchId, item }) => `${branchBase({ branchId })}/sales/${item.saleId}/cancel`, statuses: ['OPEN'], confirm: () => 'Cancel this open sale?', tone: 'danger' },
] };

export const returnConfig = { key: 'returns', title: 'Sales returns & refunds', singular: 'sales return', description: 'Manage merchandise entitlement separately from actual refund settlement.', branch: true, listPath: ({ branchId, context }) => `${branchBase({ branchId })}/sales/${encodeURIComponent(context.saleId)}/returns`, detailPath: ({ branchId, context, item }) => `${branchBase({ branchId })}/sales/${context.saleId}/returns/${item.salesReturnId}`, readPermission: 'returns.read', managePermission: 'returns.manage', columns: [{ key: 'returnNumber' }, { key: 'returnedAt' }, { key: 'refundTotalAmount', label: 'Return entitlement' }, { key: 'completedRefundAmount', label: 'Settled refund' }, { key: 'status', status: true }], search: false, createFields: [notes()], update: false, actions: [
  { label: 'Add returned item', path: ({ branchId, context, item }) => `${branchBase({ branchId })}/sales/${context.saleId}/returns/${item.salesReturnId}/items`, statuses: ['DRAFT'], fields: [text('originalSaleItemId', 'Original sale item ID', true), text('returnReasonId', 'Return reason ID', true), decimal('quantityReturned', 'Quantity returned', true), select('itemCondition', 'Item condition', ['UNOPENED', 'OPENED', 'DAMAGED', 'EXPIRED', 'DEFECTIVE', 'OTHER'], true), checkbox('isRestockable', 'Restockable'), notes()] },
  { label: 'Submit', path: ({ branchId, context, item }) => `${branchBase({ branchId })}/sales/${context.saleId}/returns/${item.salesReturnId}/submit`, statuses: ['DRAFT'], confirm: () => 'Submit this return for approval?' },
  { label: 'Approve', path: ({ branchId, context, item }) => `${branchBase({ branchId })}/sales/${context.saleId}/returns/${item.salesReturnId}/approve`, statuses: ['PENDING_APPROVAL'], confirm: () => 'Approve this merchandise return entitlement?' },
  { label: 'Complete return', path: ({ branchId, context, item }) => `${branchBase({ branchId })}/sales/${context.saleId}/returns/${item.salesReturnId}/complete`, statuses: ['APPROVED'], confirm: () => 'Complete this return? Restockable inventory movements will be posted, but this does not itself prove money was refunded.', tone: 'danger' },
  { label: 'Create refund', path: ({ branchId, context, item }) => `${branchBase({ branchId })}/sales/${context.saleId}/returns/${item.salesReturnId}/refunds`, statuses: ['COMPLETED'], fields: [text('paymentMethodId', 'Payment method ID', true), decimal('amount', 'Refund amount', true), text('externalReference', 'External reference', false, { nullable: true }), notes()] },
  { label: 'Cancel return', path: ({ branchId, context, item }) => `${branchBase({ branchId })}/sales/${context.saleId}/returns/${item.salesReturnId}/cancel`, statuses: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'], confirm: () => 'Cancel this return?', tone: 'danger' },
] };



for (const action of employeeConfig.actions) action.statusKey = 'employmentStatus';
employeeConfig.actions.push(
  {
    label: 'End assignment',
    statusKey: 'employmentStatus',
    method: 'post',
    path: ({ item, context }) => `/api/admin/employees/${encodeURIComponent(item.employeeId)}/assignments/${encodeURIComponent(context.body.employeeBranchAssignmentId)}/end`,
    statuses: ['ACTIVE', 'ON_LEAVE'],
    prepare: (options) => prepareEmployeeAssignmentAction(options, resolveEndAssignment),
    fields: ({ prepared }) => [
      ...(prepared.requiresSelection
        ? [select(
          'employeeBranchAssignmentId',
          'Active assignment',
          prepared.assignments.map(assignmentOption),
          true,
          { placeholder: 'Select an active assignment' },
        )]
        : []),
      { name: 'endedOn', label: 'Ended on', type: 'date', required: true },
    ],
    pathValues: ({ prepared }) => endAssignmentPathValues(prepared),
    summary: ({ prepared }) => endAssignmentSummary(prepared),
    refreshOnFailure: true,
    confirm: () => 'End this branch assignment on the selected date?',
  },
  {
    label: 'Make primary',
    statusKey: 'employmentStatus',
    method: 'post',
    path: ({ item, context }) => `/api/admin/employees/${encodeURIComponent(item.employeeId)}/assignments/${encodeURIComponent(context.body.employeeBranchAssignmentId)}/make-primary`,
    statuses: ['ACTIVE', 'ON_LEAVE'],
    prepare: (options) => prepareEmployeeAssignmentAction(options, resolveMakePrimaryAssignment),
    fields: ({ prepared }) => (prepared.requiresSelection
      ? [select(
        'employeeBranchAssignmentId',
        'Active assignment',
        prepared.assignments.map(assignmentOption),
        true,
        {
          placeholder: 'Select an active assignment',
          transform: (value, { prepared: current }) => validateMakePrimarySelection(value, current),
        },
      )]
      : []),
    pathValues: ({ prepared }) => makePrimaryPathValues(prepared),
    summary: ({ prepared }) => makePrimarySummary(prepared),
    refreshOnFailure: true,
    resetOnFailure: true,
    confirm: () => 'Make this the employee’s primary current assignment?',
  },
);
userConfig.actions.push({ label:'Revoke role', permission:'user_roles.manage', method:'delete', path:({ item, context })=>`/api/admin/users/${item.userId}/roles/${context.body.userRoleId}`, fields:[text('userRoleId','User role grant ID',true)], confirm:()=> 'Revoke this exact global or branch-scoped role grant?', tone:'danger' });
barcodeConfig.actions = [{ label:'Delete barcode', method:'delete', path:({ item })=>`/api/admin/catalog/barcodes/${item.barcodeId}`, confirm:(item)=>`Delete barcode ${item.barcode}? This cannot remove transaction history.`, tone:'danger' }];
variantPriceConfig.actions = [{ label:'Resolve effective', permission:'pricing.read', method:'get', path:({ branchId,item })=>`${branchBase({branchId})}/prices/effective/variants/${item.productVariantId??item.variantId}`, displayResponse:true, responseTitle:'Effective variant price' }];
packagePriceConfig.actions = [{ label:'Resolve effective', permission:'pricing.read', method:'get', path:({ branchId,item })=>`${branchBase({branchId})}/prices/effective/packages/${item.productPackageId??item.packageId}`, displayResponse:true, responseTitle:'Effective package price' }];

const jsonArray = (name,label,help) => ({ name,label,type:'textarea',required:true,default:'[]',full:true,help,transform:(value)=>JSON.parse(value) });
const receiptPost = goodsReceiptConfig.actions.find((action)=>action.label==='Post');
receiptPost.fields=[jsonArray('lotAllocations','Lot allocations (JSON)','Use [] when no receipt item requires lot allocation; otherwise follow the exact receipt item / lots API shape.')];
const adjustmentItem = adjustmentConfig.actions.find((action)=>action.label==='Add item');
adjustmentItem.fields.push({name:'lotAllocations',label:'Lot allocations (JSON)',type:'textarea',default:'[]',full:true,transform:(value)=>JSON.parse(value)});
countConfig.actions.splice(2,0,{label:'Record count',method:'patch',path:({branchId,item,context})=>`${branchBase({branchId})}/stock-counts/${item.stockCountId}/items/${context.body.stockCountItemId}`,statuses:['IN_PROGRESS'],fields:[text('stockCountItemId','Stock count item ID',true),decimal('countedQuantity','Physically counted quantity',true),text('varianceReason','Variance reason',false,{nullable:true}),notes()]});
const transferAdd = transferConfig.actions.find((action)=>action.label==='Add item');
transferAdd.fields.push({name:'lotAllocations',label:'Requested lot allocations (JSON)',type:'textarea',default:'[]',full:true,transform:(value)=>JSON.parse(value)});
for (const label of ['Dispatch','Receive']) { const action=transferConfig.actions.find((entry)=>entry.label===label); action.fields=[jsonArray('items',`${label} item quantities (JSON)`,'Supply each transfer item ID, exact quantity, and any lot allocations required by the API.')]; }

export const supplierPackageConfig = { key:'supplier-packages',title:'Supplier packages',singular:'supplier package',description:'Map supplier ordering records to normalized product packages.',listPath:({context})=>`/api/admin/suppliers/${context.supplierId}/products/${context.supplierProductId}/packages`,detailPath:({context,item})=>`/api/admin/suppliers/${context.supplierId}/product-packages/${item.supplierProductPackageId}`,readPermission:'suppliers.read',managePermission:'suppliers.manage',columns:[{key:'packageCode'},{key:'packageName'},{key:'supplierPackageSku'},{key:'minimumPackageQuantity'},{key:'isActive'}],createFields:[text('productPackageId','Product package ID',true),text('supplierPackageSku','Supplier package SKU',false,{nullable:true}),decimal('minimumPackageQuantity','Minimum package quantity',true,{default:'1.000'}),checkbox('isActive','Active',true)],updateFields:[text('supplierPackageSku','Supplier package SKU',false,{nullable:true}),decimal('minimumPackageQuantity','Minimum package quantity',true),checkbox('isActive','Active',true)]};

export const salePaymentConfig = { key:'sale-payments',title:'Payment attempts',singular:'payment attempt',description:'Review tender attempts separately from completed settlement.',branch:true,listPath:({branchId,context})=>`${branchBase({branchId})}/sales/${context.saleId}/payments`,detailPath:({branchId,context,item})=>`${branchBase({branchId})}/sales/${context.saleId}/payments/${item.salePaymentId}`,readPermission:'payments.read',managePermission:'payments.manage',createPath:({branchId,context})=>`${branchBase({branchId})}/sales/${context.saleId}/payments`,columns:[{key:'salePaymentId',label:'Attempt ID'},{key:'methodName'},{key:'paymentType'},{key:'amount'},{key:'externalReference'},{key:'status',status:true}],search:false,createFields:[text('paymentMethodId','Payment method ID',true),decimal('amount','Amount',true),text('externalReference','External reference',false,{nullable:true}),notes()],update:false,actions:[{label:'Complete',path:({branchId,context,item})=>`${branchBase({branchId})}/sales/${context.saleId}/payments/${item.salePaymentId}/complete`,statuses:['PENDING'],confirm:()=> 'Complete this payment attempt? The server will enforce the remaining tender cap.'},{label:'Fail',path:({branchId,context,item})=>`${branchBase({branchId})}/sales/${context.saleId}/payments/${item.salePaymentId}/fail`,statuses:['PENDING'],confirm:()=> 'Mark this payment attempt as failed?',tone:'danger'},{label:'Cancel',path:({branchId,context,item})=>`${branchBase({branchId})}/sales/${context.saleId}/payments/${item.salePaymentId}/cancel`,statuses:['PENDING'],confirm:()=> 'Cancel this pending payment attempt?',tone:'danger'}]};

export const refundConfig = { key:'refunds',title:'Refund attempts',singular:'refund attempt',description:'Settle approved return entitlement through explicit refund attempts.',branch:true,listPath:({branchId,context})=>`${branchBase({branchId})}/sales/${context.saleId}/returns/${context.salesReturnId}/refunds`,detailPath:false,readPermission:'returns.read',managePermission:'returns.manage',createPath:({branchId,context})=>`${branchBase({branchId})}/sales/${context.saleId}/returns/${context.salesReturnId}/refunds`,columns:[{key:'salePaymentId',label:'Refund attempt ID'},{key:'methodName'},{key:'amount'},{key:'externalReference'},{key:'status',status:true}],search:false,createFields:[text('paymentMethodId','Payment method ID',true),decimal('amount','Refund amount',true),text('externalReference','External reference',false,{nullable:true}),notes()],update:false,actions:[{label:'Complete refund',path:({branchId,context,item})=>`${branchBase({branchId})}/sales/${context.saleId}/returns/${context.salesReturnId}/refunds/${item.salePaymentId}/complete`,statuses:['PENDING'],confirm:()=> 'Complete this refund settlement? Cash refunds remain constrained to the original sale till.',tone:'danger'},{label:'Fail refund',path:({branchId,context,item})=>`${branchBase({branchId})}/sales/${context.saleId}/returns/${context.salesReturnId}/refunds/${item.salePaymentId}/fail`,statuses:['PENDING'],confirm:()=> 'Mark this refund attempt as failed?',tone:'danger'},{label:'Cancel refund',path:({branchId,context,item})=>`${branchBase({branchId})}/sales/${context.saleId}/returns/${context.salesReturnId}/refunds/${item.salePaymentId}/cancel`,statuses:['PENDING'],confirm:()=> 'Cancel this pending refund attempt?',tone:'danger'}]};



purchaseOrderConfig.actions.splice(1,0,
  { label:'Update item', method:'patch', path:({branchId,item,context})=>`${branchBase({branchId})}/purchase-orders/${item.purchaseOrderId}/items/${context.body.purchaseOrderItemId}`, statuses:['DRAFT'], fields:[text('purchaseOrderItemId','Purchase order item ID',true),decimal('orderedPackageQuantity','Package quantity',true),decimal('unitCost','Unit cost',true),decimal('discountAmount','Discount amount',true),decimal('taxRatePercent','Tax rate percent',true)] },
  { label:'Delete item', method:'delete', path:({branchId,item,context})=>`${branchBase({branchId})}/purchase-orders/${item.purchaseOrderId}/items/${context.body.purchaseOrderItemId}`, statuses:['DRAFT'], fields:[text('purchaseOrderItemId','Purchase order item ID',true)], confirm:()=> 'Delete this draft purchase-order line?', tone:'danger' },
);
goodsReceiptConfig.actions.splice(1,0,
  { label:'Update item', method:'patch', path:({branchId,item,context})=>`${branchBase({branchId})}/goods-receipts/${item.goodsReceiptId}/items/${context.body.goodsReceiptItemId}`, statuses:['DRAFT'], fields:[text('goodsReceiptItemId','Goods receipt item ID',true),decimal('packageQuantityAccepted','Accepted package quantity',true),decimal('packageQuantityRejected','Rejected package quantity',true),decimal('actualUnitCost','Actual unit cost',true),decimal('discountAmount','Discount amount',true),decimal('taxAmount','Tax amount',true)] },
  { label:'Delete item', method:'delete', path:({branchId,item,context})=>`${branchBase({branchId})}/goods-receipts/${item.goodsReceiptId}/items/${context.body.goodsReceiptItemId}`, statuses:['DRAFT'], fields:[text('goodsReceiptItemId','Goods receipt item ID',true)], confirm:()=> 'Delete this draft receipt line?', tone:'danger' },
);
adjustmentConfig.actions.splice(1,0,
  { label:'Update item', method:'patch', path:({branchId,item,context})=>`${branchBase({branchId})}/inventory-adjustments/${item.inventoryAdjustmentId}/items/${context.body.inventoryAdjustmentItemId}`, statuses:['DRAFT'], fields:[text('inventoryAdjustmentItemId','Adjustment item ID',true),decimal('quantityChange','Signed quantity change',true),decimal('unitCost','Unit cost',false,{nullable:true}),text('reason','Item reason',false,{nullable:true}),{name:'lotAllocations',label:'Lot allocations (JSON)',type:'textarea',default:'[]',full:true,transform:(value)=>JSON.parse(value)}] },
  { label:'Delete item', method:'delete', path:({branchId,item,context})=>`${branchBase({branchId})}/inventory-adjustments/${item.inventoryAdjustmentId}/items/${context.body.inventoryAdjustmentItemId}`, statuses:['DRAFT'], fields:[text('inventoryAdjustmentItemId','Adjustment item ID',true)], confirm:()=> 'Delete this draft adjustment item?', tone:'danger' },
);
adjustmentConfig.actions.push({label:'View ledger',permission:'inventory_adjustments.read',method:'get',path:({branchId,item})=>`${branchBase({branchId})}/inventory-adjustments/${item.inventoryAdjustmentId}/ledger`,statuses:['POSTED'],displayResponse:true,responseTitle:'Adjustment ledger'});
countConfig.actions.splice(2,0,{label:'Remove participant',method:'delete',path:({branchId,item,context})=>`${branchBase({branchId})}/stock-counts/${item.stockCountId}/participants/${context.body.employeeId}`,statuses:['DRAFT','IN_PROGRESS'],fields:[text('employeeId','Participant employee ID',true)],confirm:()=> 'Remove this participant from the count?',tone:'danger'},{label:'Delete count item',method:'delete',path:({branchId,item,context})=>`${branchBase({branchId})}/stock-counts/${item.stockCountId}/items/${context.body.stockCountItemId}`,statuses:['DRAFT'],fields:[text('stockCountItemId','Stock count item ID',true)],confirm:()=> 'Delete this draft count line?',tone:'danger'});
countConfig.actions.push({label:'View variance',permission:'stock_counts.read',method:'get',path:({branchId,item})=>`${branchBase({branchId})}/stock-counts/${item.stockCountId}/variance`,statuses:['COUNTED','APPROVED','POSTED'],displayResponse:true,responseTitle:'Count variance'},{label:'View ledger',permission:'stock_counts.read',method:'get',path:({branchId,item})=>`${branchBase({branchId})}/stock-counts/${item.stockCountId}/ledger`,statuses:['POSTED'],displayResponse:true,responseTitle:'Count ledger'});
transferConfig.actions.splice(1,0,{label:'Update item',method:'patch',path:({branchId,item,context})=>`${branchBase({branchId})}/stock-transfers/${item.stockTransferId}/items/${context.body.stockTransferItemId}`,statuses:['DRAFT'],fields:[text('stockTransferItemId','Transfer item ID',true),decimal('quantityRequested','Quantity requested',true),notes(),{name:'lotAllocations',label:'Requested lot allocations (JSON)',type:'textarea',default:'[]',full:true,transform:(value)=>JSON.parse(value)}]},{label:'Delete item',method:'delete',path:({branchId,item,context})=>`${branchBase({branchId})}/stock-transfers/${item.stockTransferId}/items/${context.body.stockTransferItemId}`,statuses:['DRAFT'],fields:[text('stockTransferItemId','Transfer item ID',true)],confirm:()=> 'Delete this draft transfer item?',tone:'danger'});
tillConfig.actions.unshift({label:'View cash movements',permission:'till_sessions.read',method:'get',path:({branchId,item})=>`${branchBase({branchId})}/till-sessions/${item.tillSessionId}/cash-movements`,displayResponse:true,responseTitle:'Till cash movements'});
saleConfig.actions.splice(1,0,{label:'Update item',method:'patch',path:({branchId,item,context})=>`${branchBase({branchId})}/sales/${item.saleId}/items/${context.body.saleItemId}`,statuses:['OPEN'],fields:[text('saleItemId','Sale item ID',true),decimal('quantity','Quantity',true),decimal('discountAmount','Discount amount',true)]},{label:'Delete item',method:'delete',path:({branchId,item,context})=>`${branchBase({branchId})}/sales/${item.saleId}/items/${context.body.saleItemId}`,statuses:['OPEN'],fields:[text('saleItemId','Sale item ID',true)],confirm:()=> 'Remove this item from the open sale? The server will return recalculated totals.',tone:'danger'});
returnConfig.actions.splice(1,0,{label:'Update returned item',method:'patch',path:({branchId,item,context})=>`${branchBase({branchId})}/sales/${context.saleId}/returns/${item.salesReturnId}/items/${context.body.salesReturnItemId}`,statuses:['DRAFT'],fields:[text('salesReturnItemId','Return item ID',true),text('returnReasonId','Return reason ID',true),decimal('quantityReturned','Quantity returned',true),select('itemCondition','Item condition',['UNOPENED','OPENED','DAMAGED','EXPIRED','DEFECTIVE','OTHER'],true),checkbox('isRestockable','Restockable'),notes()]},{label:'Delete returned item',method:'delete',path:({branchId,item,context})=>`${branchBase({branchId})}/sales/${context.saleId}/returns/${item.salesReturnId}/items/${context.body.salesReturnItemId}`,statuses:['DRAFT'],fields:[text('salesReturnItemId','Return item ID',true)],confirm:()=> 'Delete this draft return item?',tone:'danger'});



function markPathOnly(config, label, fields) { const action=config.actions.find((entry)=>entry.label===label); if(action)action.pathOnly=fields; }
markPathOnly(employeeConfig,'End assignment',['employeeBranchAssignmentId']);
markPathOnly(employeeConfig,'Make primary',['employeeBranchAssignmentId']);
markPathOnly(userConfig,'Revoke role',['userRoleId']);
markPathOnly(purchaseOrderConfig,'Update item',['purchaseOrderItemId']);
markPathOnly(purchaseOrderConfig,'Delete item',['purchaseOrderItemId']);
markPathOnly(goodsReceiptConfig,'Update item',['goodsReceiptItemId']);
markPathOnly(goodsReceiptConfig,'Delete item',['goodsReceiptItemId']);
markPathOnly(adjustmentConfig,'Update item',['inventoryAdjustmentItemId']);
markPathOnly(adjustmentConfig,'Delete item',['inventoryAdjustmentItemId']);
markPathOnly(countConfig,'Record count',['stockCountItemId']);
markPathOnly(countConfig,'Remove participant',['employeeId']);
markPathOnly(countConfig,'Delete count item',['stockCountItemId']);
markPathOnly(transferConfig,'Update item',['stockTransferItemId']);
markPathOnly(transferConfig,'Delete item',['stockTransferItemId']);
markPathOnly(saleConfig,'Update item',['saleItemId']);
markPathOnly(saleConfig,'Delete item',['saleItemId']);
markPathOnly(returnConfig,'Update returned item',['salesReturnItemId']);
markPathOnly(returnConfig,'Delete returned item',['salesReturnItemId']);

for (const [config, key] of [
  [branchConfig, 'branch'],
  [employeeConfig, 'employee'],
  [userConfig, 'user'],
  [roleConfig, 'role'],
  [productConfig, 'product'],
  [variantConfig, 'productVariant'],
  [packageConfig, 'productPackage'],
  [barcodeConfig, 'productBarcode'],
  [customerConfig, 'customer'],
  [supplierConfig, 'supplier'],
  [supplierProductConfig, 'supplierProduct'],
  [supplierPackageConfig, 'supplierProductPackage'],
  [variantPriceConfig, 'branchVariantPrice'],
  [packagePriceConfig, 'branchPackagePrice'],
  [posRegisterConfig, 'posRegister'],
  [paymentMethodConfig, 'paymentMethod'],
  [saleConfig, 'sale'],
  [returnConfig, 'salesReturn'],
  [salePaymentConfig, 'payment'],
]) {
  config.detailKey = key;
  config.editKey = key;
}
for (const [config, key] of [
  [inventoryConfig, 'branchInventory'],
  [purchaseOrderConfig, 'purchaseOrder'],
  [goodsReceiptConfig, 'goodsReceipt'],
  [adjustmentConfig, 'adjustment'],
  [countConfig, 'stockCount'],
  [transferConfig, 'stockTransfer'],
]) {
  config.detailKey = false;
  config.editKey = key;
}
for (const [config, key] of [
  [catalogConfigs.find((entry) => entry.key === 'units'), 'unit'],
  [catalogConfigs.find((entry) => entry.key === 'categories'), 'category'],
  [catalogConfigs.find((entry) => entry.key === 'brands'), 'brand'],
  [catalogConfigs.find((entry) => entry.key === 'tax-rates'), 'taxRate'],
]) {
  config.detailKey = key;
  config.editKey = key;
}

employeeConfig.updateStatusKey = 'employmentStatus';
employeeConfig.updateStatuses = ['ACTIVE', 'ON_LEAVE'];
purchaseOrderConfig.updateStatuses = ['DRAFT'];
goodsReceiptConfig.updateStatuses = ['DRAFT'];
adjustmentConfig.updateStatuses = ['DRAFT'];
countConfig.updateStatuses = ['DRAFT'];
transferConfig.updateStatuses = ['DRAFT'];
saleConfig.updateStatuses = ['OPEN'];

const selectedBranchIsTransferSource = ({ item, branchId }) =>
  String(item.sourceBranchId) === String(branchId);
const selectedBranchIsTransferDestination = ({ item, branchId }) =>
  String(item.destinationBranchId) === String(branchId);
transferConfig.updateVisible = selectedBranchIsTransferSource;
for (const action of transferConfig.actions) {
  action.visible = action.label === 'Receive'
    ? selectedBranchIsTransferDestination
    : selectedBranchIsTransferSource;
}

export { active, branchBase, checkbox, decimal, notes, select, status, text };
