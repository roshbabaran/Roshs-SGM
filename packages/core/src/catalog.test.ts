import { describe, expect, it } from 'vitest';

import { addSetToCart, priceCart, saleMovements, type CartLine } from './cart';
import { describeSet, describeSetParts, regularPrice, saveProduct, saveSet, setsContaining, skuFrom, suggestedSetPrice } from './catalog';
import { NEW_SALE_TAKES_EMPTY } from './config';
import { DEMO_PRODUCTS, DEMO_SETS, DEMO_USERS, seedDemoData } from './demo';
import { levelOf, stockByProduct } from './ledger';
import type { Product, ProductSet, Sale, StockMovement, User } from './models';
import { findShortages, recordSale, StockError, type OpContext } from './operations';
import { buildReceipt, receiptText } from './receipt';
import { productTotals } from './reports';
import { PermissionError } from './roles';
import { MemoryStore, ObservableStore } from './store';
import { productFormSchema, setFormSchema } from './validation';

const [owner, cashier] = DEMO_USERS as [User, User, User];
const products = new Map(DEMO_PRODUCTS.map((p) => [p.id, p]));
const sets = new Map(DEMO_SETS.map((s) => [s.id, s]));
const starter = sets.get('set-starter-11')!;

async function setup() {
  const store = new ObservableStore(new MemoryStore());
  await seedDemoData(store);
  const ctx = (user: User): OpContext => ({ store, user, deviceId: 'a1b2c3d4-0000-4000-8000-000000000000', locationId: 'branch-main' });
  const stock = async (productId: string) => levelOf(stockByProduct(await store.list<StockMovement>('movements'), 'branch-main'), productId);
  return { store, ctx, stock };
}

const productForm = (overrides: Record<string, unknown> = {}) =>
  productFormSchema.parse({
    kind: 'cylinder',
    name: 'Brand C 11 kg',
    sku: '',
    brand: 'Brand C',
    sizeKg: '11',
    refillPrice: '900',
    cylinderPrice: '1,700',
    price: '',
    lowStockAt: '5',
    active: true,
    ...overrides,
  });

describe('products', () => {
  it('lets the owner add a product, with a code made from its name', async () => {
    const { store, ctx } = await setup();
    const product = await saveProduct(ctx(owner), productForm());
    expect(product).toMatchObject({ sku: 'BRAND-C-11-KG', kind: 'cylinder', sizeKg: 11, refillPrice: 90000, price: 260000 });
    expect(await store.get<Product>('products', product.id)).toEqual(product);
  });

  it('refuses a cashier, a duplicate name, and a cylinder without its own price', async () => {
    const { ctx } = await setup();
    await expect(saveProduct(ctx(cashier), productForm())).rejects.toBeInstanceOf(PermissionError);
    await expect(saveProduct(ctx(owner), productForm({ name: 'brand a 11 kg' }))).rejects.toThrow('already a product called');
    const free = productFormSchema.safeParse({ kind: 'cylinder', name: 'Brand C 11 kg', sku: '', brand: '', sizeKg: '11', refillPrice: '900', cylinderPrice: '0', price: '', lowStockAt: '5', active: true });
    expect(free.error?.issues[0]?.message).toContain('price of the empty cylinder');
  });

  it('changes prices without changing the code', async () => {
    const { ctx } = await setup();
    const updated = await saveProduct(ctx(owner), productForm({ name: 'Brand A 11 kg', refillPrice: '980' }), 'lpg-a-11');
    expect(updated).toMatchObject({ id: 'lpg-a-11', sku: 'LPG-A-11', refillPrice: 98000 });
  });

  it('makes readable codes', () => {
    expect(skuFrom('Single-burner stove')).toBe('SINGLE-BURNER-STOVE');
    expect(skuFrom('Brand A 2.7 kg')).toBe('BRAND-A-2.7-KG');
  });
});

