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
