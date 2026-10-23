/**
 * The Borrowing window: anything sold on credit, cylinders lent with a refill,
 * returns, payments and post-dated cheques. What each person owes and which
 * cylinders they have are worked out from the loans ledger (see LoanEntry),
 * never typed over.
 */
import { priceCart, type CartLine } from './cart';
import { localDay } from './dates';
import type { Borrower, Cheque, Customer, ISODate, LoanEntry, Payment, Product, ProductSet, Sale, StockMovement } from './models';
import { formatPeso, type Centavos } from './money';
import { loanEntry, recordSale, saveAndQueue, tidyName, type BorrowerRef, type OpContext } from './operations';
import { assertCan, can, worksAt } from './roles';
import { uuid } from './ids';

/** A payment that goes on the borrower's account instead of being paid now. */
export function onAccount(amount: Centavos): Payment {
  return { method: 'credit', amount, tendered: 0, change: 0 };
}

/** A cylinder lent with its refill. */
export interface LendInput {
  borrower: BorrowerRef;
  productId: string;
  qty: number;
  /** How the refill is paid now, or null to put it on their account. */
  payment: Payment | null;
}

/** The cart line and total for lending a cylinder (its refill at the borrower's own price, if they have one). */
export function lendLine(product: Product, qty: number, borrower?: Pick<Customer, 'discount'> | null): { line: CartLine; total: Centavos } {
  const line: CartLine = { type: 'borrow', productId: product.id, qty };
  return { line, total: priceCart([line], new Map([[product.id, product]]), new Map(), borrower).total };
}

/** Records a cylinder lent with its refill. Returns the sale, for the receipt. */
export async function lend(ctx: OpContext, input: LendInput): Promise<Sale> {
  const product = await ctx.store.get<Product>('products', input.productId);
  if (!product || product.kind !== 'cylinder') throw new Error('Choose a cylinder.');
  const borrower = input.borrower.id ? await ctx.store.get<Customer>('borrowers', input.borrower.id) : null;
  const { line, total } = lendLine(product, input.qty, borrower);
  const payment = input.payment ?? onAccount(total);
  return recordSale(ctx, { cart: [line], payment, customer: input.borrower });
}

/** What a credit sale costs, with the borrower's own discount. */
export async function creditTotal(ctx: OpContext, cart: CartLine[], borrowerId?: string): Promise<Centavos> {
  const [products, sets, borrower] = await Promise.all([
    ctx.store.list<Product>('products'),
    ctx.store.list<ProductSet>('sets'),
    borrowerId ? ctx.store.get<Customer>('borrowers', borrowerId) : Promise.resolve(null),
  ]);
  return priceCart(cart, new Map(products.map((p) => [p.id, p])), new Map(sets.map((s) => [s.id, s])), borrower).total;
}

/**
 * Sales on credit: anything in the store on the customer's account, refills,
 * new cylinders, accessories or sets. They take it now and pay later, and can
 * pay part of it now (`downPayment`); that part is recorded as a payment with
 * the sale. Returns the sale, for the receipt.
 */
