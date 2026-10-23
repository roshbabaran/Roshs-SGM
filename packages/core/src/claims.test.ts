import { describe, expect, it } from 'vitest';

import { sellOnCredit } from './borrowing';
import { approveClaim, canReturnFrom, defectiveCharge, hasLpg, ordersToPickUp, pendingClaims, recordPickup, rejectClaim, requestDefective, requestReturn, saleProgress } from './claims';
import { localDay } from './dates';
import { DEMO_PRODUCTS, DEMO_SETS, DEMO_USERS, seedDemoData } from './demo';
import { levelOf, stockByProduct } from './ledger';
import type { Claim, Customer, Sale, SaleLine, SetSaleItem, StockMovement, User } from './models';
import { recordMovement, recordSale, voidSale, type OpContext } from './operations';
import { buildReceipt } from './receipt';
import { claimBreakdown, returnTotals } from './reports';
import { PermissionError } from './roles';
import { MemoryStore, ObservableStore } from './store';

const [owner, cashier, warehouse, admin] = DEMO_USERS as [User, User, User, User];

async function setup() {
  const store = new ObservableStore(new MemoryStore());
  await seedDemoData(store);
  const ctx = (user: User): OpContext => ({ store, user, deviceId: 'a1b2c3d4-0000-4000-8000-000000000000', locationId: 'branch-main' });
  const stock = async (productId: string) => levelOf(stockByProduct(await store.list<StockMovement>('movements'), 'branch-main'), productId);
  const claims = () => store.list<Claim>('claims');
  return { store, ctx, stock, claims };
}

const cash = (amount: number) => ({ method: 'cash' as const, amount, tendered: amount, change: 0 });

async function prepaidOrder(ctx: OpContext) {
  return recordSale(ctx, {
    cart: [
      { type: 'refill', productId: 'lpg-a-11', qty: 3 },
      { type: 'item', productId: 'acc-hose', qty: 1 },
    ],
    payment: cash(3 * 95000 + 18000),
    customer: { name: 'Carlo Bautista' },
    prepaid: true,
  });
}

describe('prepaid orders', () => {
  it('takes the money now, moves no stock, and prints the claim code', async () => {
    const { ctx, stock } = await setup();
    const before = await stock('lpg-a-11');
    const sale = await prepaidOrder(ctx(cashier));

    expect(sale.prepaid).toBe(true);
    expect(sale.claimCode).toMatch(/^[A-Z2-9]{6}$/);
    expect(await stock('lpg-a-11')).toEqual(before);
    const receipt = buildReceipt(sale, { locationName: 'Main Branch', cashierName: 'Cashier' });
    expect(receipt.notes.join(' ')).toContain(`Claim code: ${sale.claimCode}`);
  });

  it('needs a customer and must be paid in full', async () => {
    const { ctx } = await setup();
    await expect(
      recordSale(ctx(cashier), { cart: [{ type: 'item', productId: 'acc-hose', qty: 1 }], payment: cash(18000), prepaid: true }),
    ).rejects.toThrow('needs the name');
    await expect(
      recordSale(ctx(cashier), {
        cart: [{ type: 'borrow', productId: 'lpg-a-11', qty: 1 }],
        payment: cash(95000),
        customer: { name: 'Carlo Bautista' },
        prepaid: true,
      }),
    ).rejects.toThrow('paid in full');
  });

  it('is picked up in parts by a cashier, with the claim code', async () => {
    const { store, ctx, stock, claims } = await setup();
    const sale = await prepaidOrder(ctx(cashier));
    const before = await stock('lpg-a-11');
    const pickup = { saleId: sale.id, claimCode: sale.claimCode! };

    await expect(recordPickup(ctx(cashier), { ...pickup, claimCode: '', items: [{ line: 0, qty: 1 }] })).rejects.toThrow('claim code');
    await expect(recordPickup(ctx(cashier), { ...pickup, claimCode: 'WRONG1', items: [{ line: 0, qty: 1 }] })).rejects.toThrow("doesn't match");
    await expect(recordPickup(ctx(warehouse), { ...pickup, items: [{ line: 0, qty: 1 }] })).rejects.toBeInstanceOf(PermissionError);

    await recordPickup(ctx(cashier), { ...pickup, items: [{ line: 0, qty: 2 }] });
    expect(await stock('lpg-a-11')).toEqual({ ...before, full: before.full - 2, empty: before.empty + 2 });
    expect(saleProgress(sale, await claims()).map((p) => p.toPickUp)).toEqual([1, 1]);
    await expect(recordPickup(ctx(cashier), { ...pickup, items: [{ line: 0, qty: 2 }] })).rejects.toThrow('Only 1');

    // The owner can release the rest without the receipt.
    await recordPickup(ctx(owner), { ...pickup, claimCode: '', items: [{ line: 0, qty: 1 }, { line: 1, qty: 1 }] });
    expect(ordersToPickUp(await store.list<Sale>('sales'), await claims()).map((s) => s.id)).not.toContain(sale.id);
  });

  it('lists the seeded order waiting to be picked up', async () => {
    const { store, claims } = await setup();
    const waiting = ordersToPickUp(await store.list<Sale>('sales'), await claims());
    expect(waiting.map((s) => s.claimCode)).toEqual(['K7Q2MX']);
    // Lito's own price for 11 kg refills applies.
    expect(waiting[0]?.total).toBe(2 * 90000);
  });
});

