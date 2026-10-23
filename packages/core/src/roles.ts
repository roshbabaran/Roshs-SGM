import type { User } from './models';

/**
 * Everything a person can be allowed to do. The apps use these to hide menus and
 * buttons; the API server must check the same permissions on every request,
 * because anyone can call the server without the app.
 */
export const PERMISSIONS = [
  'dashboard.view',
  'pos.sell',
  'pos.discount',
  'borrow.manage',
  'cheques.manage',
  'claims.approve',
  'sales.view',
  'sales.void',
  'inventory.view',
  'inventory.record',
  'inventory.receive',
  'reports.view',
  'products.manage',
  'users.manage',
  'settings.device',
  'backups.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export type Role = 'owner' | 'admin' | 'manager' | 'employee' | 'warehouse';

export const ROLES: readonly Role[] = ['owner', 'admin', 'manager', 'employee', 'warehouse'];

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  manager: 'Branch manager',
  employee: 'Employee',
  warehouse: 'Warehouse staff',
};

export const PERMISSION_LABELS: Record<Permission, string> = {
  'dashboard.view': 'See the dashboard',
  'pos.sell': 'Sell at the counter, and record pick ups, returns and defectives',
  'pos.discount': 'Give discounts at the counter',
  'borrow.manage': 'Lend cylinders, give credit and take payments',
  'cheques.manage': 'Mark post-dated cheques deposited or bounced',
  'claims.approve': 'Approve returns and defective exchanges',
  'sales.view': 'See sales history',
  'sales.void': 'Void sales',
  'inventory.view': 'See stock',
  'inventory.record': 'Record stock movements',
  'inventory.receive': "Accept stock sent from other branches, and settle counts that don't match",
  'reports.view': 'See reports',
  'products.manage': 'Change products, prices and sets',
  'users.manage': 'Manage users and devices',
  'settings.device': 'Change device settings',
  'backups.manage': 'Make and open backups',
};

/**
 * Admins can do everything the owner can, but only the owner can change the owner's and admins' accounts.
 * A branch manager runs the branches they are assigned to: selling, discounts, credit, cheques, approvals,
 * voids, stock and reports, but not products, accounts or devices. Backups are only ever the owner's and admins'.
 * Stock sent between branches is accepted by the owner, an admin, or the receiving branch's manager or warehouse staff.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: PERMISSIONS,
  admin: PERMISSIONS,
  manager: [
    'dashboard.view',
    'pos.sell',
    'pos.discount',
    'borrow.manage',
    'cheques.manage',
    'claims.approve',
    'sales.view',
    'sales.void',
    'inventory.view',
    'inventory.record',
    'inventory.receive',
    'reports.view',
  ],
  employee: ['dashboard.view', 'pos.sell', 'borrow.manage', 'sales.view', 'inventory.view'],
  warehouse: ['inventory.view', 'inventory.record', 'inventory.receive'],
};

/**
 * Permissions that come only with a role and can't be given to anyone else as an extra: backups (the owner's and
 * admins', since a backup holds every sale and loan on the PC) and accepting stock from other branches (the owner,
 * admins, branch managers and warehouse staff).
 */
export const ROLE_ONLY: readonly Permission[] = ['backups.manage', 'inventory.receive'];

/** What Users & Devices can let someone do beyond their role. */
export const GRANTABLE_PERMISSIONS: readonly Permission[] = PERMISSIONS.filter((p) => !ROLE_ONLY.includes(p));

/** A role's permissions plus any extras the owner granted to this person. */
export function permissionsOf(user: User): Set<Permission> {
  const extras = (user.extraPermissions ?? []).filter((p) => !ROLE_ONLY.includes(p));
  return new Set([...ROLE_PERMISSIONS[user.role], ...extras]);
}

export function can(user: User | null | undefined, permission: Permission): boolean {
  if (!user || !user.active) return false;
  return permissionsOf(user).has(permission);
}

/** The owner and admins work at every branch and warehouse. */
export function worksEverywhere(user: Pick<User, 'role'>): boolean {
  return user.role === 'owner' || user.role === 'admin';
}

/** Whether this person works at a branch or warehouse: the owner and admins everywhere, anyone else where assigned. */
export function worksAt(user: Pick<User, 'role' | 'locationIds'> | null | undefined, locationId: string): boolean {
  return !!user && (worksEverywhere(user) || user.locationIds.includes(locationId));
}

/**
 * The roles that can never sign in without the server: they approve, void and run
 * branches, so a stolen or shared PC can't be used to do that offline.
 */
export function needsServerToSignIn(user: Pick<User, 'role'>): boolean {
  return user.role === 'owner' || user.role === 'admin' || user.role === 'manager';
}

/**
 * The branch or warehouse a person works on at this device. The owner and
 * admins work wherever the device is set up; anyone else works at the device's
 * location if assigned there, otherwise at their own first assigned location.
 */
export function workLocationFor(user: User, deviceLocationId: string): string {
  if (worksEverywhere(user) || user.locationIds.includes(deviceLocationId)) return deviceLocationId;
  return user.locationIds[0] ?? deviceLocationId;
}

/** Only the owner may create or change the owner's and admins' accounts; admins manage everyone else. */
export function canManageAccount(manager: User | null | undefined, role: Role): boolean {
  if (!can(manager, 'users.manage')) return false;
  return manager!.role === 'owner' || (role !== 'owner' && role !== 'admin');
}

export class PermissionError extends Error {
  constructor(public readonly permission: Permission) {
    super(`You don't have permission to do this (${PERMISSION_LABELS[permission].toLowerCase()}).`);
    this.name = 'PermissionError';
  }
}

export function assertCan(user: User | null | undefined, permission: Permission): asserts user is User {
  if (!can(user, permission)) throw new PermissionError(permission);
}
