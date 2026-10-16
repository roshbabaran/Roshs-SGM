/**
 * Stage 6: from lines of text to receipt fields. The printed parts of the
 * receipt (the column headings QTY, UNIT, ARTICLES, UNIT PRICE and AMOUNT, and
 * the TOTAL, Date and No. labels) read far more reliably than handwriting, so
 * they become the map: the headings give the columns, and the rows under them,
 * down to TOTAL, are the items. A receipt without printed headings is read row
 * by row instead: a number first is the quantity, the last number the amount.
 *
 * Photos are rarely straight, so everything is placed in "level" coordinates
 * first: the photo turned by the median slant of its longer lines.
 */
import { isUnitWord, looksNumeric, parseQty } from './normalize';
import type { OcrLine, Rect } from './types';

export type Column = 'qty' | 'unit' | 'item' | 'unitPrice' | 'amount';

/** A word from the photo, also placed in level coordinates. */
export interface Token {
  text: string;
  confidence: number;
  /** Photo pixels, for the review screen. */
  rect: Rect;
  /** Level coordinates: centre, edges and height. */
  u: number;
  v: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** Index of the OcrLine it came from. */
  line: number;
}

/** The words that make up one field, joined in reading order. */
export interface Cell {
  text: string;
  /** The least confident word's confidence. */
  confidence: number;
  rect: Rect;
  tokens: Token[];
}

export interface LayoutRow {
  cells: Partial<Record<Column, Cell>>;
  rect: Rect;
}

export interface ReceiptLayout {
  method: 'headers' | 'lines';
  /** How far the receipt is turned in the photo, in degrees (positive: clockwise). */
  skew: number;
  rows: LayoutRow[];
  receiptNo: Cell | null;
  date: Cell | null;
  total: Cell | null;
}

// --- Words people print on receipts ----------------------------------------

const HEADINGS: Record<Column, string[][]> = {
  qty: [['QTY'], ['QUANTITY'], ['QTTY'], ['QNTY'], ['QUAN']],
  unit: [['UNIT'], ['UNITS'], ['UOM'], ['U/M']],
  item: [['ARTICLES'], ['ARTICLE'], ['DESCRIPTION'], ['PARTICULARS'], ['ITEMS'], ['ITEM'], ['PRODUCT']],
  unitPrice: [['UNIT', 'PRICE'], ['U/PRICE'], ['U', 'PRICE'], ['UNIT', 'COST'], ['PRICE'], ['U/P'], ['RATE']],
  amount: [['AMOUNT'], ['AMT'], ['TOTAL', 'PRICE']],
};
const TOTAL_LABELS = [['TOTAL', 'AMOUNT', 'DUE'], ['TOTAL', 'AMOUNT'], ['TOTAL', 'SALES'], ['TOTAL', 'DUE'], ['GRAND', 'TOTAL'], ['AMOUNT', 'DUE'], ['TOTAL']];
/** Printed lines under the table; item rows stop at the first of these. */
const FOOTER_WORDS = new Set(['RECEIVED', 'GOODS', 'CONDITION', 'SIGNATURE', 'CASHIER', 'AUTHORIZED', 'REPRESENTATIVE', 'THANK', 'OFFICIAL']);
/** Printed words above the table; rows holding them aren't items when there are no headings. */
const PRINTED_WORDS = new Set([
  ...FOOTER_WORDS,
  'TIN',
  'VAT',
  'NONVAT',
  'ADDRESS',
  'SOLD',
  'INVOICE',
  'RECEIPT',
  'DEALER',
  'MARKETING',
  'TERMS',
  'BUSINESS',
  'STYLE',
  'DATE',
  'NO',
  'BY',
]);
/** Lines with these hold a "No." that isn't the receipt number. */
const OTHER_NUMBERS = /\b(?:tin|tel|telephone|contact|cel|cell|phone|mobile|vat|permit|acc|account)\b/i;

/** A word as printed headings are compared: capitals, no punctuation, digits read as the letters they resemble. */
function headingForm(text: string): string {
  return text
    .toUpperCase()
    .replace(/[^A-Z0-9/]/g, '')
    .replace(/0/g, 'O')
    .replace(/[1|]/g, 'I')
    .replace(/5/g, 'S');
}

