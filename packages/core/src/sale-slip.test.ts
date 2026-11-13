import { describe, expect, it } from 'vitest';

import { DEMO_USERS, seedDemoData } from './demo';
import { localDay } from './dates';
import { salesBetween } from './reports';
import type { LoanEntry, OutboxEntry, Product, Sale, StockMovement, User } from './models';
import { checkSlipNo, recordSale, saleTimeFor, voidSale, type OpContext, type SaleInput } from './operations';
import { MemoryStore, ObservableStore } from './store';

const [owner, cashier] = DEMO_USERS as [User, User, User];

async function setup() {
  const store = new ObservableStore(new MemoryStore());
  await seedDemoData(store);
  const ctx = (user: User): OpContext => ({ store, user, deviceId: 'a1b2c3d4-0000-4000-8000-000000000000', locationId: 'branch-main' });
  const hose = (await store.get<Product>('products', 'acc-hose'))!;
  const sell = (slipNo?: string, more: Partial<SaleInput> = {}) =>
    recordSale(ctx(cashier), {
      cart: [{ type: 'item', productId: hose.id, qty: 1 }],
      payment: { method: 'cash', amount: hose.price, tendered: hose.price, change: 0 },
      slipNo,
      ...more,
    });
  return { store, ctx, sell };
}

describe('sales scanned from a handwritten receipt', () => {
  it('keep the receipt number', async () => {
    const { sell } = await setup();
    expect((await sell(' 7128 ')).slipNo).toBe('7128');
    expect((await sell()).slipNo).toBeUndefined();
    expect((await sell('')).slipNo).toBeUndefined();
  });

  it('refuse the same receipt number twice, unless the first sale was voided', async () => {
    const { ctx, sell } = await setup();
    const first = await sell('7128');
    await expect(sell('7128')).rejects.toThrow(`already entered as sale ${first.receiptNo}`);
    await voidSale(ctx(owner), first.id, 'Wrong items');
    await expect(sell('7128')).resolves.toMatchObject({ slipNo: '7128' });
  });

  it('can be checked before the sale, while the number can still be corrected', async () => {
    const { ctx, sell } = await setup();
    const first = await sell('7128');
    await expect(checkSlipNo(ctx(cashier), '7128')).rejects.toThrow(`already entered as sale ${first.receiptNo}`);
    await expect(checkSlipNo(ctx(cashier), '7129')).resolves.toBeUndefined();
    await expect(checkSlipNo({ ...ctx(cashier), locationId: 'branch-other' }, '7128')).resolves.toBeUndefined();
    await expect(checkSlipNo(ctx(cashier), '7'.repeat(41))).rejects.toThrow('too long');
  });
});

describe('when a scanned sale happened', () => {
  /** 3:00 PM on Nov 10, 2026, local time. */
  const NOW = new Date(2026, 10, 10, 15, 0, 0);
  const local = (iso: string) => {
    const d = new Date(iso);
    return `${localDay(d)} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  };

  it('uses a written or typed time as it is', () => {
    const at = saleTimeFor('2026-11-08', '14:30', NOW);
    expect(local(at.soldAt)).toBe('2026-11-08 14:30');
    expect(at.timeEstimated).toBe(false);
  });

  it('uses the time it is saved for a receipt dated today, and 11:59 PM on an earlier day', () => {
    expect(saleTimeFor('2026-11-10', null, NOW)).toEqual({ soldAt: NOW.toISOString(), timeEstimated: true });
    const earlier = saleTimeFor('2026-11-08', null, NOW);
    expect(local(earlier.soldAt)).toBe('2026-11-08 23:59');
    expect(earlier.timeEstimated).toBe(true);
  });

  it('refuses a date or time that is not real', () => {
    expect(() => saleTimeFor('2026-02-30', null, NOW)).toThrow('date');
    expect(() => saleTimeFor('2026-11-08', '25:00', NOW)).toThrow('time');
  });

  it('dates the sale, its stock movements and account entries then, and notes when it was entered', async () => {
    const { store, ctx } = await setup();
    const soldAt = new Date(2026, 10, 8, 23, 59).toISOString();
    const now = () => NOW;
    // On credit, so the account entries are dated too. Elena has no standing discount.
    const sale = await recordSale(
      { ...ctx(owner), now },
      {
        cart: [{ type: 'refill', productId: 'lpg-a-11', qty: 1 }],
        payment: { method: 'credit', amount: 95000, tendered: 95000, change: 0 },
        customer: { id: 'demo-customer-elena', name: 'Elena Torres' },
        soldAt,
        timeEstimated: true,
        registeredName: '  Juan   Dela Cruz ',
      },
    );
    expect(sale).toMatchObject({ createdAt: soldAt, recordedAt: NOW.toISOString(), timeEstimated: true, registeredName: 'Juan Dela Cruz' });
    const movements = (await store.list<StockMovement>('movements')).filter((m) => m.saleId === sale.id);
    expect(movements.length).toBeGreaterThan(0);
    expect(movements.every((m) => m.occurredAt === soldAt && m.createdAt === soldAt)).toBe(true);
    const loans = (await store.list<LoanEntry>('loans')).filter((e) => e.saleId === sale.id);
    expect(loans.length).toBeGreaterThan(0);
    expect(loans.every((e) => e.occurredAt === soldAt)).toBe(true);
    // Queued for the server when it was entered.
    const queued = (await store.list<OutboxEntry>('outbox')).find((e) => e.recordId === sale.id);
    expect(queued?.createdAt).toBe(NOW.toISOString());
    // It counts on the day it happened.
    const sales = await store.list<Sale>('sales');
    expect(salesBetween(sales, '2026-11-08', '2026-11-08', 'branch-main').map((s) => s.id)).toContain(sale.id);
    expect(salesBetween(sales, '2026-11-10', '2026-11-10', 'branch-main').map((s) => s.id)).not.toContain(sale.id);
  });

  it('refuses a time in the future, allowing a few minutes for clocks a little apart', async () => {
    const { ctx } = await setup();
    const now = () => NOW;
    const input = (soldAt: string): SaleInput => ({
      cart: [{ type: 'item', productId: 'acc-hose', qty: 1 }],
      payment: { method: 'cash', amount: 18000, tendered: 18000, change: 0 },
      soldAt,
    });
    await expect(recordSale({ ...ctx(cashier), now }, input(new Date(NOW.getTime() + 10 * 60_000).toISOString()))).rejects.toThrow('future');
    await expect(recordSale({ ...ctx(cashier), now }, input(new Date(NOW.getTime() + 2 * 60_000).toISOString()))).resolves.toBeTruthy();
    await expect(recordSale({ ...ctx(cashier), now }, input('not a date'))).rejects.toThrow('valid date');
  });

  it("keeps a sale without soldAt as before: no recordedAt, no registered name", async () => {
    const { sell } = await setup();
    const sale = await sell(undefined, { registeredName: '   ' });
    expect(sale.recordedAt).toBeUndefined();
    expect(sale.timeEstimated).toBeUndefined();
    expect(sale.registeredName).toBeUndefined();
  });
});
