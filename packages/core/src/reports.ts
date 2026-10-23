import { accountOf, LOAN_LABELS, type BorrowingTotals } from './borrowing';
import { lineDiscountAmount } from './cart';
import { CLAIM_LABELS, defectiveItemText, saleProgress } from './claims';
import { BUSINESS } from './config';
import { dayRange, formatDateTime, formatDay, localDay, parseDay } from './dates';
import { PAYMENT_LABELS, type Claim, type Customer, type ISODate, type LoanEntry, type PaymentMethod, type Sale } from './models';
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

/** What discounts took off these sales, in all. */
export function discountTotal(sales: Sale[]): Centavos {
  return sales.reduce((sum, sale) => sum + sale.lines.reduce((s, line) => s + lineDiscountAmount(line), 0), 0);
}

export interface ReturnTotals {
  /** Completed returns, and what was refunded for them. */
  returns: number;
  refunded: Centavos;
  /** How many of those returns took back a whole sale, which voids it (it is then left out of the sales totals). */
  wholeSales: number;
  /** Completed defective exchanges, and what customers paid for them (gas lost, or an accessory's charge). */
  defectives: number;
  charged: Centavos;
}

/** Returns and defective exchanges count on the day they were completed. */
function completedClaims(claims: Claim[], from: string, to: string, locationId?: string): Claim[] {
  return claims.filter((c) => {
    if (c.status !== 'completed' || c.kind === 'pickup' || (locationId && c.locationId !== locationId)) return false;
    const day = localDay(c.decidedAt ?? c.createdAt);
    return day >= from && day <= to;
  });
}

/** Returns and defective exchanges completed on days from `from` to `to`, at one branch or all. */
export function returnTotals(claims: Claim[], from: string, to: string, locationId?: string): ReturnTotals {
  const totals: ReturnTotals = { returns: 0, refunded: 0, wholeSales: 0, defectives: 0, charged: 0 };
  for (const c of completedClaims(claims, from, to, locationId)) {
    if (c.kind === 'return') {
      totals.returns += 1;
      totals.refunded += c.refund ?? 0;
      if (c.voidsSale) totals.wholeSales += 1;
    } else {
      totals.defectives += 1;
      totals.charged += c.charge ?? 0;
    }
  }
  return totals;
}

/** One item in the returns or defective exchanges breakdown. */
export interface ClaimItemTotal {
  key: string;
  name: string;
  /** How many came back, or were exchanged. */
  qty: number;
  /** Refunded for returns; paid by the customer for defective exchanges. */
  amount: Centavos;
  /** Defective cylinders: the gas they lost, in all. */
  lostKg?: number;
}

/**
 * What came back, item by item: returned items with what was refunded for them,
 * and defective exchanges with what customers paid. A refund is shared among
 * the items of its return by what each cost on the sale.
 */