describe('sets', () => {
  it('costs less than its items bought one by one', () => {
    expect(regularPrice(starter, products)).toBe(275000 + 45000 + 18000);
    expect(starter.price).toBeLessThan(regularPrice(starter, products));
  });

  it('takes each item off the shelf when sold', async () => {
    const { ctx, stock } = await setup();
    const before = { lpg: await stock('lpg-a-11'), regulator: await stock('acc-regulator'), hose: await stock('acc-hose') };
    const sale = await recordSale(ctx(cashier), { cart: addSetToCart([], starter), payment: { method: 'cash', amount: starter.price, tendered: starter.price, change: 0 } });

    expect(sale.lines).toHaveLength(1);
    expect(sale.total).toBe(starter.price);
    expect((await stock('lpg-a-11')).full).toBe(before.lpg.full - 1);
    expect((await stock('lpg-a-11')).empty).toBe(before.lpg.empty - (NEW_SALE_TAKES_EMPTY ? 1 : 0));
    expect((await stock('acc-regulator')).unit).toBe(before.regulator.unit - 1);
    expect((await stock('acc-hose')).unit).toBe(before.hose.unit - 1);

    const receipt = buildReceipt(sale, { locationName: 'Main Branch', cashierName: 'Cashier' });
    expect(receipt.lines[0]?.name).toBe('Starter kit 11 kg (set)');
    expect(receipt.lines[0]?.rows.map((r) => r.detail)).toEqual([
      '1 x ₱3,250.00',
      '- 1 x Brand A 11 kg (new cylinder)',
      '- 1 x LPG regulator',
      '- 1 x LPG hose (1.5 m)',
    ]);
    expect(productTotals([sale])).toEqual([{ key: 'set:set-starter-11', name: 'Starter kit 11 kg (set)', qty: 1, amount: starter.price }]);
  });

  it("refuses a set when one of its items is out of stock", async () => {
    const { ctx, stock } = await setup();
    const stoves = (await stock('acc-stove')).unit;
    const kitchen = sets.get('set-kitchen')!;
    const cart: CartLine[] = [{ type: 'set', setId: kitchen.id, qty: stoves + 1 }];
    const total = kitchen.price * (stoves + 1);
    await expect(recordSale(ctx(cashier), { cart, payment: { method: 'cash', amount: total, tendered: total, change: 0 } })).rejects.toBeInstanceOf(StockError);
  });

  it('checks the set form', () => {
    const form = { name: 'Promo', items: [{ productId: 'lpg-a-11', type: 'refill', qty: '2' }], sets: [] as { setId: string; qty: string }[], price: '1,800', active: true };
    expect(setFormSchema.parse(form)).toEqual({ name: 'Promo', items: [{ productId: 'lpg-a-11', type: 'refill', qty: 2 }], sets: [], price: 180000, active: true });
    const twice = setFormSchema.safeParse({ ...form, items: [...form.items, ...form.items] });
    expect(twice.error?.issues[0]?.message).toContain('listed twice');
    expect(setFormSchema.safeParse({ ...form, items: [] }).success).toBe(false);
    expect(setFormSchema.safeParse({ ...form, items: [], sets: [{ setId: 'set-kitchen', qty: '1' }] }).success).toBe(true);
  });

  it('lets the owner save a set and refuses a cylinder sold as an item', async () => {
    const { store, ctx } = await setup();
    const saved = await saveSet(ctx(owner), { name: 'Hose and regulator', items: [{ productId: 'acc-hose', type: 'item', qty: 1 }, { productId: 'acc-regulator', type: 'item', qty: 1 }], sets: [], price: 59000, active: true });
    expect(await store.get<ProductSet>('sets', saved.id)).toEqual(saved);
    await expect(saveSet(ctx(owner), { name: 'Odd', items: [{ productId: 'lpg-a-11', type: 'item', qty: 1 }], sets: [], price: 100, active: true })).rejects.toThrow("can't be sold as item");
  });
});