/** Edit distance, for printed words the reader got slightly wrong. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return prev[b.length];
}

function sameWord(read: string, word: string): boolean {
  const form = headingForm(read);
  if (form === word.replace(/[^A-Z0-9/]/g, '')) return true;
  // One wrong letter is fine in longer words ("ARTICLFS", "AMOUNI").
  return word.length >= 5 && Math.abs(form.length - word.length) <= 1 && editDistance(form, word) <= 1;
}

// --- Level coordinates -------------------------------------------------------

/** The receipt's slant: the median angle of the longer lines, whose boxes give a reliable direction. */
export function skewOf(lines: OcrLine[]): number {
  const angles: number[] = [];
  for (const line of lines) {
    const [a, b, , d] = line.quad;
    const width = Math.hypot(b.x - a.x, b.y - a.y);
    const height = Math.hypot(d.x - a.x, d.y - a.y);
    if (width >= 3 * height && line.text.length >= 4) angles.push(Math.atan2(b.y - a.y, b.x - a.x));
  }
  if (angles.length === 0) return 0;
  angles.sort((x, y) => x - y);
  return angles[Math.floor(angles.length / 2)];
}

function tokensOf(lines: OcrLine[], angle: number): Token[] {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const tokens: Token[] = [];
  lines.forEach((line, index) => {
    const words = line.words.length > 0 ? line.words : [line];
    for (const word of words) {
      const { x, y, width, height } = word.rect;
      const us: number[] = [];
      const vs: number[] = [];
      for (const [px, py] of [
        [x, y],
        [x + width, y],
        [x, y + height],
        [x + width, y + height],
      ]) {
        us.push(px * cos + py * sin);
        vs.push(-px * sin + py * cos);
      }
      // The word box is upright in the photo; level it around its centre so it doesn't grow taller.
      const cu = (x + width / 2) * cos + (y + height / 2) * sin;
      const cv = -(x + width / 2) * sin + (y + height / 2) * cos;
      const halfHeight = (Math.max(...vs) - Math.min(...vs)) / 2 - (Math.abs(sin) * width) / 2;
      const half = Math.max(halfHeight, height * 0.3);
      tokens.push({
        text: word.text,
        confidence: word.confidence,
        rect: word.rect,
        u: cu,
        v: cv,
        left: Math.min(...us),
        right: Math.max(...us),
        top: cv - half,
        bottom: cv + half,
        line: index,
      });
    }
  });
  return tokens;
}

// --- Rows --------------------------------------------------------------------

interface Row {
  tokens: Token[];
  v: number;
  height: number;
}

/** Groups words into rows: a word joins the row its height overlaps most. */
function clusterRows(tokens: Token[]): Row[] {
  const rows: Row[] = [];
  for (const token of tokens.slice().sort((a, b) => a.v - b.v)) {
    let best: Row | null = null;
    let bestOverlap = 0;
    for (let i = Math.max(0, rows.length - 4); i < rows.length; i += 1) {
      const row = rows[i];
      const overlap = Math.min(row.v + row.height / 2, token.bottom) - Math.max(row.v - row.height / 2, token.top);
      const ratio = overlap / Math.min(row.height, token.bottom - token.top);
      if (ratio > bestOverlap) {
        bestOverlap = ratio;
        best = row;
      }
    }
    if (best && bestOverlap >= 0.4) {
      const n = best.tokens.length;
      best.tokens.push(token);
      best.v = (best.v * n + token.v) / (n + 1);
      best.height = (best.height * n + (token.bottom - token.top)) / (n + 1);
    } else {
      rows.push({ tokens: [token], v: token.v, height: token.bottom - token.top });
    }
  }
  for (const row of rows) row.tokens.sort((a, b) => a.u - b.u);
  return rows.sort((a, b) => a.v - b.v);
}

/** Phrases from `phrases` found in a row, longest first, each word used once. */
function findPhrases(row: Row, phrases: string[][], minConfidence = 0.5): Token[][] {
  const found: Token[][] = [];
  const used = new Set<Token>();
  const sorted = phrases.slice().sort((a, b) => b.length - a.length);
  for (const phrase of sorted) {
    for (let i = 0; i + phrase.length <= row.tokens.length; i += 1) {
      const run = row.tokens.slice(i, i + phrase.length);
      if (run.some((t) => used.has(t) || t.confidence < minConfidence)) continue;
      if (!run.every((t, k) => sameWord(t.text, phrase[k]))) continue;
      // Words of one phrase sit close together.
      if (run.some((t, k) => k > 0 && t.left - run[k - 1].right > 2 * (t.bottom - t.top))) continue;
      run.forEach((t) => used.add(t));
      found.push(run);
    }
  }
  return found;
}

function boundsOf(tokens: Token[]): Rect {
  const x = Math.min(...tokens.map((t) => t.rect.x));
  const y = Math.min(...tokens.map((t) => t.rect.y));
  const right = Math.max(...tokens.map((t) => t.rect.x + t.rect.width));
  const bottom = Math.max(...tokens.map((t) => t.rect.y + t.rect.height));
  return { x, y, width: right - x, height: bottom - y };
}

