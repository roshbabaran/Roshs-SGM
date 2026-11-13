/**
 * The receipt reader end to end: photo to text (stages 2–5, engine.ts), then
 * layout (6), clean values (7), products (8) and checks (9), giving a draft the
 * cashier reviews (10). Nothing here saves a sale: the cashier checks the draft
 * in the review window, and only Save there records it through recordSale.
 */
import { cartLineKey, unitPrice as priceAs, type CartLine } from '../cart';
import { formatDay, localDay } from '../dates';
import type { Centavos } from '../money';
import { checkLine, checkListPrice, checkTotal, MIN_CONFIDENCE } from './checks';
import { now, readText, type OcrEngine, type TextResult } from './engine';
import { layoutOf, secondLookOf, type Cell, type LookColumn } from './layout';
import { listPriceOf, matchItem, type Catalogue } from './match';
import { parseAmount, parseQty, parseReceiptDate, parseReceiptTime, parseReceiptNo, type FixedValue } from './normalize';
import { inkOnly } from './preprocess';
import { readBoxes } from './recognize';
import type { DraftField, DraftLine, DraftTarget, OcrLine, PixelImage, Point, Quad, ReceiptDraft } from './types';

export interface ReceiptOptions {
  /** Today as YYYY-MM-DD, for checking the written date. Defaults to the device's date. */
  today?: string;
  /**
   * Read an ink-only copy of the photo (inkOnly in preprocess.ts): pink and
   * magenta print and speckle fade to the paper's white, and black, blue and
   * red ink stay dark. On by default.
   */
  inkOnly?: boolean;
}

/** The photo as the reader should see it: the ink-only copy unless `options.inkOnly` is false. */
export function readingImage(image: PixelImage, options: Pick<ReceiptOptions, 'inkOnly'> = {}): PixelImage {
  return options.inkOnly === false ? image : inkOnly(image);
}

/** How sure a second read has to be to be used: the value after a label, and each kind of cell. */
export const SECOND_LOOK = { value: 0.5, qty: 0.5, price: 0.6, item: 0.6 };

/** Whether what a cell read on its own looks like what the cell holds. A lone stroke isn't a price. */
function fitsCell(column: LookColumn, line: OcrLine): boolean {
  const text = line.text.trim();
  switch (column) {
    case 'qty':
      return line.confidence >= SECOND_LOOK.qty && /^\d{1,3}$/.test(text) && Number(text) > 0;
    case 'unitPrice':
    case 'amount':
      return line.confidence >= SECOND_LOOK.price && parseAmount(text) !== null && (text.match(/\d/g)?.length ?? 0) >= 2;
    case 'item':
      return line.confidence >= SECOND_LOOK.item && /[a-z0-9]{2,}/i.test(text);
  }
}

const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** The first `keep` words of a line, as a line of their own (the printed label, without the handwriting after it). */
function labelPart(line: OcrLine, keep: number, cut?: number): OcrLine {
  const words = line.words.slice(0, keep);
  const [a, b, c, d] = line.quad;
  const last = words[words.length - 1];
  const end = last.rect;
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  // How far along the line the label ends, measured on the line's top edge.
  let t = Math.min(1, Math.max(0, ((end.x + end.width - a.x) * (b.x - a.x) + (end.y - a.y) * (b.y - a.y)) / (length * length)));
  if (cut && cut < last.text.length) {
    // The value was read into the label's last word: keep only the label's characters.
    const at = last.at && last.at.length === last.text.length ? (last.at[cut - 1] + last.at[cut]) / 2 : null;
    t = at ?? t * (cut / last.text.length);
    // The word's box ends where the label ends, so the value read on its own sits to its right.
    const right = Math.max(lerp(a, b, t).x, lerp(d, c, t).x);
    words[words.length - 1] = {
      ...last,
      text: last.text.slice(0, cut),
      rect: { ...last.rect, width: Math.max(1, right - last.rect.x) },
      ...(last.at ? { at: last.at.slice(0, cut) } : {}),
    };
  }
  const quad: Quad = [a, lerp(a, b, t), lerp(d, c, t), d];
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  return {
    text: words.map((w) => w.text).join(' '),
    confidence: words.reduce((sum, w) => sum + w.confidence, 0) / words.length,
    quad,
    rect: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) },
    words,
  };
}