describe('new cylinders', () => {
  const sale = (cart: CartLine[]): Sale => {
    const { lines, total } = priceCart(cart, products);
    return {
      id: 's1',
      receiptNo: 'TEST-000001',
      locationId: 'branch-main',
      deviceId: 'd1',
      cashierId: 'u-cashier',
      lines,
      total,
      payment: { method: 'cash', amount: total, tendered: total, change: 0 },
      status: 'completed',
      createdAt: '2026-10-12T02:00:00.000Z',
      receivedAt: null,
    };
  };

  it('show the cylinder and its content separately on the receipt', () => {
    const receipt = buildReceipt(sale([{ type: 'new', productId: 'lpg-a-11', qty: 2 }]), { locationName: 'Main Branch', cashierName: 'Cashier' });
    expect(receipt.lines).toEqual([
      {
        name: 'Brand A 11 kg (new cylinder)',
        rows: [
          { detail: 'Cylinder 2 x ₱1,800.00', amount: '₱3,600.00' },
          { detail: 'Content 2 x ₱950.00', amount: '₱1,900.00' },
        ],
      },
    ]);
    expect(receiptText(receipt)).toContain('Content 2 x ₱950.00');
  });

  it('need an empty cylinder on the shelf when NEW_SALE_TAKES_EMPTY is on', () => {
    const movements = saleMovements(sale([{ type: 'refill', productId: 'lpg-a-50', qty: 1 }]), 'u');
    const levels = new Map([['lpg-a-50', { full: 3, empty: 0, unit: 0, defective: 0 }]]);
    const shortages = findShortages([{ type: 'new', productId: 'lpg-a-50', qty: 1 }], products, levels);
    expect(shortages.map((s) => s.condition)).toEqual(NEW_SALE_TAKES_EMPTY ? ['empty'] : []);
    expect(movements.length).toBe(2);
  });
});

describe('sets inside sets', () => {
  it('sells a set inside a set as its items, priced from the regular prices', async () => {
    const { ctx, stock } = await setup();
    const party = await saveSet(ctx(owner), {
      name: 'Party pack',
      items: [{ productId: 'acc-stove', type: 'item', qty: 1 }],
      sets: [{ setId: 'set-two-refills', qty: 2 }],
      price: 450000,
      active: true,
    });
    const all = new Map([...sets, [party.id, party]]);
    // 4 refills and a stove, each at its regular price; the two-refill set's own lower price doesn't count.
    expect(regularPrice(party, products, all)).toBe(4 * 95000 + 120000);
    expect(suggestedSetPrice(party, products, all)).toBe(2 * 188000 + 120000);
    expect(describeSet(party, products, all)).toBe('1 × Single-burner stove, 4 × Brand A 11 kg (refill)');
    expect(describeSetParts(party, products, all)).toContain('2 × Two 11 kg refills');

    const before = await stock('lpg-a-11');
    const sale = await recordSale(ctx(cashier), { cart: addSetToCart([], party), payment: { method: 'cash', amount: 450000, tendered: 450000, change: 0 } });
    expect(sale.lines[0]?.type === 'set' && sale.lines[0].items.map((i) => [i.productId, i.qty])).toEqual([
      ['acc-stove', 1],
      ['lpg-a-11', 4],
    ]);
    expect((await stock('lpg-a-11')).full).toBe(before.full - 4);
    expect(receiptText(buildReceipt(sale, { locationName: 'Main', cashierName: 'Cashier' }))).not.toContain('Two 11 kg refills');
  });

  it('refuses a set inside itself, and lists the sets a change affects', async () => {
    const { store, ctx } = await setup();
    const party = await saveSet(ctx(owner), { name: 'Party pack', items: [], sets: [{ setId: 'set-two-refills', qty: 1 }], price: 180000, active: true });
    const big = await saveSet(ctx(owner), { name: 'Big party', items: [], sets: [{ setId: party.id, qty: 2 }], price: 350000, active: true });
    await expect(
      saveSet(ctx(owner), { name: 'Two 11 kg refills', items: [{ productId: 'lpg-a-11', type: 'refill', qty: 2 }], sets: [{ setId: big.id, qty: 1 }], price: 188000, active: true }, 'set-two-refills'),
    ).rejects.toThrow("can't also go inside");
    const all = await store.list<ProductSet>('sets');
    expect(setsContaining('set-two-refills', all).map((s) => s.name).sort()).toEqual(['Big party', 'Party pack']);
    expect(setsContaining(big.id, all)).toEqual([]);
  });
});
