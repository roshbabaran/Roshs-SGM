/** Builders for the OCR tests: lines of text placed on a pretend photo, and a small catalogue. */
import type { Product, ProductSet } from '../models';
import type { Catalogue } from './match';
import type { OcrLine, OcrText, Quad } from './types';

/**
 * A line of text as the reader would return it: `x`, `y` is its top-left
 * corner, each character 14 px wide, 32 px high, turned by `angle` degrees
 * around the photo's origin.
 */
export function ocrLine(text: string, x: number, y: number, options: { angle?: number; confidence?: number } = {}): OcrLine {
  const charWidth = 14;
  const height = 32;
  const rad = ((options.angle ?? 0) * Math.PI) / 180;
  const turn = (px: number, py: number) => ({ x: px * Math.cos(rad) - py * Math.sin(rad), y: px * Math.sin(rad) + py * Math.cos(rad) });
  const confidence = options.confidence ?? 0.98;
  const words: OcrText[] = [];
  let offset = 0;
  for (const word of text.split(' ')) {
    if (word) {
      const a = turn(x + offset * charWidth, y);
      const b = turn(x + (offset + word.length) * charWidth, y + height);
      words.push({
        text: word,
        confidence,
        rect: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) },
      });
    }
    offset += word.length + 1;
  }
  const width = text.length * charWidth;
  const quad: Quad = [turn(x, y), turn(x + width, y), turn(x + width, y + height), turn(x, y + height)];
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  return {
    text,
    confidence,
    quad,
    rect: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) },
    words,
  };
}

/**
 * A line as the reader returned it on a real photo: its text, confidence and
 * box (x, y, width, height in photo pixels). Its words share the box's width
 * by their number of characters.
 */
export function boxLine(text: string, confidence: number, [x, y, width, height]: [number, number, number, number]): OcrLine {
  const charWidth = width / text.length;
  const words: OcrText[] = [];
  let offset = 0;
  for (const word of text.split(' ')) {
    if (word) words.push({ text: word, confidence, rect: { x: x + offset * charWidth, y, width: word.length * charWidth, height } });
    offset += word.length + 1;
  }
  const quad: Quad = [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
  return { text, confidence, quad, rect: { x, y, width, height }, words };
}

export const cylinder = (id: string, name: string, brand: string, sizeKg: number, refill: number, price: number): Product => ({
  id,
  sku: id.toUpperCase(),
  name,
  kind: 'cylinder',
  brand,
  sizeKg,
  refillPrice: refill * 100,
  price: price * 100,
  lowStockAt: 2,
  active: true,
});

const accessory = (id: string, name: string, price: number): Product => ({
  id,
  sku: id.toUpperCase(),
  name,
  kind: 'accessory',
  price: price * 100,
  lowStockAt: 2,
  active: true,
});

export const PRODUCTS: Product[] = [
  cylinder('petron-11', 'Petron Gasul 11 kg', 'Petron', 11, 950, 2800),
  cylinder('solane-11', 'Solane 11 kg', 'Solane', 11, 980, 2900),
  cylinder('fiesta-11', 'Fiesta Gas 11 kg', 'Fiesta', 11, 900, 2600),
  cylinder('petron-2.7', 'Petron Gasul 2.7 kg', 'Petron', 2.7, 280, 1100),
  accessory('regulator', 'LPG regulator', 450),
  accessory('hose', 'LPG hose (1.5 m)', 180),
  accessory('clamp', 'Hose clamp', 25),
];

export const SETS: ProductSet[] = [
  {
    id: 'starter',
    name: 'Starter kit 11 kg',
    items: [
      { productId: 'petron-11', type: 'new', qty: 1 },
      { productId: 'regulator', type: 'item', qty: 1 },
    ],
    price: 320000,
    active: true,
  },
];

export const CATALOGUE: Catalogue = { products: PRODUCTS, sets: SETS };

/**
 * The lines of a receipt like the ones SGM's booklet is assumed to have:
 * printed headings, then one row per item, then TOTAL.
 */
export function receiptLines(
  rows: [qty: string, unit: string, item: string, price: string, amount: string][],
  total: string,
  options: { angle?: number; headings?: boolean } = {},
): OcrLine[] {
  const angle = options.angle ?? 0;
  const lines: OcrLine[] = [
    ocrLine('SIBUGAY GAS MARKETING', 300, 40, { angle }),
    ocrLine('No. 7128', 760, 110, { angle }),
    ocrLine('Date: 10/16/26', 700, 170, { angle }),
  ];
  if (options.headings !== false) {
    lines.push(
      ocrLine('QTY', 60, 240, { angle }),
      ocrLine('UNIT', 150, 240, { angle }),
      ocrLine('ARTICLES', 380, 240, { angle }),
      ocrLine('UNIT PRICE', 660, 240, { angle }),
      ocrLine('AMOUNT', 860, 240, { angle }),
    );
  }
  rows.forEach(([qty, unit, item, price, amount], i) => {
    const y = 300 + i * 60;
    if (qty) lines.push(ocrLine(qty, 70, y, { angle }));
    if (unit) lines.push(ocrLine(unit, 150, y, { angle }));
    if (item) lines.push(ocrLine(item, 250, y, { angle }));
    if (price) lines.push(ocrLine(price, 670, y, { angle }));
    if (amount) lines.push(ocrLine(amount, 860, y, { angle }));
  });
  const totalY = 300 + Math.max(rows.length, 4) * 60;
  lines.push(ocrLine('TOTAL', 690, totalY, { angle }), ocrLine(total, 860, totalY, { angle }));
  lines.push(ocrLine('Received the above goods in good order and condition.', 60, totalY + 90, { angle }));
  return lines;
}