/**
 * Stages 2–5 for a receipt, with a second look: after reading every line, the
 * places the layout says are worth it (secondLookOf in layout.ts) are cut out
 * closer and read on their own. Handwriting that shared a line with its
 * printed label is read again apart from the label, and empty cells of item
 * rows with other writing are read in case the detector missed a short mark
 * such as a "1". A second read is used only when it is sure enough and looks
 * like what belongs there. Pass the ink-only copy of the photo (readingImage).
 */
export async function readReceiptText(image: PixelImage, engine: OcrEngine): Promise<TextResult> {
  const first = await readText(image, engine);
  const start = now();
  const look = secondLookOf(first.lines, image);
  const boxes = [...look.splits, ...look.cells].map(({ quad }) => ({ quad, score: 1 }));
  if (boxes.length === 0) return first;
  const reads = await readBoxes(image, boxes, engine.runtime, engine.rec, engine.options);

  const lines = first.lines.slice();
  const added: OcrLine[] = [];
  look.splits.forEach((split, i) => {
    const read = reads[i];
    const line = first.lines[split.line];
    if (!read || read.confidence < SECOND_LOOK.value || split.keep < 1 || split.keep > line.words.length) return;
    lines[split.line] = labelPart(line, split.keep, split.cut);
    added.push(read);
  });
  look.cells.forEach((cell, i) => {
    const read = reads[look.splits.length + i];
    if (read && fitsCell(cell.column, read)) added.push(read);
  });
  return { lines: [...lines, ...added], timings: { ...first.timings, second: now() - start } };
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

/** Small words that belong in Filipino and Spanish names in lower case ("Juan dela Cruz"); never joined to the word before. */
const NAME_PARTICLES = new Set(['de', 'del', 'dela', 'delos', 'la', 'las', 'los', 'san', 'sta', 'sto', 'y', 'van', 'von', 'da', 'di']);

/**
 * A written name with its words where the writer put them. The reader runs
 * words together ("LizaRamos"): names start each word with a capital, so a
 * capital after a small letter starts a new word. It also splits handwriting
 * apart where letters are spaced widely ("M aria", "Liza Ra m os"): when the
 * name has capitals and shows such a break (a single-letter piece, or a lone
 * capital before a small-letter piece), a lone capital before a small-letter
 * piece, and small-letter pieces of one or two letters, are joined back to the
 * word before. A name without such a break ("Mila ts") is left as read.
 */
export function separateNameWords(text: string): string {
  const words = text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/\s+/)
    .filter(Boolean);
  // Joined back only when the read shows signs of being broken apart: a single-letter piece, or a lone capital before a small-letter piece.
  const broken = words.some((w, i) => /^[a-z]$/.test(w) || (/^[A-Z]$/.test(w) && /^[a-z]/.test(words[i + 1] ?? '')));
  if (!broken || !words.some((w) => /^[A-Z]/.test(w))) return words.join(' ');
  const joined: string[] = [];
  for (const word of words) {
    const previous = joined[joined.length - 1];
    const lower = /^[a-z]/.test(word) && !NAME_PARTICLES.has(word.toLowerCase());
    if (previous !== undefined && lower && (/^[A-Z]$/.test(previous) || word.length <= 2)) {
      joined[joined.length - 1] = previous + word;
    } else {
      joined.push(word);
    }
  }
  return joined.join(' ');
}

/** "Nov 10", with the year when it isn't this year's. */
function dayLabel(day: string, today: string): string {
  return day.slice(0, 4) === today.slice(0, 4) ? formatDay(day) : `${formatDay(day)}, ${day.slice(0, 4)}`;
}

/**
 * A cylinder whose quantity wasn't written: if the amount is a whole number of
 * the other way of selling it (new instead of refill, say) but not of this
 * one, it was sold the other way.
 */
