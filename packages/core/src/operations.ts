/**
 * The things people do in SGM, written once for both apps. Each operation
 * checks permissions, saves its records in one transaction, and queues them
 * in the outbox for the server.
 */
import { cartDemand, priceCart, saleMovements, type CartLine } from './cart';
import { ALLOW_NEGATIVE_STOCK } from './config';
import { localDay, parseDay } from './dates';
import { shortId, uuid } from './ids';
import { levelOf, sellable, stockByProduct, type StockLevel } from './ledger';
import type { DeviceSettings, MetaRecord, OutboxEntry, Payment, Product, Sale, StockMovement, User } from './models';
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

export function outboxEntry(collection: OutboxEntry['collection'], record: Sale | StockMovement, now: string): OutboxEntry {
  return { id: uuid(), collection, recordId: record.id, payload: record, createdAt: now, attempts: 0 };
}

/** Lines in the cart that need more sellable stock than the branch has. */
export function findShortages(
  cart: Pick<CartLine, 'productId' | 'qty'>[],
  products: Map<string, Product>,
  levels: Map<string, StockLevel>,
): Shortage[] {
  const shortages: Shortage[] = [];
  for (const [productId, needed] of cartDemand(cart)) {
    const product = products.get(productId);
    if (!product) continue;
    const available = sellable(product, levelOf(levels, productId));
    if (available < needed) shortages.push({ productId, name: product.name, available, needed });
  }
  return shortages;
}

const RECEIPT_SEQ_ID = 'receipt-seq';

export async function recordSale(ctx: OpContext, input: { cart: CartLine[]; payment: Payment }): Promise<Sale> {
  const user = ctx.user;
  assertCan(user, 'pos.sell');
  if (input.cart.length === 0) throw new Error('The cart is empty.');

  const [products, movements] = await Promise.all([
    ctx.store.list<Product>('products'),
    ctx.store.list<StockMovement>('movements'),
  ]);
  const byId = new Map(products.map((p) => [p.id, p]));
  const { lines, total } = priceCart(input.cart, byId);
  if (input.payment.amount !== total) throw new Error('The payment does not match the cart total.');

  if (!ALLOW_NEGATIVE_STOCK) {
    const shortages = findShortages(input.cart, byId, stockByProduct(movements, ctx.locationId));
    if (shortages.length > 0) throw new StockError(shortages);
  }

  const now = (ctx.now?.() ?? new Date()).toISOString();
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
    createdAt: now,
    receivedAt: null,
  };
  const saleMoves = saleMovements(sale, user.id);

  await ctx.store.batch([
    put('sales', sale),
    ...saleMoves.map((m) => put('movements', m)),
    put('meta', { id: RECEIPT_SEQ_ID, value: seq }),
    put('outbox', outboxEntry('sales', sale, now)),
    ...saleMoves.map((m) => put('outbox', outboxEntry('movements', m, now))),
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
    throw new Error('Choose a different branch or warehouse for a transfer.');
  }

  const condition = product.kind === 'accessory' ? 'unit' : input.condition === 'unit' ? 'full' : input.condition;
  const qty = signFor(input) * input.qty;

  if (qty < 0 && !ALLOW_NEGATIVE_STOCK) {
    const levels = stockByProduct(await ctx.store.list<StockMovement>('movements'), ctx.locationId);
    const available = levelOf(levels, product.id)[condition];
    if (available + qty < 0) {
      throw new StockError([{ productId: product.id, name: `${product.name} (${condition})`, available, needed: -qty }]);
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
  await ctx.store.batch([put('movements', movement), put('outbox', outboxEntry('movements', movement, now))]);
  return movement;
}

/** Voiding keeps the sale (marked voided) and adds movements that put the stock back. */
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
  const voided: Sale = { ...sale, status: 'voided', voidReason: reason, voidedBy: user.id, voidedAt: now, receivedAt: null };

  await ctx.store.batch([
    put('sales', voided),
    ...reversals.map((m) => put('movements', m)),
    put('outbox', outboxEntry('sales', voided, now)),
    ...reversals.map((m) => put('outbox', outboxEntry('movements', m, now))),
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
