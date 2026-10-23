import { describe, expect, it } from 'vitest';

import { changeDiscount, priceCart, type CartLine } from './cart';
import { saveCustomer } from './customers';
import { localDay } from './dates';
import { DEMO_PRODUCTS, DEMO_SETS, DEMO_USERS, seedDemoData } from './demo';
import type { Claim, Customer, LoanEntry, Sale, User } from './models';
import { recordSale, type OpContext } from './operations';
import { buildReceipt } from './receipt';
import { customerReport, discountTotal } from './reports';
import { canManageAccount, can, GRANTABLE_PERMISSIONS, needsServerToSignIn, PermissionError, worksAt, type Permission } from './roles';
import { MemoryStore, ObservableStore } from './store';
import { discountFormSchema } from './validation';

const [owner, cashier, warehouse, admin] = DEMO_USERS as [User, User, User, User];
const products = new Map(DEMO_PRODUCTS.map((p) => [p.id, p]));
const sets = new Map(DEMO_SETS.map((s) => [s.id, s]));

async function setup() {
  const store = new ObservableStore(new MemoryStore());
  await seedDemoData(store);
  const ctx = (user: User): OpContext => ({ store, user, deviceId: 'a1b2c3d4-0000-4000-8000-000000000000', locationId: 'branch-main' });
  const customer = async (name: string) => (await store.list<Customer>('borrowers')).find((c) => c.name.startsWith(name))!;
  return { store, ctx, customer };
}

const cash = (amount: number) => ({ method: 'cash' as const, amount, tendered: amount, change: 0 });

describe('discounts', () => {
  it("applies a customer's own price and percentage, and keeps the regular price for the receipt", () => {
    const regular: CartLine[] = [
      { type: 'refill', productId: 'lpg-a-11', qty: 2 },
      { type: 'item', productId: 'acc-hose', qty: 1 },
    ];
    const customer = { discount: { percent: 10, prices: { 'lpg-a-11:refill': 90000 } } };
    const { lines, total } = priceCart(regular, products, sets, customer);
    expect(lines.map((l) => [l.unitPrice, l.regularPrice, l.discount?.source])).toEqual([
      [90000, 95000, 'customer'],
      [16200, 18000, 'customer'],
    ]);
    expect(total).toBe(2 * 90000 + 16200);
    expect(discountTotal([{ lines } as Sale])).toBe(2 * 5000 + 1800);
  });

  it("lets the cashier's discount replace the customer's, but never raise the price", () => {
    const cart = changeDiscount([{ type: 'refill', productId: 'lpg-a-11', qty: 1 }], 0, { kind: 'price', price: 99000 });
    expect(priceCart(cart, products).lines[0]).toMatchObject({ unitPrice: 95000 });
    expect(priceCart(cart, products).lines[0]?.regularPrice).toBeUndefined();
    const percent = changeDiscount(cart, 0, { kind: 'percent', percent: 20 });
    expect(priceCart(percent, products, sets, { discount: { percent: 5 } }).lines[0]).toMatchObject({
      unitPrice: 76000,
      discount: { kind: 'percent', percent: 20, source: 'counter' },
    });
  });

  it('needs pos.discount for a discount at the counter, which employees are not given by default', async () => {
    const { ctx } = await setup();
    const cart = changeDiscount([{ type: 'item', productId: 'acc-hose', qty: 1 }], 0, { kind: 'percent', percent: 50 });
    await expect(recordSale(ctx(cashier), { cart, payment: cash(9000) })).rejects.toBeInstanceOf(PermissionError);
    const withExtra = { ...cashier, extraPermissions: ['pos.discount' as const] };
    const sale = await recordSale(ctx(withExtra), { cart, payment: cash(9000) });
    const receipt = buildReceipt(sale, { locationName: 'Main Branch', cashierName: 'Cashier' });
    expect(receipt.lines[0]?.rows.map((r) => [r.detail, r.amount])).toEqual([
      ['1 x ₱180.00', '₱180.00'],
      ['Less discount (50% off)', '-₱90.00'],
    ]);
  });

  it('checks the discount form', () => {
    const schema = discountFormSchema(95000);
    expect(schema.parse({ kind: 'percent', value: '12.5' })).toEqual({ kind: 'percent', percent: 12.5 });
    expect(schema.parse({ kind: 'price', value: '900' })).toEqual({ kind: 'price', price: 90000 });
    expect(schema.safeParse({ kind: 'price', value: '950' }).error?.issues[0]?.message).toContain('less than the regular');
    expect(schema.safeParse({ kind: 'percent', value: '0' }).success).toBe(false);
  });
});

