import { describe, expect, it } from 'vitest';

import { accountOf } from './borrowing';
import { addDays, parseDay } from './dates';
import { cylindersByAge, debtByAge, dueForRefill, owedByDay, refillRhythm } from './insights';
import type { Customer, LoanEntry, Sale, SaleLine } from './models';

const today = '2026-10-23';
const ana: Customer = { id: 'c-ana', name: 'Ana Lim', createdAt: '2026-01-01T00:00:00.000Z', receivedAt: null };
const ben: Customer = { id: 'c-ben', name: 'Ben Cruz', createdAt: '2026-01-01T00:00:00.000Z', receivedAt: null };

/** Noon, `days` before today. */
const at = (days: number) => new Date(parseDay(addDays(today, -days)).getTime() + 12 * 3_600_000).toISOString();

let n = 0;
const entry = (customer: Customer, days: number, fields: Partial<LoanEntry> & Pick<LoanEntry, 'kind'>): LoanEntry => ({
  id: `e${++n}`,
  borrowerId: customer.id,
  borrowerName: customer.name,
  amount: 0,
  locationId: 'branch-main',
  userId: 'u-owner',
  deviceId: 'd1',
  occurredAt: at(days),
  createdAt: at(days),
  receivedAt: null,
  ...fields,
});

const refill: SaleLine = { type: 'refill', productId: 'lpg-a-11', name: 'Brand A 11 kg', qty: 1, unitPrice: 95000, amount: 95000 };
const hose: SaleLine = { type: 'item', productId: 'acc-hose', name: 'Hose', qty: 1, unitPrice: 18000, amount: 18000 };
const sale = (customer: Customer, days: number, lines: SaleLine[] = [refill], fields: Partial<Sale> = {}): Sale =>
  ({
    id: `s${++n}`,
    receiptNo: `R${n}`,
    locationId: 'branch-main',
    deviceId: 'd1',
    cashierId: 'u-cashier',
    lines,
    total: lines.reduce((sum, l) => sum + l.amount, 0),
    payment: { method: 'cash', amount: 0, tendered: 0, change: 0 },
    status: 'completed',
    borrowerId: customer.id,
    borrowerName: customer.name,
    createdAt: at(days),
    receivedAt: null,
    ...fields,
  }) as Sale;

describe('how old the debt is', () => {
  it('pays off the oldest first and puts what is left in its age group', () => {
    const entries = [
      entry(ana, 90, { kind: 'credit', amount: 40000 }),
      entry(ana, 45, { kind: 'credit', amount: 30000 }),
      entry(ana, 20, { kind: 'credit', amount: 20000 }),
      entry(ana, 3, { kind: 'credit', amount: 10000 }),
      entry(ana, 2, { kind: 'payment', amount: -50000 }),
    ];
    const groups = debtByAge([accountOf(ana, entries)], today);
    expect(groups.map((g) => [g.key, g.total])).toEqual([
      ['week', 10000],
      ['month', 20000],
      ['twoMonths', 20000],
      ['older', 0],
    ]);
    expect(groups[2]!.parts).toEqual([{ customerId: ana.id, customerName: ana.name, value: 20000, since: at(45), days: 45 }]);
    // It adds up to what they owe.
    expect(groups.reduce((sum, g) => sum + g.total, 0)).toBe(accountOf(ana, entries).owed);
  });

  it('counts a bounced cheque as never paid, so the debt keeps its age', () => {
    const entries = [entry(ben, 40, { kind: 'credit', amount: 20000 }), entry(ben, 35, { kind: 'payment', amount: -20000 })];
    entries.push(entry(ben, 30, { kind: 'cheque_bounced', amount: 20000, reverses: entries[1]!.id }));
    const groups = debtByAge([accountOf(ben, entries)], today);
    expect(groups.find((g) => g.key === 'twoMonths')!.parts).toMatchObject([{ customerId: ben.id, value: 20000, days: 40 }]);
  });

  it('lists the customers in a group oldest first, one line each', () => {
    const accounts = [
      accountOf(ana, [entry(ana, 10, { kind: 'credit', amount: 5000 }), entry(ana, 25, { kind: 'credit', amount: 5000 })]),
      accountOf(ben, [entry(ben, 28, { kind: 'credit', amount: 1000 })]),
    ];
    const month = debtByAge(accounts, today).find((g) => g.key === 'month')!;
    expect(month.total).toBe(11000);
    expect(month.parts.map((p) => [p.customerName, p.value, p.days])).toEqual([
      ['Ben Cruz', 1000, 28],
      ['Ana Lim', 10000, 25],
    ]);
  });
});

