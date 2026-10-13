/**
 * The Borrowing window: refills on credit, cylinders lent with a refill, returns
 * and payments. What each person owes and which cylinders they have are worked
 * out from the loans ledger (see LoanEntry), never typed over.
 */
import { unitPrice, type CartLine } from './cart';
import { localDay } from './dates';
import type { Borrower, ISODate, LoanEntry, Payment, Product, Sale, StockMovement } from './models';
import { formatPeso, type Centavos } from './money';
import { loanEntry, recordSale, saveAndQueue, type BorrowerRef, type OpContext } from './operations';
import { assertCan } from './roles';
import { uuid } from './ids';

/** A payment that goes on the borrower's account instead of being paid now. */
export function onAccount(amount: Centavos): Payment {
  return { method: 'credit', amount, tendered: 0, change: 0 };
}

export interface LendInput {
  /** credit: they swap an empty for a full cylinder and pay later. cylinder: they also borrow the cylinder. */
  kind: 'credit' | 'cylinder';
  borrower: BorrowerRef;
  productId: string;
  qty: number;
  /** How a borrowed cylinder's refill is paid now, or null to put it on their account. */
  payment: Payment | null;
}

/** The cart line and total for a loan, before it is recorded. */
export function lendLine(kind: LendInput['kind'], product: Product, qty: number): { line: CartLine; total: Centavos } {
  const type = kind === 'cylinder' ? 'borrow' : 'refill';
  return { line: { type, productId: product.id, qty }, total: unitPrice(product, type) * qty };
}

/** Records a refill on credit, or a cylinder lent with its refill. Returns the sale, for the receipt. */
export async function lend(ctx: OpContext, input: LendInput): Promise<Sale> {
  const product = await ctx.store.get<Product>('products', input.productId);
  if (!product || product.kind !== 'cylinder') throw new Error('Choose a cylinder.');
  const { line, total } = lendLine(input.kind, product, input.qty);
  const payment = input.kind === 'credit' || !input.payment ? onAccount(total) : input.payment;
  return recordSale(ctx, { cart: [line], payment, borrower: input.borrower });
}

async function borrowerAndEntries(ctx: OpContext, borrowerId: string): Promise<{ borrower: Borrower; entries: LoanEntry[] }> {
  const borrower = await ctx.store.get<Borrower>('borrowers', borrowerId);
  if (!borrower) throw new Error('That borrower is no longer on the list.');
  const entries = (await ctx.store.list<LoanEntry>('loans')).filter((e) => e.borrowerId === borrowerId);
  return { borrower, entries };
}

/** A borrowed cylinder comes back: it goes on the shelf as an empty and off the borrower's list. */
export async function returnCylinder(
  ctx: OpContext,
  input: { borrowerId: string; productId: string; qty: number },
): Promise<LoanEntry> {
  const user = ctx.user;
  assertCan(user, 'borrow.manage');
  const { borrower, entries } = await borrowerAndEntries(ctx, input.borrowerId);
  const product = await ctx.store.get<Product>('products', input.productId);
  if (!product) throw new Error('That product no longer exists.');
  const out = cylindersOut(entries).get(product.id) ?? 0;
  if (input.qty < 1) throw new Error('Enter how many cylinders came back.');
  if (input.qty > out) {
    throw new Error(`${borrower.name} has ${out} ${product.name} cylinder${out === 1 ? '' : 's'} out, not ${input.qty}.`);
  }

  const now = (ctx.now?.() ?? new Date()).toISOString();
  const movement: StockMovement = {
    id: uuid(),
    type: 'CYLINDER_RETURN',
    productId: product.id,
    locationId: ctx.locationId,
    condition: 'empty',
    qty: input.qty,
    reason: `Returned by ${borrower.name}`,
    userId: user.id,
    deviceId: ctx.deviceId,
    occurredAt: now,
    createdAt: now,
    receivedAt: null,
  };
  const entry = loanEntry(ctx, user, borrower, { kind: 'cylinder_return', amount: 0, productId: product.id, qty: -input.qty }, now);
  await ctx.store.batch([...saveAndQueue('movements', [movement], now), ...saveAndQueue('loans', [entry], now)]);
  return entry;
}

/** The borrower pays back all or part of what they owe. */
export async function payLoan(ctx: OpContext, input: { borrowerId: string; payment: Payment }): Promise<LoanEntry> {
  const user = ctx.user;
  assertCan(user, 'borrow.manage');
  if (input.payment.method === 'credit') throw new Error('Choose how they paid.');
  const { borrower, entries } = await borrowerAndEntries(ctx, input.borrowerId);
  const owed = amountOwed(entries);
  if (input.payment.amount <= 0) throw new Error('Enter the amount paid.');
  if (input.payment.amount > owed) throw new Error(`${borrower.name} owes ${formatPeso(Math.max(0, owed))}. Enter that or less.`);

  const now = (ctx.now?.() ?? new Date()).toISOString();
  const entry = loanEntry(ctx, user, borrower, { kind: 'payment', amount: -input.payment.amount, payment: input.payment }, now);
  await ctx.store.batch(saveAndQueue('loans', [entry], now));
  return entry;
}

/** Corrects a borrower's name or phone number. Their history keeps the name used at the time. */
export async function saveBorrower(ctx: OpContext, input: { id: string; name: string; phone: string }): Promise<Borrower> {
  assertCan(ctx.user, 'borrow.manage');
  const borrowers = await ctx.store.list<Borrower>('borrowers');
  const current = borrowers.find((b) => b.id === input.id);
  if (!current) throw new Error('That borrower is no longer on the list.');
  const name = input.name.trim().replace(/\s+/g, ' ');
  if (name.length < 2) throw new Error("Enter the borrower's name.");
  if (borrowers.some((b) => b.id !== input.id && b.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`Another borrower is already called ${name}.`);
  }
  const phone = input.phone.trim();
  const updated: Borrower = { id: current.id, name, ...(phone ? { phone } : {}), createdAt: current.createdAt, receivedAt: null };
  const now = (ctx.now?.() ?? new Date()).toISOString();
  await ctx.store.batch(saveAndQueue('borrowers', [updated], now));
  return updated;
}