/** The words as one field, in reading order (left to right unless `ordered` says they already are). */
function cellOf(tokens: Token[], ordered = false): Cell {
  const sorted = ordered ? tokens : tokens.slice().sort((a, b) => a.u - b.u);
  return {
    text: sorted.map((t) => t.text).join(' '),
    confidence: Math.min(...sorted.map((t) => t.confidence)),
    rect: boundsOf(sorted),
    tokens: sorted,
  };
}

const isNumberish = (text: string) => looksNumeric(text) || parseQty(text) !== null;

// --- Columns from the printed headings --------------------------------------

interface ColumnGuide {
  column: Column;
  left: number;
  right: number;
  u: number;
}

const ORDER: Column[] = ['qty', 'unit', 'item', 'unitPrice', 'amount'];

function headingRow(rows: Row[]): { index: number; guides: ColumnGuide[] } | null {
  let best: { index: number; guides: ColumnGuide[] } | null = null;
  rows.forEach((row, index) => {
    const guides: ColumnGuide[] = [];
    // UNIT PRICE before UNIT, so "UNIT" in "UNIT PRICE" isn't taken for the unit column.
    for (const column of ['unitPrice', 'amount', 'item', 'qty', 'unit'] as Column[]) {
      const rest = { ...row, tokens: row.tokens.filter((t) => !guides.some((g) => t.u >= g.left && t.u <= g.right)) };
      const [phrase] = findPhrases(rest, HEADINGS[column], 0.6);
      if (!phrase) continue;
      const left = Math.min(...phrase.map((t) => t.left));
      const right = Math.max(...phrase.map((t) => t.right));
      guides.push({ column, left, right, u: (left + right) / 2 });
    }
    const main = guides.filter((g) => g.column === 'item' || g.column === 'amount' || g.column === 'unitPrice').length;
    if (guides.length >= 2 && main >= 1 && (!best || guides.length > best.guides.length)) {
      best = { index, guides: guides.sort((a, b) => a.u - b.u) };
    }
  });
  return best;
}

/** Which kinds of text each column holds. */
function fits(column: Column, token: Token): boolean {
  const numeric = isNumberish(token.text);
  switch (column) {
    case 'qty':
    case 'unitPrice':
    case 'amount':
      return numeric;
    case 'unit':
      return !numeric || isUnitWord(token.text);
    case 'item':
      return true;
  }
}

/**
 * Where one column ends and the next begins. Narrow columns (QTY, UNIT) are
 * about as wide as their heading, and the item column takes the room between
 * them and the prices, so the edge sits close to the narrow column's heading.
 */
function edgeBetween(a: ColumnGuide, b: ColumnGuide): number {
  const gap = Math.max(0, b.left - a.right);
  if (b.column === 'item') return a.right + Math.min(gap * 0.25, (a.right - a.left) * 0.5);
  if (a.column === 'item') return b.left - Math.min(gap * 0.25, (b.right - b.left) * 0.5);
  return (a.right + b.left) / 2;
}

function columnFor(token: Token, guides: ColumnGuide[]): Column | null {
  let index = guides.length - 1;
  for (let i = 0; i < guides.length - 1; i += 1) {
    if (token.u < edgeBetween(guides[i], guides[i + 1])) {
      index = i;
      break;
    }
  }
  if (fits(guides[index].column, token)) return guides[index].column;
  // Doesn't fit where it sits (a price written a little left, say): try the neighbours.
  const neighbours = [guides[index - 1], guides[index + 1]].filter((g): g is ColumnGuide => !!g && fits(g.column, token));
  neighbours.sort((a, b) => Math.abs(a.u - token.u) - Math.abs(b.u - token.u));
  return neighbours[0]?.column ?? (guides.some((g) => g.column === 'item') ? 'item' : null);
}

/**
 * Two amounts the reader ran together ("2,800.008,400.00" for 2,800.00 and
 * 8,400.00, when the unit price and amount were written close), split back
 * into two words placed where each part was written.
 */
export function splitJoinedAmounts(token: Token): Token[] {
  const match = /^(.*?\d\.\d{2})(\d[\d,]*\.\d{2})$/.exec(token.text);
  if (!match || !looksNumeric(match[1]) || !looksNumeric(match[2])) return [token];
  const share = match[1].length / token.text.length;
  const split = (text: string, from: number, to: number): Token => {
    const left = token.left + (token.right - token.left) * from;
    const right = token.left + (token.right - token.left) * to;
    const rect = { ...token.rect, x: token.rect.x + token.rect.width * from, width: token.rect.width * (to - from) };
    return { ...token, text, left, right, u: (left + right) / 2, rect };
  };
  return [split(match[1], 0, share), split(match[2], share, 1)];
}

