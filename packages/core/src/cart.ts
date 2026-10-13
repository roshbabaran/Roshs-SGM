import { NEW_SALE_TAKES_EMPTY } from './config';
import { uuid } from './ids';
import type {
  MovementType,
  Product,
  ProductLineType,
  ProductSaleLine,
  ProductSet,
  Sale,
  SaleLine,
  SaleLineType,
  StockCondition,
  StockMovement,
} from './models';
import type { Centavos } from './money';

export interface ProductCartLine {
  type: ProductLineType;
  productId: string;
  qty: number;
}

export interface SetCartLine {
  type: 'set';
  setId: string;
  qty: number;
}

/** One line of the sale being made: a product sold one way, or a set. */
export type CartLine = ProductCartLine | SetCartLine;

export const LINE_TYPE_LABELS: Record<SaleLineType, string> = {
  refill: 'Refill',
  new: 'New cylinder',
  borrow: 'Refill, borrowed cylinder',
  item: 'Item',
  set: 'Set',
};

export function defaultLineType(product: Product): ProductLineType {
  return product.kind === 'cylinder' ? 'refill' : 'item';
}

/** Lines with the same key are the same thing sold the same way, so they share one line. */
export function cartLineKey(line: CartLine): string {
  return line.type === 'set' ? `set:${line.setId}` : `${line.productId}:${line.type}`;
}

export function unitPrice(product: Product, type: ProductLineType): Centavos {
  if (type === 'refill' || type === 'borrow') return product.refillPrice ?? product.price;
  return product.price;
}

/** The content (gas) part of a new cylinder's price. The rest of the price pays for the cylinder. */
export function contentPrice(product: Product): Centavos | undefined {
  if (product.kind !== 'cylinder' || product.refillPrice === undefined || product.refillPrice >= product.price) return undefined;
  return product.refillPrice;
}

function addLine(cart: CartLine[], line: CartLine): CartLine[] {
  const key = cartLineKey(line);
  const index = cart.findIndex((l) => cartLineKey(l) === key);
  if (index === -1) return [...cart, line];
  return cart.map((l, i) => (i === index ? { ...l, qty: l.qty + line.qty } : l));
}

export function addToCart(cart: CartLine[], product: Product, type = defaultLineType(product)): CartLine[] {
  return addLine(cart, { type, productId: product.id, qty: 1 });
}

export function addSetToCart(cart: CartLine[], set: ProductSet): CartLine[] {
  return addLine(cart, { type: 'set', setId: set.id, qty: 1 });
}

/** Sets a line's quantity; zero or less removes the line. */
export function changeQty(cart: CartLine[], index: number, qty: number): CartLine[] {
  if (qty <= 0) return cart.filter((_, i) => i !== index);
  return cart.map((line, i) => (i === index ? { ...line, qty } : line));
}

/** Switches a cylinder line between refill and new, merging with an existing line of that type. */
export function changeType(cart: CartLine[], index: number, type: ProductLineType): CartLine[] {
  const line = cart[index];
  if (!line || line.type === 'set' || line.type === type) return cart;
  const target = cart.findIndex((l, i) => i !== index && l.type !== 'set' && l.productId === line.productId && l.type === type);
  if (target === -1) return cart.map((l, i) => (i === index ? { ...line, type } : l));
  return cart
    .map((l, i) => (i === target ? { ...l, qty: l.qty + line.qty } : l))
    .filter((_, i) => i !== index);
}

function productFrom(products: Map<string, Product>, id: string): Product {
  const product = products.get(id);
  if (!product) throw new Error(`Product not found: ${id}`);
  return product;
}

