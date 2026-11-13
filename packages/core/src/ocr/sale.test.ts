import { describe, expect, it } from 'vitest';

import type { CartLine } from '../cart';
import { DEMO_USERS, seedDemoData } from '../demo';
import type { Customer, Product, ProductSet, User } from '../models';
import { recordSale, saleTimeFor, type OpContext } from '../operations';
import { MemoryStore, ObservableStore } from '../store';
import { linkedCustomer, scannedSaleInput, scannedTotal } from './sale';

const [owner] = DEMO_USERS as [User, User, User];
/** Lito Garcia pays ₱900 for a Brand A 11 kg refill instead of ₱950. */
const LITO = 'demo-customer-lito';
const REFILL: CartLine[] = [{ type: 'refill', productId: 'lpg-a-11', qty: 2 }];

async function setup() {
  const store = new ObservableStore(new MemoryStore());
  await seedDemoData(store);
  const ctx: OpContext = { store, user: owner, deviceId: 'a1b2c3d4-0000-4000-8000-000000000000', locationId: 'branch-main' };
  const [products, sets, customers] = await Promise.all([
    store.list<Product>('products'),
    store.list<ProductSet>('sets'),
    store.list<Customer>('borrowers'),
  ]);
  const catalogue = { products: new Map(products.map((p) => [p.id, p])), sets: new Map(sets.map((s) => [s.id, s])) };
  return { ctx, customers, catalogue };
}

describe('the sale the scan window saves', () => {
  it("links a customer only by their exact name or the cashier's pick", async () => {
    const { customers } = await setup();
    expect(linkedCustomer('  lito GARCIA   (garcia eatery) ', null, customers)?.id).toBe(LITO);
    expect(linkedCustomer('Lito Garcia', null, customers)).toBeNull();
    expect(linkedCustomer('Lito G.', LITO, customers)?.id).toBe(LITO);
    expect(linkedCustomer('', null, customers)).toBeNull();
  });

  it("charges what the window shows: the linked customer's own prices, which recordSale accepts", async () => {
    const { ctx, customers, catalogue } = await setup();
    const name = 'Lito Garcia (Garcia Eatery)';
    const customer = linkedCustomer(name, null, customers);
    const shown = scannedTotal({ cart: REFILL, customer, ...catalogue });
    expect(shown).toBe(180000);

    const { soldAt, timeEstimated } = saleTimeFor('2026-11-08', '14:30', new Date(2026, 10, 10, 15, 0));
    const { total, input } = scannedSaleInput({ cart: REFILL, name, customer, ...catalogue, slipNo: ' 4410 ', soldAt, timeEstimated });
    expect(total).toBe(shown);
    expect(input.payment).toEqual({ method: 'cash', amount: shown, tendered: shown, change: 0 });
    const sale = await recordSale({ ...ctx, now: () => new Date(2026, 10, 10, 15, 0) }, input);
    expect(sale).toMatchObject({ total: shown, borrowerId: LITO, registeredName: name, slipNo: '4410', createdAt: soldAt });
  });

  it('goes back to the regular price when the link is cleared', async () => {
    const { ctx, catalogue } = await setup();
    const name = 'Lito G.';
    const shown = scannedTotal({ cart: REFILL, customer: null, ...catalogue });
    expect(shown).toBe(190000);
    const { input } = scannedSaleInput({ cart: REFILL, name, customer: null, ...catalogue, ...saleTimeFor('2026-11-08', null) });
    const sale = await recordSale(ctx, input);
    expect(sale.total).toBe(190000);
    expect(sale.borrowerId).toBeUndefined();
    expect(sale.registeredName).toBe(name);
  });

  it("is refused if the window charged a different price than the customer's (the guard this keeps from happening)", async () => {
    const { ctx, customers, catalogue } = await setup();
    const customer = linkedCustomer('Lito Garcia (Garcia Eatery)', null, customers);
    const { input } = scannedSaleInput({ cart: REFILL, name: 'Lito Garcia (Garcia Eatery)', customer, ...catalogue, ...saleTimeFor('2026-11-08', null) });
    const regular = scannedTotal({ cart: REFILL, customer: null, ...catalogue });
    await expect(recordSale(ctx, { ...input, payment: { ...input.payment, amount: regular, tendered: regular } })).rejects.toThrow('does not match');
  });
});
