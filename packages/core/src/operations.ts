/**
 * The things people do in SGM, written once for both apps. Each operation
 * checks permissions, saves its records in one transaction, and queues them
 * in the outbox for the server.
 */
import { priceCart, productUnits, saleMovements, saleUnits, stockChanges, type CartLine } from './cart';
import { ALLOW_NEGATIVE_STOCK } from './config';
import { localDay, parseDay } from './dates';
import { shortId, uuid } from './ids';
import { levelOf, NO_STOCK, stockByProduct, type StockLevel } from './ledger';
import type {
  Borrower,
  DeviceSettings,
  LoanEntry,
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

/** Who a Borrowing-window sale is for: someone already on the list (id), or a new borrower. */
export interface BorrowerRef {
  id?: string;
  name: string;
  phone?: string;
}

/** Finds the borrower, or makes a new one (refusing a second borrower with the same name). */
async function resolveBorrower(ctx: OpContext, ref: BorrowerRef, now: string): Promise<{ borrower: Borrower; isNew: boolean }> {
  const borrowers = await ctx.store.list<Borrower>('borrowers');
  if (ref.id) {
    const borrower = borrowers.find((b) => b.id === ref.id);
    if (!borrower) throw new Error('That borrower is no longer on the list.');
    return { borrower, isNew: false };
  }
  const name = ref.name.trim().replace(/\s+/g, ' ');
  if (name.length < 2) throw new Error("Enter the borrower's name.");
  if (borrowers.some((b) => b.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`${name} is already on the list of borrowers. Choose them instead of adding them again.`);
  }
  const phone = ref.phone?.trim();
  const borrower: Borrower = { id: uuid(), name, ...(phone ? { phone } : {}), createdAt: now, receivedAt: null };
  return { borrower, isNew: true };
}

export function loanEntry(
  ctx: OpContext,
  user: User,
  borrower: Pick<Borrower, 'id' | 'name'>,
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

/**
 * Checks the number of a handwritten receipt before a sale keeps it: the same
 * number can't be entered twice at one branch (a voided sale doesn't count).
 * The Sell screen checks it when a scan is confirmed, while the number can
 * still be corrected, and recordSale checks it again.
 */
export async function checkSlipNo(ctx: OpContext, slipNo: string): Promise<void> {
  if (slipNo.length > 40) throw new Error('The receipt number is too long.');
  const sales = await ctx.store.list<Sale>('sales');
  const entered = sales.find((s) => s.slipNo === slipNo && s.locationId === ctx.locationId && s.status === 'completed');
  if (entered) throw new Error(`Receipt no. ${slipNo} was already entered as sale ${entered.receiptNo}. Check the number on the receipt.`);
}

/**
 * Records a sale. Sales from the Borrowing window also name the borrower: a
 * payment 'on account' adds the total to what they owe, and each borrowed
 * cylinder is noted until it comes back. A sale scanned from a handwritten
 * receipt keeps the receipt's number (`slipNo`), and the same number can't be
 * entered twice at one branch.
 */
export async function recordSale(
  ctx: OpContext,
  input: { cart: CartLine[]; payment: Payment; borrower?: BorrowerRef; slipNo?: string },
): Promise<Sale> {
  const user = ctx.user;
  assertCan(user, 'pos.sell');
  if (input.cart.length === 0) throw new Error('The cart is empty.');
  const slipNo = input.slipNo?.trim() || undefined;
  const onAccount = input.payment.method === 'credit';
  const lendsCylinder = input.cart.some((line) => line.type === 'borrow');
  if ((onAccount || lendsCylinder) && !input.borrower) throw new Error('Choose who is borrowing.');
  if (onAccount || lendsCylinder) assertCan(user, 'borrow.manage');

  const [products, sets, movements] = await Promise.all([
    ctx.store.list<Product>('products'),
    ctx.store.list<ProductSet>('sets'),
    ctx.store.list<StockMovement>('movements'),
  ]);
  const byId = new Map(products.map((p) => [p.id, p]));
  const setsById = new Map(sets.map((s) => [s.id, s]));
  const { lines, total } = priceCart(input.cart, byId, setsById);
  if (input.payment.amount !== total) throw new Error('The payment does not match the cart total.');

  if (!ALLOW_NEGATIVE_STOCK) {
    const shortages = findShortages(input.cart, byId, stockByProduct(movements, ctx.locationId), setsById);
    if (shortages.length > 0) throw new StockError(shortages);
  }

  if (slipNo) await checkSlipNo(ctx, slipNo);

  const now = (ctx.now?.() ?? new Date()).toISOString();
  const borrower = input.borrower ? await resolveBorrower(ctx, input.borrower, now) : null;
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
    status: 'completed',
    ...(borrower ? { borrowerId: borrower.borrower.id, borrowerName: borrower.borrower.name } : {}),
    ...(slipNo ? { slipNo } : {}),
    createdAt: now,
    receivedAt: null,
  };

  const loans: LoanEntry[] = [];
  if (borrower) {
    if (onAccount) loans.push(loanEntry(ctx, user, borrower.borrower, { kind: 'credit', amount: total, saleId: sale.id }, now));
    for (const unit of saleUnits(sale)) {
      if (unit.type !== 'borrow') continue;
      loans.push(
        loanEntry(ctx, user, borrower.borrower, { kind: 'cylinder_out', amount: 0, productId: unit.productId, qty: unit.qty, saleId: sale.id }, now),
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
    case 'TRANSFER_IN':
      return 1;
    case 'ADJUSTMENT':
      return input.direction === 'add' ? 1 : -1;
    default:
      return -1;
  }
}

export async function recordMovement(ctx: OpContext, input: MovementInput): Promise<StockMovement> {
  const user = ctx.user;
  assertCan(user, 'inventory.record');
  const product = await ctx.store.get<Product>('products', input.productId);
  if (!product) throw new Error('That product no longer exists.');
  if ((input.type === 'TRANSFER_IN' || input.type === 'TRANSFER_OUT') && input.counterpartLocationId === ctx.locationId) {
    throw new Error('Choose a different branch or warehouse for Stocks In or Stocks Out.');
  }

  const condition = product.kind === 'accessory' ? 'unit' : input.condition === 'unit' ? 'full' : input.condition;
  const qty = signFor(input) * input.qty;

  if (qty < 0 && !ALLOW_NEGATIVE_STOCK) {
    const levels = stockByProduct(await ctx.store.list<StockMovement>('movements'), ctx.locationId);
    const available = levelOf(levels, product.id)[condition];
    if (available + qty < 0) {
      throw new StockError([{ productId: product.id, condition, name: `${product.name} (${condition})`, available, needed: -qty }]);
    }
  }

  const nowDate = ctx.now?.() ?? new Date();
  const now = nowDate.toISOString();
  // Back-dated entries are placed at noon of the chosen day.
  const occurredAt =
    input.day === localDay(nowDate) ? now : new Date(parseDay(input.day).getTime() + 12 * 3_600_000).toISOString();

  const movement: StockMovement = {
    id: uuid(),
    type: input.type,
    productId: product.id,
    locationId: ctx.locationId,
    condition,
    qty,
    reason: input.reason || undefined,
    counterpartLocationId: input.counterpartLocationId || undefined,
    userId: user.id,
    deviceId: ctx.deviceId,
    occurredAt,
    createdAt: now,
    receivedAt: null,
  };
  await ctx.store.batch(saveAndQueue('movements', [movement], now));
  return movement;
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
  const reversals: StockMovement[] = (await ctx.store.list<StockMovement>('movements'))
    .filter((m) => m.saleId === sale.id && m.type !== 'VOID_REVERSAL')
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
      if (entry.saleId !== sale.id || reversed.has(entry.id) || (entry.kind !== 'credit' && entry.kind !== 'cylinder_out')) continue;
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

  await ctx.store.batch([
    ...saveAndQueue('sales', [voided], now),
    ...saveAndQueue('movements', reversals, now),
    ...saveAndQueue('loans', loanReversals, now),
  ]);
  return voided;
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
