/**
 * The things people do in SGM, written once for both apps. Each operation
 * checks permissions, saves its records in one transaction, and queues them
 * in the outbox for the server.
 */
import { isBorrowingSale, priceCart, productUnits, saleMovements, saleUnits, stockChanges, type CartLine } from './cart';
import { ALLOW_NEGATIVE_STOCK } from './config';
import { isValidDay, localDay, parseDay } from './dates';
import { claimCode, shortId, uuid } from './ids';
import { levelOf, NO_STOCK, stockByProduct, type StockLevel } from './ledger';
import type {
  Customer,
  DeviceSettings,
  ISODate,
  LoanEntry,
  Location,
  MetaRecord,
  OutboxCollection,
  OutboxEntry,
  OutboxRecord,
  Payment,
  Product,
  ProductSet,
  Sale,
  StockCondition,
  StockMovement,
  User,
} from './models';
import { CONDITION_LABELS } from './models';
import { assertCan } from './roles';
import { COLLECTIONS, put, remove, type ObservableStore, type StoreOp } from './store';
import type { MovementInput } from './validation';

export interface OpContext {
  store: ObservableStore;
  user: User | null;
  deviceId: string;
  locationId: string;
  now?: () => Date;
}

export interface Shortage {
  productId: string;
  condition: StockCondition;
  name: string;
  available: number;
  needed: number;
}

export class StockError extends Error {
  constructor(public readonly shortages: Shortage[]) {
    super(
      'Not enough stock: ' +
        shortages.map((s) => `${s.name} (have ${s.available}, need ${s.needed})`).join(', ') +
        '.',
    );
    this.name = 'StockError';
  }
}

export function outboxEntry(collection: OutboxCollection, record: OutboxRecord, now: string): OutboxEntry {
  return { id: uuid(), collection, recordId: record.id, payload: record, createdAt: now, attempts: 0 };
}

/** Saves records and queues each one for the server. */
export function saveAndQueue(collection: OutboxCollection, records: OutboxRecord[], now: string): StoreOp[] {
  return records.flatMap((record) => [put(collection, record), put('outbox', outboxEntry(collection, record, now))]);
}

/** Stock the cart takes off the shelf, per product and condition (sets opened up into their items). */
export function stockNeeds(cart: CartLine[], sets: Map<string, ProductSet> = new Map()): Map<string, StockLevel> {
  const needs = new Map<string, StockLevel>();
  for (const unit of productUnits(cart, sets)) {
    for (const change of stockChanges(unit)) {
      if (change.qty >= 0) continue;
      const level = needs.get(unit.productId) ?? { ...NO_STOCK };
      level[change.condition] -= change.qty;
      needs.set(unit.productId, level);
    }
  }
  return needs;
}

/** Products in the cart that need more stock than the branch has (full, empty or units). */
export function findShortages(
  cart: CartLine[],
  products: Map<string, Product>,
  levels: Map<string, StockLevel>,
  sets: Map<string, ProductSet> = new Map(),
): Shortage[] {
  const shortages: Shortage[] = [];
  for (const [productId, needs] of stockNeeds(cart, sets)) {
    const product = products.get(productId);
    if (!product) continue;
    const level = levelOf(levels, productId);
    for (const condition of ['full', 'unit', 'empty'] as const) {
      const needed = needs[condition];
      if (needed > 0 && level[condition] < needed) {
        const name = condition === 'empty' ? `${product.name} empty cylinders` : product.name;
        shortages.push({ productId, condition, name, available: level[condition], needed });
      }
    }
  }
  return shortages;
}

/** Who a sale is for: a customer already on the list (id), or a new one. */
export interface CustomerRef {
  id?: string;
  name: string;
  phone?: string;
}

/** Who a Borrowing-window sale is for. */
export type BorrowerRef = CustomerRef;

/** Names are kept tidy: no spaces at the ends, one space between words. */
export const tidyName = (name: string) => name.trim().replace(/\s+/g, ' ');

/** Finds the customer, or makes a new one (refusing a second customer with the same name). */
export async function resolveCustomer(ctx: OpContext, ref: CustomerRef, now: string): Promise<{ customer: Customer; isNew: boolean }> {
  const customers = await ctx.store.list<Customer>('borrowers');
  if (ref.id) {
    const customer = customers.find((c) => c.id === ref.id);
    if (!customer) throw new Error('That customer is no longer on the list.');
    return { customer, isNew: false };
  }
  const name = tidyName(ref.name);
  if (name.length < 2) throw new Error("Enter the customer's name.");
  if (customers.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`${name} is already on the list of customers. Choose them instead of adding them again.`);
  }
  const phone = ref.phone?.trim();
  const customer: Customer = { id: uuid(), name, ...(phone ? { phone } : {}), createdAt: now, receivedAt: null };
  return { customer, isNew: true };
}