const byWhen = (a: LoanEntry, b: LoanEntry) => a.occurredAt.localeCompare(b.occurredAt) || a.createdAt.localeCompare(b.createdAt);

/** What a borrower owes now (negative if they paid more than they owed). */
export function amountOwed(entries: LoanEntry[]): Centavos {
  return entries.reduce((sum, e) => sum + e.amount, 0);
}

/** Cylinders a borrower still has, per product. */
export function cylindersOut(entries: LoanEntry[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of entries) {
    if (!e.productId || !e.qty) continue;
    out.set(e.productId, (out.get(e.productId) ?? 0) + e.qty);
  }
  for (const [productId, qty] of out) if (qty === 0) out.delete(productId);
  return out;
}

export interface OpenCredit {
  entry: LoanEntry;
  /** Still unpaid. Payments go to the oldest refill first. */
  left: Centavos;
}

export interface OpenCylinder {
  entry: LoanEntry;
  productId: string;
  /** Still not returned. Returns close the oldest loan of that cylinder first. */
  left: number;
}

export interface BorrowerAccount {
  borrower: Borrower;
  owed: Centavos;
  cylinders: Map<string, number>;
  cylindersOut: number;
  openCredits: OpenCredit[];
  openCylinders: OpenCylinder[];
  /** When the oldest unpaid refill or unreturned cylinder was borrowed. */
  openSince: ISODate | null;
  lastActivity: ISODate | null;
  /** Their whole history, oldest first. */
  entries: LoanEntry[];
}

export function accountOf(borrower: Borrower, allEntries: LoanEntry[]): BorrowerAccount {
  const entries = allEntries.filter((e) => e.borrowerId === borrower.id).sort(byWhen);
  const voided = new Set(entries.flatMap((e) => (e.kind === 'void' && e.reverses ? [e.reverses] : [])));

  const openCredits: OpenCredit[] = entries
    .filter((e) => e.kind === 'credit' && !voided.has(e.id))
    .map((entry) => ({ entry, left: entry.amount }));
  let paid = -entries.filter((e) => e.kind === 'payment').reduce((sum, e) => sum + e.amount, 0);
  for (const credit of openCredits) {
    const used = Math.min(paid, credit.left);
    credit.left -= used;
    paid -= used;
  }

  const openCylinders: OpenCylinder[] = entries
    .filter((e) => e.kind === 'cylinder_out' && !voided.has(e.id) && e.productId)
    .map((entry) => ({ entry, productId: entry.productId!, left: entry.qty ?? 0 }));
  const returned = new Map<string, number>();
  for (const e of entries) {
    if (e.kind === 'cylinder_return' && e.productId) returned.set(e.productId, (returned.get(e.productId) ?? 0) - (e.qty ?? 0));
  }
  for (const loan of openCylinders) {
    const back = returned.get(loan.productId) ?? 0;
    const used = Math.min(back, loan.left);
    loan.left -= used;
    returned.set(loan.productId, back - used);
  }

  const stillOpen = [...openCredits.filter((c) => c.left > 0), ...openCylinders.filter((c) => c.left > 0)];
  const cylinders = cylindersOut(entries);
  return {
    borrower,
    owed: amountOwed(entries),
    cylinders,
    cylindersOut: Array.from(cylinders.values()).reduce((sum, qty) => sum + qty, 0),
    openCredits: openCredits.filter((c) => c.left > 0),
    openCylinders: openCylinders.filter((c) => c.left > 0),
    openSince: stillOpen.map((item) => item.entry.occurredAt).sort()[0] ?? null,
    lastActivity: entries.at(-1)?.occurredAt ?? null,
    entries,
  };
}

/** Every borrower's account, the ones owing the longest first. */
export function borrowerAccounts(borrowers: Borrower[], entries: LoanEntry[]): BorrowerAccount[] {
  return borrowers
    .map((borrower) => accountOf(borrower, entries))
    .sort((a, b) => (a.openSince ?? '9999').localeCompare(b.openSince ?? '9999') || a.borrower.name.localeCompare(b.borrower.name));
}

export const LOAN_LABELS: Record<LoanEntry['kind'], string> = {
  credit: 'Refill on account',
  payment: 'Payment',
  cylinder_out: 'Cylinder lent',
  cylinder_return: 'Cylinder returned',
  void: 'Voided sale',
};

export interface BorrowingTotals {
  /** Refills put on account, less any voided. */
  credit: Centavos;
  collected: Centavos;
  lent: number;
  returned: number;
}

/** Borrowing activity on days from `from` to `to` (both included), at one branch or all. */
export function borrowingTotals(entries: LoanEntry[], from: string, to: string, locationId?: string): BorrowingTotals {
  const totals: BorrowingTotals = { credit: 0, collected: 0, lent: 0, returned: 0 };
  for (const e of entries) {
    if (locationId && e.locationId !== locationId) continue;
    const day = localDay(e.occurredAt);
    if (day < from || day > to) continue;
    if (e.kind === 'credit' || e.kind === 'void') totals.credit += e.amount;
    if (e.kind === 'payment') totals.collected -= e.amount;
    if (e.kind === 'cylinder_out' || (e.kind === 'void' && e.qty)) totals.lent += e.qty ?? 0;
    if (e.kind === 'cylinder_return') totals.returned -= e.qty ?? 0;
  }
  return totals;
}