describe('customers', () => {
  it('can be added while selling, and the sale is found by their name', async () => {
    const { store, ctx, customer } = await setup();
    const sale = await recordSale(ctx(cashier), {
      cart: [{ type: 'item', productId: 'acc-hose', qty: 1 }],
      payment: cash(18000),
      customer: { name: '  Pedro   Reyes ', phone: '0917 111 2222' },
    });
    const pedro = await customer('Pedro Reyes');
    expect(pedro).toMatchObject({ name: 'Pedro Reyes', phone: '0917 111 2222' });
    expect(sale).toMatchObject({ borrowerId: pedro.id, borrowerName: 'Pedro Reyes' });
    expect((await store.list<LoanEntry>('loans')).some((e) => e.borrowerId === pedro.id)).toBe(false);
  });

  it("lets cashiers fix names but only the owner and admins change discounts", async () => {
    const { ctx, customer } = await setup();
    const lito = await customer('Lito');
    await saveCustomer(ctx(cashier), { id: lito.id, name: 'Lito Garcia', phone: '0919 555 0177' });
    await expect(saveCustomer(ctx(cashier), { id: lito.id, name: 'Lito Garcia', phone: '', discount: { percent: 50 } })).rejects.toBeInstanceOf(
      PermissionError,
    );
    const saved = await saveCustomer(ctx(admin), { id: lito.id, name: 'Lito Garcia', phone: '', discount: { percent: 5 } });
    expect(saved.discount).toEqual({ percent: 5 });
    const cleared = await saveCustomer(ctx(owner), { id: lito.id, name: 'Lito Garcia', phone: '', discount: {} });
    expect(cleared.discount).toBeUndefined();
    await expect(saveCustomer(ctx(warehouse), { name: 'Someone', phone: '' })).rejects.toBeInstanceOf(PermissionError);
    await expect(saveCustomer(ctx(cashier), { name: 'maria santos', phone: '' })).rejects.toThrow('already called');
  });
});

describe('customer report', () => {
  it("lists each chosen customer's sales, borrowing and claims, with totals", async () => {
    const { store, customer } = await setup();
    const [sales, loans, claims, customers] = await Promise.all([
      store.list<Sale>('sales'),
      store.list<LoanEntry>('loans'),
      store.list<Claim>('claims'),
      store.list<Customer>('borrowers'),
    ]);
    const maria = await customer('Maria');
    const lito = await customer('Lito');
    const today = localDay(new Date());
    const input = { customers, sales, loans, claims, from: '2000-01-01', to: today, productName: (id?: string) => products.get(id ?? '')?.name ?? '' };

    const all = customerReport(input);
    expect(all.rows.map((r) => r.customer.name).sort()).toEqual(customers.map((c) => c.name).sort());

    const some = customerReport({ ...input, customerIds: [maria.id, lito.id] });
    expect(some.rows.map((r) => r.customer.id).sort()).toEqual([maria.id, lito.id].sort());
    const litoRow = some.rows.find((r) => r.customer.id === lito.id)!;
    expect(litoRow).toMatchObject({ sales: 1, spent: 180000, discounts: 10000, toPickUp: 2, owed: 0 });
    const mariaRow = some.rows.find((r) => r.customer.id === maria.id)!;
    expect(mariaRow).toMatchObject({ owed: 5000, payments: 90000 });
    expect(some.activity.filter((a) => a.customerId === maria.id).map((a) => a.what)).toEqual(
      expect.arrayContaining(['Sale on credit', 'Payment']),
    );
  });
});

describe('roles', () => {
  it('gives admins everything, but only the owner manages owner and admin accounts', () => {
    expect(can(admin, 'users.manage')).toBe(true);
    expect(can(admin, 'claims.approve')).toBe(true);
    expect(can(cashier, 'claims.approve')).toBe(false);
    expect(can(cashier, 'cheques.manage')).toBe(false);
    expect(canManageAccount(owner, 'admin')).toBe(true);
    expect(canManageAccount(admin, 'employee')).toBe(true);
    expect(canManageAccount(admin, 'admin')).toBe(false);
    expect(canManageAccount(admin, 'owner')).toBe(false);
    expect(canManageAccount(cashier, 'employee')).toBe(false);
  });

  it('lets a branch manager run their branches, but not products, accounts or backups', () => {
    const manager = DEMO_USERS.find((u) => u.role === 'manager')!;
    for (const p of ['claims.approve', 'cheques.manage', 'sales.void', 'pos.discount', 'inventory.record', 'reports.view'] as const) {
      expect(can(manager, p)).toBe(true);
    }
    for (const p of ['products.manage', 'users.manage', 'backups.manage', 'settings.device'] as const) {
      expect(can(manager, p)).toBe(false);
    }
    expect(worksAt(manager, 'branch-main')).toBe(true);
    expect(worksAt(manager, 'branch-2')).toBe(false);
    expect(worksAt(admin, 'branch-2')).toBe(true);
    expect(canManageAccount(admin, 'manager')).toBe(true);
    expect(canManageAccount(manager, 'employee')).toBe(false);
    expect([owner, admin, manager, cashier, warehouse].map(needsServerToSignIn)).toEqual([true, true, true, false, false]);
  });

  it('keeps backups to the owner and admins, even when someone is given them', () => {
    const manager = DEMO_USERS.find((u) => u.role === 'manager')!;
    expect([owner, admin, manager, cashier, warehouse].map((u) => can(u, 'backups.manage'))).toEqual([true, true, false, false, false]);
    for (const user of [manager, cashier]) {
      const given = { ...user, extraPermissions: ['backups.manage', 'reports.view'] as Permission[] };
      expect(can(given, 'backups.manage')).toBe(false);
      expect(can(given, 'reports.view')).toBe(true);
    }
    expect(GRANTABLE_PERMISSIONS).not.toContain('backups.manage');
  });
});