describe('returns', () => {
  it("waits for approval when a cashier asks, then puts the stock back and records the refund", async () => {
    const { store, ctx, stock, claims } = await setup();
    const sale = await recordSale(ctx(cashier), { cart: [{ type: 'item', productId: 'acc-hose', qty: 3 }], payment: cash(54000) });
    const before = await stock('acc-hose');

    const asked = await requestReturn(ctx(cashier), { saleId: sale.id, items: [{ line: 0, qty: 1 }], refundMethod: 'cash', reason: 'Wrong length' });
    expect(asked.status).toBe('pending');
    expect(asked.refund).toBe(18000);
    expect(await stock('acc-hose')).toEqual(before);
    await expect(approveClaim(ctx(cashier), asked.id)).rejects.toBeInstanceOf(PermissionError);
    await expect(
      requestReturn(ctx(cashier), { saleId: sale.id, items: [{ line: 0, qty: 3 }], refundMethod: 'cash', reason: 'Wrong length' }),
    ).rejects.toThrow('already waiting');

    const approved = await approveClaim(ctx(admin), asked.id, 'OK');
    expect(approved).toMatchObject({ status: 'completed', decidedBy: admin.id, voidsSale: false });
    expect((await stock('acc-hose')).unit).toBe(before.unit + 1);
    expect((await store.get<Sale>('sales', sale.id))?.status).toBe('completed');
    const today = localDay(new Date());
    expect(returnTotals(await claims(), today, today)).toMatchObject({ returns: 1, refunded: 18000, wholeSales: 0 });
    expect(claimBreakdown(await claims(), await store.list<Sale>('sales'), today, today).returned).toEqual([
      { key: 'acc-hose', name: sale.lines[0]!.name, qty: 1, amount: 18000 },
    ]);
  });

  it('voids the sale when everything comes back, so a cashier can undo a sale with approval', async () => {
    const { store, ctx, stock } = await setup();
    const sale = await recordSale(ctx(cashier), { cart: [{ type: 'item', productId: 'acc-hose', qty: 1 }], payment: cash(18000) });
    const before = await stock('acc-hose');
    await expect(voidSale(ctx(cashier), sale.id, 'Wrong item')).rejects.toBeInstanceOf(PermissionError);

    const asked = await requestReturn(ctx(cashier), { saleId: sale.id, items: [{ line: 0, qty: 1 }], refundMethod: 'cash', reason: 'Wrong item' });
    expect(asked.voidsSale).toBe(true);
    await approveClaim(ctx(owner), asked.id);
    const voided = await store.get<Sale>('sales', sale.id);
    expect(voided?.status).toBe('voided');
    expect(voided?.voidedBy).toBe(owner.id);
    expect(await stock('acc-hose')).toEqual({ ...before, unit: before.unit + 1 });
    const today = localDay(new Date());
    const claims = await store.list<Claim>('claims');
    expect(returnTotals(claims, today, today)).toMatchObject({ returns: 1, refunded: 18000, wholeSales: 1 });
    expect(claimBreakdown(claims, await store.list<Sale>('sales'), today, today).returned).toEqual([
      { key: 'acc-hose', name: sale.lines[0]!.name, qty: 1, amount: 18000 },
    ]);
  });

  it("never takes back LPG the customer has, and never voids a sale whose LPG stays with them", async () => {
    const { store, ctx, stock, claims } = await setup();
    const sale = await recordSale(ctx(cashier), {
      cart: [
        { type: 'refill', productId: 'lpg-a-11', qty: 1 },
        { type: 'item', productId: 'acc-hose', qty: 1 },
      ],
      payment: cash(95000 + 18000),
    });
    expect(saleProgress(sale, await claims()).map((p) => [p.lpg, p.returnable])).toEqual([
      [true, 0],
      [false, 1],
    ]);
    await expect(
      requestReturn(ctx(owner), { saleId: sale.id, items: [{ line: 0, qty: 1 }], refundMethod: 'cash', reason: 'Smells of gas' }),
    ).rejects.toThrow("LPG can't be returned");

    // The hose alone comes back; the sale stays, because the refill is still the customer's.
    const before = await stock('lpg-a-11');
    const done = await requestReturn(ctx(owner), { saleId: sale.id, items: [{ line: 1, qty: 1 }], refundMethod: 'cash', reason: 'Wrong length' });
    expect(done).toMatchObject({ status: 'completed', voidsSale: false, refund: 18000 });
    expect((await store.get<Sale>('sales', sale.id))?.status).toBe('completed');
    expect(await stock('lpg-a-11')).toEqual(before);
    expect(canReturnFrom(sale, await claims())).toBe(false);

    // A set with a cylinder in it is LPG too; one of accessories only isn't.
    const setLine = (items: SetSaleItem[]): SaleLine => ({ type: 'set', setId: 's', name: 'Set', qty: 1, unitPrice: 0, amount: 0, items });
    expect(hasLpg(setLine(DEMO_SETS[0]!.items.map((i) => ({ ...i, name: i.productId }))))).toBe(true);
    expect(hasLpg(setLine([{ productId: 'acc-hose', type: 'item', qty: 2, name: 'Hose' }]))).toBe(false);
  });

  it("refunds a prepaid order's LPG only while it waits to be picked up", async () => {
    const { ctx, claims } = await setup();
    const sale = await prepaidOrder(ctx(cashier));
    await recordPickup(ctx(cashier), { saleId: sale.id, claimCode: sale.claimCode!, items: [{ line: 0, qty: 2 }] });
    expect(saleProgress(sale, await claims())[0]).toMatchObject({ lpg: true, toPickUp: 1, returnable: 1 });
    await expect(
      requestReturn(ctx(owner), { saleId: sale.id, items: [{ line: 0, qty: 2 }], refundMethod: 'cash', reason: 'Only needs one' }),
    ).rejects.toThrow('Only 1 of');
    const done = await requestReturn(ctx(owner), { saleId: sale.id, items: [{ line: 0, qty: 1 }], refundMethod: 'cash', reason: 'Only needs two' });
    expect(done).toMatchObject({ status: 'completed', voidsSale: false });
    expect(done.items[0]?.notPickedUp).toBe(1);
  });

  it('turns down an LPG return asked for before the order was picked up, once it has been', async () => {
    const { ctx } = await setup();
    const sale = await prepaidOrder(ctx(cashier));
    const asked = await requestReturn(ctx(cashier), { saleId: sale.id, items: [{ line: 0, qty: 1 }], refundMethod: 'cash', reason: 'Only needs two' });
    await recordPickup(ctx(cashier), { saleId: sale.id, claimCode: sale.claimCode!, items: [{ line: 0, qty: 3 }] });
    await expect(approveClaim(ctx(owner), asked.id)).rejects.toThrow('was picked up since this was asked for, so reject this request');
  });

  it("can't return a sale on account that has LPG; it is voided instead", async () => {
    const { ctx } = await setup();
    const sale = await sellOnCredit(ctx(owner), {
      borrower: { name: 'Ana Lim' },
      cart: [
        { type: 'refill', productId: 'lpg-a-11', qty: 1 },
        { type: 'item', productId: 'acc-hose', qty: 1 },
      ],
    });
    expect(canReturnFrom(sale, [])).toBe(false);
    await expect(
      requestReturn(ctx(owner), { saleId: sale.id, items: [{ line: 1, qty: 1 }], refundMethod: 'cash', reason: 'Wrong length' }),
    ).rejects.toThrow('can void it');
  });

  it("is completed straight away when the owner records it, and a prepaid order's unpicked items bring no stock back", async () => {
    const { ctx, stock } = await setup();
    const sale = await prepaidOrder(ctx(cashier));
    const before = await stock('lpg-a-11');
    const done = await requestReturn(ctx(owner), { saleId: sale.id, items: [{ line: 0, qty: 1 }], refundMethod: 'cash', reason: 'Only needs two' });
    expect(done.status).toBe('completed');
    expect(done.items[0]?.notPickedUp).toBe(1);
    expect(await stock('lpg-a-11')).toEqual(before);
  });

  it("is decided by a branch manager only at their own branches", async () => {
    const { store, ctx } = await setup();
    const manager = DEMO_USERS.find((u) => u.role === 'manager')!;
    const sale = await recordSale(ctx(cashier), { cart: [{ type: 'item', productId: 'acc-hose', qty: 2 }], payment: cash(36000) });
    const here = await requestReturn(ctx(cashier), { saleId: sale.id, items: [{ line: 0, qty: 1 }], refundMethod: 'cash', reason: 'Wrong length' });
    expect(pendingClaims(await store.list<Claim>('claims'), manager).map((c) => c.id)).toContain(here.id);
    await expect(approveClaim(ctx(manager), here.id)).resolves.toMatchObject({ status: 'completed', decidedBy: manager.id });

    const elsewhere = { ...here, id: 'claim-at-branch-2', status: 'pending' as const, locationId: 'branch-2', decidedBy: undefined, decidedAt: undefined };
    await store.batch([{ type: 'put', collection: 'claims', record: elsewhere }]);
    expect(pendingClaims(await store.list<Claim>('claims'), manager).map((c) => c.id)).not.toContain(elsewhere.id);
    await expect(approveClaim(ctx(manager), elsewhere.id)).rejects.toThrow("aren't assigned");
    await expect(rejectClaim(ctx(manager), elsewhere.id, 'Not ours')).rejects.toThrow("aren't assigned");
  });

  it('can be rejected with a reason, and then changes nothing', async () => {
    const { ctx, stock } = await setup();
    const sale = await recordSale(ctx(cashier), { cart: [{ type: 'item', productId: 'acc-hose', qty: 1 }], payment: cash(18000) });
    const before = await stock('acc-hose');
    const asked = await requestReturn(ctx(cashier), { saleId: sale.id, items: [{ line: 0, qty: 1 }], refundMethod: 'cash', reason: 'Changed mind' });
    await expect(rejectClaim(ctx(owner), asked.id, '')).rejects.toThrow('Say why');
    const rejected = await rejectClaim(ctx(owner), asked.id, 'Used already');
    expect(rejected.status).toBe('rejected');
    await expect(approveClaim(ctx(owner), asked.id)).rejects.toThrow('already rejected');
    expect(await stock('acc-hose')).toEqual(before);
  });
});

