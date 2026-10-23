/**
 * The customer report's charts that look at today rather than the period: how
 * long what is owed has been unpaid, how long lent cylinders have been out, and
 * which regulars are late for their next LPG refill.
 */
import type { BorrowerAccount } from './borrowing';
import { hasLpg } from './claims';
import { addDays, daysAgo, dayRange, localDay, parseDay } from './dates';
import type { Customer, ISODate, LoanEntry, Sale } from './models';

export type AgeGroupKey = 'week' | 'month' | 'twoMonths' | 'older';

/** How long ago something was bought or lent, in four groups. */
export const AGE_GROUPS: readonly { key: AgeGroupKey; label: string; upTo: number }[] = [
  { key: 'week', label: '0 to 7 days', upTo: 7 },
  { key: 'month', label: '8 to 30 days', upTo: 30 },
  { key: 'twoMonths', label: '31 to 60 days', upTo: 60 },
  { key: 'older', label: 'Over 60 days', upTo: Infinity },
];

export function ageGroupOf(days: number): AgeGroupKey {
  return AGE_GROUPS.find((g) => days <= g.upTo)!.key;
}

/** One customer's share of an age group: money still owed, or cylinders of one kind still out. */
export interface AgedPart {
  customerId: string;
  customerName: string;
  /** Centavos owed, or cylinders. */
  value: number;
  /** When the oldest of it was bought or lent. */
  since: ISODate;
  days: number;
  /** Cylinders: which kind. */
  productId?: string;
}

export interface AgeGroup {
  key: AgeGroupKey;
  label: string;
  /** Centavos owed, or cylinders. */
  total: number;
  /** The oldest first. */
  parts: AgedPart[];
}

/** Adds each open item to its age group, one part per customer (and per cylinder kind). */
function byAge(items: { account: BorrowerAccount; value: number; at: ISODate; productId?: string }[], today: string): AgeGroup[] {
  const now = parseDay(today);
  const groups = AGE_GROUPS.map((g) => ({ key: g.key, label: g.label, total: 0, parts: new Map<string, AgedPart>() }));
  for (const item of items) {
    if (item.value <= 0) continue;
    const days = Math.max(0, daysAgo(item.at, now));
    const group = groups.find((g) => g.key === ageGroupOf(days))!;
    const key = `${item.account.borrower.id}:${item.productId ?? ''}`;
    const part = group.parts.get(key);
    group.total += item.value;
    if (part) {
      part.value += item.value;
      if (item.at < part.since) Object.assign(part, { since: item.at, days });
    } else {
      group.parts.set(key, {
        customerId: item.account.borrower.id,
        customerName: item.account.borrower.name,
        value: item.value,
        since: item.at,
        days,
        ...(item.productId ? { productId: item.productId } : {}),
      });
    }
  }
  return groups.map((g) => ({ ...g, parts: [...g.parts.values()].sort((a, b) => b.days - a.days || b.value - a.value) }));
}

/** What customers owe today, by how long ago they bought it. Payments pay off the oldest first. */
export function debtByAge(accounts: BorrowerAccount[], today: string): AgeGroup[] {
  return byAge(
    accounts.flatMap((account) => account.openCredits.map((c) => ({ account, value: c.left, at: c.entry.occurredAt }))),
    today,
  );
}

/** Lent cylinders still out today, by how long ago they were lent. Returns close the oldest first. */
export function cylindersByAge(accounts: BorrowerAccount[], today: string): AgeGroup[] {
  return byAge(
    accounts.flatMap((account) => account.openCylinders.map((c) => ({ account, value: c.left, at: c.entry.occurredAt, productId: c.productId }))),
    today,
  );
}

/** How often a customer buys LPG, worked out from the days they bought it. */
export interface RefillRhythm {
  customer: Customer;
  /** Days they bought LPG on. */
  purchases: number;
  /** Their usual days between LPG purchases (the middle of the gaps, so one odd gap doesn't throw it off). */
  usualGap: number;
  lastDay: string;
  daysSince: number;
  /** When the next refill would be, going by the usual gap. */
  nextDay: string;
  /** Days past the usual gap; 0 or less when not due yet. */
  late: number;
}

/** Purchases it takes to tell how often someone buys: three days, so two gaps. */
export const RHYTHM_PURCHASES = 3;

/** Their buying rhythm from completed sales with LPG in them, at one branch or all; null with too few purchases. */
export function refillRhythm(customer: Customer, sales: Sale[], today: string, locationId?: string): RefillRhythm | null {
  const days = [
    ...new Set(
      sales
        .filter((s) => s.borrowerId === customer.id && s.status === 'completed' && (!locationId || s.locationId === locationId) && s.lines.some(hasLpg))
        .map((s) => localDay(s.createdAt)),
    ),
  ]
    .filter((day) => day <= today)
    .sort();
  if (days.length < RHYTHM_PURCHASES) return null;
  const gaps = days.slice(1).map((day, i) => dayRange(days[i]!, day).length - 1).sort((a, b) => a - b);
  const middle = gaps.length / 2;
  const usualGap = Math.max(1, Math.round(gaps.length % 2 ? gaps[Math.floor(middle)]! : (gaps[middle - 1]! + gaps[middle]!) / 2));
  const lastDay = days.at(-1)!;
  const daysSince = dayRange(lastDay, today).length - 1;
  return { customer, purchases: days.length, usualGap, lastDay, daysSince, nextDay: addDays(lastDay, usualGap), late: daysSince - usualGap };
}

/** Days late before someone is worth a call: a quarter of their usual gap, and at least two. */
export function lateEnough(rhythm: RefillRhythm): boolean {
  return rhythm.late >= Math.max(2, Math.round(rhythm.usualGap / 4));
}

/** Regulars well past their usual gap between LPG purchases, the latest (for how often they buy) first. */
export function dueForRefill(customers: Customer[], sales: Sale[], today: string, locationId?: string): RefillRhythm[] {
  const byCustomer = new Map<string, Sale[]>();
  for (const sale of sales) {
    if (!sale.borrowerId) continue;
    const theirs = byCustomer.get(sale.borrowerId);
    if (theirs) theirs.push(sale);
    else byCustomer.set(sale.borrowerId, [sale]);
  }
  return customers
    .map((c) => refillRhythm(c, byCustomer.get(c.id) ?? [], today, locationId))
    .filter((r): r is RefillRhythm => !!r && lateEnough(r))
    .sort((a, b) => b.daysSince / b.usualGap - a.daysSince / a.usualGap || a.customer.name.localeCompare(b.customer.name));
}

/** What a customer owed at the end of each day from `from` to `to`. */
export function owedByDay(entries: LoanEntry[], from: string, to: string): { day: string; owed: number }[] {
  const sorted = [...entries].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  let owed = 0;
  let next = 0;
  return dayRange(from, to).map((day) => {
    while (next < sorted.length && localDay(sorted[next]!.occurredAt) <= day) owed += sorted[next++]!.amount;
    return { day, owed };
  });
}
