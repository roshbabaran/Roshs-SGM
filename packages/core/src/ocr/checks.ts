/**
 * Stage 9: checking the arithmetic and filling gaps. On each line the quantity
 * times the unit price should be the amount, and the amounts should add up to
 * the total. When one value disagrees and the others agree with each other or
 * with SGM's price list, the likely right value is proposed and marked for the
 * cashier to check. Nothing is changed silently: every worked-out or corrected
 * value is marked 'check' with a note saying why.
 */
import { formatPeso, type Centavos } from '../money';
import type { DraftField } from './types';

/** A field read from a cell this unsure (0–1) is marked for checking. */
export const MIN_CONFIDENCE = 0.8;

export interface LineFields {
  qty: DraftField<number>;
  unitPrice: DraftField<Centavos>;
  amount: DraftField<Centavos>;
}

const MAX_QTY = 999;

function set<T>(field: DraftField<T>, value: T, note: string): void {
  field.value = value;
  field.status = 'check';
  field.note = note;
}

/** Wholly divides, giving a sensible quantity. */
function quotient(amount: Centavos, price: Centavos): number | null {
  if (price <= 0 || amount % price !== 0) return null;
  const q = amount / price;
  return q >= 1 && q <= MAX_QTY ? q : null;
}

/** How much a field can be trusted, for deciding which of two disagreeing values to doubt. */
function trust(field: DraftField<unknown>): number {
  if (field.value === null) return 0;
  if (field.status !== 'ok') return 0.5;
  return field.confidence ?? 1;
}

/**
 * Makes one line's quantity, unit price and amount agree, filling what's
 * missing. `listPrice` is SGM's price for the matched product, if any.
 */
export function checkLine(fields: LineFields, listPrice: Centavos | null): void {
  const { qty, unitPrice, amount } = fields;

  // Fill in what wasn't written or couldn't be read.
  if (qty.value === null) {
    const fromAmount =
      amount.value !== null ? (unitPrice.value !== null ? quotient(amount.value, unitPrice.value) : listPrice ? quotient(amount.value, listPrice) : null) : null;
    if (fromAmount !== null) set(qty, fromAmount, 'Worked out from the amount and the price.');
    else set(qty, 1, 'No quantity found, so it was set to 1.');
  }
  if (unitPrice.value === null) {
    const fromAmount = amount.value !== null && qty.value ? (amount.value % qty.value === 0 ? amount.value / qty.value : null) : null;
    if (fromAmount !== null) set(unitPrice, fromAmount, 'Worked out from the amount and the quantity.');
    else if (listPrice !== null) set(unitPrice, listPrice, "Not read, so SGM's price was used.");
  }
  if (amount.value === null && qty.value !== null && unitPrice.value !== null) {
    set(amount, qty.value * unitPrice.value, 'Worked out from the quantity and the price.');
  }

  const q = qty.value;
  const u = unitPrice.value;
  const a = amount.value;
  if (q === null || u === null || a === null || q * u === a) return;

  // "980⁰⁰" read as 98000: the amount carries the cents twice.
  if (a === q * u * 100) {
    set(amount, q * u, `Read as ${formatPeso(a)}; quantity × price is ${formatPeso(q * u)}.`);
    return;
  }
  // The amount agrees with the price list, so the written unit price is the odd one out.
  if (listPrice !== null && u !== listPrice && q * listPrice === a) {
    set(unitPrice, listPrice, `Read as ${formatPeso(u)}; the amount and SGM's price say ${formatPeso(listPrice)}.`);
    return;
  }
  const qtyFromAmount = quotient(a, u);
  const amountFromQty = q * u;
  // Doubt whichever of quantity and amount was read less surely.
  if (qtyFromAmount !== null && trust(qty) < trust(amount)) {
    set(qty, qtyFromAmount, `Read as ${q}; the amount and price say ${qtyFromAmount}.`);
    return;
  }
  if (listPrice === null || u === listPrice || qtyFromAmount === null) {
    set(amount, amountFromQty, `Read as ${formatPeso(a)}; ${q} × ${formatPeso(u)} is ${formatPeso(amountFromQty)}.`);
    return;
  }
  set(qty, qtyFromAmount, `Read as ${q}; the amount and price say ${qtyFromAmount}.`);
}

/** Notes the price list difference, which matters because the sale charges SGM's price, not the written one. */
export function checkListPrice(fields: LineFields, listPrice: Centavos | null): void {
  const { unitPrice } = fields;
  if (listPrice === null || unitPrice.value === null || unitPrice.value === listPrice) return;
  unitPrice.status = 'check';
  unitPrice.note = `SGM's price is ${formatPeso(listPrice)}, and the sale will use it. ${unitPrice.note ?? ''}`.trim();
}

/**
 * Compares the written total with the line amounts. Returns notes for the
 * receipt as a whole; marks the total for checking when they disagree.
 */
export function checkTotal(total: DraftField<Centavos>, amounts: (Centavos | null)[], cartTotal: Centavos | null): string[] {
  const notes: string[] = [];
  const known = amounts.filter((a): a is Centavos => a !== null);
  const sum = known.reduce((s, a) => s + a, 0);
  if (total.value === null) {
    if (known.length > 0) {
      total.value = sum;
      total.status = 'check';
      total.note = 'No total found; this is the sum of the amounts.';
    }
  } else if (known.length === amounts.length && sum !== total.value) {
    if (total.value === sum * 100) {
      total.note = `Read as ${formatPeso(total.value)}; the amounts add up to ${formatPeso(sum)}.`;
      total.value = sum;
    } else {
      total.note = `The amounts add up to ${formatPeso(sum)}, but the total reads ${formatPeso(total.value)}.`;
      notes.push(total.note);
    }
    total.status = 'check';
  }
  if (cartTotal !== null && total.value !== null && cartTotal !== total.value) {
    notes.push(`At SGM's prices this sale comes to ${formatPeso(cartTotal)}; the receipt says ${formatPeso(total.value)}.`);
  }
  return notes;
}
