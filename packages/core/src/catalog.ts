/** The owner's product list and sets: adding them, changing prices, hiding them from sale. */
import { LINE_TYPE_LABELS, nestedSetNames, setContents, unitPrice } from './cart';
import { uuid } from './ids';
import type { NestedSet, Product, ProductSet, SetItem } from './models';
import type { Centavos } from './money';
import { saveAndQueue, type OpContext } from './operations';
import { assertCan } from './roles';
import type { ProductInput, SetInput } from './validation';

const MAX_SKU = 20;

/** A product code made from its name: "Brand C 11 kg" becomes "BRAND-C-11-KG". */
export function skuFrom(name: string): string {
  const trim = (code: string) => code.replace(/^-+|-+$/g, '');
  return trim(trim(name.toUpperCase().replace(/[^A-Z0-9.]+/g, '-')).slice(0, MAX_SKU)) || 'ITEM';
}

function uniqueSku(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const code = `${base.slice(0, MAX_SKU - String(n).length - 1)}-${n}`;
    if (!taken.has(code)) return code;
  }
}

/** Adds a product (no id) or changes one. New products start with no stock; record a delivery to add some. */
export async function saveProduct(ctx: OpContext, input: ProductInput, id?: string): Promise<Product> {
  assertCan(ctx.user, 'products.manage');
  const products = await ctx.store.list<Product>('products');
  const current = id ? products.find((p) => p.id === id) : undefined;
  if (id && !current) throw new Error('That product no longer exists.');
  if (current && current.kind !== input.kind) {
    throw new Error("A product can't change between cylinder and accessory. Add a new product instead.");
  }
  const others = products.filter((p) => p.id !== id);
  if (others.some((p) => p.name.toLowerCase() === input.name.toLowerCase())) {
    throw new Error(`There is already a product called ${input.name}.`);
  }
  const taken = new Set(others.map((p) => p.sku.toUpperCase()));
  const owner = others.find((p) => p.sku.toUpperCase() === input.sku);
  if (input.sku && owner) throw new Error(`The code ${input.sku} is already used by ${owner.name}.`);
  const sku = input.sku || current?.sku || uniqueSku(skuFrom(input.name), taken);

  const product: Product = {
    id: current?.id ?? uuid(),
    sku,
    name: input.name,
    kind: input.kind,
    ...(input.brand ? { brand: input.brand } : {}),
    ...(input.sizeKg !== undefined ? { sizeKg: input.sizeKg } : {}),
    ...(input.refillPrice !== undefined ? { refillPrice: input.refillPrice } : {}),
    price: input.price,
    lowStockAt: input.lowStockAt,
    active: input.active,
    receivedAt: null,
  };
  const now = (ctx.now?.() ?? new Date()).toISOString();
  await ctx.store.batch(saveAndQueue('products', [product], now));
  return product;
}

/** Whether `set` has the set `targetId` inside it, directly or deeper down. */
export function containsSet(set: Pick<ProductSet, 'sets'>, targetId: string, sets: Map<string, ProductSet>, seen = new Set<string>()): boolean {
  for (const nested of set.sets ?? []) {
    if (nested.setId === targetId) return true;
    const child = sets.get(nested.setId);
    if (child && !seen.has(child.id)) {
      seen.add(child.id);
      if (containsSet(child, targetId, sets, seen)) return true;
    }
  }
  return false;
}

/** The sets that have this set inside them, directly or deeper down: changing it changes them too. */
export function setsContaining(setId: string, sets: ProductSet[]): ProductSet[] {
  const byId = new Map(sets.map((s) => [s.id, s]));
  return sets.filter((s) => s.id !== setId && containsSet(s, setId, byId));
}

