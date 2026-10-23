/**
 * Named customers: picked or added when selling, and listed on the Products
 * page with any discount the owner gives them. They live in the 'borrowers'
 * collection, where 1.0 kept the Borrowing window's borrowers.
 */
import { discountKey } from './cart';
import type { Customer, CustomerDiscount, Product, ProductSet } from './models';
import { formatPeso } from './money';
import { saveAndQueue, tidyName, type OpContext } from './operations';
import { assertCan, can } from './roles';
import { uuid } from './ids';

export interface CustomerInput {
  /** Missing for a new customer. */
  id?: string;
  name: string;
  phone: string;
  discount?: CustomerDiscount;
}

/** Drops an empty discount, so a customer without one has no discount field at all. */
function cleanDiscount(discount: CustomerDiscount | undefined): CustomerDiscount | undefined {
  if (!discount) return undefined;
  const prices = Object.fromEntries(Object.entries(discount.prices ?? {}).filter(([, price]) => Number.isInteger(price) && price >= 0));
  const percent = discount.percent && discount.percent > 0 ? discount.percent : undefined;
  if (percent !== undefined && (percent >= 100 || !Number.isFinite(percent))) throw new Error('A percentage discount must be from 1 to 99.');
  const result: CustomerDiscount = {
    ...(percent !== undefined ? { percent } : {}),
    ...(Object.keys(prices).length > 0 ? { prices } : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

const sameDiscount = (a: CustomerDiscount | undefined, b: CustomerDiscount | undefined) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});

/**
 * Adds a customer or changes one. Anyone who sells can add a customer and
 * correct a name or phone number; only someone who manages products and prices
 * (the owner or an admin) can give or change a discount.
 */
export async function saveCustomer(ctx: OpContext, input: CustomerInput): Promise<Customer> {
  if (!can(ctx.user, 'pos.sell') && !can(ctx.user, 'borrow.manage')) assertCan(ctx.user, 'products.manage');
  const customers = await ctx.store.list<Customer>('borrowers');
  const current = input.id ? customers.find((c) => c.id === input.id) : undefined;
  if (input.id && !current) throw new Error('That customer is no longer on the list.');
  const name = tidyName(input.name);
  if (name.length < 2) throw new Error("Enter the customer's name.");
  if (name.length > 60) throw new Error('Keep the name under 60 characters.');
  if (customers.some((c) => c.id !== input.id && c.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`Another customer is already called ${name}.`);
  }
  const discount = input.discount === undefined ? current?.discount : cleanDiscount(input.discount);
  if (!sameDiscount(discount, current?.discount)) assertCan(ctx.user, 'products.manage');

  const now = (ctx.now?.() ?? new Date()).toISOString();
  const phone = input.phone.trim();
  const customer: Customer = {
    id: current?.id ?? uuid(),
    name,
    ...(phone ? { phone } : {}),
    ...(discount ? { discount } : {}),
    createdAt: current?.createdAt ?? now,
    receivedAt: null,
  };
  await ctx.store.batch(saveAndQueue('borrowers', [customer], now));
  return customer;
}

/** What a customer's own price key names: "Brand A 11 kg, refill" or "Starter kit (set)". */
export function discountKeyLabel(key: string, products: Map<string, Product>, sets: Map<string, ProductSet>): string {
  const [first, second] = key.split(':');
  if (first === 'set') return `${sets.get(second)?.name ?? 'Missing set'} (set)`;
  const name = products.get(first)?.name ?? 'Missing product';
  return second === 'item' ? name : `${name}, ${second === 'new' ? 'new cylinder' : 'refill'}`;
}

/** The ways a customer can be given their own price: each product as it is sold, and each set. */
export function discountTargets(products: Product[], sets: ProductSet[]): { key: string; label: string; regular: number }[] {
  const productsById = new Map(products.map((p) => [p.id, p]));
  const setsById = new Map(sets.map((s) => [s.id, s]));
  const targets = [
    ...products.flatMap((p) =>
      p.kind === 'cylinder'
        ? [
            { key: discountKey({ type: 'refill', productId: p.id }), regular: p.refillPrice ?? p.price },
            { key: discountKey({ type: 'new', productId: p.id }), regular: p.price },
          ]
        : [{ key: discountKey({ type: 'item', productId: p.id }), regular: p.price }],
    ),
    ...sets.map((s) => ({ key: discountKey({ type: 'set', setId: s.id }), regular: s.price })),
  ];
  return targets.map((t) => ({ ...t, label: discountKeyLabel(t.key, productsById, setsById) }));
}

/** "10% off everything · Brand A 11 kg, refill ₱900.00" */
export function describeDiscount(discount: CustomerDiscount | undefined, products: Map<string, Product>, sets: Map<string, ProductSet>): string {
  if (!discount) return '';
  return [
    discount.percent ? `${+discount.percent.toFixed(2)}% off everything` : '',
    ...Object.entries(discount.prices ?? {}).map(([key, price]) => `${discountKeyLabel(key, products, sets)} ${formatPeso(price)}`),
  ]
    .filter(Boolean)
    .join(' · ');
}
