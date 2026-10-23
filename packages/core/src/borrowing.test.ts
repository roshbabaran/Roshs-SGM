import { describe, expect, it } from 'vitest';

import { accountOf, borrowingTotals, cheques, chequesDue, lend, payLoan, returnCylinder, sellOnCredit, settleCheque } from './borrowing';
import { addDays, localDay } from './dates';
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

    const sale = await sellOnCredit(ctx(cashier), { borrower: { name: 'Ana Lim', phone: '0917 000 0000' }, cart: [{ type: 'refill', productId: 'lpg-a-11', qty: 2 }] });

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
      sellOnCredit(ctx(cashier), { borrower: { name: 'maria santos' }, cart: [{ type: 'refill', productId: 'lpg-a-11', qty: 1 }] }),
    ).rejects.toThrow('already on the list');
    await expect(
      sellOnCredit(ctx(warehouse), { borrower: { name: 'New Person' }, cart: [{ type: 'refill', productId: 'lpg-a-11', qty: 1 }] }),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  it('takes part payments, oldest refill first, and refuses paying more than is owed', async () => {
    const { ctx, account } = await setup();
    const maria = await account('Maria Santos');
    // ₱950 refill, less ₱500 cash and a ₱400 post-dated cheque.
    expect(maria.owed).toBe(5000);

    await expect(payLoan(ctx(cashier), { borrowerId: maria.borrower.id, payment: cash(6000) })).rejects.toThrow('owes ₱50.00');
    await payLoan(ctx(cashier), { borrowerId: maria.borrower.id, payment: cash(2000) });
    const after = await account('Maria Santos');
    expect(after.owed).toBe(3000);
    expect(after.openCredits.map((c) => c.left)).toEqual([3000]);

    await payLoan(ctx(cashier), { borrowerId: maria.borrower.id, payment: cash(3000) });
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
    await lend(ctx(cashier), { borrower: { name: 'Ben Cruz' }, productId: 'lpg-a-11', qty: 1, payment: null });
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
    const sale = await lend(ctx(cashier), { borrower: { name: 'Ben Cruz' }, productId: 'lpg-a-11', qty: 1, payment: null });
    await voidSale(ctx(owner), sale.id, 'Wrong customer');
    const ben = await account('Ben Cruz');
    expect(ben.owed).toBe(0);
    expect(ben.cylindersOut).toBe(0);
    expect((await store.get<Sale>('sales', sale.id))?.status).toBe('voided');
  });

  it('is refused once the borrowed cylinder came back', async () => {
    const { ctx, account } = await setup();
    const sale = await lend(ctx(cashier), { borrower: { name: 'Ben Cruz' }, productId: 'lpg-a-11', qty: 1, payment: cash(95000) });
    await returnCylinder(ctx(cashier), { borrowerId: (await account('Ben Cruz')).borrower.id, productId: 'lpg-a-11', qty: 1 });
    await expect(voidSale(ctx(owner), sale.id, 'Changed mind')).rejects.toThrow('already been returned');
  });
});

describe('borrowing totals', () => {
  it('adds up credit, payments, cylinders lent and returned in a date range', async () => {
    const { store } = await setup();
    const today = localDay(new Date());
    // The last week; the older sample customers' credit and loans are left out.
    const totals = borrowingTotals(await store.list<LoanEntry>('loans'), addDays(today, -7), today);
    expect(totals).toEqual({ credit: 95000 + 92000, collected: 50000 + 40000, byCheque: 40000, bounced: 0, lent: 2, returned: 0 });
  });
});

describe('sales on credit', () => {
  it("puts accessories and sets on the account, at the borrower's own price", async () => {
    const { ctx, account, stock } = await setup();
    const before = await stock('acc-stove');
    const sale = await sellOnCredit(ctx(cashier), {
      borrower: { name: 'Ana Lim' },
      cart: [
        { type: 'item', productId: 'acc-stove', qty: 1 },
        { type: 'set', setId: 'set-two-refills', qty: 1 },
      ],
    });
    expect(sale.total).toBe(120000 + 188000);
    expect((await stock('acc-stove')).unit).toBe(before.unit - 1);
    expect((await account('Ana Lim')).owed).toBe(308000);
    await expect(sellOnCredit(ctx(cashier), { borrower: { name: 'Ana Lim' }, cart: [{ type: 'borrow', productId: 'lpg-a-11', qty: 1 }] })).rejects.toThrow(
      'Lend cylinder',
    );
  });
});