function priceLine(line: CartLine, products: Map<string, Product>, sets: Map<string, ProductSet>): SaleLine {
  if (line.type === 'set') {
    const set = sets.get(line.setId);
    if (!set) throw new Error(`Set not found: ${line.setId}`);
    return {
      type: 'set',
      setId: set.id,
      name: set.name,
      qty: line.qty,
      unitPrice: set.price,
      amount: set.price * line.qty,
      items: set.items.map((item) => ({ ...item, name: productFrom(products, item.productId).name })),
    };
  }
  const product = productFrom(products, line.productId);
  const price = unitPrice(product, line.type);
  const priced: ProductSaleLine = {
    type: line.type,
    productId: product.id,
    name: product.name,
    qty: line.qty,
    unitPrice: price,
    amount: price * line.qty,
  };
  const content = line.type === 'new' ? contentPrice(product) : undefined;
  if (content !== undefined) priced.contentPrice = content;
  return priced;
}

export function priceCart(
  cart: CartLine[],
  products: Map<string, Product>,
  sets: Map<string, ProductSet> = new Map(),
): { lines: SaleLine[]; total: Centavos } {
  const lines = cart.map((line) => priceLine(line, products, sets));
  return { lines, total: lines.reduce((sum, line) => sum + line.amount, 0) };
}

/** The cart with each set opened up into the products it contains. */
export function productUnits(cart: CartLine[], sets: Map<string, ProductSet> = new Map()): ProductCartLine[] {
  return cart.flatMap((line): ProductCartLine[] => {
    if (line.type !== 'set') return [line];
    const set = sets.get(line.setId);
    return set ? set.items.map((item) => ({ type: item.type, productId: item.productId, qty: item.qty * line.qty })) : [];
  });
}

/** A sale's lines with each set opened up into the products it contained. */
export function saleUnits(sale: Pick<Sale, 'lines'>): ProductCartLine[] {
  return sale.lines.flatMap((line): ProductCartLine[] =>
    line.type === 'set'
      ? line.items.map((item) => ({ type: item.type, productId: item.productId, qty: item.qty * line.qty }))
      : [{ type: line.type, productId: line.productId, qty: line.qty }],
  );
}

/** Sellable units the cart needs per product (full cylinders, or accessory units). */
export function cartDemand(units: Pick<ProductCartLine, 'productId' | 'qty'>[]): Map<string, number> {
  const demand = new Map<string, number>();
  for (const line of units) demand.set(line.productId, (demand.get(line.productId) ?? 0) + line.qty);
  return demand;
}

interface StockChange {
  type: MovementType;
  condition: StockCondition;
  qty: number;
}

/**
 * What selling a product one way does to the shelf:
 * - refill: one full cylinder out, one empty cylinder in
 * - new cylinder: one full cylinder out, and one empty out too when NEW_SALE_TAKES_EMPTY is on
 * - borrowed cylinder: one full cylinder out; the empty comes back when it is returned
 * - accessory: one unit out
 */
export function stockChanges(unit: ProductCartLine): StockChange[] {
  const fullOut: StockChange = { type: 'SALE', condition: 'full', qty: -unit.qty };
  switch (unit.type) {
    case 'item':
      return [{ type: 'SALE', condition: 'unit', qty: -unit.qty }];
    case 'refill':
      return [fullOut, { type: 'EMPTY_IN', condition: 'empty', qty: unit.qty }];
    case 'new':
      return NEW_SALE_TAKES_EMPTY ? [fullOut, { type: 'SALE', condition: 'empty', qty: -unit.qty }] : [fullOut];
    case 'borrow':
      return [fullOut];
  }
}

export function saleMovements(sale: Sale, userId: string): StockMovement[] {
  const base = {
    locationId: sale.locationId,
    saleId: sale.id,
    userId,
    deviceId: sale.deviceId,
    occurredAt: sale.createdAt,
    createdAt: sale.createdAt,
    receivedAt: null,
    ...(sale.borrowerName ? { reason: `Borrowing: ${sale.borrowerName}` } : {}),
  };
  return saleUnits(sale).flatMap((unit) =>
    stockChanges(unit).map((change) => ({ ...base, id: uuid(), productId: unit.productId, ...change })),
  );
}