export function claimBreakdown(claims: Claim[], sales: Sale[], from: string, to: string, locationId?: string): { returned: ClaimItemTotal[]; defective: ClaimItemTotal[] } {
  const salesById = new Map(sales.map((s) => [s.id, s]));
  const returned = new Map<string, ClaimItemTotal>();
  const defective = new Map<string, ClaimItemTotal>();
  for (const c of completedClaims(claims, from, to, locationId)) {
    if (c.kind === 'defective') {
      const key = c.productId ?? c.productName ?? c.id;
      const row = defective.get(key) ?? { key, name: c.productName ?? 'Item', qty: 0, amount: 0 };
      row.qty += 1;
      row.amount += c.charge ?? 0;
      if (c.lostKg !== undefined) row.lostKg = Math.round(((row.lostKg ?? 0) + c.lostKg) * 100) / 100;
      defective.set(key, row);
      continue;
    }
    const sale = c.saleId ? salesById.get(c.saleId) : undefined;
    const items = c.items.map((item) => {
      const line = sale?.lines[item.line];
      return {
        key: !line ? `name:${item.name}` : line.type === 'set' ? `set:${line.setId}` : line.productId,
        name: line?.type === 'set' ? `${line.name} (set)` : (line?.name ?? item.name),
        qty: item.qty,
        worth: line && line.qty > 0 ? (line.amount * item.qty) / line.qty : 0,
      };
    });
    const worth = items.reduce((sum, i) => sum + i.worth, 0);
    let left = c.refund ?? 0;
    items.forEach((item, i) => {
      const share = i === items.length - 1 ? left : worth > 0 ? Math.round(((c.refund ?? 0) * item.worth) / worth) : 0;
      left -= share;
      const row = returned.get(item.key) ?? { key: item.key, name: item.name, qty: 0, amount: 0 };
      row.qty += item.qty;
      row.amount += share;
      returned.set(item.key, row);
    });
  }
  const byQty = (a: ClaimItemTotal, b: ClaimItemTotal) => b.qty - a.qty || b.amount - a.amount || a.name.localeCompare(b.name);
  return { returned: [...returned.values()].sort(byQty), defective: [...defective.values()].sort(byQty) };
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
  returns?: ReturnTotals;
  /** Item by item, from claimBreakdown(). */
  claimItems?: ReturnType<typeof claimBreakdown>;
  printedBy: string;
  printedAt: Date;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const longDay = (day: string) => `${formatDay(day)}, ${parseDay(day).getFullYear()}`;

const rangeText = (from: string, to: string) => (from === to ? longDay(from) : `${longDay(from)} to ${longDay(to)}`);

/** A table for a printed report; columns after the first are right-aligned unless `left` says otherwise. */
function htmlTable(headers: string[], rows: string[][], options: { foot?: string[]; empty?: string; left?: number[] } = {}): string {
  const e = escapeHtml;
  const cls = (i: number) => (i > 0 && !options.left?.includes(i) ? ' class="num"' : '');
  return `
    <table>
      <thead><tr>${headers.map((h, i) => `<th${cls(i)}>${e(h)}</th>`).join('')}</tr></thead>
      <tbody>${
        rows.length > 0
          ? rows.map((r) => `<tr>${r.map((c, i) => `<td${cls(i)}>${e(c)}</td>`).join('')}</tr>`).join('')
          : `<tr><td colspan="${headers.length}" class="none">${e(options.empty ?? 'No sales in this period.')}</td></tr>`
      }</tbody>
      ${options.foot ? `<tfoot><tr>${options.foot.map((c, i) => `<td${cls(i)}>${e(c)}</td>`).join('')}</tr></tfoot>` : ''}
    </table>`;
}

/** The page frame shared by the printed reports: the business, the report's name, dates and branch. */
function reportPage(title: string, range: string, branchName: string, body: string, foot: string): string {
  const e = escapeHtml;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${e(title)} ${e(range)}</title>
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
      <b>${e(title)}</b><br>
      ${e(range)}<br>
      ${e(branchName)}
    </div>
  </div>
${body}
  <div class="foot">${e(foot)}</div>
</body>
</html>`;
}

/** The sales report as an A4 page, for the system print dialog (or "Save as PDF"). */
export function salesReportHtml(report: SalesReportInput): string {
  const e = escapeHtml;
  const total = report.sales.reduce((sum, s) => sum + s.total, 0);
  const count = report.sales.length;
  const discounts = discountTotal(report.sales);
  const days = dailyTotals(report.sales, dayRange(report.from, report.to));
  const table = (headers: string[], rows: string[][], foot?: string[]) => htmlTable(headers, rows, { foot });
  const range = rangeText(report.from, report.to);
  const borrowing = report.borrowing;
  const returns = report.returns;

  const body = `
  <div class="summary">
    <div class="tile">Total sales<b>${e(formatPeso(total))}</b></div>
    <div class="tile">Transactions<b>${count}</b></div>
    <div class="tile">Average sale<b>${e(formatPeso(count ? Math.round(total / count) : 0))}</b></div>
    ${discounts > 0 ? `<div class="tile">Discounts given<b>${e(formatPeso(discounts))}</b></div>` : ''}
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
      ['Sales on credit', formatPeso(borrowing.credit)],
      ['Collections', formatPeso(borrowing.collected)],
      ...(borrowing.byCheque > 0 ? [['Collections by post-dated cheque', formatPeso(borrowing.byCheque)]] : []),
      ...(borrowing.bounced > 0 ? [['Bounced cheques', formatPeso(borrowing.bounced)]] : []),
      ['Borrowed cylinders', String(borrowing.lent)],
      ['Returned cylinders', String(borrowing.returned)],
    ],
  )}`
      : ''
  }
  ${
    returns && (returns.returns > 0 || returns.defectives > 0)
      ? `<h2>Returns and defectives</h2>
  ${table(
    ['', 'Count', 'Amount'],
    [
      ['Refunded for returns', String(returns.returns), formatPeso(returns.refunded)],
      ...(returns.wholeSales > 0 ? [['Returns of whole sales (voided, so left out of the sales above)', String(returns.wholeSales), '']] : []),
      ['Paid for defective exchanges', String(returns.defectives), formatPeso(returns.charged)],
    ],
  )}`
      : ''
  }
  ${
    report.claimItems && (report.claimItems.returned.length > 0 || report.claimItems.defective.length > 0)
      ? `<div class="columns">
    <div>
      <h2>Items returned</h2>
      ${htmlTable(
        ['Item', 'Qty', 'Refunded'],
        report.claimItems.returned.map((r) => [r.name, String(r.qty), formatPeso(r.amount)]),
        { empty: 'No returns in this period.' },
      )}
    </div>
    <div>
      <h2>Defective exchanges</h2>
      ${htmlTable(
        ['Item', 'Exchanged', 'Gas lost', 'Paid'],
        report.claimItems.defective.map((r) => [r.name, String(r.qty), r.lostKg !== undefined ? `${r.lostKg} kg` : '', formatPeso(r.amount)]),
        { empty: 'No defective exchanges in this period.' },
      )}
    </div>
  </div>`
      : ''
  }
`;
  return reportPage(
    'Sales report',
    range,
    report.branchName,
    body,
    `Completed sales only; voided sales are left out. Sales put on account and prepaid orders are counted when made; returns when approved. Printed ${formatDateTime(report.printedAt.toISOString())} by ${report.printedBy}.`,
  );
}

