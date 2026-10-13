/** The owner's product list and sets: adding them, changing prices, hiding them from sale. */
import { LINE_TYPE_LABELS, unitPrice } from './cart';
import { uuid } from './ids';
import type { Product, ProductSet } from './models';
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

/** Adds a set (no id) or changes one. */
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

  const set: ProductSet = {
    id: current?.id ?? uuid(),
    name: input.name,
    items: input.items,
    price: input.price,
    active: input.active,
    receivedAt: null,
  };
  const now = (ctx.now?.() ?? new Date()).toISOString();
  await ctx.store.batch(saveAndQueue('sets', [set], now));
  return set;
}

/** What a set's items cost when bought one by one. */
export function regularPrice(set: Pick<ProductSet, 'items'>, products: Map<string, Product>): Centavos {
  return set.items.reduce((sum, item) => {
    const product = products.get(item.productId);
    return product ? sum + unitPrice(product, item.type) * item.qty : sum;
  }, 0);
}

/** "1 × Brand A 11 kg (new), 1 × LPG regulator" */
export function describeSet(set: Pick<ProductSet, 'items'>, products: Map<string, Product>): string {
  return set.items
    .map((item) => {
      const name = products.get(item.productId)?.name ?? 'Missing product';
      return `${item.qty} × ${name}${item.type === 'item' ? '' : ` (${item.type})`}`;
    })
    .join(', ');
}
