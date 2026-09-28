const ACCESS_CONTROL_PERMISSIONS = Object.freeze(
  [
    {
      code: 'branches.read',
      name: 'View branches',
      description: 'View branch records and branch details.',
    },
    {
      code: 'branches.manage',
      name: 'Manage branches',
      description:
        'Create branches and update branch details and operating status.',
    },
    {
      code: 'employees.read',
      name: 'View employees',
      description: 'View employee records and branch assignment history.',
    },
    {
      code: 'employees.manage',
      name: 'Manage employees',
      description:
        'Create and update employees, manage branch assignments, and terminate employment.',
    },
    {
      code: 'users.read',
      name: 'View user accounts',
      description:
        'View internal user accounts and their access configuration.',
    },
    {
      code: 'users.manage',
      name: 'Manage user accounts',
      description:
        'Provision and update internal user accounts and perform administrative password resets.',
    },
    {
      code: 'roles.read',
      name: 'View roles',
      description: 'View roles and their assigned application permissions.',
    },
    {
      code: 'roles.manage',
      name: 'Manage roles',
      description:
        'Create, update, and deactivate roles and replace their permission sets.',
    },
    {
      code: 'permissions.read',
      name: 'View permissions',
      description: 'View the application-defined permission catalog.',
    },
    {
      code: 'user_roles.manage',
      name: 'Manage user role grants',
      description:
        'Assign and revoke global or branch-scoped role grants for users.',
    },
    {
      code: 'catalog.read',
      name: 'Read Catalog',
      description: 'View shared reference catalog configuration.',
    },
    {
      code: 'catalog.manage',
      name: 'Manage Catalog',
      description: 'Create and update shared reference catalog configuration.',
    },
    {
      code: 'products.read',
      name: 'Read Products',
      description: 'View products, variants, packages, and barcodes.',
    },
    {
      code: 'products.manage',
      name: 'Manage Products',
      description: 'Create and update products, variants, packages, and barcodes.',
    },
    {
      code: 'pricing.read',
      name: 'Read Pricing',
      description: 'View branch pricing configuration.',
    },
    {
      code: 'pricing.manage',
      name: 'Manage Pricing',
      description: 'Create and update branch pricing configuration.',
    },
    {
      code: 'suppliers.read',
      name: 'Read Suppliers',
      description: 'View suppliers and supplier catalog configuration.',
    },
    {
      code: 'suppliers.manage',
      name: 'Manage Suppliers',
      description: 'Create and update suppliers and supplier catalog configuration.',
    },
    {
      code: 'purchasing.read',
      name: 'Read Purchasing',
      description: 'View branch purchase orders and their receiving progress.',
    },
    {
      code: 'purchasing.manage',
      name: 'Manage Purchasing',
      description: 'Create and progress branch purchase orders.',
    },
    {
      code: 'receiving.read',
      name: 'Read Receiving',
      description: 'View branch goods receipts and posted lot evidence.',
    },
    {
      code: 'receiving.manage',
      name: 'Manage Receiving',
      description: 'Create, edit, cancel, and atomically post branch goods receipts.',
    },
    {
      code: 'inventory.read',
      name: 'Read Inventory',
      description: 'View branch stock projections, lots, and inventory ledger history.',
    },
    {
      code: 'inventory.manage',
      name: 'Manage Inventory Configuration',
      description: 'Set branch reorder configuration and branch lot operational state without changing stock quantities.',
    },
    {
      code: 'inventory_adjustments.read',
      name: 'Read Inventory Adjustments',
      description: 'View branch inventory adjustment documents and their ledger evidence.',
    },
    {
      code: 'inventory_adjustments.manage',
      name: 'Manage Inventory Adjustments',
      description: 'Create, approve, post, and cancel controlled branch inventory adjustments.',
    },
    {
      code: 'stock_counts.read',
      name: 'Read Stock Counts',
      description: 'View branch physical stock counts and variance evidence.',
    },
    {
      code: 'stock_counts.manage',
      name: 'Manage Stock Counts',
      description: 'Create, conduct, reconcile, post, and cancel branch stock counts.',
    },
    {
      code: 'stock_transfers.read',
      name: 'Read Stock Transfers',
      description: 'View stock transfers involving an authorized branch.',
    },
    {
      code: 'stock_transfers.manage',
      name: 'Manage Stock Transfers',
      description: 'Create, dispatch, receive, and cancel controlled inter-branch stock transfers.',
    },
    {
      code: 'customers.read',
      name: 'Read Customers',
      description: 'View organization-wide customer master records.',
    },
    {
      code: 'customers.manage',
      name: 'Manage Customers',
      description: 'Create and update organization-wide customer master records.',
    },
    {
      code: 'pos_registers.read',
      name: 'Read POS Registers',
      description: 'View branch POS register configuration.',
    },
    {
      code: 'pos_registers.manage',
      name: 'Manage POS Registers',
      description: 'Create and update branch POS register configuration.',
    },
    {
      code: 'till_sessions.read',
      name: 'Read Till Sessions',
      description: 'View branch till sessions and their cash movement history.',
    },

    {
      code: 'till_sessions.manage',
      name: 'Manage Till Sessions',
      description: 'Operate branch till sessions and record drawer cash movements.',
    },
    {
      code: 'sales.read',
      name: 'Read Sales',
      description: 'View branch sales and their persisted checkout line details.',
    },
    {
      code: 'sales.manage',
      name: 'Manage Sales',
      description: 'Create, edit, complete, and cancel branch checkout sales.',
    },
    {
      code: 'payment_methods.read',
      name: 'Read Payment Methods',
      description: 'View organization-wide payment-method configuration.',
    },
    {
      code: 'payment_methods.manage',
      name: 'Manage Payment Methods',
      description: 'Create and update organization-wide payment methods.',
    },
    {
      code: 'payments.read',
      name: 'Read Sale Payments',
      description: 'View branch sale-payment attempts and funding summaries.',
    },
    {
      code: 'payments.manage',
      name: 'Manage Sale Payments',
      description: 'Create and transition branch sale-payment attempts.',
    },
    {
      code: 'returns.read',
      name: 'Read Sales Returns',
      description: 'View branch sales returns, returned items, and refund evidence.',
    },
    {
      code: 'returns.manage',
      name: 'Manage Sales Returns',
      description: 'Create, approve, post, cancel, and refund branch sales returns.',
    },
    {
      code: 'reports.read',
      name: 'Read Reports',
      description: 'View branch and organization reporting and analytics.',
    },
  ].map((permission) => Object.freeze(permission)),
);

const SYSTEM_ADMIN_ROLE = Object.freeze({
  code: 'SYSTEM_ADMIN',
  name: 'System Administrator',
  description:
    'Full organization and access administration through application-defined permissions.',
});

const USER_CREDENTIAL_LOCK_NAME = 'supermarket:user-credentials';
const USER_CREDENTIAL_LOCK_TIMEOUT_SECONDS = 10;

export {
  ACCESS_CONTROL_PERMISSIONS,
  SYSTEM_ADMIN_ROLE,
  USER_CREDENTIAL_LOCK_NAME,
  USER_CREDENTIAL_LOCK_TIMEOUT_SECONDS,
};
