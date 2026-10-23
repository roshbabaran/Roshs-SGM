import { NEW_SALE_TAKES_EMPTY } from './config';
import { uuid } from './ids';
import type {
  Customer,
  Discount,
  LineDiscount,
  MovementType,
  NestedSet,
  Product,
  ProductLineType,
  ProductSaleLine,
  ProductSet,
  Sale,
  SaleLine,
  SaleLineType,
  SetItem,
  StockCondition,
  StockMovement,
} from './models';
import { formatPeso, type Centavos } from './money';

export interface ProductCartLine {
  type: ProductLineType;
  productId: string;
  qty: number;
  /** A discount the cashier gave at the counter (needs pos.discount). It wins over the customer's own discount. */
  discount?: Discount;
}

export interface SetCartLine {
  type: 'set';
  setId: string;
  qty: number;
  discount?: Discount;
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

/**
 * Everything a set contains, with the sets inside it opened up into their
 * products. The same product sold the same way is added up into one item.
 */
export function setContents(set: Pick<ProductSet, 'items' | 'sets'> & { id?: string }, sets: Map<string, ProductSet>): SetItem[] {
  const totals = new Map<string, SetItem>();
  const add = (items: SetItem[], times: number) => {
    for (const item of items) {
      const key = `${item.productId}:${item.type}`;
      const current = totals.get(key);
      totals.set(key, { ...item, qty: (current?.qty ?? 0) + item.qty * times });
    }
  };
  const open = (current: Pick<ProductSet, 'items' | 'sets'>, times: number, inside: Set<string>) => {
    add(current.items, times);
    for (const nested of current.sets ?? []) {
      const child = sets.get(nested.setId);
      // A set that is missing, or that would contain itself, adds nothing.
      if (!child || inside.has(child.id)) continue;
      open(child, times * nested.qty, new Set([...inside, child.id]));
    }
  };
  open(set, 1, new Set(set.id ? [set.id] : []));
  return Array.from(totals.values());
}

/** The sets inside a set, by name: "1 × Starter kit 11 kg". */
export function nestedSetNames(nested: NestedSet[] | undefined, sets: Map<string, ProductSet>): string[] {
  return (nested ?? []).map((n) => `${n.qty} × ${sets.get(n.setId)?.name ?? 'Missing set'}`);
}

/** The key a customer's own price is kept under: "productId:refill", "productId:item" or "set:setId". */
export function discountKey(line: Pick<ProductCartLine, 'type' | 'productId'> | Pick<SetCartLine, 'type' | 'setId'>): string {
  if (line.type === 'set') return `set:${line.setId}`;
  return `${line.productId}:${line.type === 'borrow' ? 'refill' : line.type}`;
}

/** The customer's standing discount for this line: their own price for it, otherwise their percentage. */
export function customerDiscountFor(
  customer: Pick<Customer, 'discount'> | null | undefined,
  line: Pick<ProductCartLine, 'type' | 'productId'> | Pick<SetCartLine, 'type' | 'setId'>,
): Discount | undefined {
  const price = customer?.discount?.prices?.[discountKey(line)];
  if (price !== undefined) return { kind: 'price', price };
  const percent = customer?.discount?.percent;
  return percent ? { kind: 'percent', percent } : undefined;
}

/** One unit's price after a discount, in whole centavos, never more than the regular price. */
export function discountedPrice(regular: Centavos, discount: Discount): Centavos {
  const price = discount.kind === 'percent' ? Math.round((regular * (100 - discount.percent)) / 100) : discount.price;
  return Math.max(0, Math.min(regular, price));
}

/** "10% off" or "₱900.00 each" */
export function discountLabel(discount: Discount): string {
  return discount.kind === 'percent' ? `${+discount.percent.toFixed(2)}% off` : `${formatPeso(discount.price)} each`;
}

/** How much a priced line was discounted in all. */
export function lineDiscountAmount(line: Pick<SaleLine, 'regularPrice' | 'unitPrice' | 'qty'>): Centavos {
  return line.regularPrice === undefined ? 0 : (line.regularPrice - line.unitPrice) * line.qty;
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

/** Gives a line a discount at the counter, or takes it away (undefined). */
export function changeDiscount(cart: CartLine[], index: number, discount: Discount | undefined): CartLine[] {
  return cart.map((line, i) => {
    if (i !== index) return line;
    const { discount: _old, ...rest } = line;
    return discount ? { ...rest, discount } : rest;
  });
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

/** The price after the discount the cashier gave, or else the customer's own discount, and where it came from. */
function applyDiscount(
  line: CartLine,
  regular: Centavos,
  customer: Pick<Customer, 'discount'> | null | undefined,
): { unitPrice: Centavos; regularPrice?: Centavos; discount?: LineDiscount } {
  const fromCustomer = customerDiscountFor(customer, line);
  const chosen: LineDiscount | undefined = line.discount
    ? { ...line.discount, source: 'counter' }
    : fromCustomer
      ? { ...fromCustomer, source: 'customer' }
      : undefined;
  if (!chosen) return { unitPrice: regular };
  const price = discountedPrice(regular, chosen);
  return price < regular ? { unitPrice: price, regularPrice: regular, discount: chosen } : { unitPrice: regular };
}

function priceLine(
  line: CartLine,
  products: Map<string, Product>,
  sets: Map<string, ProductSet>,
  customer: Pick<Customer, 'discount'> | null | undefined,
): SaleLine {
  if (line.type === 'set') {
    const set = sets.get(line.setId);
    if (!set) throw new Error(`Set not found: ${line.setId}`);
    const price = applyDiscount(line, set.price, customer);
    return {
      type: 'set',
      setId: set.id,
      name: set.name,
      qty: line.qty,
      ...price,
      amount: price.unitPrice * line.qty,
      items: setContents(set, sets).map((item) => ({ ...item, name: productFrom(products, item.productId).name })),
    };
  }
  const product = productFrom(products, line.productId);
  const price = applyDiscount(line, unitPrice(product, line.type), customer);
  const priced: ProductSaleLine = {
    type: line.type,
    productId: product.id,
    name: product.name,
    qty: line.qty,
    ...price,
    amount: price.unitPrice * line.qty,
  };
  const content = line.type === 'new' ? contentPrice(product) : undefined;
  if (content !== undefined) priced.contentPrice = content;
  return priced;
}

/** Prices every line: the regular price, less the cashier's discount or else the customer's own discount. */
export function priceCart(
  cart: CartLine[],
  products: Map<string, Product>,
  sets: Map<string, ProductSet> = new Map(),
  customer?: Pick<Customer, 'discount'> | null,
): { lines: SaleLine[]; total: Centavos } {
  const lines = cart.map((line) => priceLine(line, products, sets, customer));
  return { lines, total: lines.reduce((sum, line) => sum + line.amount, 0) };
}

/** The cart with each set opened up into the products it contains. */
export function productUnits(cart: CartLine[], sets: Map<string, ProductSet> = new Map()): ProductCartLine[] {
  return cart.flatMap((line): ProductCartLine[] => {
    if (line.type !== 'set') return [{ type: line.type, productId: line.productId, qty: line.qty }];
    const set = sets.get(line.setId);
    return set ? setContents(set, sets).map((item) => ({ type: item.type, productId: item.productId, qty: item.qty * line.qty })) : [];
  });
}

/** One sale line's products, for `qty` of it (a set opens up into what it contained when sold). */
export function lineUnits(line: SaleLine, qty = line.qty): ProductCartLine[] {
  return line.type === 'set'
    ? line.items.map((item) => ({ type: item.type, productId: item.productId, qty: item.qty * qty }))
    : [{ type: line.type, productId: line.productId, qty }];
}

/** A sale's lines with each set opened up into the products it contained. */
export function saleUnits(sale: Pick<Sale, 'lines'>): ProductCartLine[] {
  return sale.lines.flatMap((line) => lineUnits(line));
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

/** A sale made in the Borrowing window: on the customer's account, or lending a cylinder. */
export function isBorrowingSale(sale: Pick<Sale, 'lines' | 'payment'>): boolean {
  return sale.payment.method === 'credit' || sale.lines.some((line) => line.type === 'borrow');
}

/** The stock a sale takes off the shelf. A prepaid order takes none until it is picked up (claims.ts). */
export function saleMovements(sale: Sale, userId: string): StockMovement[] {
  if (sale.prepaid) return [];
  const base = {
    locationId: sale.locationId,
    saleId: sale.id,
    userId,
    deviceId: sale.deviceId,
    occurredAt: sale.createdAt,
    createdAt: sale.createdAt,
    receivedAt: null,
    ...(sale.borrowerName ? { reason: `${isBorrowingSale(sale) ? 'Borrowing' : 'Customer'}: ${sale.borrowerName}` } : {}),
  };
  return saleUnits(sale).flatMap((unit) =>
    stockChanges(unit).map((change) => ({ ...base, id: uuid(), productId: unit.productId, ...change })),
  );
}