function rowFromColumns(row: Row, guides: ColumnGuide[]): LayoutRow {
  const byColumn = new Map<Column, Token[]>();
  for (const token of row.tokens.flatMap(splitJoinedAmounts)) {
    const column = columnFor(token, guides);
    if (!column) continue;
    byColumn.set(column, [...(byColumn.get(column) ?? []), token]);
  }
  // Two numbers in one price column, well apart: the left one is the unit price, the right one the amount.
  const prices = byColumn.get('unitPrice') ?? [];
  const amounts = byColumn.get('amount') ?? [];
  if (amounts.length >= 2 && prices.length === 0) {
    const at = widestGap(amounts);
    if (at > 0) byColumn.set('unitPrice', amounts.splice(0, at));
  }
  if (prices.length >= 2 && amounts.length === 0) {
    const at = widestGap(prices);
    if (at > 0) byColumn.set('amount', prices.splice(at));
  }
  // No quantity column on this receipt, or nothing in it: "2 Petron 11kg" puts it before the item.
  const items = byColumn.get('item') ?? [];
  if (!byColumn.get('qty')?.length && items.length > 1 && parseQty(items[0].text) && !looksLikeSize(items[1].text)) {
    byColumn.set('qty', [items.shift() as Token]);
  }
  const cells: Partial<Record<Column, Cell>> = {};
  for (const column of ORDER) {
    const tokens = byColumn.get(column);
    if (tokens && tokens.length > 0) cells[column] = cellOf(tokens);
  }
  return { cells, rect: boundsOf(row.tokens) };
}

/**
 * Where a run of words splits into two numbers: the index after the widest gap,
 * or 0 when every gap is narrow enough to be a space inside one number ("1,35 0.00").
 */
function widestGap(tokens: Token[]): number {
  let at = 0;
  let widest = 0;
  for (let i = 1; i < tokens.length; i += 1) {
    const gap = tokens[i].left - tokens[i - 1].right;
    if (gap > widest) {
      widest = gap;
      at = i;
    }
  }
  const height = tokens[at]?.bottom - tokens[at]?.top || 1;
  return widest > height ? at : 0;
}

const looksLikeSize = (text: string) => /^(?:kgs?|kilos?|k)\.?$/i.test(text);

// --- Rows read on their own (no headings) -----------------------------------

function rowFromPattern(row: Row): LayoutRow | null {
  const tokens = row.tokens.flatMap(splitJoinedAmounts);
  if (tokens.some((t) => t.confidence >= 0.8 && PRINTED_WORDS.has(headingForm(t.text)))) return null;
  const cells: Partial<Record<Column, Cell>> = {};
  const trailing: Token[] = [];
  while (tokens.length > 0 && looksNumeric(tokens[tokens.length - 1].text) && trailing.length < 2) {
    trailing.unshift(tokens.pop() as Token);
  }
  if (tokens.length > 0 && parseQty(tokens[0].text) && tokens.length > 1 && !looksLikeSize(tokens[1].text)) {
    cells.qty = cellOf([tokens.shift() as Token]);
  }
  if (tokens.length > 1 && isUnitWord(tokens[0].text)) cells.unit = cellOf([tokens.shift() as Token]);
  if (trailing.length === 2) cells.unitPrice = cellOf([trailing[0]]);
  if (trailing.length > 0) cells.amount = cellOf([trailing[trailing.length - 1]]);
  const words = tokens.filter((t) => /[a-z]{2,}/i.test(t.text));
  if (words.length === 0 || (!cells.amount && !cells.qty)) return null;
  cells.item = cellOf(tokens);
  return { cells, rect: boundsOf(row.tokens) };
}

// --- Fields ------------------------------------------------------------------

function rowHas(row: Row, words: Set<string>): boolean {
  return row.tokens.some((t) => t.confidence >= 0.7 && words.has(headingForm(t.text)));
}

/** The number written after the TOTAL label, on its row or just under it. */
function findTotal(rows: Row[], from: number): Cell | null {
  for (let i = rows.length - 1; i >= from; i -= 1) {
    const [label] = findPhrases(rows[i], TOTAL_LABELS, 0.6);
    if (!label) continue;
    const end = Math.max(...label.map((t) => t.right));
    const after = rows[i].tokens.filter((t) => t.left >= end - 2 && looksNumeric(t.text));
    if (after.length > 0) return cellOf([after[0]]);
    const below = rows[i + 1]?.tokens.filter((t) => t.left >= Math.min(...label.map((l) => l.left)) && looksNumeric(t.text)) ?? [];
    if (below.length > 0 && rows[i + 1].v - rows[i].v < 2 * rows[i].height) return cellOf([below[below.length - 1]]);
  }
  return null;
}

