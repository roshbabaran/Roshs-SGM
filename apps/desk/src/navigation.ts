import type { Permission } from '@sgm/core';
import type { IconName } from '@sgm/ui';

export interface Page {
  href: string;
  label: string;
  icon: IconName;
  /** Who sees the page in the menu. Settings is for everyone (sign out, sync, device ID). */
  permission?: Permission;
}

/** SGM Desk's sidebar menu, in order. Ctrl+1, Ctrl+2... open the pages a person can see. */
export const PAGES: Page[] = [
  { href: '/', label: 'Dashboard', icon: 'grid-outline', permission: 'dashboard.view' },
  { href: '/pos', label: 'Sell', icon: 'cart-outline', permission: 'pos.sell' },
  { href: '/borrowing', label: 'Borrowing', icon: 'swap-horizontal-outline', permission: 'borrow.manage' },
  { href: '/inventory', label: 'Inventory', icon: 'cube-outline', permission: 'inventory.view' },
  { href: '/sales', label: 'Transactions', icon: 'receipt-outline', permission: 'sales.view' },
  { href: '/reports', label: 'Reports', icon: 'bar-chart-outline', permission: 'reports.view' },
  { href: '/products', label: 'Products', icon: 'pricetags-outline', permission: 'products.manage' },
  { href: '/users', label: 'Users', icon: 'people-outline', permission: 'users.manage' },
  { href: '/settings', label: 'Settings', icon: 'settings-outline' },
];
