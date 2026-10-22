/**
 * Sample data and a pretend server, so the apps work before the real API
 * server exists. Nothing here should ship to the stores: replace DemoApi with
 * HttpApi (set EXPO_PUBLIC_API_URL) and load real products from the server.
 */
import { ApiError, type ApiClient, type LoginResult, type PullResult, type PushResult } from './api';
import { APP_STATUS_OK, type AppStatus } from './app-policy';
import { priceCart, saleMovements, type CartLine } from './cart';
import { levelOf, sellable, stockByProduct } from './ledger';
import type { Borrower, LoanEntry, Location, OutboxEntry, Payment, Product, ProductSet, Sale, StockMovement, User } from './models';
import { peso } from './money';
import { findShortages } from './operations';
import { put, type ObservableStore, type StoreOp } from './store';

export const DEMO_LOCATIONS: Location[] = [
  { id: 'branch-main', name: 'Main Branch', kind: 'branch' },
  { id: 'branch-2', name: 'Branch 2', kind: 'branch' },
  { id: 'warehouse', name: 'Warehouse', kind: 'warehouse' },
];

export const DEMO_USERS: User[] = [
  {
    id: 'u-owner',
    username: 'owner',
    displayName: 'Owner (demo)',
    role: 'owner',
    locationIds: DEMO_LOCATIONS.map((l) => l.id),
    active: true,
  },
  {
    id: 'u-cashier',
    username: 'cashier',
    displayName: 'Cashier (demo)',
    role: 'employee',
    locationIds: ['branch-main'],
    active: true,
  },
  {
    id: 'u-warehouse',
    username: 'warehouse',
    displayName: 'Warehouse staff (demo)',
    role: 'warehouse',
    locationIds: ['warehouse'],
    active: true,
  },
];

/** Demo sign-ins. Real PINs live only on the server, stored as salted hashes. */
export const DEMO_ACCOUNTS = [
  { username: 'owner', pin: '1111', userId: 'u-owner' },
  { username: 'cashier', pin: '2222', userId: 'u-cashier' },
  { username: 'warehouse', pin: '3333', userId: 'u-warehouse' },
];

const cylinder = (id: string, brand: string, sizeKg: number, refill: number, price: number, lowStockAt: number): Product => ({
  id,
  sku: id.toUpperCase(),
  name: `${brand} ${sizeKg} kg`,
  kind: 'cylinder',
  brand,
  sizeKg,
  refillPrice: peso(refill),
  price: peso(price),
  lowStockAt,
  active: true,
});

const accessory = (id: string, name: string, price: number, lowStockAt: number): Product => ({
  id,
  sku: id.toUpperCase(),
  name,
  kind: 'accessory',
  price: peso(price),
  lowStockAt,
  active: true,
});

/** Sample brands and prices only; the owner sets the real ones. */
export const DEMO_PRODUCTS: Product[] = [
  cylinder('lpg-a-2.7', 'Brand A', 2.7, 280, 1250, 4),
  cylinder('lpg-a-11', 'Brand A', 11, 950, 2750, 10),
  cylinder('lpg-b-11', 'Brand B', 11, 920, 2650, 10),
  cylinder('lpg-a-22', 'Brand A', 22, 1900, 4800, 3),
  cylinder('lpg-a-50', 'Brand A', 50, 4300, 9500, 2),
  accessory('acc-regulator', 'LPG regulator', 450, 5),
  accessory('acc-hose', 'LPG hose (1.5 m)', 180, 5),
  accessory('acc-stove', 'Single-burner stove', 1200, 2),
];

/** Sample bundles; the owner makes the real ones on the Products page. */
export const DEMO_SETS: ProductSet[] = [
  {
    id: 'set-starter-11',
    name: 'Starter kit 11 kg',
    items: [
      { productId: 'lpg-a-11', type: 'new', qty: 1 },
      { productId: 'acc-regulator', type: 'item', qty: 1 },
      { productId: 'acc-hose', type: 'item', qty: 1 },
    ],
    price: peso(3250),
    active: true,
  },
  {
    id: 'set-kitchen',
    name: 'Kitchen set',
    items: [
      { productId: 'lpg-a-11', type: 'new', qty: 1 },
      { productId: 'acc-stove', type: 'item', qty: 1 },
      { productId: 'acc-regulator', type: 'item', qty: 1 },
      { productId: 'acc-hose', type: 'item', qty: 1 },
    ],
    price: peso(4350),
    active: true,
  },
  {
    id: 'set-two-refills',
    name: 'Two 11 kg refills',
    items: [{ productId: 'lpg-a-11', type: 'refill', qty: 2 }],
    price: peso(1880),
    active: true,
  },
];

