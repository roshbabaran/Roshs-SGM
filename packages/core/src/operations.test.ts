import { describe, expect, it } from 'vitest';

import { DEMO_USERS, seedDemoData } from './demo';
import { addDays, localDay } from './dates';
import { levelOf, stockByProduct } from './ledger';
import type { OutboxEntry, Sale, StockMovement, User } from './models';
import { recordMovement, recordSale, StockError, voidSale, type OpContext } from './operations';
import { PermissionError } from './roles';
import { MemoryStore, ObservableStore } from './store';
import { downPaymentSchema, movementFormSchema, paymentFormSchema } from './validation';

const [owner, cashier, warehouse] = DEMO_USERS as [User, User, User];

async function setup() {
  const store = new ObservableStore(new MemoryStore());
  await seedDemoData(store);
  const ctx = (user: User, locationId = 'branch-main'): OpContext => ({
    store,
    user,
    deviceId: 'a1b2c3d4-0000-4000-8000-000000000000',
    locationId,
  });
  const stock = async (productId: string, locationId = 'branch-main') =>
    levelOf(stockByProduct(await store.list<StockMovement>('movements'), locationId), productId);
  return { store, ctx, stock };
}

const cashPayment = (amount: number) => ({ method: 'cash' as const, amount, tendered: amount, change: 0 });