export function loanEntry(
  ctx: OpContext,
  user: User,
  borrower: Pick<Customer, 'id' | 'name'>,
  fields: Pick<LoanEntry, 'kind' | 'amount'> & Partial<LoanEntry>,
  now: string,
): LoanEntry {
  return {
    id: uuid(),
    borrowerId: borrower.id,
    borrowerName: borrower.name,
    locationId: ctx.locationId,
    userId: user.id,
    deviceId: ctx.deviceId,
    occurredAt: now,
    createdAt: now,
    receivedAt: null,
    ...fields,
  };
}

const RECEIPT_SEQ_ID = 'receipt-seq';

/** How far ahead of this device's clock a sale time may be, for clocks a little apart. */
export const CLOCK_SKEW_MS = 5 * 60_000;

/**
 * When a sale entered from a receipt happened. A time written on the receipt
 * or typed by the cashier ("HH:MM", 24-hour) is used as it is. Without one, a
 * sale dated today gets the time it is saved (11:59 PM would be in the future,
 * and this keeps today's sales in the order they were entered), and a sale
 * from an earlier day gets 11:59 PM local time on that day, so it falls on
 * the right day in every daily report. Either way `timeEstimated` is true.
 */
export function saleTimeFor(day: string, time: string | null, now: Date = new Date()): { soldAt: ISODate; timeEstimated: boolean } {
  if (!isValidDay(day)) throw new Error('Enter the date of the sale.');
  const at = parseDay(day);
  if (time) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
    const hours = match ? parseInt(match[1], 10) : NaN;
    const minutes = match ? parseInt(match[2], 10) : NaN;
    if (!(hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59)) throw new Error('Enter the time like 2:30 PM, or leave it empty.');
    at.setHours(hours, minutes, 0, 0);
    return { soldAt: at.toISOString(), timeEstimated: false };
  }
  if (day === localDay(now)) return { soldAt: now.toISOString(), timeEstimated: true };
  at.setHours(23, 59, 0, 0);
  return { soldAt: at.toISOString(), timeEstimated: true };
}

/**
 * Checks the number of a handwritten receipt before a sale keeps it: the same
 * number can't be entered twice at one branch (a voided sale doesn't count).
 * The scan window checks it while the number can still be corrected, and
 * recordSale checks it again.
 */
export async function checkSlipNo(ctx: OpContext, slipNo: string): Promise<void> {
  if (slipNo.length > 40) throw new Error('The receipt number is too long.');
  const sales = await ctx.store.list<Sale>('sales');
  const entered = sales.find((s) => s.slipNo === slipNo && s.locationId === ctx.locationId && s.status === 'completed');
  if (entered) throw new Error(`Receipt no. ${slipNo} was already entered as sale ${entered.receiptNo}. Check the number on the receipt.`);
}

/** Checks a discount the cashier typed: a percentage from just above 0 to 100, or a price of zero or more. */
function checkDiscount(line: CartLine): void {
  const discount = line.discount;
  if (!discount) return;
  const ok =
    discount.kind === 'percent'
      ? Number.isFinite(discount.percent) && discount.percent > 0 && discount.percent <= 100
      : Number.isInteger(discount.price) && discount.price >= 0;
  if (!ok) throw new Error('One of the discounts is not a valid amount.');
}

export interface SaleInput {
  cart: CartLine[];
  payment: Payment;
  /** The customer the sale is for. Required on account, when lending a cylinder, and for prepaid orders. */
  customer?: CustomerRef;
  /** The number of the handwritten receipt the cart was scanned from. */
  slipNo?: string;
  /** The name written on a scanned receipt. Kept on the sale as written; it never adds a customer. */
  registeredName?: string;
  /**
   * When the sale happened, for one entered afterwards from a receipt
   * (saleTimeFor). It becomes the sale's createdAt, and the time of its stock
   * movements and account entries; it can't be in the future. Defaults to now.
   */
  soldAt?: ISODate;
  /** soldAt's time of day was chosen by the app because the receipt gave none. */
  timeEstimated?: boolean;
  /** Paid now and picked up later (Claims window): no stock leaves the shelf yet. */
  prepaid?: boolean;
  /** Sales on credit: the part the customer pays now. The rest goes on their account. */
  downPayment?: Payment;
}