/** [productId, full (or units), empty] per location. */
const OPENING_STOCK: Record<string, [string, number, number][]> = {
  'branch-main': [
    ['lpg-a-2.7', 12, 4],
    ['lpg-a-11', 40, 15],
    ['lpg-b-11', 26, 8],
    ['lpg-a-22', 8, 3],
    ['lpg-a-50', 3, 1],
    ['acc-regulator', 15, 0],
    ['acc-hose', 20, 0],
    ['acc-stove', 4, 0],
  ],
  'branch-2': [
    ['lpg-a-2.7', 6, 2],
    ['lpg-a-11', 18, 6],
    ['lpg-b-11', 12, 4],
    ['acc-regulator', 6, 0],
    ['acc-hose', 8, 0],
  ],
  warehouse: [
    ['lpg-a-2.7', 60, 20],
    ['lpg-a-11', 220, 80],
    ['lpg-b-11', 150, 40],
    ['lpg-a-22', 40, 12],
    ['lpg-a-50', 15, 5],
    ['acc-regulator', 80, 0],
    ['acc-hose', 100, 0],
    ['acc-stove', 25, 0],
  ],
};

/** Small seeded random generator, so the sample sales are the same every time. */
function seededRandom(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fills an empty local database with sample branches, users, products, stock, a week of sales and some borrowing. */
export async function seedDemoData(store: ObservableStore, now = new Date()): Promise<boolean> {
  if ((await store.list('products')).length > 0) return false;

  const ops: StoreOp[] = [];
  DEMO_LOCATIONS.forEach((l) => ops.push(put('locations', l)));
  DEMO_USERS.forEach((u) => ops.push(put('users', u)));
  DEMO_PRODUCTS.forEach((p) => ops.push(put('products', p)));
  DEMO_SETS.forEach((s) => ops.push(put('sets', s)));

  const day = 86_400_000;
  const openingAt = new Date(now.getTime() - 8 * day).toISOString();
  const movements: StockMovement[] = [];
  for (const [locationId, rows] of Object.entries(OPENING_STOCK)) {
    for (const [productId, full, empty] of rows) {
      const product = DEMO_PRODUCTS.find((p) => p.id === productId)!;
      const base = {
        type: 'OPENING' as const,
        productId,
        locationId,
        userId: 'u-owner',
        deviceId: 'demo-seed',
        occurredAt: openingAt,
        createdAt: openingAt,
        receivedAt: openingAt,
      };
      if (product.kind === 'accessory') {
        movements.push({ ...base, id: `open-${locationId}-${productId}`, condition: 'unit', qty: full });
      } else {
        movements.push({ ...base, id: `open-${locationId}-${productId}-full`, condition: 'full', qty: full });
        movements.push({ ...base, id: `open-${locationId}-${productId}-empty`, condition: 'empty', qty: empty });
      }
    }
  }

  const productsById = new Map(DEMO_PRODUCTS.map((p) => [p.id, p]));
  let seq = 0;
  const addSale = (cart: CartLine[], at: Date, payment: (total: number) => Payment, borrower?: Borrower): Sale => {
    const { lines, total } = priceCart(cart, productsById);
    const createdAt = at.toISOString();
    seq += 1;
    const sale: Sale = {
      id: `demo-sale-${seq}`,
      receiptNo: `DEMO-${seq.toString().padStart(6, '0')}`,
      locationId: 'branch-main',
      deviceId: 'demo-seed',
      cashierId: 'u-cashier',
      lines,
      total,
      payment: payment(total),
      status: 'completed',
      ...(borrower ? { borrowerId: borrower.id, borrowerName: borrower.name } : {}),
      createdAt,
      receivedAt: createdAt,
    };
    ops.push(put('sales', sale));
    movements.push(...saleMovements(sale, 'u-cashier').map((m) => ({ ...m, receivedAt: createdAt })));
    return sale;
  };

  // A week of sample sales at the main branch, so the dashboard and reports have something to show.
  const random = seededRandom(42);
  const weighted = ['lpg-a-11', 'lpg-a-11', 'lpg-a-11', 'lpg-b-11', 'lpg-b-11', 'lpg-a-2.7', 'lpg-a-22', 'acc-regulator', 'acc-hose', 'lpg-a-50'];
  for (let daysAgo = 6; daysAgo >= 0; daysAgo--) {
    const count = daysAgo === 0 ? 3 : 4 + Math.floor(random() * 5);
    const start = new Date(now.getTime() - daysAgo * day);
    start.setHours(8, 0, 0, 0);
    for (let i = 0; i < count; i++) {
      const at =
        daysAgo === 0
          ? new Date(now.getTime() - (count - i) * 25 * 60_000)
          : new Date(start.getTime() + (i / count) * 10 * 3_600_000 + random() * 30 * 60_000);
      const product = productsById.get(weighted[Math.floor(random() * weighted.length)])!;
      const qty = random() < 0.85 ? 1 : 2;
      const cart: CartLine[] = [
        { productId: product.id, type: product.kind === 'accessory' ? 'item' : random() < 0.8 ? 'refill' : 'new', qty },
      ];
      // Keep sample stock above the low-stock line, except 50 kg, so the dashboard shows one warning.
      const levels = stockByProduct(movements, 'branch-main');
      const floor = product.id === 'lpg-a-50' ? 0 : product.lowStockAt + 1;
      if (sellable(product, levelOf(levels, product.id)) - qty < floor) continue;
      if (findShortages(cart, productsById, levels).length > 0) continue;

      const cash = random() < 0.75;
      addSale(cart, at, (total) => {
        const tendered = cash ? Math.ceil(total / 10_000) * 10_000 : total;
        return {
          method: cash ? 'cash' : 'gcash',
          amount: total,
          tendered,
          change: tendered - total,
          reference: cash ? undefined : `GC${(1_000_000 + seq * 7919).toString()}`,
        };
      });
    }
  }

  // Sample borrowing: a refill on credit, part paid; a cylinder lent; a cylinder lent with its refill on account.
  const daysAgoAt = (days: number, hour: number) => {
    const at = new Date(now.getTime() - days * day);
    at.setHours(hour, 15, 0, 0);
    return at;
  };
  const borrower = (id: string, name: string, phone: string, since: Date): Borrower => ({
    id,
    name,
    phone,
    createdAt: since.toISOString(),
    receivedAt: since.toISOString(),
  });
  const loans: LoanEntry[] = [];
  const loan = (who: Borrower, at: Date, fields: Pick<LoanEntry, 'kind' | 'amount'> & Partial<LoanEntry>) =>
    loans.push({
      id: `demo-loan-${loans.length + 1}`,
      borrowerId: who.id,
      borrowerName: who.name,
      locationId: 'branch-main',
      userId: 'u-cashier',
      deviceId: 'demo-seed',
      occurredAt: at.toISOString(),
      createdAt: at.toISOString(),
      receivedAt: at.toISOString(),
      ...fields,
    });
  const credit = (total: number): Payment => ({ method: 'credit', amount: total, tendered: 0, change: 0 });
  const cashExact = (total: number): Payment => ({ method: 'cash', amount: total, tendered: total, change: 0 });

  const maria = borrower('demo-borrower-maria', 'Maria Santos', '0917 555 0142', daysAgoAt(5, 9));
  const onCredit = addSale([{ productId: 'lpg-a-11', type: 'refill', qty: 1 }], daysAgoAt(5, 9), credit, maria);
  loan(maria, daysAgoAt(5, 9), { kind: 'credit', amount: onCredit.total, saleId: onCredit.id });
  loan(maria, daysAgoAt(2, 16), {
    kind: 'payment',
    amount: -peso(500),
    payment: { method: 'cash', amount: peso(500), tendered: peso(500), change: 0 },
  });

  const jun = borrower('demo-borrower-jun', 'Jun Dela Cruz', '0918 555 0199', daysAgoAt(3, 11));
  const lent = addSale([{ productId: 'lpg-a-2.7', type: 'borrow', qty: 1 }], daysAgoAt(3, 11), cashExact, jun);
  loan(jun, daysAgoAt(3, 11), { kind: 'cylinder_out', amount: 0, productId: 'lpg-a-2.7', qty: 1, saleId: lent.id });

  const rosa = borrower('demo-borrower-rosa', 'Rosa Reyes', '0927 555 0123', daysAgoAt(1, 14));
  const both = addSale([{ productId: 'lpg-b-11', type: 'borrow', qty: 1 }], daysAgoAt(1, 14), credit, rosa);
  loan(rosa, daysAgoAt(1, 14), { kind: 'credit', amount: both.total, saleId: both.id });
  loan(rosa, daysAgoAt(1, 14), { kind: 'cylinder_out', amount: 0, productId: 'lpg-b-11', qty: 1, saleId: both.id });

  [maria, jun, rosa].forEach((b) => ops.push(put('borrowers', b)));
  loans.forEach((l) => ops.push(put('loans', l)));
  movements.forEach((m) => ops.push(put('movements', m)));
  await store.batch(ops);
  return true;
}

/**
 * Pretends to be the API server. Toggle `online` to see how the apps behave
 * when the connection drops.
 */
export class DemoApi implements ApiClient {
  readonly mode = 'demo';
  online = true;

  constructor(private readonly options: { latencyMs?: number; now?: () => Date } = {}) {}

  async login(username: string, pin: string): Promise<LoginResult> {
    await this.roundTrip();
    const account = DEMO_ACCOUNTS.find((a) => a.username === username && a.pin === pin);
    const user = DEMO_USERS.find((u) => u.id === account?.userId);
    if (!account || !user || !user.active) throw new ApiError('auth', 'Wrong username or PIN.', 401);
    const now = this.now();
    return {
      token: `demo.${user.id}.${now.getTime()}`,
      user,
      expiresAt: new Date(now.getTime() + 12 * 3_600_000).toISOString(),
    };
  }

  async push(entries: OutboxEntry[]): Promise<PushResult> {
    await this.roundTrip();
    const receivedAt = this.now().toISOString();
    return { accepted: entries.map((entry) => ({ id: entry.id, receivedAt })), rejected: [] };
  }

  async pull(cursor: string | null): Promise<PullResult> {
    await this.roundTrip();
    return { cursor: cursor ?? 'demo', changes: [] };
  }

  async appStatus(): Promise<AppStatus> {
    return APP_STATUS_OK;
  }

  private async roundTrip(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, this.options.latencyMs ?? 300));
    if (!this.online) throw new ApiError('network', "Can't reach the SGM server.");
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}
