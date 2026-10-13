import type { User } from './models';

/**
 * Everything a person can be allowed to do. The apps use these to hide menus and
 * buttons; the API server must check the same permissions on every request,
 * because anyone can call the server without the app.
 */
export const PERMISSIONS = [
  'dashboard.view',
  'pos.sell',
  'borrow.manage',
  'sales.view',
  'sales.void',
  'inventory.view',
  'inventory.record',
  'reports.view',
  'products.manage',
  'users.manage',
  'settings.device',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export type Role = 'owner' | 'employee' | 'warehouse';

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  employee: 'Employee',
  warehouse: 'Warehouse staff',
};

export const PERMISSION_LABELS: Record<Permission, string> = {
  'dashboard.view': 'See the dashboard',
  'pos.sell': 'Sell at the counter',
  'borrow.manage': 'Lend cylinders, give credit and take payments',
  'sales.view': 'See sales history',
  'sales.void': 'Void sales',
  'inventory.view': 'See stock',
  'inventory.record': 'Record stock movements',
  'reports.view': 'See reports',
  'products.manage': 'Change products, prices and sets',
  'users.manage': 'Manage users',
  'settings.device': 'Change device settings',
};

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: PERMISSIONS,
  employee: ['dashboard.view', 'pos.sell', 'borrow.manage', 'sales.view', 'inventory.view'],
  warehouse: ['inventory.view', 'inventory.record'],
};

/** A role's permissions plus any extras the owner granted to this person. */
export function permissionsOf(user: User): Set<Permission> {
  return new Set([...ROLE_PERMISSIONS[user.role], ...(user.extraPermissions ?? [])]);
}

export function can(user: User | null | undefined, permission: Permission): boolean {
  if (!user || !user.active) return false;
  return permissionsOf(user).has(permission);
}

/**
 * The branch or warehouse a person works on at this device. The owner works
 * wherever the device is set up; anyone else works at the device's location if
 * assigned there, otherwise at their own first assigned location.
 */
export function workLocationFor(user: User, deviceLocationId: string): string {
  if (user.role === 'owner' || user.locationIds.includes(deviceLocationId)) return deviceLocationId;
  return user.locationIds[0] ?? deviceLocationId;
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