describe('how long cylinders have been out', () => {
  it('closes the oldest loan first and keeps each kind apart', () => {
    const entries = [
      entry(ana, 70, { kind: 'cylinder_out', productId: 'lpg-a-11', qty: 2 }),
      entry(ana, 10, { kind: 'cylinder_out', productId: 'lpg-a-11', qty: 1 }),
      entry(ana, 5, { kind: 'cylinder_out', productId: 'lpg-a-2.7', qty: 1 }),
      entry(ana, 4, { kind: 'cylinder_return', productId: 'lpg-a-11', qty: -1 }),
    ];
    const groups = cylindersByAge([accountOf(ana, entries)], today);
    expect(groups.map((g) => [g.key, g.total])).toEqual([
      ['week', 1],
      ['month', 1],
      ['twoMonths', 0],
      ['older', 1],
    ]);
    expect(groups[0]!.parts).toMatchObject([{ productId: 'lpg-a-2.7', value: 1, days: 5 }]);
    expect(groups[3]!.parts).toMatchObject([{ productId: 'lpg-a-11', value: 1, days: 70 }]);
  });
});

describe('due for a refill', () => {
  it("learns how often a customer buys LPG, leaving out other items and voided sales", () => {
    const sales = [
      sale(ana, 40),
      sale(ana, 30),
      sale(ana, 30), // twice on one day is one purchase
      sale(ana, 25, [hose]),
      sale(ana, 22, [refill], { status: 'voided' }),
      sale(ana, 18),
      sale(ana, 6),
    ];
    // Gaps of 10, 12 and 12 days: usually every 12.
    expect(refillRhythm(ana, sales, today)).toMatchObject({ purchases: 4, usualGap: 12, daysSince: 6, late: -6, nextDay: addDays(today, 6) });
    expect(refillRhythm(ben, [sale(ben, 20), sale(ben, 10)], today)).toBeNull();
  });

  it('lists only regulars well past their usual gap, the latest for how often they buy first', () => {
    const sales = [
      // Every 7 days, last 20 days ago: nearly three times their gap.
      sale(ana, 41),
      sale(ana, 34),
      sale(ana, 27),
      sale(ana, 20),
      // Every 10 days, last 11 days ago: only a day late, so not yet.
      sale(ben, 31),
      sale(ben, 21),
      sale(ben, 11),
    ];
    expect(dueForRefill([ana, ben], sales, today).map((r) => [r.customer.name, r.usualGap, r.late])).toEqual([['Ana Lim', 7, 13]]);
    const late = [...sales, sale(ben, 1, [hose])];
    // Buying something else doesn't count as their refill.
    expect(dueForRefill([ben], late, addDays(today, 3)).map((r) => r.late)).toEqual([4]);
    // At one branch only.
    expect(dueForRefill([ana], sales, today, 'branch-2')).toEqual([]);
  });
});

describe('what one customer owed day by day', () => {
  it('adds up their entries to the end of each day', () => {
    const entries = [
      entry(ana, 5, { kind: 'credit', amount: 30000 }),
      entry(ana, 3, { kind: 'payment', amount: -10000 }),
      entry(ana, 3, { kind: 'credit', amount: 5000 }),
      entry(ana, 0, { kind: 'payment', amount: -25000 }),
    ];
    expect(owedByDay(entries, addDays(today, -6), today).map((d) => d.owed)).toEqual([0, 30000, 30000, 25000, 25000, 25000, 0]);
  });
});
