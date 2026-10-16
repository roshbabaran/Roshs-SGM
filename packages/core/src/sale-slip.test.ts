import { describe, expect, it } from 'vitest';

import { DEMO_USERS, seedDemoData } from './demo';
import type { Product, User } from './models';
import { checkSlipNo, recordSale, voidSale, type OpContext } from './operations';
import { MemoryStore, ObservableStore } from './store';

const [owner, cashier] = DEMO_USERS as [User, User, User];

async function setup() {
  const store = new ObservableStore(new MemoryStore());
  await seedDemoData(store);
  const ctx = (user: User): OpContext => ({ store, user, deviceId: 'a1b2c3d4-0000-4000-8000-000000000000', locationId: 'branch-main' });
  const hose = (await store.get<Product>('products', 'acc-hose'))!;
  const sell = (slipNo?: string) =>
    recordSale(ctx(cashier), {
      cart: [{ type: 'item', productId: hose.id, qty: 1 }],
      payment: { method: 'cash', amount: hose.price, tendered: hose.price, change: 0 },
      slipNo,
    });
  return { ctx, sell };
}

describe('sales scanned from a handwritten receipt', () => {
  it('keep the receipt number', async () => {
    const { sell } = await setup();
    expect((await sell(' 7128 ')).slipNo).toBe('7128');
    expect((await sell()).slipNo).toBeUndefined();
    expect((await sell('')).slipNo).toBeUndefined();
  });

  it('refuse the same receipt number twice, unless the first sale was voided', async () => {
    const { ctx, sell } = await setup();
    const first = await sell('7128');
    await expect(sell('7128')).rejects.toThrow(`already entered as sale ${first.receiptNo}`);
    await voidSale(ctx(owner), first.id, 'Wrong items');
    await expect(sell('7128')).resolves.toMatchObject({ slipNo: '7128' });
  });

  it('can be checked before the sale, while the number can still be corrected', async () => {
    const { ctx, sell } = await setup();
    const first = await sell('7128');
    await expect(checkSlipNo(ctx(cashier), '7128')).rejects.toThrow(`already entered as sale ${first.receiptNo}`);
    await expect(checkSlipNo(ctx(cashier), '7129')).resolves.toBeUndefined();
    await expect(checkSlipNo({ ...ctx(cashier), locationId: 'branch-other' }, '7128')).resolves.toBeUndefined();
    await expect(checkSlipNo(ctx(cashier), '7'.repeat(41))).rejects.toThrow('too long');
  });
});