export async function sellOnCredit(
  ctx: OpContext,
  input: { borrower: BorrowerRef; cart: CartLine[]; downPayment?: Payment | null },
): Promise<Sale> {
  if (input.cart.length === 0) throw new Error('Add what they are taking.');
  if (input.cart.some((line) => line.type === 'borrow')) throw new Error('Use Lend cylinder to lend a cylinder.');
  const total = await creditTotal(ctx, input.cart, input.borrower.id);
  return recordSale(ctx, {
    cart: input.cart,
    payment: onAccount(total),
    customer: input.borrower,
    ...(input.downPayment ? { downPayment: input.downPayment } : {}),
  });
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

/** The borrower pays back all or part of what they owe, with money or a post-dated cheque. */
export async function payLoan(ctx: OpContext, input: { borrowerId: string; payment: Payment }): Promise<LoanEntry> {
  const user = ctx.user;
  assertCan(user, 'borrow.manage');
  if (input.payment.method === 'credit') throw new Error('Choose how they paid.');
  if (input.payment.method === 'cheque' && !input.payment.cheque) throw new Error("Enter the cheque's number, bank and the date it can be cashed.");
  const { borrower, entries } = await borrowerAndEntries(ctx, input.borrowerId);
  const owed = amountOwed(entries);
  if (input.payment.amount <= 0) throw new Error('Enter the amount paid.');
  if (input.payment.amount > owed) throw new Error(`${borrower.name} owes ${formatPeso(Math.max(0, owed))}. Enter that or less.`);

  const now = (ctx.now?.() ?? new Date()).toISOString();
  const entry = loanEntry(ctx, user, borrower, { kind: 'payment', amount: -input.payment.amount, payment: input.payment }, now);
  await ctx.store.batch(saveAndQueue('loans', [entry], now));
  return entry;
}

/** Corrects a borrower's name or phone number, keeping their discount. Their history keeps the name used at the time. */
export async function saveBorrower(ctx: OpContext, input: { id: string; name: string; phone: string }): Promise<Borrower> {
  assertCan(ctx.user, 'borrow.manage');
  const borrowers = await ctx.store.list<Borrower>('borrowers');
  const current = borrowers.find((b) => b.id === input.id);
  if (!current) throw new Error('That borrower is no longer on the list.');
  const name = tidyName(input.name);
  if (name.length < 2) throw new Error("Enter the borrower's name.");
  if (borrowers.some((b) => b.id !== input.id && b.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`Another customer is already called ${name}.`);
  }
  const { phone: _oldPhone, ...rest } = current;
  const phone = input.phone.trim();
  const updated: Borrower = { ...rest, name, ...(phone ? { phone } : {}), receivedAt: null };
  const now = (ctx.now?.() ?? new Date()).toISOString();
  await ctx.store.batch(saveAndQueue('borrowers', [updated], now));
  return updated;
}

export type ChequeState = 'waiting' | 'cleared' | 'bounced';

/** A post-dated cheque a borrower paid with, and what became of it. */
export interface ChequeInfo {
  /** The payment entry. */
  entry: LoanEntry;
  cheque: Cheque;
  amount: Centavos;
  state: ChequeState;
  /** When it was marked cleared or bounced. */
  settledAt: ISODate | null;
}

/** Every post-dated cheque in the ledger, the soonest to cash first. */
export function cheques(entries: LoanEntry[]): ChequeInfo[] {
  const settled = new Map(
    entries.flatMap((e) => ((e.kind === 'cheque_cleared' || e.kind === 'cheque_bounced') && e.reverses ? [[e.reverses, e] as const] : [])),
  );
  return entries
    .flatMap((entry): ChequeInfo[] => {
      if (entry.kind !== 'payment' || entry.payment?.method !== 'cheque' || !entry.payment.cheque) return [];
      const outcome = settled.get(entry.id);
      return [
        {
          entry,
          cheque: entry.payment.cheque,
          amount: -entry.amount,
          state: !outcome ? 'waiting' : outcome.kind === 'cheque_cleared' ? 'cleared' : 'bounced',
          settledAt: outcome?.occurredAt ?? null,
        },
      ];
    })
    .sort((a, b) => a.cheque.cashOn.localeCompare(b.cheque.cashOn) || a.entry.occurredAt.localeCompare(b.entry.occurredAt));
}

/** Cheques not yet deposited whose day has come, by `today` ('YYYY-MM-DD'). */
export function chequesDue(entries: LoanEntry[], today: string): ChequeInfo[] {
  return cheques(entries).filter((c) => c.state === 'waiting' && c.cheque.cashOn <= today);
}

/**
 * Marks a post-dated cheque deposited and cleared, or bounced. A bounced
 * cheque's amount is owed again. The owner and admins, or a branch manager for
 * cheques taken at their branches (cheques.manage).
 */
export async function settleCheque(ctx: OpContext, input: { paymentId: string; outcome: 'cleared' | 'bounced'; note?: string }): Promise<LoanEntry> {
  const user = ctx.user;
  assertCan(user, 'cheques.manage');
  const loans = await ctx.store.list<LoanEntry>('loans');
  const info = cheques(loans).find((c) => c.entry.id === input.paymentId);
  if (!info) throw new Error('That cheque is no longer in the records.');
  if (info.state !== 'waiting') throw new Error(`That cheque was already marked ${info.state}.`);
  if (!worksAt(user, info.entry.locationId)) throw new Error("That cheque was taken at a branch you aren't assigned to.");
  const borrower = { id: info.entry.borrowerId, name: info.entry.borrowerName };
  const now = (ctx.now?.() ?? new Date()).toISOString();
  const entry = loanEntry(
    ctx,
    user,
    borrower,
    {
      kind: input.outcome === 'cleared' ? 'cheque_cleared' : 'cheque_bounced',
      amount: input.outcome === 'cleared' ? 0 : info.amount,
      reverses: info.entry.id,
      ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    },
    now,
  );
  await ctx.store.batch(saveAndQueue('loans', [entry], now));
  return entry;
}

/** Whether this person is told about cheques that are due (the owner, admins and branch managers). */
export const seesCheques = (user: Parameters<typeof can>[0]) => can(user, 'cheques.manage');

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
  // A bounced cheque's amount comes off what was paid.
  let paid = -entries
    .filter((e) => (e.kind === 'payment' && !voided.has(e.id)) || e.kind === 'cheque_bounced')
    .reduce((sum, e) => sum + e.amount, 0);
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
  credit: 'Sale on credit',
  payment: 'Payment',
  cylinder_out: 'Borrowed cylinder',
  cylinder_return: 'Returned cylinder',
  void: 'Voided sale',
  cheque_cleared: 'Cheque cleared',
  cheque_bounced: 'Cheque bounced',
};