/** One customer's totals for the customer report. Balances (owed, cylinders out, to pick up) are as of now. */
export interface CustomerReportRow {
  customer: Customer;
  sales: number;
  spent: Centavos;
  discounts: Centavos;
  payments: Centavos;
  owed: Centavos;
  cylindersOut: number;
  /** Prepaid items still waiting to be picked up. */
  toPickUp: number;
  returns: number;
  refunded: Centavos;
  defectives: number;
  lastActivity: ISODate | null;
}

/** One thing a customer did: a sale, a payment, a cylinder brought back, a pick up, a return or an exchange. */
export interface CustomerActivity {
  id: string;
  at: ISODate;
  customerId: string;
  customerName: string;
  what: string;
  details: string;
  /** Money, when there was any: what the sale came to, what they paid, or (negative) what they got back. */
  amount: Centavos | null;
  receiptNo?: string;
}

export interface CustomerReportInput {
  customers: Customer[];
  sales: Sale[];
  loans: LoanEntry[];
  claims: Claim[];
  from: string;
  to: string;
  locationId?: string;
  /** The customers to report on; undefined for all of them. */
  customerIds?: string[];
  productName: (id: string | undefined) => string;
}

const itemsText = (sale: Sale) => sale.lines.map((l) => `${l.qty} × ${l.name}`).join(', ');

/**
 * Everything named customers did in a period: their sales, borrowing,
 * payments, pick ups, returns and defective exchanges, with a row of totals
 * each. Customers with nothing in the period and nothing still open are left out.
 */