describe('defective exchanges', () => {
  it('charges only the gas it lost, and swaps a full cylinder for the defective one once approved', async () => {
    const { store, ctx, stock } = await setup();
    const product = DEMO_PRODUCTS.find((p) => p.id === 'lpg-a-11')!;
    expect(defectiveCharge(product, 2)).toBe(Math.round((95000 * 2) / 11));
    const before = await stock('lpg-a-11');

    const asked = await requestDefective(ctx(cashier), {
      customer: { name: 'Nena Flores' },
      productId: 'lpg-a-11',
      lostKg: 2,
      chargeMethod: 'cash',
      reason: 'Leaking valve',
    });
    expect(asked).toMatchObject({ status: 'pending', charge: 17273, customerName: 'Nena Flores' });
    expect((await store.list<Customer>('borrowers')).some((c) => c.name === 'Nena Flores')).toBe(true);
    expect(await stock('lpg-a-11')).toEqual(before);

    await approveClaim(ctx(owner), asked.id);
    // The defective cylinder is counted on its own, not with the empties that get refilled.
    expect(await stock('lpg-a-11')).toEqual({ ...before, full: before.full - 1, defective: before.defective + 1 });
  });

  it("records an exchange without the customer's name, or with the one on the receipt", async () => {
    const { ctx, store } = await setup();
    const customers = (await store.list<Customer>('borrowers')).length;
    const nameless = await requestDefective(ctx(cashier), { productId: 'acc-hose', chargeMethod: 'cash', reason: 'Cracked near the clamp' });
    expect(nameless.status).toBe('pending');
    expect(nameless.customerId).toBeUndefined();
    expect(nameless.customerName).toBeUndefined();
    expect((await store.list<Customer>('borrowers')).length).toBe(customers);
    await approveClaim(ctx(owner), nameless.id);

    const sale = await recordSale(ctx(cashier), { cart: [{ type: 'item', productId: 'acc-hose', qty: 1 }], payment: cash(18000), customer: { name: 'Dina Ramos' } });
    const fromReceipt = await requestDefective(ctx(owner), { customer: null, productId: 'acc-hose', chargeMethod: 'cash', reason: 'Leaks at the end', saleId: sale.id });
    expect(fromReceipt).toMatchObject({ status: 'completed', customerId: sale.borrowerId, customerName: 'Dina Ramos', receiptNo: sale.receiptNo });
  });

  it('swaps a defective accessory for a new one, free unless a charge is entered', async () => {
    const { ctx, stock } = await setup();
    const before = await stock('acc-regulator');
    const free = await requestDefective(ctx(owner), { customer: { name: 'Nena Flores' }, productId: 'acc-regulator', chargeMethod: 'cash', reason: 'Knob broke' });
    expect(free).toMatchObject({ status: 'completed', charge: 0 });
    expect(free.lostKg).toBeUndefined();
    expect(await stock('acc-regulator')).toEqual({ ...before, unit: before.unit - 1, defective: 1 });
    const charged = await requestDefective(ctx(cashier), {
      customer: { id: free.customerId!, name: 'Nena Flores' },
      productId: 'acc-regulator',
      charge: 10000,
      chargeMethod: 'gcash',
      reason: 'Dropped it; cracked',
    });
    expect(charged).toMatchObject({ status: 'pending', charge: 10000 });
    await expect(
      requestDefective(ctx(cashier), { customer: { id: free.customerId!, name: 'Nena Flores' }, productId: 'acc-regulator', charge: 99_999_99, chargeMethod: 'cash', reason: 'Knob broke' }),
    ).rejects.toThrow('Enter a charge');
  });

  it('adds up exchanges item by item for the sales report', async () => {
    const { store, ctx } = await setup();
    const nena = { name: 'Nena Flores' };
    const first = await requestDefective(ctx(owner), { customer: nena, productId: 'lpg-a-11', lostKg: 1.5, chargeMethod: 'cash', reason: 'Leaking valve' });
    await requestDefective(ctx(owner), { customer: { id: first.customerId!, name: nena.name }, productId: 'lpg-a-11', lostKg: 0.25, chargeMethod: 'cash', reason: 'Leaking valve' });
    await requestDefective(ctx(owner), { customer: { id: first.customerId!, name: nena.name }, productId: 'acc-regulator', chargeMethod: 'cash', reason: 'Knob broke' });
    const today = localDay(new Date());
    const claims = await store.list<Claim>('claims');
    const { defective } = claimBreakdown(claims, [], today, today);
    const lpg11 = DEMO_PRODUCTS.find((p) => p.id === 'lpg-a-11')!;
    expect(defective).toEqual([
      { key: 'lpg-a-11', name: lpg11.name, qty: 2, amount: defectiveCharge(lpg11, 1.5) + defectiveCharge(lpg11, 0.25), lostKg: 1.75 },
      expect.objectContaining({ key: 'acc-regulator', qty: 1, amount: 0 }),
    ]);
    expect(defective[1]?.lostKg).toBeUndefined();
    // The waiting demo exchange is not counted until it is approved.
    expect(returnTotals(claims, today, today)).toMatchObject({ defectives: 3 });
  });

  it('sends defective stock back to the depot, never from a delivery', async () => {
    const { ctx, stock } = await setup();
    await requestDefective(ctx(owner), { customer: { name: 'Nena Flores' }, productId: 'lpg-a-11', lostKg: 1, chargeMethod: 'cash', reason: 'Leaking valve' });
    const movement = { productId: 'lpg-a-11', condition: 'defective' as const, direction: 'add' as const, qty: 1, reason: 'Back to Petron', day: localDay(new Date()), counterpartLocationId: '' };
    await recordMovement(ctx(owner), { ...movement, type: 'RETURN_TO_SUPPLIER' });
    expect((await stock('lpg-a-11')).defective).toBe(0);
    await expect(recordMovement(ctx(owner), { ...movement, type: 'RETURN_TO_SUPPLIER' })).rejects.toThrow('Not enough stock');
    await expect(recordMovement(ctx(owner), { ...movement, type: 'DELIVERY_IN' })).rejects.toThrow('good condition');
  });

  it('refuses more gas than the cylinder holds, and warehouse staff', async () => {
    const { ctx } = await setup();
    const input = { customer: { name: 'Nena Flores' }, productId: 'lpg-a-11', lostKg: 12, chargeMethod: 'cash' as const, reason: 'Leaking valve' };
    await expect(requestDefective(ctx(cashier), input)).rejects.toThrow('from 0 to 11 kg');
    await expect(requestDefective(ctx(warehouse), { ...input, lostKg: 1 })).rejects.toBeInstanceOf(PermissionError);
  });

  it('is not undone when the sale it came from is voided', async () => {
    const { ctx, stock } = await setup();
    const sale = await recordSale(ctx(cashier), { cart: [{ type: 'refill', productId: 'lpg-a-11', qty: 1 }], payment: cash(95000) });
    await requestDefective(ctx(owner), { customer: { name: 'Nena Flores' }, productId: 'lpg-a-11', lostKg: 1, chargeMethod: 'cash', reason: 'Leaking valve', saleId: sale.id });
    const afterExchange = await stock('lpg-a-11');
    await voidSale(ctx(owner), sale.id, 'Entered twice');
    expect(await stock('lpg-a-11')).toEqual({ ...afterExchange, full: afterExchange.full + 1, empty: afterExchange.empty - 1 });
  });
});