/**
 * Records a sale. A sale can name its customer: their standing discount is
 * applied, and the sale shows in their history. Sales from the Borrowing
 * window always name one: a payment 'on account' adds the total to what they
 * owe, and each borrowed cylinder is noted until it comes back. A prepaid
 * order is paid now and its stock leaves the shelf when it is picked up. A sale
 * scanned from a handwritten receipt keeps the receipt's number (`slipNo`), and
 * the same number can't be entered twice at one branch. It also keeps the name
 * written on it (`registeredName`) and when it happened (`soldAt`), which can
 * be earlier than when it is entered (`recordedAt`).
 */
export async function recordSale(ctx: OpContext, input: SaleInput): Promise<Sale> {
  const user = ctx.user;
  assertCan(user, 'pos.sell');
  if (input.cart.length === 0) throw new Error('The cart is empty.');
  const slipNo = input.slipNo?.trim() || undefined;
  const registeredName = input.registeredName ? tidyName(input.registeredName) || undefined : undefined;
  if (registeredName && registeredName.length > 120) throw new Error('The name on the receipt is too long.');
  const nowDate = ctx.now?.() ?? new Date();
  const now = nowDate.toISOString();
  let at = now;
  if (input.soldAt !== undefined) {
    const sold = new Date(input.soldAt);
    if (Number.isNaN(sold.getTime())) throw new Error('The date of the sale is not a valid date.');
    if (sold.getTime() > nowDate.getTime() + CLOCK_SKEW_MS) throw new Error("The sale's date and time can't be in the future.");
    at = sold.toISOString();
  }
  const onAccount = input.payment.method === 'credit';
  const lendsCylinder = input.cart.some((line) => line.type === 'borrow');
  if ((onAccount || lendsCylinder) && !input.customer) throw new Error('Choose who is borrowing.');
  if (onAccount || lendsCylinder) assertCan(user, 'borrow.manage');
  if (input.payment.method === 'cheque') throw new Error('Post-dated cheques are taken as payments in the Borrowing window.');
  if (input.cart.some((line) => line.discount)) assertCan(user, 'pos.discount');
  input.cart.forEach(checkDiscount);
  const down = input.downPayment;
  if (down) {
    if (!onAccount) throw new Error('Only a sale on credit can be paid in part.');
    if (down.method === 'credit' || down.method === 'cheque') throw new Error('Take a post-dated cheque with Record payment after the sale.');
    if (!Number.isInteger(down.amount) || down.amount <= 0) throw new Error('Enter the amount paid now.');
  }
  if (input.prepaid) {
    if (!input.customer) throw new Error('A prepaid order needs the name of the customer who will pick it up.');
    if (onAccount || lendsCylinder) throw new Error('A prepaid order is paid in full now; it cannot go on account or lend a cylinder.');
  }

  const [products, sets, movements] = await Promise.all([
    ctx.store.list<Product>('products'),
    ctx.store.list<ProductSet>('sets'),
    ctx.store.list<StockMovement>('movements'),
  ]);
  const customer = input.customer ? await resolveCustomer(ctx, input.customer, now) : null;
  const byId = new Map(products.map((p) => [p.id, p]));
  const setsById = new Map(sets.map((s) => [s.id, s]));
  const { lines, total } = priceCart(input.cart, byId, setsById, customer?.customer);
  if (input.payment.amount !== total) throw new Error('The payment does not match the cart total.');
  if (down && down.amount >= total) throw new Error('The amount paid now must be less than the total. A sale paid in full is made in the Sell window.');

  // A prepaid order's stock is checked when it is picked up.
  if (!ALLOW_NEGATIVE_STOCK && !input.prepaid) {
    const shortages = findShortages(input.cart, byId, stockByProduct(movements, ctx.locationId), setsById);
    if (shortages.length > 0) throw new StockError(shortages);
  }

  if (slipNo) await checkSlipNo(ctx, slipNo);

  const borrower = customer ? { borrower: customer.customer, isNew: customer.isNew } : null;
  const seq = ((await ctx.store.get<MetaRecord<number>>('meta', RECEIPT_SEQ_ID))?.value ?? 0) + 1;
  const sale: Sale = {
    id: uuid(),
    receiptNo: `${shortId(ctx.deviceId)}-${seq.toString().padStart(6, '0')}`,
    locationId: ctx.locationId,
    deviceId: ctx.deviceId,
    cashierId: user.id,
    lines,
    total,
    payment: input.payment,
    ...(down ? { downPayment: down } : {}),
    status: 'completed',
    ...(borrower ? { borrowerId: borrower.borrower.id, borrowerName: borrower.borrower.name } : {}),
    ...(slipNo ? { slipNo } : {}),
    ...(registeredName ? { registeredName } : {}),
    ...(input.prepaid ? { prepaid: true, claimCode: claimCode() } : {}),
    createdAt: at,
    ...(input.soldAt !== undefined ? { recordedAt: now, ...(input.timeEstimated ? { timeEstimated: true } : {}) } : {}),
    receivedAt: null,
  };

  const loans: LoanEntry[] = [];
  if (borrower && isBorrowingSale(sale)) {
    // The account entries happen when the sale did.
    if (onAccount) loans.push(loanEntry(ctx, user, borrower.borrower, { kind: 'credit', amount: total, saleId: sale.id }, at));
    if (onAccount && down) {
      loans.push(loanEntry(ctx, user, borrower.borrower, { kind: 'payment', amount: -down.amount, payment: down, saleId: sale.id }, at));
    }
    for (const unit of saleUnits(sale)) {
      if (unit.type !== 'borrow') continue;
      loans.push(
        loanEntry(ctx, user, borrower.borrower, { kind: 'cylinder_out', amount: 0, productId: unit.productId, qty: unit.qty, saleId: sale.id }, at),
      );
    }
  }

  await ctx.store.batch([
    ...(borrower?.isNew ? saveAndQueue('borrowers', [borrower.borrower], now) : []),
    ...saveAndQueue('sales', [sale], now),
    ...saveAndQueue('movements', saleMovements(sale, user.id), now),
    ...saveAndQueue('loans', loans, now),
    put('meta', { id: RECEIPT_SEQ_ID, value: seq }),
  ]);
  return sale;
}