export function customerReport(input: CustomerReportInput): { rows: CustomerReportRow[]; activity: CustomerActivity[] } {
  const wanted = input.customerIds ? new Set(input.customerIds) : null;
  const customers = input.customers.filter((c) => !wanted || wanted.has(c.id));
  const inRange = (iso: string, locationId: string) =>
    (!input.locationId || locationId === input.locationId) && localDay(iso) >= input.from && localDay(iso) <= input.to;

  const activity: CustomerActivity[] = [];
  const rows: CustomerReportRow[] = [];
  for (const customer of customers) {
    const sales = input.sales.filter((s) => s.borrowerId === customer.id);
    const loans = input.loans.filter((e) => e.borrowerId === customer.id);
    const claims = input.claims.filter((c) => c.customerId === customer.id && c.status === 'completed');
    const mine: CustomerActivity[] = [];
    const add = (entry: Omit<CustomerActivity, 'customerId' | 'customerName'>) =>
      mine.push({ ...entry, customerId: customer.id, customerName: customer.name });

    for (const sale of sales) {
      if (!inRange(sale.createdAt, sale.locationId)) continue;
      const what =
        sale.status === 'voided'
          ? 'Sale (voided)'
          : sale.prepaid
            ? 'Prepaid order'
            : sale.payment.method === 'credit'
              ? 'Sale on credit'
              : 'Sale';
      const discount = sale.lines.reduce((sum, line) => sum + lineDiscountAmount(line), 0);
      const details = [itemsText(sale), discount > 0 ? `discount ${formatPeso(discount)}` : '', sale.payment.method === 'credit' ? '' : PAYMENT_LABELS[sale.payment.method]]
        .filter(Boolean)
        .join(' · ');
      add({ id: sale.id, at: sale.createdAt, what, details, amount: sale.total, receiptNo: sale.receiptNo });
    }
    for (const entry of loans) {
      // Credit, lending and voids are shown by their sale above.
      if (entry.kind === 'credit' || entry.kind === 'cylinder_out' || entry.kind === 'void' || !inRange(entry.occurredAt, entry.locationId)) continue;
      const cheque = entry.payment?.cheque;
      const details =
        entry.kind === 'payment'
          ? [entry.payment ? PAYMENT_LABELS[entry.payment.method] : '', cheque ? `no. ${cheque.number}, ${cheque.bank}, cash on ${formatDay(cheque.cashOn)}` : '']
              .filter(Boolean)
              .join(' · ')
          : entry.kind === 'cylinder_return'
            ? `${Math.abs(entry.qty ?? 0)} × ${input.productName(entry.productId)}`
            : (entry.note ?? '');
      add({
        id: entry.id,
        at: entry.occurredAt,
        what: LOAN_LABELS[entry.kind],
        details,
        amount: entry.kind === 'payment' ? -entry.amount : entry.kind === 'cheque_bounced' ? -entry.amount : null,
      });
    }
    for (const claim of claims) {
      const at = claim.decidedAt ?? claim.createdAt;
      if (!inRange(at, claim.locationId)) continue;
      const items = claim.items.map((i) => `${i.qty} × ${i.name}`).join(', ');
      const details =
        claim.kind === 'pickup'
          ? items
          : claim.kind === 'return'
            ? [items, claim.voidsSale ? 'whole sale' : '', claim.reason ?? ''].filter(Boolean).join(' · ')
            : [defectiveItemText(claim), claim.reason ?? ''].filter(Boolean).join(' · ');
      const amount = claim.kind === 'return' ? -(claim.refund ?? 0) : claim.kind === 'defective' ? (claim.charge ?? 0) : null;
      add({ id: claim.id, at, what: CLAIM_LABELS[claim.kind], details, amount, receiptNo: claim.receiptNo });
    }

    const account = accountOf(customer, loans);
    const toPickUp = sales.reduce((sum, s) => sum + saleProgress(s, input.claims).reduce((n, p) => n + p.toPickUp, 0), 0);
    const counted = sales.filter((s) => s.status === 'completed' && inRange(s.createdAt, s.locationId));
    // Like the sales report, a return of a whole sale counts as a return too.
    const returns = claims.filter((c) => c.kind === 'return' && inRange(c.decidedAt ?? c.createdAt, c.locationId));
    const open = account.owed !== 0 || account.cylindersOut > 0 || toPickUp > 0;
    if (mine.length === 0 && !open) continue;
    rows.push({
      customer,
      sales: counted.length,
      spent: counted.reduce((sum, s) => sum + s.total, 0),
      discounts: discountTotal(counted),
      payments: mine.filter((a) => a.what === LOAN_LABELS.payment).reduce((sum, a) => sum + (a.amount ?? 0), 0),
      owed: account.owed,
      cylindersOut: account.cylindersOut,
      toPickUp,
      returns: returns.length,
      refunded: returns.reduce((sum, c) => sum + (c.refund ?? 0), 0),
      defectives: claims.filter((c) => c.kind === 'defective' && inRange(c.decidedAt ?? c.createdAt, c.locationId)).length,
      lastActivity: [...sales.map((s) => s.createdAt), ...loans.map((e) => e.occurredAt), ...claims.map((c) => c.decidedAt ?? c.createdAt)].sort().at(-1) ?? null,
    });
    activity.push(...mine);
  }
  rows.sort((a, b) => b.spent - a.spent || a.customer.name.localeCompare(b.customer.name));
  activity.sort((a, b) => b.at.localeCompare(a.at));
  return { rows, activity };
}