describe('sales on credit with a part paid now', () => {
  const gcash = (amount: number) => ({ method: 'gcash' as const, amount, tendered: amount, change: 0, reference: '7012345678' });

  it('records the part paid as a payment with the sale, and prints both on the receipt', async () => {
    const { store, ctx, account } = await setup();
    const sale = await sellOnCredit(ctx(cashier), {
      borrower: { name: 'Ana Lim' },
      cart: [{ type: 'item', productId: 'acc-stove', qty: 1 }],
      downPayment: gcash(50000),
    });
    expect(sale.payment).toEqual({ method: 'credit', amount: 120000, tendered: 0, change: 0 });
    expect(sale.downPayment).toMatchObject({ method: 'gcash', amount: 50000 });
    const ana = await account('Ana Lim');
    expect(ana.owed).toBe(70000);
    expect(ana.openCredits.map((c) => c.left)).toEqual([70000]);
    const receipt = buildReceipt(sale, { locationName: 'Main Branch', cashierName: 'Cashier' });
    expect(receipt.paidNow).toEqual({ label: 'GCash', amount: '₱500.00', reference: '7012345678', balance: '₱700.00' });
  });

  it('refuses paying it all, a cheque, or a part payment on a sale that is not on credit', async () => {
    const { ctx } = await setup();
    const cart = [{ type: 'item' as const, productId: 'acc-stove', qty: 1 }];
    await expect(sellOnCredit(ctx(cashier), { borrower: { name: 'Ana Lim' }, cart, downPayment: cash(120000) })).rejects.toThrow('less than the total');
    await expect(
      sellOnCredit(ctx(cashier), {
        borrower: { name: 'Ana Lim' },
        cart,
        downPayment: { method: 'cheque', amount: 10000, tendered: 10000, change: 0, cheque: { number: '123', bank: 'BDO', cashOn: '2099-01-01' } },
      }),
    ).rejects.toThrow('Record payment');
    await expect(recordSale(ctx(cashier), { cart, payment: cash(120000), downPayment: cash(10000) })).rejects.toThrow('on credit');
  });

  it('gives the part paid back when the sale is voided', async () => {
    const { store, ctx, account } = await setup();
    const today = localDay(new Date());
    const before = borrowingTotals(await store.list<LoanEntry>('loans'), today, today, 'branch-main');
    const sale = await sellOnCredit(ctx(cashier), {
      borrower: { name: 'Ana Lim' },
      cart: [{ type: 'item', productId: 'acc-stove', qty: 1 }],
      downPayment: cash(30000),
    });
    const during = borrowingTotals(await store.list<LoanEntry>('loans'), today, today, 'branch-main');
    expect(during.credit - before.credit).toBe(120000);
    expect(during.collected - before.collected).toBe(30000);

    await voidSale(ctx(owner), sale.id, 'Customer changed their mind');
    const ana = await account('Ana Lim');
    expect(ana.owed).toBe(0);
    expect(ana.openCredits).toEqual([]);
    const after = borrowingTotals(await store.list<LoanEntry>('loans'), today, today, 'branch-main');
    expect(after.credit).toBe(before.credit);
    expect(after.collected).toBe(before.collected);
  });
});

describe('post-dated cheques', () => {
  const cheque = (amount: number, cashOn: string) => ({
    method: 'cheque' as const,
    amount,
    tendered: amount,
    change: 0,
    cheque: { number: '0099887', bank: 'BDO', cashOn },
  });

  it('counts as paid until it bounces, and shows on the day it can be cashed', async () => {
    const { store, ctx, account } = await setup();
    const today = localDay(new Date());
    const rosa = await account('Rosa Reyes');
    const owed = rosa.owed;
    const later = '2099-01-15';
    const entry = await payLoan(ctx(cashier), { borrowerId: rosa.borrower.id, payment: cheque(50000, later) });
    expect((await account('Rosa Reyes')).owed).toBe(owed - 50000);

    const loans = await store.list<LoanEntry>('loans');
    expect(chequesDue(loans, today).map((c) => c.cheque.number)).toEqual(['0012345']);
    expect(chequesDue(loans, later).map((c) => c.cheque.number)).toEqual(['0012345', '0099887']);

    await expect(settleCheque(ctx(cashier), { paymentId: entry.id, outcome: 'bounced' })).rejects.toBeInstanceOf(PermissionError);
    await settleCheque(ctx(owner), { paymentId: entry.id, outcome: 'bounced', note: 'Insufficient funds' });
    expect((await account('Rosa Reyes')).owed).toBe(owed);
    await expect(settleCheque(ctx(owner), { paymentId: entry.id, outcome: 'cleared' })).rejects.toThrow('already marked bounced');
    const after = await store.list<LoanEntry>('loans');
    expect(cheques(after).find((c) => c.entry.id === entry.id)?.state).toBe('bounced');
    expect(borrowingTotals(after, today, today).bounced).toBe(50000);
  });

  it('is only taken as a borrowing payment, not at the counter', async () => {
    const { ctx } = await setup();
    await expect(
      recordSale(ctx(cashier), { cart: [{ type: 'item', productId: 'acc-hose', qty: 1 }], payment: cheque(18000, '2099-01-15') }),
    ).rejects.toThrow('Borrowing window');
  });
});