function signFor(input: MovementInput): 1 | -1 {
  switch (input.type) {
    case 'DELIVERY_IN':
      return 1;
    case 'ADJUSTMENT':
      return input.direction === 'add' ? 1 : -1;
    default:
      return -1;
  }
}

/**
 * Records a stock change made by hand. Marking stock as defective moves it out of
 * the full, empty or in-stock count and into the defective count. Stocks Out
 * leaves this branch now and waits at the other one until it is accepted there
 * (acceptTransfer in transfers.ts).
 */
export async function recordMovement(ctx: OpContext, input: MovementInput): Promise<StockMovement[]> {
  const user = ctx.user;
  assertCan(user, 'inventory.record');
  const product = await ctx.store.get<Product>('products', input.productId);
  if (!product) throw new Error('That product no longer exists.');
  if (input.type === 'TRANSFER_OUT') {
    if (input.counterpartLocationId === ctx.locationId) throw new Error('Choose a different branch or warehouse for Stocks Out.');
    if (!(await ctx.store.get<Location>('locations', input.counterpartLocationId))) throw new Error('Choose the branch or warehouse it is sent to.');
  }

  // Accessories are counted as units or defective; cylinders as full, empty or defective.
  const condition: StockCondition =
    input.condition === 'defective' ? 'defective' : product.kind === 'accessory' ? 'unit' : input.condition === 'unit' ? 'full' : input.condition;
  if (condition === 'defective' && input.type === 'DELIVERY_IN') throw new Error('Stock from the depot comes in good condition.');
  if (condition === 'defective' && input.type === 'DAMAGED') throw new Error('Choose whether the defective stock was full or empty.');
  const qty = signFor(input) * input.qty;

  if (qty < 0 && !ALLOW_NEGATIVE_STOCK) {
    const levels = stockByProduct(await ctx.store.list<StockMovement>('movements'), ctx.locationId);
    const available = levelOf(levels, product.id)[condition];
    if (available + qty < 0) {
      throw new StockError([{ productId: product.id, condition, name: `${product.name} (${CONDITION_LABELS[condition].toLowerCase()})`, available, needed: -qty }]);
    }
  }

  const nowDate = ctx.now?.() ?? new Date();
  const now = nowDate.toISOString();
  // Back-dated entries are placed at noon of the chosen day.
  const occurredAt =
    input.day === localDay(nowDate) ? now : new Date(parseDay(input.day).getTime() + 12 * 3_600_000).toISOString();

  const movement = (as: StockCondition, change: number, id = uuid()): StockMovement => ({
    id,
    type: input.type,
    productId: product.id,
    locationId: ctx.locationId,
    condition: as,
    qty: change,
    reason: input.reason || undefined,
    counterpartLocationId: input.counterpartLocationId || undefined,
    ...(input.type === 'TRANSFER_OUT' ? { transferId: id } : {}),
    userId: user.id,
    deviceId: ctx.deviceId,
    occurredAt,
    createdAt: now,
    receivedAt: null,
  });
  const movements = input.type === 'DAMAGED' ? [movement(condition, qty), movement('defective', -qty)] : [movement(condition, qty)];
  await ctx.store.batch(saveAndQueue('movements', movements, now));
  return movements;
}

