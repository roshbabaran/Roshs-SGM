/**
 * Stage 10, the end of review: the sale the scan window saves. Kept here, not
 * in the window, so the total the cashier sees and the payment sent to
 * recordSale come from one place: both price the cart with the same linked
 * customer, whose standing discount recordSale applies too.
 */
import { priceCart, type CartLine } from '../cart';
import type { Customer, Product, ProductSet } from '../models';
import type { Centavos } from '../money';
import { tidyName, type SaleInput } from '../operations';
import { editDistance } from './layout';

/**
 * The customer a name written on a receipt links: the one the cashier picked,
 * else the one whose name is exactly the written name (ignoring case and extra
 * spaces). Never a new customer.
 */
export function linkedCustomer(name: string, pickedId: string | null, customers: Customer[]): Customer | null {
  const picked = pickedId ? customers.find((c) => c.id === pickedId) : undefined;
  if (picked) return picked;
  const written = tidyName(name).toLowerCase();
  return written ? (customers.find((c) => tidyName(c.name).toLowerCase() === written) ?? null) : null;
}

/**
 * A name as compared with the customer list: small letters only, no spaces,
 * and the letters the reader confuses in handwriting made the same ("l", "I",
 * "J" and "1"; "O" and "0"; "u" and "v"; "rn" and "m").
 */
function nameForm(name: string): string {
  return name
    .toLowerCase()
    .replace(/rn/g, 'm')
    .replace(/[lij1|!]/g, 'i')
    .replace(/0/g, 'o')
    .replace(/v/g, 'u')
    .replace(/5/g, 's')
    .replace(/[^a-z]/g, '');
}

/** How alike a written name and a customer's name are, 0 to 1; a customer's name is also tried without what follows "(" ("Lito Garcia (Garcia Eatery)"). */
export function nameSimilarity(written: string, customer: string): number {
  const a = nameForm(written);
  if (a.length < 2) return 0;
  const forms = [customer, customer.split('(')[0]].map(nameForm).filter((b) => b.length >= 2);
  return Math.max(0, ...forms.map((b) => 1 - editDistance(a, b) / Math.max(a.length, b.length)));
}

/** At least this alike to be suggested, and this alike to be shown as the likely customer. */
export const NAME_SUGGEST = { suggest: 0.7, likely: 0.88 };

/**
 * Customers whose names are close to a name read from a receipt, closest
 * first: a read that is off by a letter or two ("loy Navarro" for Joy
 * Navarro) still finds them. Only suggestions for the cashier: nothing is
 * linked until they pick one, and no customer is ever added.
 */
export function nameSuggestions(written: string, customers: Customer[], limit = 3): { customer: Customer; similarity: number }[] {
  return customers
    .map((customer) => ({ customer, similarity: nameSimilarity(written, customer.name) }))
    .filter((s) => s.similarity >= NAME_SUGGEST.suggest)
    .sort((a, b) => b.similarity - a.similarity || a.customer.name.localeCompare(b.customer.name))
    .slice(0, limit);
}

export interface ScannedSale {
  cart: CartLine[];
  /** The name as written on the receipt (may be empty). */
  name: string;
  /** From linkedCustomer. */
  customer: Customer | null;
  products: Map<string, Product>;
  sets: Map<string, ProductSet>;
  slipNo?: string;
  /** From saleTimeFor. */
  soldAt: string;
  timeEstimated: boolean;
}

/** The sale's total at SGM's prices, with the linked customer's own prices: what the window shows and recordSale charges. */
export function scannedTotal(scan: Pick<ScannedSale, 'cart' | 'customer' | 'products' | 'sets'>): Centavos {
  return priceCart(scan.cart, scan.products, scan.sets, scan.customer).total;
}

/** The total, and the recordSale input that pays it in cash. */
export function scannedSaleInput(scan: ScannedSale): { total: Centavos; input: SaleInput } {
  const total = scannedTotal(scan);
  const name = tidyName(scan.name);
  const slipNo = scan.slipNo?.trim();
  return {
    total,
    input: {
      cart: scan.cart,
      payment: { method: 'cash', amount: total, tendered: total, change: 0 },
      ...(slipNo ? { slipNo } : {}),
      ...(scan.customer ? { customer: { id: scan.customer.id, name: scan.customer.name } } : {}),
      ...(name ? { registeredName: name } : {}),
      soldAt: scan.soldAt,
      timeEstimated: scan.timeEstimated,
    },
  };
}
