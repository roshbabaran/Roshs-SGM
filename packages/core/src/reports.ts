import { formatDay, localDay } from './dates';
import { PAYMENT_LABELS, type PaymentMethod, type Sale } from './models';
import type { Centavos } from './money';

/** Completed (not voided) sales whose local day is within [from, to]. */
export function salesBetween(sales: Sale[], from: string, to: string, locationId?: string): Sale[] {
  return sales.filter((sale) => {
    if (sale.status !== 'completed') return false;
    if (locationId && sale.locationId !== locationId) return false;
    const day = localDay(sale.createdAt);
    return day >= from && day <= to;
  });
}

export interface DayTotal {
  day: string;
  label: string;
  total: Centavos;
  count: number;
}

export function dailyTotals(sales: Sale[], days: string[]): DayTotal[] {
  const totals = new Map(days.map((day) => [day, { day, label: formatDay(day), total: 0, count: 0 }]));
  for (const sale of sales) {
    const entry = totals.get(localDay(sale.createdAt));
    if (!entry) continue;
    entry.total += sale.total;
    entry.count += 1;
  }
  return Array.from(totals.values());
}

export interface ProductTotal {
  productId: string;
  name: string;
  qty: number;
  amount: Centavos;
}

export function productTotals(sales: Sale[]): ProductTotal[] {
  const totals = new Map<string, ProductTotal>();
  for (const sale of sales) {
    for (const line of sale.lines) {
      const entry = totals.get(line.productId) ?? { productId: line.productId, name: line.name, qty: 0, amount: 0 };
      entry.qty += line.qty;
      entry.amount += line.amount;
      totals.set(line.productId, entry);
    }
  }
  return Array.from(totals.values()).sort((a, b) => b.amount - a.amount);
}

export interface PaymentTotal {
  method: PaymentMethod;
  label: string;
  count: number;
  amount: Centavos;
}

export function paymentTotals(sales: Sale[]): PaymentTotal[] {
  const totals = new Map<PaymentMethod, PaymentTotal>();
  for (const sale of sales) {
    const method = sale.payment.method;
    const entry = totals.get(method) ?? { method, label: PAYMENT_LABELS[method], count: 0, amount: 0 };
    entry.count += 1;
    entry.amount += sale.total;
    totals.set(method, entry);
  }
  return Array.from(totals.values()).sort((a, b) => b.amount - a.amount);
}