/**
 * Voiding keeps the sale (marked voided) and adds movements that put the stock
 * back. A Borrowing-window sale also takes its refill off the borrower's account
 * and its borrowed cylinders off their list.
 */
export async function voidSale(ctx: OpContext, saleId: string, reason: string): Promise<Sale> {
  const user = ctx.user;
  assertCan(user, 'sales.void');
  const sale = await ctx.store.get<Sale>('sales', saleId);
  if (!sale) throw new Error('Sale not found.');
  if (sale.status === 'voided') throw new Error('This sale is already voided.');
  const now = (ctx.now?.() ?? new Date()).toISOString();
  const { voided, ops } = await voidSaleOps(ctx, user, sale, reason, now);
  await ctx.store.batch(ops);
  return voided;
}

/**
 * The records that void a sale, for saving in one batch with anything else
 * (an approved return that gives everything back voids its sale). Every stock
 * movement the sale made is reversed: the sale itself, pick ups and earlier
 * returns, so the shelf ends up as if the sale never happened.
 */
export async function voidSaleOps(
  ctx: OpContext,
  user: User,
  sale: Sale,
  reason: string,
  now: string,
): Promise<{ voided: Sale; ops: StoreOp[] }> {
  const reversals: StockMovement[] = (await ctx.store.list<StockMovement>('movements'))
    .filter((m) => m.saleId === sale.id && m.type !== 'VOID_REVERSAL' && m.type !== 'DEFECTIVE_EXCHANGE')
    .map((m) => ({
      ...m,
      id: uuid(),
      type: 'VOID_REVERSAL',
      qty: -m.qty,
      reason,
      userId: user.id,
      deviceId: ctx.deviceId,
      occurredAt: now,
      createdAt: now,
      receivedAt: null,
    }));

  const loanReversals: LoanEntry[] = [];
  if (sale.borrowerId) {
    const theirs = (await ctx.store.list<LoanEntry>('loans')).filter((e) => e.borrowerId === sale.borrowerId);
    const reversed = new Set(theirs.map((e) => e.reverses));
    for (const entry of theirs) {
      // The part paid when a sale on credit was made is given back with it.
      if (entry.saleId !== sale.id || reversed.has(entry.id) || (entry.kind !== 'credit' && entry.kind !== 'cylinder_out' && entry.kind !== 'payment')) continue;
      if (entry.kind === 'cylinder_out') {
        const stillOut = theirs.filter((e) => e.productId === entry.productId).reduce((sum, e) => sum + (e.qty ?? 0), 0);
        if (stillOut < (entry.qty ?? 0)) {
          throw new Error(
            "The cylinder borrowed in this sale has already been returned, so the sale can't be voided. Record an Adjustment in Inventory instead.",
          );
        }
      }
      loanReversals.push({
        ...entry,
        id: uuid(),
        kind: 'void',
        amount: -entry.amount,
        ...(entry.qty !== undefined ? { qty: -entry.qty } : {}),
        reverses: entry.id,
        note: reason,
        locationId: ctx.locationId,
        userId: user.id,
        deviceId: ctx.deviceId,
        occurredAt: now,
        createdAt: now,
        receivedAt: null,
      });
    }
  }
  const voided: Sale = { ...sale, status: 'voided', voidReason: reason, voidedBy: user.id, voidedAt: now, receivedAt: null };
  return {
    voided,
    ops: [...saveAndQueue('sales', [voided], now), ...saveAndQueue('movements', reversals, now), ...saveAndQueue('loans', loanReversals, now)],
  };
}

const DEVICE_SETTINGS_ID = 'device-settings';

export async function loadDeviceSettings(store: ObservableStore, defaultLocationId: string): Promise<DeviceSettings> {
  const saved = await store.get<MetaRecord<DeviceSettings>>('meta', DEVICE_SETTINGS_ID);
  return saved?.value ?? { locationId: defaultLocationId, paperWidthMm: 58 };
}

export async function saveDeviceSettings(store: ObservableStore, settings: DeviceSettings): Promise<void> {
  await store.batch([put('meta', { id: DEVICE_SETTINGS_ID, value: settings })]);
}

/** Deletes everything in the local database (used by "Reset demo data"). */
export async function clearLocalData(store: ObservableStore): Promise<void> {
  const ops: StoreOp[] = [];
  for (const collection of COLLECTIONS) {
    for (const record of await store.list(collection)) ops.push(remove(collection, record.id));
  }
  await store.batch(ops);
}
