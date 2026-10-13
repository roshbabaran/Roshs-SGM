import { describe, expect, it } from 'vitest';

import { accountOf, borrowingTotals, lend, payLoan, returnCylinder } from './borrowing';
import { localDay } from './dates';
import { DEMO_USERS, seedDemoData } from './demo';
import { levelOf, stockByProduct } from './ledger';
import type { Borrower, LoanEntry, OutboxEntry, Sale, StockMovement, User } from './models';
import { recordSale, voidSale, type OpContext } from './operations';
import { buildReceipt } from './receipt';
import { PermissionError } from './roles';
import { MemoryStore, ObservableStore } from './store';

const [owner, cashier, warehouse] = DEMO_USERS as [User, User, User];

async function setup() {
  const store = new ObservableStore(new MemoryStore());
  await seedDemoData(store);
  const ctx = (user: User): OpContext => ({ store, user, deviceId: 'a1b2c3d4-0000-4000-8000-000000000000', locationId: 'branch-main' });
  const stock = async (productId: string) => levelOf(stockByProduct(await store.list<StockMovement>('movements'), 'branch-main'), productId);
  const account = async (name: string) => {
    const borrower = (await store.list<Borrower>('borrowers')).find((b) => b.name === name)!;
    return accountOf(borrower, await store.list<LoanEntry>('loans'));
  };
  return { store, ctx, stock, account };
}

const cash = (amount: number) => ({ method: 'cash' as const, amount, tendered: amount, change: 0 });

