import { LINE_TYPE_LABELS } from './cart';
import { BUSINESS, RECEIPT_FOOTER } from './config';
import { formatDateTime } from './dates';
import { PAYMENT_LABELS, type Sale, type SaleLine, type SaleLineType } from './models';
import { formatPeso } from './money';

/** One printed row under an item: "2 x ₱950.00 (refill)" and its amount (blank for a set's contents). */
export interface ReceiptRow {
  detail: string;
  amount: string;
}

export interface ReceiptLine {
  name: string;
  rows: ReceiptRow[];
}

/** A receipt ready to show or print, with every amount already formatted. */
export interface Receipt {
  businessName: string;
  address: string;
  tin: string;
  receiptNo: string;
  dateTime: string;
  locationName: string;
  cashierName: string;
  /** The borrower, for sales made in the Borrowing window. */
  customer?: string;
  lines: ReceiptLine[];
  total: string;
  /** Put on the customer's account: nothing was paid now, so there is no change. */
  onAccount: boolean;
  paymentLabel: string;
  tendered: string;
  change: string;
  reference?: string;
  /** Reminders printed above the footer, e.g. a borrowed cylinder to bring back. */
  notes: string[];
  footer: string[];
  voided: boolean;
}

export type PaperWidth = 58 | 80;

const typeNote = (type: SaleLineType) => (type === 'item' ? '' : ` (${LINE_TYPE_LABELS[type].toLowerCase()})`);

/** A sale line as printed. A new cylinder shows the cylinder and its content separately; a set lists what it contains. */
export function receiptLine(line: SaleLine): ReceiptLine {
  if (line.type === 'set') {
    return {
      name: `${line.name} (set)`,
      rows: [
        { detail: `${line.qty} x ${formatPeso(line.unitPrice)}`, amount: formatPeso(line.amount) },
        ...line.items.map((item) => ({ detail: `- ${item.qty * line.qty} x ${item.name}${typeNote(item.type)}`, amount: '' })),
      ],
    };
  }
  if (line.type === 'new' && line.contentPrice !== undefined) {
    const cylinder = line.unitPrice - line.contentPrice;
    return {
      name: `${line.name} (new cylinder)`,
      rows: [
        { detail: `Cylinder ${line.qty} x ${formatPeso(cylinder)}`, amount: formatPeso(cylinder * line.qty) },
        { detail: `Content ${line.qty} x ${formatPeso(line.contentPrice)}`, amount: formatPeso(line.contentPrice * line.qty) },
      ],
    };
  }
  return {
    name: line.name,
    rows: [{ detail: `${line.qty} x ${formatPeso(line.unitPrice)}${typeNote(line.type)}`, amount: formatPeso(line.amount) }],
  };
}

export function buildReceipt(sale: Sale, names: { locationName: string; cashierName: string }): Receipt {
  const borrowed = sale.lines.filter((line) => line.type === 'borrow');
  return {
    businessName: BUSINESS.name,
    address: BUSINESS.address,
    tin: BUSINESS.tin,
    receiptNo: sale.receiptNo,
    dateTime: formatDateTime(sale.createdAt),
    locationName: names.locationName,
    cashierName: names.cashierName,
    customer: sale.borrowerName,
    lines: sale.lines.map(receiptLine),
    total: formatPeso(sale.total),
    onAccount: sale.payment.method === 'credit',
    paymentLabel: PAYMENT_LABELS[sale.payment.method],
    tendered: formatPeso(sale.payment.tendered),
    change: formatPeso(sale.payment.change),
    reference: sale.payment.reference,
    notes: borrowed.map((line) => `Borrowed cylinder: ${line.qty} x ${line.name}. Please return it.`),
    footer: RECEIPT_FOOTER,
    voided: sale.status === 'voided',
  };
}

/** The payment rows under TOTAL: what was paid and the change, or the amount put on account. */
export function paymentRows(receipt: Receipt): ReceiptRow[] {
  if (receipt.onAccount) return [{ detail: receipt.paymentLabel, amount: receipt.total }];
  return [
    { detail: receipt.paymentLabel, amount: receipt.tendered },
    ...(receipt.reference ? [{ detail: 'Ref no.', amount: receipt.reference }] : []),
    { detail: 'Change', amount: receipt.change },
  ];
}