/** The customer report as an A4 page. */
export function customerReportHtml(report: {
  from: string;
  to: string;
  branchName: string;
  /** "All customers" or their names. */
  customersLabel: string;
  rows: CustomerReportRow[];
  activity: CustomerActivity[];
  printedBy: string;
  printedAt: Date;
}): string {
  const e = escapeHtml;
  const spent = report.rows.reduce((sum, r) => sum + r.spent, 0);
  const owed = report.rows.reduce((sum, r) => sum + Math.max(0, r.owed), 0);
  const body = `
  <div class="summary">
    <div class="tile">Customers<b>${report.rows.length}</b></div>
    <div class="tile">Bought in the period<b>${e(formatPeso(spent))}</b></div>
    <div class="tile">Owed now<b>${e(formatPeso(owed))}</b></div>
  </div>
  <p class="muted">${e(report.customersLabel)}</p>

  <h2>Customers</h2>
  ${htmlTable(
    ['Customer', 'Sales', 'Bought', 'Discounts', 'Paid back', 'Owes now', 'Cylinders out', 'To pick up', 'Returns'],
    report.rows.map((r) => [
      r.customer.name,
      String(r.sales),
      formatPeso(r.spent),
      formatPeso(r.discounts),
      formatPeso(r.payments),
      formatPeso(r.owed),
      String(r.cylindersOut),
      String(r.toPickUp),
      r.returns > 0 ? `${r.returns} (${formatPeso(r.refunded)})` : '0',
    ]),
    { empty: 'No activity for these customers in this period.' },
  )}

  <h2>Activity</h2>
  ${htmlTable(
    ['When', 'Customer', 'What', 'Details', 'Amount'],
    report.activity.map((a) => [formatDateTime(a.at), a.customerName, a.what, [a.receiptNo, a.details].filter(Boolean).join(' · '), a.amount === null ? '' : formatPeso(a.amount)]),
    { empty: 'No activity for these customers in this period.', left: [1, 2, 3] },
  )}
`;
  return reportPage(
    'Customer report',
    rangeText(report.from, report.to),
    report.branchName,
    body,
    `What named customers bought, borrowed, paid, picked up and returned in the period. Owes now, cylinders out and to pick up are as of printing. Printed ${formatDateTime(report.printedAt.toISOString())} by ${report.printedBy}.`,
  );
}
