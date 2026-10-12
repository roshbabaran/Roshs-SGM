import type { Product, Sale, SaleLine, SaleLineType, StockMovement } from './models';
import type { Centavos } from './money';
import { uuid } from './ids';

export interface CartLine {
  productId: string;
  type: SaleLineType;
  qty: number;
}

export const LINE_TYPE_LABELS: Record<SaleLineType, string> = {
  refill: 'Refill',
  new: 'New cylinder',
  item: 'Item',
};

export function defaultLineType(product: Product): SaleLineType {
  return product.kind === 'cylinder' ? 'refill' : 'item';
}

export function unitPrice(product: Product, type: SaleLineType): Centavos {
  if (type === 'refill') return product.refillPrice ?? product.price;
  return product.price;
}

export function addToCart(cart: CartLine[], product: Product, type = defaultLineType(product)): CartLine[] {
  const index = cart.findIndex((line) => line.productId === product.id && line.type === type);
  if (index === -1) return [...cart, { productId: product.id, type, qty: 1 }];
  return cart.map((line, i) => (i === index ? { ...line, qty: line.qty + 1 } : line));
}

/** Sets a line's quantity; zero or less removes the line. */
export function changeQty(cart: CartLine[], index: number, qty: number): CartLine[] {
  if (qty <= 0) return cart.filter((_, i) => i !== index);
  return cart.map((line, i) => (i === index ? { ...line, qty } : line));
}

/** Switches a cylinder line between refill and new, merging with an existing line of that type. */
export function changeType(cart: CartLine[], index: number, type: SaleLineType): CartLine[] {
  const line = cart[index];
  if (!line || line.type === type) return cart;
  const target = cart.findIndex((l, i) => i !== index && l.productId === line.productId && l.type === type);
  if (target === -1) return cart.map((l, i) => (i === index ? { ...l, type } : l));
  return cart
    .map((l, i) => (i === target ? { ...l, qty: l.qty + line.qty } : l))
    .filter((_, i) => i !== index);
}

export function priceCart(
  cart: CartLine[],
  products: Map<string, Product>,
): { lines: SaleLine[]; total: Centavos } {
  const lines: SaleLine[] = [];
  for (const line of cart) {
    const product = products.get(line.productId);
    if (!product) throw new Error(`Product not found: ${line.productId}`);
    const price = unitPrice(product, line.type);
    lines.push({
      productId: product.id,
      name: product.name,
      type: line.type,
      qty: line.qty,
      unitPrice: price,
      amount: price * line.qty,
    });
  }
  return { lines, total: lines.reduce((sum, line) => sum + line.amount, 0) };
}

/** Sellable units the cart needs per product (full cylinders, or accessory units). */
export function cartDemand(cart: Pick<CartLine, 'productId' | 'qty'>[]): Map<string, number> {
  const demand = new Map<string, number>();
  for (const line of cart) demand.set(line.productId, (demand.get(line.productId) ?? 0) + line.qty);
  return demand;
}

/**
 * The stock movements a sale causes:
 * - refill: one full cylinder out, one empty cylinder in
 * - new cylinder: one full cylinder out
 * - accessory: one unit out
 */
export function saleMovements(sale: Sale, userId: string): StockMovement[] {
  const base = {
    locationId: sale.locationId,
    saleId: sale.id,
    userId,
    deviceId: sale.deviceId,
    occurredAt: sale.createdAt,
    createdAt: sale.createdAt,
    receivedAt: null,
  };
  const movements: StockMovement[] = [];
  for (const line of sale.lines) {
    if (line.type === 'item') {
      movements.push({ ...base, id: uuid(), type: 'SALE', productId: line.productId, condition: 'unit', qty: -line.qty });
      continue;
    }
    movements.push({ ...base, id: uuid(), type: 'SALE', productId: line.productId, condition: 'full', qty: -line.qty });
    if (line.type === 'refill') {
      movements.push({ ...base, id: uuid(), type: 'EMPTY_IN', productId: line.productId, condition: 'empty', qty: line.qty });
    }
  }
  return movements;
}