describe('recordSale', () => {
  it('saves the sale, moves stock and queues everything for the server', async () => {
    const { store, ctx, stock } = await setup();
    const before = await stock('lpg-a-11');

    const sale = await recordSale(ctx(cashier), {
      cart: [{ productId: 'lpg-a-11', type: 'refill', qty: 2 }],
      payment: cashPayment(190000),
    });

    expect(sale.receiptNo).toBe('A1B2C3-000001');
    expect(sale.total).toBe(190000);
    const after = await stock('lpg-a-11');
    expect(after.full).toBe(before.full - 2);
    expect(after.empty).toBe(before.empty + 2);

    const outbox = await store.list<OutboxEntry>('outbox');
    expect(outbox.map((e) => e.collection).sort()).toEqual(['movements', 'movements', 'sales']);
  });

  it('numbers receipts in order on each device', async () => {
    const { ctx } = await setup();
    const first = await recordSale(ctx(cashier), { cart: [{ productId: 'acc-hose', type: 'item', qty: 1 }], payment: cashPayment(18000) });
    const second = await recordSale(ctx(cashier), { cart: [{ productId: 'acc-hose', type: 'item', qty: 1 }], payment: cashPayment(18000) });
    expect([first.receiptNo, second.receiptNo]).toEqual(['A1B2C3-000001', 'A1B2C3-000002']);
  });

  it('refuses warehouse staff', async () => {
    const { ctx } = await setup();
    await expect(
      recordSale(ctx(warehouse), { cart: [{ productId: 'acc-hose', type: 'item', qty: 1 }], payment: cashPayment(18000) }),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  it('refuses to sell more full cylinders than the branch has', async () => {
    const { ctx, stock } = await setup();
    const full = (await stock('lpg-a-50')).full;
    await expect(
      recordSale(ctx(cashier), {
        cart: [{ productId: 'lpg-a-50', type: 'refill', qty: full + 1 }],
        payment: cashPayment((full + 1) * 430000),
      }),
    ).rejects.toBeInstanceOf(StockError);
  });

  it('refuses a payment that does not match the cart', async () => {
    const { ctx } = await setup();
    await expect(
      recordSale(ctx(cashier), { cart: [{ productId: 'acc-hose', type: 'item', qty: 1 }], payment: cashPayment(100) }),
    ).rejects.toThrow('does not match');
  });
});

describe('voidSale', () => {
  it('puts the stock back and keeps the sale marked as voided', async () => {
    const { store, ctx, stock } = await setup();
    const before = await stock('lpg-a-11');
    const sale = await recordSale(ctx(cashier), {
      cart: [{ productId: 'lpg-a-11', type: 'refill', qty: 1 }],
      payment: cashPayment(95000),
    });

    await expect(voidSale(ctx(cashier), sale.id, 'Customer changed mind')).rejects.toBeInstanceOf(PermissionError);
    await voidSale(ctx(owner), sale.id, 'Customer changed mind');

    expect(await stock('lpg-a-11')).toEqual(before);
    expect((await store.get<Sale>('sales', sale.id))?.status).toBe('voided');
    await expect(voidSale(ctx(owner), sale.id, 'Again please')).rejects.toThrow('already voided');
  });
});

describe('recordMovement', () => {
  const today = localDay(new Date());
  const form = (overrides: Record<string, string>) =>
    movementFormSchema.parse({
      type: 'DELIVERY_IN',
      productId: 'lpg-a-11',
      condition: 'full',
      direction: 'add',
      qty: '50',
      reason: '',
      day: today,
      counterpartLocationId: '',
      ...overrides,
    });

  it('adds a supplier delivery to the warehouse', async () => {
    const { ctx, stock } = await setup();
    const before = await stock('lpg-a-11', 'warehouse');
    await recordMovement(ctx(warehouse, 'warehouse'), form({}));
    expect((await stock('lpg-a-11', 'warehouse')).full).toBe(before.full + 50);
  });

  it('cannot remove more than is on hand', async () => {
    const { ctx } = await setup();
    await expect(
      recordMovement(ctx(warehouse, 'warehouse'), form({ type: 'DAMAGED', qty: '9999', reason: 'Dented valve' })),
    ).rejects.toBeInstanceOf(StockError);
  });

  it('moves stock marked defective into the defective count', async () => {
    const { ctx, stock } = await setup();
    const before = await stock('lpg-a-11', 'warehouse');
    await recordMovement(ctx(warehouse, 'warehouse'), form({ type: 'DAMAGED', condition: 'empty', qty: '2', reason: 'Dented valve' }));
    expect(await stock('lpg-a-11', 'warehouse')).toEqual({ ...before, empty: before.empty - 2, defective: before.defective + 2 });
    await expect(
      recordMovement(ctx(warehouse, 'warehouse'), form({ type: 'DAMAGED', condition: 'defective', qty: '1', reason: 'Dented valve' })),
    ).rejects.toThrow('full or empty');
  });

  it('needs a reason for adjustments and refuses future dates', () => {
    const missingReason = movementFormSchema.safeParse({
      type: 'ADJUSTMENT',
      productId: 'lpg-a-11',
      condition: 'full',
      direction: 'remove',
      qty: '1',
      reason: '',
      day: today,
      counterpartLocationId: '',
    });
    expect(missingReason.success).toBe(false);
    expect(missingReason.error?.issues[0]?.path).toEqual(['reason']);

    const future = movementFormSchema.safeParse({
      type: 'DELIVERY_IN',
      productId: 'lpg-a-11',
      condition: 'full',
      direction: 'add',
      qty: '1',
      reason: '',
      day: addDays(today, 1),
      counterpartLocationId: '',
    });
    expect(future.success).toBe(false);
  });

  it('refuses a cashier', async () => {
    const { ctx } = await setup();
    await expect(recordMovement(ctx(cashier), form({}))).rejects.toBeInstanceOf(PermissionError);
  });
});

describe('payment form', () => {
  const schema = paymentFormSchema(95000);

  it('works out the change for cash', () => {
    expect(schema.parse({ method: 'cash', tendered: '1,000', reference: '' })).toEqual({
      method: 'cash',
      amount: 95000,
      tendered: 100000,
      change: 5000,
      reference: undefined,
    });
  });

  it('says how much cash is short', () => {
    const result = schema.safeParse({ method: 'cash', tendered: '900', reference: '' });
    expect(result.error?.issues[0]?.message).toBe('Short by ₱50.00');
  });

  it('needs a reference number for GCash', () => {
    expect(schema.safeParse({ method: 'gcash', tendered: '', reference: '' }).success).toBe(false);
    expect(schema.parse({ method: 'gcash', tendered: '', reference: 'GC123456' }).reference).toBe('GC123456');
  });
});

describe('down payment on a sale on credit', () => {
  const schema = downPaymentSchema(95000);

  it('takes blank or 0 as nothing paid now, whatever method is picked', () => {
    for (const amount of ['', '0', '0.00']) {
      for (const method of ['cash', 'gcash', 'maya', 'bank'] as const) {
        const result = schema.safeParse({ amount, method, reference: '' });
        expect(result.success).toBe(true);
        expect(result.data).toBeNull();
      }
    }
  });

  it('records part paid now, with a reference number for GCash', () => {
    expect(schema.parse({ amount: '200', method: 'cash', reference: '' })).toMatchObject({ method: 'cash', amount: 20000 });
    expect(schema.safeParse({ amount: '200', method: 'gcash', reference: '' }).success).toBe(false);
    expect(schema.parse({ amount: '200', method: 'gcash', reference: 'GC123456' })).toMatchObject({ amount: 20000, reference: 'GC123456' });
  });

  it('turns away the full amount or a negative one', () => {
    expect(schema.safeParse({ amount: '950', method: 'cash', reference: '' }).success).toBe(false);
    expect(schema.safeParse({ amount: '-5', method: 'cash', reference: '' }).success).toBe(false);
  });
});