describe('refill on credit', () => {
  it('swaps the cylinders, puts the refill on the account and names the borrower on the receipt', async () => {
    const { ctx, stock, account } = await setup();
    const before = await stock('lpg-a-11');

    const sale = await lend(ctx(cashier), { kind: 'credit', borrower: { name: 'Ana Lim', phone: '0917 000 0000' }, productId: 'lpg-a-11', qty: 2, payment: null });

    expect(sale.payment).toEqual({ method: 'credit', amount: 190000, tendered: 0, change: 0 });
    expect(await stock('lpg-a-11')).toEqual({ ...before, full: before.full - 2, empty: before.empty + 2 });
    const ana = await account('Ana Lim');
    expect(ana.owed).toBe(190000);
    expect(ana.openSince).toBe(sale.createdAt);
    const receipt = buildReceipt(sale, { locationName: 'Main Branch', cashierName: 'Cashier' });
    expect(receipt.customer).toBe('Ana Lim');
    expect(receipt.onAccount).toBe(true);
  });

  it('refuses a second borrower with the same name, and warehouse staff', async () => {
    const { ctx } = await setup();
    await expect(
      lend(ctx(cashier), { kind: 'credit', borrower: { name: 'maria santos' }, productId: 'lpg-a-11', qty: 1, payment: null }),
    ).rejects.toThrow('already on the list');
    await expect(
      lend(ctx(warehouse), { kind: 'credit', borrower: { name: 'New Person' }, productId: 'lpg-a-11', qty: 1, payment: null }),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  it('takes part payments, oldest refill first, and refuses paying more than is owed', async () => {
    const { ctx, account } = await setup();
    const maria = await account('Maria Santos');
    expect(maria.owed).toBe(45000);

    await expect(payLoan(ctx(cashier), { borrowerId: maria.borrower.id, payment: cash(50000) })).rejects.toThrow('owes ₱450.00');
    await payLoan(ctx(cashier), { borrowerId: maria.borrower.id, payment: cash(20000) });
    const after = await account('Maria Santos');
    expect(after.owed).toBe(25000);
    expect(after.openCredits.map((c) => c.left)).toEqual([25000]);

    await payLoan(ctx(cashier), { borrowerId: maria.borrower.id, payment: cash(25000) });
    const settled = await account('Maria Santos');
    expect(settled.owed).toBe(0);
    expect(settled.openSince).toBeNull();
  });
});

describe('borrowed cylinders', () => {
  it('lends a full cylinder with its refill and takes it back as an empty', async () => {
    const { store, ctx, stock, account } = await setup();
    const before = await stock('lpg-a-22');
    const sale = await lend(ctx(cashier), {
      kind: 'cylinder',
      borrower: { name: 'Ben Cruz' },
      productId: 'lpg-a-22',
      qty: 1,
      payment: cash(190000),
    });

    expect(sale.total).toBe(190000);
    expect(await stock('lpg-a-22')).toEqual({ ...before, full: before.full - 1 });
    let ben = await account('Ben Cruz');
    expect(ben.owed).toBe(0);
    expect(ben.cylinders.get('lpg-a-22')).toBe(1);
    expect(buildReceipt(sale, { locationName: '', cashierName: '' }).notes).toEqual([
      'Borrowed cylinder: 1 x Brand A 22 kg. Please return it.',
    ]);

    await expect(returnCylinder(ctx(cashier), { borrowerId: ben.borrower.id, productId: 'lpg-a-22', qty: 2 })).rejects.toThrow('has 1');
    await returnCylinder(ctx(cashier), { borrowerId: ben.borrower.id, productId: 'lpg-a-22', qty: 1 });
    expect(await stock('lpg-a-22')).toEqual({ ...before, full: before.full - 1, empty: before.empty + 1 });
    ben = await account('Ben Cruz');
    expect(ben.cylindersOut).toBe(0);
    expect(ben.openSince).toBeNull();

    const outbox = await store.list<OutboxEntry>('outbox');
    expect(new Set(outbox.map((e) => e.collection))).toEqual(new Set(['borrowers', 'sales', 'movements', 'loans']));
  });

  it("can put a borrowed cylinder's refill on the account", async () => {
    const { ctx, account } = await setup();
    await lend(ctx(cashier), { kind: 'cylinder', borrower: { name: 'Ben Cruz' }, productId: 'lpg-a-11', qty: 1, payment: null });
    const ben = await account('Ben Cruz');
    expect(ben.owed).toBe(95000);
    expect(ben.cylindersOut).toBe(1);
  });

  it('needs a borrower for credit or a borrowed cylinder at the counter', async () => {
    const { ctx } = await setup();
    await expect(
      recordSale(ctx(cashier), { cart: [{ type: 'borrow', productId: 'lpg-a-11', qty: 1 }], payment: cash(95000) }),
    ).rejects.toThrow('Choose who is borrowing');
  });
});

describe('voiding a Borrowing-window sale', () => {
  it('takes the refill off the account and the cylinder off their list', async () => {
    const { store, ctx, account } = await setup();
    const sale = await lend(ctx(cashier), { kind: 'cylinder', borrower: { name: 'Ben Cruz' }, productId: 'lpg-a-11', qty: 1, payment: null });
    await voidSale(ctx(owner), sale.id, 'Wrong customer');
    const ben = await account('Ben Cruz');
    expect(ben.owed).toBe(0);
    expect(ben.cylindersOut).toBe(0);
    expect((await store.get<Sale>('sales', sale.id))?.status).toBe('voided');
  });

  it('is refused once the borrowed cylinder came back', async () => {
    const { ctx, account } = await setup();
    const sale = await lend(ctx(cashier), { kind: 'cylinder', borrower: { name: 'Ben Cruz' }, productId: 'lpg-a-11', qty: 1, payment: cash(95000) });
    await returnCylinder(ctx(cashier), { borrowerId: (await account('Ben Cruz')).borrower.id, productId: 'lpg-a-11', qty: 1 });
    await expect(voidSale(ctx(owner), sale.id, 'Changed mind')).rejects.toThrow('already been returned');
  });
});

describe('borrowing totals', () => {
  it('adds up credit, payments, cylinders lent and returned in a date range', async () => {
    const { store } = await setup();
    const today = localDay(new Date());
    const totals = borrowingTotals(await store.list<LoanEntry>('loans'), '2000-01-01', today);
    expect(totals).toEqual({ credit: 95000 + 92000, collected: 50000, lent: 2, returned: 0 });
  });
});
