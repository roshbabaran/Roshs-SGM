/**
 * The receipt reader end to end: photo to text (stages 2–5, engine.ts), then
 * layout (6), clean values (7), products (8) and checks (9), giving a draft the
 * cashier reviews (10). Nothing here saves a sale: the review screen turns the
 * confirmed draft into cart lines, and the sale goes through recordSale like
 * any other.
 */
import { cartLineKey, type CartLine } from '../cart';
import { formatDay, localDay } from '../dates';
import type { Centavos } from '../money';
import { checkLine, checkListPrice, checkTotal, MIN_CONFIDENCE } from './checks';
import { now, readText, type OcrEngine } from './engine';
import { layoutOf, type Cell } from './layout';
import { listPriceOf, matchItem, type Catalogue } from './match';
import { parseAmount, parseQty, parseReceiptDate, parseReceiptNo, type FixedValue } from './normalize';
import type { DraftField, DraftLine, OcrLine, PixelImage, ReceiptDraft } from './types';

export interface ReceiptOptions {
  /** Today as YYYY-MM-DD, for checking the written date. Defaults to the device's date. */
  today?: string;
}

/** A field from the text of a cell, marked for checking when it was hard to read. */
function fieldFrom<T>(cell: Cell | null | undefined, parse: (text: string) => FixedValue<T> | null, what: string): DraftField<T> {
  if (!cell) return { value: null, read: '', status: 'missing' };
  const base = { read: cell.text, rect: cell.rect, confidence: cell.confidence };
  const parsed = parse(cell.text);
  if (!parsed) return { ...base, value: null, status: 'missing', note: `Couldn't read the ${what}.` };
  if (parsed.fixed) return { ...base, value: parsed.value, status: 'check', note: `Some of the ${what} was read from letters that look like digits.` };
  if (cell.confidence < MIN_CONFIDENCE) return { ...base, value: parsed.value, status: 'check', note: `The ${what} was hard to read.` };
  return { ...base, value: parsed.value, status: 'ok' };
}

/** Stages 6–9: the lines of text from a receipt photo, made into a draft sale. */
export function draftFromLines(
  ocrLines: OcrLine[],
  image: { width: number; height: number },
  catalogue: Catalogue,
  options: ReceiptOptions = {},
): ReceiptDraft {
  const today = options.today ?? localDay(new Date());
  const layout = layoutOf(ocrLines);

  const lines: DraftLine[] = layout.rows.map((row) => {
    const qty = fieldFrom(row.cells.qty, parseQty, 'quantity');
    const unitPrice = fieldFrom(row.cells.unitPrice, parseAmount, 'unit price');
    const amount = fieldFrom(row.cells.amount, parseAmount, 'amount');
    const cell = row.cells.item;
    const item: DraftField<string> = cell
      ? {
          value: cell.text,
          read: cell.text,
          rect: cell.rect,
          confidence: cell.confidence,
          status: cell.confidence < MIN_CONFIDENCE ? 'check' : 'ok',
        }
      : { value: null, read: '', status: 'missing', note: 'No item written on this line.' };

    const prices: Centavos[] = [];
    if (unitPrice.value !== null) prices.push(unitPrice.value);
    if (amount.value !== null && qty.value && amount.value % qty.value === 0) prices.push(amount.value / qty.value);
    const match = matchItem(cell?.text ?? '', catalogue, { prices, unit: row.cells.unit?.text });
    const listPrice = match.target ? listPriceOf(match.target, catalogue) : null;
    const fields = { qty, unitPrice, amount };
    checkLine(fields, listPrice);
    checkListPrice(fields, listPrice);
    return {
      item,
      target: match.target,
      targetStatus: match.status,
      targetNote: match.note,
      candidates: match.candidates,
      qty,
      unitPrice,
      amount,
      listPrice,
      rect: row.rect,
    };
  });

  const receiptNo = fieldFrom(layout.receiptNo, parseReceiptNo, 'receipt number');
  if (!layout.receiptNo) receiptNo.note = 'No receipt number found.';

  let date: DraftField<string> = { value: null, read: '', status: 'missing', note: 'No date found.' };
  if (layout.date) {
    const read = parseReceiptDate(layout.date.text, today);
    date = { read: layout.date.text, rect: layout.date.rect, confidence: layout.date.confidence, value: read?.day ?? null, status: 'ok' };
    if (!read) {
      date.status = 'missing';
      date.note = "Couldn't read the date.";
    } else if (read.note) {
      date.status = 'check';
      date.note = read.note;
    } else if (read.day !== today) {
      date.status = 'check';
      date.note = `This receipt is dated ${formatDay(read.day)}. The sale will be recorded today.`;
    } else if (layout.date.confidence < MIN_CONFIDENCE) {
      date.status = 'check';
      date.note = 'The date was hard to read.';
    }
  }

  const total = fieldFrom(layout.total, parseAmount, 'total');
  const matched = lines.every((line) => line.listPrice !== null && line.qty.value !== null);
  const cartTotal = matched && lines.length > 0 ? lines.reduce((sum, line) => sum + (line.listPrice ?? 0) * (line.qty.value ?? 0), 0) : null;
  const notes = checkTotal(
    total,
    lines.map((line) => line.amount.value),
    cartTotal,
  );
  if (lines.length === 0) notes.unshift('No item lines were found. Retake the photo with the whole receipt in view, or add the items by hand.');

  return {
    receiptNo,
    date,
    total,
    lines,
    notes,
    method: layout.method,
    image: { width: image.width, height: image.height },
    ocrLines,
    timings: {},
  };
}

/** Reads a receipt photo into a draft sale for the cashier to review. */
export async function readReceipt(image: PixelImage, engine: OcrEngine, catalogue: Catalogue, options: ReceiptOptions = {}): Promise<ReceiptDraft> {
  const text = await readText(image, engine);
  const start = now();
  const draft = draftFromLines(text.lines, image, catalogue, options);
  draft.timings = { ...text.timings, fields: now() - start };
  return draft;
}

/** The reviewed lines as cart lines, the same item twice becoming one line. Lines without a product are left out. */
export function draftToCart(lines: Pick<DraftLine, 'target' | 'qty'>[]): CartLine[] {
  const cart: CartLine[] = [];
  for (const line of lines) {
    const qty = line.qty.value;
    if (!line.target || !qty || qty < 1) continue;
    const next: CartLine =
      line.target.kind === 'set'
        ? { type: 'set', setId: line.target.setId, qty }
        : { type: line.target.type, productId: line.target.productId, qty };
    const same = cart.find((l) => cartLineKey(l) === cartLineKey(next));
    if (same) same.qty += qty;
    else cart.push(next);
  }
  return cart;
}

/** What still stops the reviewed lines from going into the sale, in words for the cashier; null when nothing does. */
export function draftProblem(lines: Pick<DraftLine, 'target' | 'qty'>[]): string | null {
  if (lines.length === 0) return 'There are no items to add.';
  const unpicked = lines.filter((line) => !line.target).length;
  if (unpicked > 0) return unpicked === 1 ? 'Pick the product for the line marked in red, or remove it.' : `Pick the products for the ${unpicked} lines marked in red, or remove them.`;
  if (lines.some((line) => !line.qty.value || line.qty.value < 1)) return 'Every line needs a quantity of at least 1.';
  return null;
}
