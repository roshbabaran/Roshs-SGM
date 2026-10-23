import { describe, expect, it } from 'vitest';

import { addToCart, changeType, priceCart, saleMovements, type CartLine } from './cart';
import { NEW_SALE_TAKES_EMPTY } from './config';
import { DEMO_PRODUCTS } from './demo';
import { movementRows, stockBefore, stockByProduct } from './ledger';
import type { Sale, StockMovement } from './models';

const products = new Map(DEMO_PRODUCTS.map((p) => [p.id, p]));
const lpg11 = products.get('lpg-a-11')!;
const hose = products.get('acc-hose')!;

function saleOf(cart: CartLine[]): Sale {
  const { lines, total } = priceCart(cart, products);
  return {
    id: 'sale-1',
    receiptNo: 'TEST-000001',
    locationId: 'branch-main',
    deviceId: 'device-1',
    cashierId: 'u-cashier',
    lines,
    total,
    payment: { method: 'cash', amount: total, tendered: total, change: 0 },
    status: 'completed',
    createdAt: '2026-10-12T02:00:00.000Z',
    receivedAt: null,
  };
}

describe('cart', () => {
  it('adds the same product and type to one line', () => {
    let cart: CartLine[] = [];
    cart = addToCart(cart, lpg11);
    cart = addToCart(cart, lpg11);
    cart = addToCart(cart, lpg11, 'new');
    expect(cart).toEqual([
      { productId: 'lpg-a-11', type: 'refill', qty: 2 },
      { productId: 'lpg-a-11', type: 'new', qty: 1 },
    ]);
  });

  it('merges lines when a refill is switched to a new cylinder', () => {
    const cart: CartLine[] = [
      { productId: 'lpg-a-11', type: 'refill', qty: 2 },
      { productId: 'lpg-a-11', type: 'new', qty: 1 },
    ];
    expect(changeType(cart, 0, 'new')).toEqual([{ productId: 'lpg-a-11', type: 'new', qty: 3 }]);
  });

  it('prices refills and new cylinders differently', () => {
    const { total } = priceCart(
      [
        { productId: 'lpg-a-11', type: 'refill', qty: 2 },
        { productId: 'lpg-a-11', type: 'new', qty: 1 },
        { productId: 'acc-hose', type: 'item', qty: 1 },
      ],
      products,
    );
    expect(total).toBe(2 * lpg11.refillPrice! + lpg11.price + hose.price);
  });
});

describe('stock ledger', () => {
  it('takes a full cylinder and an empty back for a refill', () => {
    const movements = saleMovements(saleOf([{ productId: 'lpg-a-11', type: 'refill', qty: 2 }]), 'u-cashier');
    const level = stockByProduct(movements, 'branch-main').get('lpg-a-11');
    expect(level).toEqual({ full: -2, empty: 2, unit: 0, defective: 0 });
  });

  it('takes a full cylinder, and an empty one too, for a new-cylinder sale', () => {
    const movements = saleMovements(saleOf([{ productId: 'lpg-a-11', type: 'new', qty: 2 }]), 'u-cashier');
    expect(stockByProduct(movements, 'branch-main').get('lpg-a-11')).toEqual({
      full: -2,
      empty: NEW_SALE_TAKES_EMPTY ? -2 : 0,
      unit: 0,
      defective: 0,
    });
  });

  it('takes a full cylinder and nothing back when the cylinder is borrowed', () => {
    const movements = saleMovements(saleOf([{ productId: 'lpg-a-11', type: 'borrow', qty: 1 }]), 'u-cashier');
    expect(stockByProduct(movements, 'branch-main').get('lpg-a-11')).toEqual({ full: -1, empty: 0, unit: 0, defective: 0 });
  });

  it('counts accessories as units and ignores other branches', () => {
    const movements = saleMovements(saleOf([{ productId: 'acc-hose', type: 'item', qty: 3 }]), 'u-cashier');
    expect(stockByProduct(movements, 'branch-main').get('acc-hose')).toEqual({ full: 0, empty: 0, unit: -3, defective: 0 });
    expect(stockByProduct(movements, 'branch-2').size).toBe(0);
  });
});

describe('stock over the day', () => {
  const move = (id: string, condition: 'full' | 'empty', qty: number, occurredAt: string): StockMovement => ({
    id,
    type: 'ADJUSTMENT',
    productId: 'lpg-a-11',
    locationId: 'branch-main',
    condition,
    qty,
    userId: 'u-owner',
    deviceId: 'device-1',
    occurredAt,
    createdAt: occurredAt,
    receivedAt: null,
  });
  const movements = [
    move('m3', 'full', -1, '2026-10-12T03:00:00.000Z'),
    move('m1', 'full', 10, '2026-10-11T03:00:00.000Z'),
    move('m2', 'empty', 4, '2026-10-11T04:00:00.000Z'),
    move('m4', 'empty', 1, '2026-10-12T05:00:00.000Z'),
  ];

  it('counts only what happened before a moment', () => {
    expect(stockBefore(movements, 'branch-main', '2026-10-12T00:00:00.000Z').get('lpg-a-11')).toEqual({ full: 10, empty: 4, unit: 0, defective: 0 });
  });

  it("gives each entry the product's stock before and after it, in the order they happened", () => {
    const rows = movementRows(movements, 'branch-main');
    expect(rows.map((r) => r.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(rows[0]).toMatchObject({ before: { full: 0, empty: 0, unit: 0 }, after: { full: 10, empty: 0, unit: 0 } });
    expect(rows[2]).toMatchObject({ before: { full: 10, empty: 4, unit: 0 }, after: { full: 9, empty: 4, unit: 0 } });
    expect(rows[3]).toMatchObject({ before: { full: 9, empty: 4, unit: 0 }, after: { full: 9, empty: 5, unit: 0 } });
  });

  it('puts what one sale did to a product on one row, and its void on another', () => {
    const sale = saleOf([
      { productId: 'lpg-a-11', type: 'refill', qty: 2 },
      { productId: 'acc-hose', type: 'item', qty: 1 },
    ]);
    const sold = saleMovements(sale, 'u-cashier');
    const voidedAt = '2026-10-12T06:00:00.000Z';
    const voided = sold.map((m) => ({ ...m, id: `${m.id}-void`, type: 'VOID_REVERSAL' as const, qty: -m.qty, occurredAt: voidedAt, createdAt: voidedAt }));
    const rows = movementRows([...movements, ...sold, ...voided], 'branch-main').filter((r) => r.productId === 'lpg-a-11');

    expect(rows.map((r) => r.type)).toEqual(['ADJUSTMENT', 'ADJUSTMENT', 'SALE', 'ADJUSTMENT', 'ADJUSTMENT', 'VOID_REVERSAL']);
    expect(rows[2]).toMatchObject({
      saleId: 'sale-1',
      change: { full: -2, empty: 2, unit: 0 },
      before: { full: 10, empty: 4, unit: 0 },
      after: { full: 8, empty: 6, unit: 0 },
      synced: false,
    });
    expect(rows[2].movements).toHaveLength(2);
    expect(rows[5]).toMatchObject({
      change: { full: 2, empty: -2, unit: 0 },
      before: { full: 7, empty: 7, unit: 0 },
      after: { full: 9, empty: 5, unit: 0 },
    });
  });
});
