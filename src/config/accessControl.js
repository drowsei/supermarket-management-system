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