/** What follows a label on its row: the rest of the label's own word, or the words just after it. */
function valueAfter(row: Row, label: Token, pattern: RegExp): Cell | null {
  const rest = pattern.exec(label.text);
  const tokens: Token[] = [];
  if (rest && rest[1]) tokens.push({ ...label, text: rest[1] });
  let lastRight = label.right;
  for (const t of row.tokens) {
    if (t === label || t.u <= label.u) continue;
    if (t.left - lastRight > 4 * (t.bottom - t.top)) break;
    if (t.confidence >= 0.85 && PRINTED_WORDS.has(headingForm(t.text))) break;
    tokens.push(t);
    lastRight = t.right;
    if (tokens.length >= 4) break;
  }
  return tokens.length > 0 ? cellOf(tokens) : null;
}

const DATE_LABEL = /^(?:date|dated|petsa)\s*[:;.,]?\s*(.*)$/i;
const NUMBER_LABEL = /^(?:n[o0º°]|#|n[o0]\.?:)\s*[.:]?\s*(.*)$/i;

function findDate(rows: Row[]): Cell | null {
  for (const row of rows) {
    for (const t of row.tokens) {
      if (DATE_LABEL.test(t.text) && t.confidence >= 0.5) {
        const value = valueAfter(row, t, DATE_LABEL);
        if (value) return value;
      }
    }
  }
  // No label: the first thing anywhere that looks like a date.
  for (const row of rows) {
    for (const t of row.tokens) {
      if (/\b\d{1,2}\s*[/-]\s*\d{1,2}\s*[/-]\s*\d{2,4}\b/.test(t.text)) return cellOf([t]);
    }
  }
  return null;
}

function findReceiptNo(rows: Row[], lines: OcrLine[]): Cell | null {
  for (const row of rows) {
    for (const t of row.tokens) {
      if (!NUMBER_LABEL.test(t.text) || OTHER_NUMBERS.test(lines[t.line]?.text ?? '')) continue;
      const value = valueAfter(row, t, NUMBER_LABEL);
      if (!value) continue;
      const digits = value.tokens.find((v) => /\d{3,}/.test(v.text.replace(/[OoIlSB]/g, '0')));
      if (digits) return cellOf([digits]);
    }
  }
  return null;
}

// --- Putting it together ---------------------------------------------------

export function layoutOf(lines: OcrLine[]): ReceiptLayout {
  const angle = skewOf(lines);
  const rows = clusterRows(tokensOf(lines, angle));
  const heading = headingRow(rows);
  const receiptNo = findReceiptNo(rows, lines);
  const date = findDate(rows);
  const layoutRows: LayoutRow[] = [];
  let total: Cell | null = null;

  if (heading) {
    total = findTotal(rows, heading.index + 1);
    for (let i = heading.index + 1; i < rows.length; i += 1) {
      const row = rows[i];
      if (findPhrases(row, TOTAL_LABELS, 0.6).length > 0 || rowHas(row, FOOTER_WORDS)) break;
      const read = rowFromColumns(row, heading.guides);
      const { qty, unitPrice, amount, item } = read.cells;
      const previous = layoutRows[layoutRows.length - 1];
      if (!qty && !unitPrice && !amount && item && previous) {
        // A second line of the same item ("Petron 11kg" / "refill").
        previous.cells.item = previous.cells.item ? cellOf([...previous.cells.item.tokens, ...item.tokens], true) : item;
        continue;
      }
      if (!item && !qty && amount && previous && !previous.cells.amount) {
        previous.cells.amount = amount;
        continue;
      }
      if (Object.keys(read.cells).length > 0) layoutRows.push(read);
    }
    // Without a TOTAL label, a last row holding only an amount is the total.
    const last = layoutRows[layoutRows.length - 1];
    if (!total && last && last.cells.amount && !last.cells.item && !last.cells.qty && layoutRows.length > 1) {
      total = last.cells.amount;
      layoutRows.pop();
    }
  } else {
    total = findTotal(rows, 0);
    for (const row of rows) {
      if (findPhrases(row, TOTAL_LABELS, 0.6).length > 0) continue;
      const read = rowFromPattern(row);
      if (read) layoutRows.push(read);
    }
  }
  return {
    method: heading ? 'headers' : 'lines',
    skew: (angle * 180) / Math.PI,
    rows: layoutRows,
    receiptNo,
    date,
    total,
  };
}
