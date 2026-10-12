import { LINE_TYPE_LABELS } from './cart';
import { BUSINESS, RECEIPT_FOOTER } from './config';
import { formatDateTime } from './dates';
import { PAYMENT_LABELS, type Sale } from './models';
import { formatPeso } from './money';

/** A receipt ready to show or print, with every amount already formatted. */
export interface Receipt {
  businessName: string;
  address: string;
  tin: string;
  receiptNo: string;
  dateTime: string;
  locationName: string;
  cashierName: string;
  lines: { name: string; detail: string; amount: string }[];
  total: string;
  paymentLabel: string;
  tendered: string;
  change: string;
  reference?: string;
  footer: string[];
  voided: boolean;
}

export type PaperWidth = 58 | 80;

export function buildReceipt(sale: Sale, names: { locationName: string; cashierName: string }): Receipt {
  return {
    businessName: BUSINESS.name,
    address: BUSINESS.address,
    tin: BUSINESS.tin,
    receiptNo: sale.receiptNo,
    dateTime: formatDateTime(sale.createdAt),
    locationName: names.locationName,
    cashierName: names.cashierName,
    lines: sale.lines.map((line) => ({
      name: line.name,
      detail:
        `${line.qty} x ${formatPeso(line.unitPrice)}` +
        (line.type === 'item' ? '' : ` (${LINE_TYPE_LABELS[line.type].toLowerCase()})`),
      amount: formatPeso(line.amount),
    })),
    total: formatPeso(sale.total),
    paymentLabel: PAYMENT_LABELS[sale.payment.method],
    tendered: formatPeso(sale.payment.tendered),
    change: formatPeso(sale.payment.change),
    reference: sale.payment.reference,
    footer: RECEIPT_FOOTER,
    voided: sale.status === 'voided',
  };
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
    rule,
  ];
  if (receipt.voided) out.push(center('*** VOIDED ***'), rule);
  for (const line of receipt.lines) {
    out.push(line.name, row(`  ${line.detail}`, line.amount));
  }
  out.push(rule, row('TOTAL', receipt.total), row(receipt.paymentLabel, receipt.tendered));
  if (receipt.reference) out.push(row('Ref no.', receipt.reference));
  out.push(row('Change', receipt.change), rule, ...receipt.footer.map(center));
  return out.join('\n');
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

/** HTML sized for a thermal printer roll; used by both apps' print functions. */
export function receiptHtml(receipt: Receipt, paperWidthMm: PaperWidth = 58): string {
  const e = escapeHtml;
  const lines = receipt.lines
    .map(
      (line) => `
      <div class="item">${e(line.name)}</div>
      <div class="row"><span>${e(line.detail)}</span><span>${e(line.amount)}</span></div>`,
    )
    .join('');
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
  <div class="rule"></div>
  ${receipt.voided ? '<div class="center void">*** VOIDED ***</div><div class="rule"></div>' : ''}
  ${lines}
  <div class="rule"></div>
  <div class="row total"><span>TOTAL</span><span>${e(receipt.total)}</span></div>
  <div class="row"><span>${e(receipt.paymentLabel)}</span><span>${e(receipt.tendered)}</span></div>
  ${receipt.reference ? `<div class="row"><span>Ref no.</span><span>${e(receipt.reference)}</span></div>` : ''}
  <div class="row"><span>Change</span><span>${e(receipt.change)}</span></div>
  <div class="rule"></div>
  ${receipt.footer.map((line) => `<div class="center">${e(line)}</div>`).join('')}
</body>
</html>`;
}
