import { describe, expect, it } from 'vitest';

import { addToCart, changeType, priceCart, saleMovements, type CartLine } from './cart';
import { DEMO_PRODUCTS } from './demo';
import { stockByProduct } from './ledger';
import type { Sale } from './models';

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
    expect(level).toEqual({ full: -2, empty: 2, unit: 0 });
  });

  it('takes only a full cylinder for a new-cylinder sale', () => {
    const movements = saleMovements(saleOf([{ productId: 'lpg-a-11', type: 'new', qty: 1 }]), 'u-cashier');
    expect(stockByProduct(movements, 'branch-main').get('lpg-a-11')).toEqual({ full: -1, empty: 0, unit: 0 });
  });

  it('counts accessories as units and ignores other branches', () => {
    const movements = saleMovements(saleOf([{ productId: 'acc-hose', type: 'item', qty: 3 }]), 'u-cashier');
    expect(stockByProduct(movements, 'branch-main').get('acc-hose')).toEqual({ full: 0, empty: 0, unit: -3 });
    expect(stockByProduct(movements, 'branch-2').size).toBe(0);
  });
});
