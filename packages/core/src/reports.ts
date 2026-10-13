import type { BorrowingTotals } from './borrowing';
import { BUSINESS } from './config';
import { dayRange, formatDateTime, formatDay, localDay, parseDay } from './dates';
import { PAYMENT_LABELS, type PaymentMethod, type Sale } from './models';
import { formatPeso, type Centavos } from './money';
import { escapeHtml } from './receipt';

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
  /** The product's id, or "set:" and the set's id. */
  key: string;
  name: string;
  qty: number;
  amount: Centavos;
}

/** Sales per product. Sets are counted as sets, not split into their items. */
export function productTotals(sales: Sale[]): ProductTotal[] {
  const totals = new Map<string, ProductTotal>();
  for (const sale of sales) {
    for (const line of sale.lines) {
      const key = line.type === 'set' ? `set:${line.setId}` : line.productId;
      const entry = totals.get(key) ?? { key, name: line.type === 'set' ? `${line.name} (set)` : line.name, qty: 0, amount: 0 };
      entry.qty += line.qty;
      entry.amount += line.amount;
      totals.set(key, entry);
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

export interface SalesReportInput {
  from: string;
  to: string;
  /** "All branches" or the branch's name. */
  branchName: string;
  /** Completed sales in the range, as from salesBetween(). */
  sales: Sale[];
  borrowing?: BorrowingTotals;
  printedBy: string;
  printedAt: Date;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const longDay = (day: string) => `${formatDay(day)}, ${parseDay(day).getFullYear()}`;

/** The sales report as an A4 page, for the system print dialog (or "Save as PDF"). */
export function salesReportHtml(report: SalesReportInput): string {
  const e = escapeHtml;
  const total = report.sales.reduce((sum, s) => sum + s.total, 0);
  const count = report.sales.length;
  const days = dailyTotals(report.sales, dayRange(report.from, report.to));
  const table = (headers: string[], rows: string[][], foot?: string[]) => `
    <table>
      <thead><tr>${headers.map((h, i) => `<th${i > 0 ? ' class="num"' : ''}>${e(h)}</th>`).join('')}</tr></thead>
      <tbody>${
        rows.length > 0
          ? rows.map((r) => `<tr>${r.map((c, i) => `<td${i > 0 ? ' class="num"' : ''}>${e(c)}</td>`).join('')}</tr>`).join('')
          : `<tr><td colspan="${headers.length}" class="none">No sales in this period.</td></tr>`
      }</tbody>
      ${foot ? `<tfoot><tr>${foot.map((c, i) => `<td${i > 0 ? ' class="num"' : ''}>${e(c)}</td>`).join('')}</tr></tfoot>` : ''}
    </table>`;
  const range = report.from === report.to ? longDay(report.from) : `${longDay(report.from)} to ${longDay(report.to)}`;
  const borrowing = report.borrowing;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Sales report ${e(range)}</title>
<style>
  @page { size: A4; margin: 15mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 10.5pt/1.4 Arial, Helvetica, sans-serif; color: #000; }
  h1 { font-size: 16pt; margin: 0; }
  h2 { font-size: 13pt; margin: 14pt 0 5pt; }
  .muted { color: #444; }
  .head { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #000; padding-bottom: 6pt; }
  .summary { display: flex; gap: 10pt; margin-top: 10pt; }
  .tile { flex: 1; border: 1px solid #999; border-radius: 4pt; padding: 6pt 8pt; }
  .tile b { display: block; font-size: 13pt; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  th, td { border-bottom: 1px solid #ccc; padding: 2.5pt 6pt; text-align: left; }
  th { background: #eee; font-weight: bold; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  tfoot td { font-weight: bold; border-top: 1.5px solid #000; }
  .none { color: #666; text-align: center; }
  .columns { display: flex; gap: 14pt; }
  .columns > div { flex: 1; }
  .foot { margin-top: 12pt; font-size: 9pt; color: #444; }
</style>
</head>
<body>
  <div class="head">
    <div>
      <h1>${e(BUSINESS.name)}</h1>
      <div class="muted">${e(BUSINESS.address)} · ${e(BUSINESS.tin)}</div>
    </div>
    <div style="text-align: right">
      <b>Sales report</b><br>
      ${e(range)}<br>
      ${e(report.branchName)}
    </div>
  </div>

  <div class="summary">
    <div class="tile">Total sales<b>${e(formatPeso(total))}</b></div>
    <div class="tile">Transactions<b>${count}</b></div>
    <div class="tile">Average sale<b>${e(formatPeso(count ? Math.round(total / count) : 0))}</b></div>
  </div>

  <h2>Sales per day</h2>
  ${table(
    ['Day', 'Transactions', 'Amount'],
    days.map((d) => [`${WEEKDAYS[parseDay(d.day).getDay()]} ${d.label}`, String(d.count), formatPeso(d.total)]),
    ['Total', String(count), formatPeso(total)],
  )}

  <div class="columns">
    <div>
      <h2>By product</h2>
      ${table(
        ['Product', 'Qty sold', 'Amount'],
        productTotals(report.sales).map((p) => [p.name, String(p.qty), formatPeso(p.amount)]),
      )}
    </div>
    <div>
      <h2>By payment method</h2>
      ${table(
        ['Payment', 'Sales', 'Amount'],
        paymentTotals(report.sales).map((p) => [p.label, String(p.count), formatPeso(p.amount)]),
      )}
    </div>
  </div>
  ${
    borrowing
      ? `<h2>Borrowing</h2>
  ${table(
    ['', 'Amount'],
    [
      ['Refills put on account', formatPeso(borrowing.credit)],
      ['Payments collected on accounts', formatPeso(borrowing.collected)],
      ['Cylinders lent', String(borrowing.lent)],
      ['Borrowed cylinders returned', String(borrowing.returned)],
    ],
  )}`
      : ''
  }

  <div class="foot">Completed sales only; voided sales are left out. Sales put on account are counted when made. Printed ${e(formatDateTime(report.printedAt.toISOString()))} by ${e(report.printedBy)}.</div>
</body>
</html>`;
}