export interface BorrowingTotals {
  /** Sales on credit, less any voided. */
  credit: Centavos;
  /** Payments received (collections), cheques included, less part payments given back when a sale was voided. */
  collected: Centavos;
  /** The part of `collected` paid with post-dated cheques. */
  byCheque: Centavos;
  /** Cheques that bounced in the period. */
  bounced: Centavos;
  lent: number;
  returned: number;
}

/** Borrowing activity on days from `from` to `to` (both included), at one branch or all. */
export function borrowingTotals(entries: LoanEntry[], from: string, to: string, locationId?: string): BorrowingTotals {
  const totals: BorrowingTotals = { credit: 0, collected: 0, byCheque: 0, bounced: 0, lent: 0, returned: 0 };
  for (const e of entries) {
    if (locationId && e.locationId !== locationId) continue;
    const day = localDay(e.occurredAt);
    if (day < from || day > to) continue;
    // A void entry copies what it cancels: a sale on credit, a borrowed cylinder or a part payment.
    if (e.kind === 'credit' || (e.kind === 'void' && !e.payment)) totals.credit += e.amount;
    if (e.kind === 'payment' || (e.kind === 'void' && e.payment)) totals.collected -= e.amount;
    if (e.kind === 'payment' && e.payment?.method === 'cheque') totals.byCheque -= e.amount;
    if (e.kind === 'cheque_bounced') totals.bounced += e.amount;
    if (e.kind === 'cylinder_out' || (e.kind === 'void' && e.qty)) totals.lent += e.qty ?? 0;
    if (e.kind === 'cylinder_return') totals.returned -= e.qty ?? 0;
  }
  return totals;
}

/** Customers with anything in the loans ledger: the people the Borrowing window lists. */
export function borrowersOnly(customers: Customer[], entries: LoanEntry[]): Customer[] {
  const ids = new Set(entries.map((e) => e.borrowerId));
  return customers.filter((c) => ids.has(c.id));
}