function typeFromAmount(target: DraftTarget | null, amount: Centavos | null, catalogue: Catalogue): DraftTarget | null {
  if (!target || target.kind !== 'product' || target.type === 'item' || amount === null) return null;
  const product = catalogue.products.find((p) => p.id === target.productId);
  if (!product || product.kind !== 'cylinder') return null;
  const other = target.type === 'new' ? 'refill' : 'new';
  const divides = (price: Centavos) => price > 0 && amount % price === 0;
  return !divides(priceAs(product, target.type)) && divides(priceAs(product, other)) ? { ...target, type: other } : null;
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

    // What one of the item cost: the unit price, or the amount over the quantity (one, when no quantity was written).
    const prices: Centavos[] = [];
    if (unitPrice.value !== null) prices.push(unitPrice.value);
    if (amount.value !== null && qty.value && amount.value % qty.value === 0) prices.push(amount.value / qty.value);
    if (amount.value !== null && qty.value === null && unitPrice.value === null) prices.push(amount.value);
    const match = matchItem(cell?.text ?? '', catalogue, { prices, unit: row.cells.unit?.text });
    let { target, status: targetStatus, note: targetNote } = match;
    const writtenDivides = unitPrice.value !== null && unitPrice.value > 0 && amount.value !== null && amount.value % unitPrice.value === 0;
    if (qty.value === null && !writtenDivides) {
      const retyped = typeFromAmount(target, amount.value, catalogue);
      if (retyped) {
        target = retyped;
        targetStatus = 'check';
        targetNote = `Worked out as ${retyped.kind === 'product' && retyped.type === 'new' ? 'a new cylinder' : 'a refill'} from the amount. Check it.`;
      }
    }
    const listPrice = target ? listPriceOf(target, catalogue) : null;
    const fields = { qty, unitPrice, amount };
    checkLine(fields, listPrice);
    checkListPrice(fields, listPrice);
    return {
      item,
      target,
      targetStatus,
      ...(targetNote ? { targetNote } : {}),
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
  else if (layout.receiptNoGuessed && receiptNo.value !== null) {
    receiptNo.status = 'check';
    receiptNo.note = 'Read without its No. label. Check that it is the receipt number.';
  }

  let date: DraftField<string> = { value: null, read: '', status: 'missing', note: 'No date found.' };
  let time: DraftField<string> = { value: null, read: '', status: 'missing' };
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
      date.note = `This receipt is dated ${dayLabel(read.day, today)}. The sale will be saved on that day.`;
    } else if (layout.date.confidence < MIN_CONFIDENCE) {
      date.status = 'check';
      date.note = 'The date was hard to read.';
    }
    const at = parseReceiptTime(layout.date.text);
    if (at) {
      time = { value: at, read: layout.date.text, rect: layout.date.rect, confidence: layout.date.confidence, status: 'ok' };
      if (layout.date.confidence < MIN_CONFIDENCE) {
        time.status = 'check';
        time.note = 'The time was hard to read.';
      }
    }
  }

  const name = layout.registeredName;
  const registeredName: DraftField<string> = name
    ? {
        value: separateNameWords(name.text),
        read: name.text,
        rect: name.rect,
        confidence: name.confidence,
        status: name.confidence < MIN_CONFIDENCE ? 'check' : 'ok',
        ...(name.confidence < MIN_CONFIDENCE ? { note: 'The name was hard to read.' } : {}),
      }
    : { value: null, read: '', status: 'missing' };

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
    time,
    registeredName,
    total,
    lines,
    notes,
    method: layout.method,
    image: { width: image.width, height: image.height },
    ocrLines,
    timings: {},
  };
}

/**
 * Reads a receipt photo into a draft sale for the cashier to review. `image`
 * is the photo as the app shrank it (fitImage, or the app's own resize); the
 * reader works on its ink-only copy unless `options.inkOnly` is false.
 */
export async function readReceipt(image: PixelImage, engine: OcrEngine, catalogue: Catalogue, options: ReceiptOptions = {}): Promise<ReceiptDraft> {
  let start = now();
  const prepared = readingImage(image, options);
  const ink = now() - start;
  const text = await readReceiptText(prepared, engine);
  start = now();
  const draft = draftFromLines(text.lines, image, catalogue, options);
  draft.timings = { ink, ...text.timings, fields: now() - start };
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