/** Characters per line on common thermal printers (Font A). */
export function charsPerLine(paperWidthMm: PaperWidth): number {
  return paperWidthMm === 80 ? 48 : 32;
}

/** Plain text version, the starting point for ESC/POS printers that take raw text. */
export function receiptText(receipt: Receipt, width = 32): string {
  const center = (text: string) => ' '.repeat(Math.max(0, Math.floor((width - text.length) / 2))) + text;
  const row = (left: string, right: string) =>
    left.length + right.length + 1 > width
      ? `${left}\n${' '.repeat(Math.max(0, width - right.length))}${right}`
      : left + ' '.repeat(width - left.length - right.length) + right;
  const rule = '-'.repeat(width);

  const out = [
    center(receipt.businessName),
    center(receipt.address),
    center(receipt.tin),
    rule,
    `Receipt: ${receipt.receiptNo}`,
    receipt.dateTime,
    `${receipt.locationName} / ${receipt.cashierName}`,
    ...(receipt.customer ? [`Customer: ${receipt.customer}`] : []),
    rule,
  ];
  if (receipt.voided) out.push(center('*** VOIDED ***'), rule);
  for (const line of receipt.lines) {
    out.push(line.name, ...line.rows.map((r) => (r.amount ? row(`  ${r.detail}`, r.amount) : `  ${r.detail}`)));
  }
  out.push(rule, row('TOTAL', receipt.total), ...paymentRows(receipt).map((r) => row(r.detail, r.amount)), rule);
  if (receipt.notes.length > 0) out.push(...receipt.notes, rule);
  out.push(...receipt.footer.map(center));
  return out.join('\n');
}

export const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

/** HTML sized for a thermal printer roll; used by both apps' print functions. */
export function receiptHtml(receipt: Receipt, paperWidthMm: PaperWidth = 58): string {
  const e = escapeHtml;
  const row = (r: ReceiptRow) => `<div class="row"><span>${e(r.detail)}</span><span>${e(r.amount)}</span></div>`;
  const lines = receipt.lines.map((line) => `<div class="item">${e(line.name)}</div>${line.rows.map(row).join('')}`).join('');
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Receipt ${e(receipt.receiptNo)}</title>
<style>
  @page { size: ${paperWidthMm}mm auto; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 3mm; width: ${paperWidthMm}mm; font: 11px/1.35 "Consolas", "Courier New", monospace; color: #000; }
  .center { text-align: center; }
  .title { font-size: 13px; font-weight: bold; }
  .rule { border-top: 1px dashed #000; margin: 4px 0; }
  .row { display: flex; justify-content: space-between; gap: 6px; }
  .item { margin-top: 2px; }
  .total { font-weight: bold; font-size: 13px; }
  .void { font-weight: bold; font-size: 14px; }
</style>
</head>
<body>
  <div class="center title">${e(receipt.businessName)}</div>
  <div class="center">${e(receipt.address)}</div>
  <div class="center">${e(receipt.tin)}</div>
  <div class="rule"></div>
  <div>Receipt: ${e(receipt.receiptNo)}</div>
  <div>${e(receipt.dateTime)}</div>
  <div>${e(receipt.locationName)} / ${e(receipt.cashierName)}</div>
  ${receipt.customer ? `<div>Customer: ${e(receipt.customer)}</div>` : ''}
  <div class="rule"></div>
  ${receipt.voided ? '<div class="center void">*** VOIDED ***</div><div class="rule"></div>' : ''}
  ${lines}
  <div class="rule"></div>
  <div class="row total"><span>TOTAL</span><span>${e(receipt.total)}</span></div>
  ${paymentRows(receipt).map(row).join('')}
  <div class="rule"></div>
  ${receipt.notes.length > 0 ? `${receipt.notes.map((note) => `<div>${e(note)}</div>`).join('')}<div class="rule"></div>` : ''}
  ${receipt.footer.map((line) => `<div class="center">${e(line)}</div>`).join('')}
</body>
</html>`;
}