/** Adds a set (no id) or changes one. A set can hold products and other sets, but never itself. */
export async function saveSet(ctx: OpContext, input: SetInput, id?: string): Promise<ProductSet> {
  assertCan(ctx.user, 'products.manage');
  const [products, sets] = await Promise.all([ctx.store.list<Product>('products'), ctx.store.list<ProductSet>('sets')]);
  const current = id ? sets.find((s) => s.id === id) : undefined;
  if (id && !current) throw new Error('That set no longer exists.');
  if (sets.some((s) => s.id !== id && s.name.toLowerCase() === input.name.toLowerCase())) {
    throw new Error(`There is already a set called ${input.name}.`);
  }
  for (const item of input.items) {
    const product = products.find((p) => p.id === item.productId);
    if (!product) throw new Error('One of the items is no longer a product.');
    const fits = product.kind === 'cylinder' ? item.type !== 'item' : item.type === 'item';
    if (!fits) throw new Error(`${product.name} can't be sold as ${LINE_TYPE_LABELS[item.type].toLowerCase()}.`);
  }
  const setId = current?.id ?? uuid();
  const byId = new Map(sets.map((s) => [s.id, s]));
  for (const nested of input.sets) {
    const child = byId.get(nested.setId);
    if (!child) throw new Error('One of the sets inside it no longer exists.');
    if (child.id === setId || containsSet(child, setId, byId)) {
      throw new Error(`${child.name} already has ${input.name} inside it, so it can't also go inside ${input.name}.`);
    }
  }
  if (input.items.length === 0 && input.sets.length === 0) throw new Error('Add at least one item or set.');

  const set: ProductSet = {
    id: setId,
    name: input.name,
    items: input.items,
    ...(input.sets.length > 0 ? { sets: input.sets } : {}),
    price: input.price,
    active: input.active,
    receivedAt: null,
  };
  const now = (ctx.now?.() ?? new Date()).toISOString();
  await ctx.store.batch(saveAndQueue('sets', [set], now));
  return set;
}

function itemsPrice(items: SetItem[], products: Map<string, Product>): Centavos {
  return items.reduce((sum, item) => {
    const product = products.get(item.productId);
    return product ? sum + unitPrice(product, item.type) * item.qty : sum;
  }, 0);
}

/**
 * What everything in a set costs when bought one by one at the products'
 * regular prices, with the sets inside it opened up (so a set inside never
 * counts at its own lower price). A set's saving is measured against this.
 */
export function regularPrice(
  set: Pick<ProductSet, 'items' | 'sets'> & { id?: string },
  products: Map<string, Product>,
  sets: Map<string, ProductSet> = new Map(),
): Centavos {
  return itemsPrice(setContents(set, sets), products);
}

/**
 * The price a new set gets until the owner types one: its own items at their
 * regular prices, plus each set inside it at that set's price.
 */
export function suggestedSetPrice(
  set: Pick<ProductSet, 'items'> & { sets?: NestedSet[] },
  products: Map<string, Product>,
  sets: Map<string, ProductSet>,
): Centavos {
  return itemsPrice(set.items, products) + (set.sets ?? []).reduce((sum, n) => sum + (sets.get(n.setId)?.price ?? 0) * n.qty, 0);
}

const itemText = (item: SetItem, products: Map<string, Product>) =>
  `${item.qty} × ${products.get(item.productId)?.name ?? 'Missing product'}${item.type === 'item' ? '' : ` (${item.type})`}`;

/** Everything in a set as products, the way the counter shows it: "1 × Brand A 11 kg (new), 1 × LPG regulator". */
export function describeSet(
  set: Pick<ProductSet, 'items' | 'sets'> & { id?: string },
  products: Map<string, Product>,
  sets: Map<string, ProductSet> = new Map(),
): string {
  return setContents(set, sets)
    .map((item) => itemText(item, products))
    .join(', ');
}

/** A set as it was put together, for the Products page: the sets inside it by name, then its own items. */
export function describeSetParts(set: Pick<ProductSet, 'items' | 'sets'>, products: Map<string, Product>, sets: Map<string, ProductSet>): string {
  return [...nestedSetNames(set.sets, sets).map((name) => `${name} (set)`), ...set.items.map((item) => itemText(item, products))].join(', ');
}
