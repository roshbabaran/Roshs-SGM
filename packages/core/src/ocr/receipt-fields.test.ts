/**
 * The booklet with an "ITEM DESCRIPTION/NATURE OF SERVICE | QUANTITY | UNIT
 * COST/PRICE | AMOUNT" table and "Registered Name:" and "Date:" written at the
 * top. The table tests use what PP-OCRv6 small actually returned for a photo
 * of one (675 × 284 px), with one line written in blue ballpoint: "11kg",
 * quantity 1, no unit price, amount 1510.
 */
import { describe, expect, it } from 'vitest';

import { layoutOf } from './layout';
import { matchItem, type Catalogue } from './match';
import { normalizeItemText, parseReceiptDate, parseReceiptTime } from './normalize';
import { draftFromLines } from './pipeline';
import { inkOnly } from './preprocess';
import { boxLine, CATALOGUE, cylinder, ocrLine, receiptLines } from './test-helpers';
import type { OcrLine } from './types';

const TODAY = '2026-11-10';
const PHOTO = { width: 675, height: 284 };

/** Read from the photo as it was. The "11kg" and the "1" weren't found. */
const PLAIN: OcrLine[] = [
  boxLine('ITEM DESCRIPTION/NATURE OFSERVICE', 0.98, [10, 5, 294, 19]),
  boxLine('QUANTITY', 1.0, [320, 5, 84, 20]),
  boxLine('UNIT COST/PRICE', 0.99, [411, 4, 114, 20]),
  boxLine('AMOUNT', 1.0, [560, 2, 82, 25]),
  boxLine('1510', 0.96, [589, 29, 81, 32]),
];

/** Read from the ink-only copy. */
const INK: OcrLine[] = [
  boxLine('ITEM DESCRIPTION/NATURE OF SERVICE', 0.98, [9, 5, 294, 21]),
  boxLine('QUANTITY', 1.0, [319, 3, 85, 24]),
  boxLine('UNIT COST/PRICE', 0.99, [410, 4, 116, 22]),
  boxLine('AMOUNT', 1.0, [559, 2, 83, 26]),
  boxLine('11K', 0.71, [136, 24, 99, 65]),
  boxLine('1510', 0.89, [588, 29, 83, 33]),
];

/** The ink-only copy upscaled: "11KC", and a stray "0" from a speck in an empty row. */
const INK_UPSCALED: OcrLine[] = [...INK.slice(0, 4), boxLine('11KC', 0.65, [136, 24, 99, 65]), INK[5], boxLine('0', 0.32, [397, 128, 53, 43])];

/** Three brands of 11 kg; only Petron's refill is ₱1,510. */
const STORE: Catalogue = {
  products: [
    cylinder('petron-11', 'Petron Gasul 11 kg', 'Petron', 11, 1510, 3200),
    cylinder('solane-11', 'Solane 11 kg', 'Solane', 11, 1450, 3100),
    cylinder('fiesta-11', 'Fiesta Gas 11 kg', 'Fiesta', 11, 1400, 3000),
    cylinder('petron-2.7', 'Petron Gasul 2.7 kg', 'Petron', 2.7, 510, 1510),
  ],
  sets: [],
};

const cellsOf = (lines: OcrLine[]) =>
  layoutOf(lines).rows.map((r) => ({ item: r.cells.item?.text, qty: r.cells.qty?.text, unitPrice: r.cells.unitPrice?.text, amount: r.cells.amount?.text }));

describe('the ITEM DESCRIPTION / QUANTITY / UNIT COST/PRICE / AMOUNT table', () => {
  it('finds the four headings, however the reader splits them', () => {
    expect(layoutOf(PLAIN).method).toBe('headers');
    expect(layoutOf(INK).method).toBe('headers');
  });

  it('reads the one written line from the plain photo', () => {
    expect(cellsOf(PLAIN)).toEqual([{ item: undefined, qty: undefined, unitPrice: undefined, amount: '1510' }]);
  });

  it('reads the one written line from the ink-only copy', () => {
    expect(cellsOf(INK)).toEqual([{ item: '11K', qty: undefined, unitPrice: undefined, amount: '1510' }]);
  });

  it('drops a stray mark read as one unsure character', () => {
    expect(cellsOf(INK_UPSCALED)).toEqual([{ item: '11KC', qty: undefined, unitPrice: undefined, amount: '1510' }]);
  });

  it('turns the ink-only reads into one 11 kg refill, picked by its price and marked for checking', () => {
    for (const lines of [INK, INK_UPSCALED]) {
      const [line, ...more] = draftFromLines(lines, PHOTO, STORE, { today: TODAY }).lines;
      expect(more).toEqual([]);
      expect(line.target).toEqual({ kind: 'product', productId: 'petron-11', type: 'refill' });
      expect(line.targetStatus).toBe('check');
      expect(line.amount.value).toBe(151000);
      // The quantity wasn't read, so it's worked out and marked.
      expect(line.qty).toMatchObject({ value: 1, read: '', status: 'check' });
      expect(line.listPrice).toBe(151000);
    }
  });

  it('leaves the plain read for the cashier: without the size, ₱1,510 is an 11 kg refill or a new 2.7 kg', () => {
    const [line] = draftFromLines(PLAIN, PHOTO, STORE, { today: TODAY }).lines;
    expect(line.target).toBeNull();
    expect(line.candidates.slice(0, 2)).toEqual([
      { kind: 'product', productId: 'petron-11', type: 'refill' },
      { kind: 'product', productId: 'petron-2.7', type: 'new' },
    ]);
    expect(line.qty).toMatchObject({ value: 1, read: '', status: 'check' });
    expect(line.amount.value).toBe(151000);
    // With only the 11 kg brands in stock, the price alone settles it.
    const elevens: Catalogue = { ...STORE, products: STORE.products.filter((p) => p.sizeKg === 11) };
    expect(draftFromLines(PLAIN, PHOTO, elevens, { today: TODAY }).lines[0]).toMatchObject({
      target: { productId: 'petron-11', type: 'refill' },
      targetStatus: 'check',
      qty: { value: 1, status: 'check' },
    });
  });

  it('leaves the product for the cashier when two brands have the price, with both first in the picker', () => {
    const tied: Catalogue = { ...STORE, products: STORE.products.map((p) => (p.id === 'solane-11' ? { ...p, refillPrice: 151000 } : p)) };
    const [line] = draftFromLines(INK, PHOTO, tied, { today: TODAY }).lines;
    expect(line.target).toBeNull();
    expect(line.targetStatus).toBe('missing');
    expect(line.candidates.slice(0, 2).map((c) => (c.kind === 'product' ? c.productId : c.setId)).sort()).toEqual(['petron-11', 'solane-11']);
  });
});

describe('a whole receipt photo in this layout, read with the ink-only step', () => {
  /** What the models read from a 1600 px photo of the booklet, with ITEM and DESCRIPTION run together and "280" read as "2.80". */
  const heading = (item: string) => [
    boxLine(item, 0.97, [225, 572, 500, 41]),
    boxLine('QUANTITY', 1.0, [773, 583, 130, 30]),
    boxLine('.UNIT COST/PRICE', 0.93, [927, 583, 250, 35]),
    boxLine('AMOUNT', 1.0, [1219, 586, 112, 33]),
  ];
  const body = [
    boxLine('Hose', 1.0, [266, 634, 100, 49]),
    boxLine('2', 1.0, [788, 637, 45, 53]),
    boxLine('360', 1.0, [1224, 642, 77, 55]),
    boxLine('Gasul 2.7kg', 1.0, [274, 697, 230, 61]),
    boxLine('1', 1.0, [799, 708, 34, 44]),
    boxLine('2.80', 0.97, [970, 708, 86, 52]),
    boxLine('280', 1.0, [1220, 709, 81, 55]),
  ];
  const photo = { width: 1600, height: 1450 };

  it('finds the item column when ITEM and DESCRIPTION are read as one word', () => {
    for (const item of ['ITEMDESCRIPTIOÑ/NATURE OF SERVICE', "ITEM'DESCRIRTION/NATURE OF SERVICE"]) {
      expect(cellsOf([...heading(item), ...body])).toEqual([
        { item: 'Hose', qty: '2', unitPrice: undefined, amount: '360' },
        { item: 'Gasul 2.7kg', qty: '1', unitPrice: '2.80', amount: '280' },
      ]);
    }
  });

  it('takes the printed words left of the other headings as the item column when they are read too badly to match', () => {
    expect(cellsOf([...heading('XTEM DESCRXPTXON/NAXURE OF SERVXCE'), ...body]).map((r) => r.item)).toEqual(['Hose', 'Gasul 2.7kg']);
  });

  it("trusts the amount when it is SGM's price and the unit price was read with a stray point", () => {
    const [hose, gasul] = draftFromLines([...heading('ITEMDESCRIPTIOÑ/NATURE OF SERVICE'), ...body], photo, CATALOGUE, { today: TODAY }).lines;
    expect(hose).toMatchObject({ target: { productId: 'hose', type: 'item' }, qty: { value: 2 }, amount: { value: 36000 } });
    expect(gasul.target).toMatchObject({ productId: 'petron-2.7', type: 'refill' });
    expect(gasul.amount).toMatchObject({ value: 28000, status: 'ok' });
    expect(gasul.unitPrice).toMatchObject({ value: 28000, status: 'check' });
  });
});

describe('void strokes and specks', () => {
  const rows: [string, string, string, string, string][] = [['2', 'pc', 'Solane 11kg', '980.00', '1,960.00']];

  it('ignores a line drawn down the amount column over the empty rows', () => {
    const lines = receiptLines(rows, '1,960.00');
    lines.push(boxLine('|', 0.9, [880, 360, 14, 170]));
    expect(layoutOf(lines).rows.map((r) => r.cells.amount?.text)).toEqual(['1,960.00']);
  });

  it('ignores one in the unit price column read as a 1, and one read turned, as a dash', () => {
    const lines = receiptLines(rows, '1,960.00');
    lines.push(boxLine('1', 0.95, [690, 360, 16, 170]), boxLine('—', 0.8, [890, 360, 18, 170]));
    expect(layoutOf(lines).rows).toHaveLength(1);
  });

  it('keeps a short 1 where a number belongs', () => {
    const lines = receiptLines([['', 'pc', 'Hose clamp', '25', '']], '25');
    lines.push(ocrLine('1', 70, 300));
    const [row] = layoutOf(lines).rows;
    expect(row.cells.qty?.text).toBe('1');
  });

  it('drops a row that is only an unsure speck, but keeps a sure one', () => {
    const lines = receiptLines(rows, '1,960.00');
    lines.push(ocrLine('o', 70, 360, { confidence: 0.3 }));
    expect(layoutOf(lines).rows).toHaveLength(1);
    const sure = receiptLines(rows, '1,960.00');
    sure.push(ocrLine('3', 70, 360, { confidence: 0.95 }));
    expect(layoutOf(sure).rows).toHaveLength(2);
  });
});

describe('labelled fields: Registered Name and Date', () => {
  const table = (lines: OcrLine[]) => [
    ...lines,
    ocrLine('QTY', 60, 240),
    ocrLine('ARTICLES', 380, 240),
    ocrLine('AMOUNT', 860, 240),
    ocrLine('1', 70, 300),
    ocrLine('Solane 11kg', 250, 300),
    ocrLine('980', 860, 300),
  ];

  it('takes the rest of the line after the label', () => {
    const layout = layoutOf(table([ocrLine('Registered Name: Juan Dela Cruz', 40, 100), ocrLine('Date: 11/10/25 2:30 pm', 640, 100)]));
    expect(layout.registeredName?.text).toBe('Juan Dela Cruz');
    expect(layout.date?.text).toBe('11/10/25 2:30 pm');
    expect(layout.rows).toHaveLength(1);
  });

  it('stops at the next label on the same line', () => {
    const layout = layoutOf(table([ocrLine('Registered Name: Juan Dela Cruz Date: 11/10/25', 40, 100)]));
    expect(layout.registeredName?.text).toBe('Juan Dela Cruz');
    expect(layout.date?.text).toBe('11/10/25');
  });

  it('takes the box to the right, level with the label', () => {
    const layout = layoutOf(table([ocrLine('Registered Name:', 40, 100), ocrLine('Maria Santos', 330, 104), ocrLine('Date:', 640, 100), ocrLine('Nov 10, 2026', 730, 98)]));
    expect(layout.registeredName?.text).toBe('Maria Santos');
    expect(layout.date?.text).toBe('Nov 10, 2026');
  });

  it('takes the box below when nothing is written to the right, never another label', () => {
    const layout = layoutOf(table([ocrLine('Registered Name:', 40, 100), ocrLine('Address:', 420, 100), ocrLine('Pedro Reyes', 52, 140)]));
    expect(layout.registeredName?.text).toBe('Pedro Reyes');
  });

  it('finds nothing rather than another label', () => {
    const layout = layoutOf(table([ocrLine('Registered Name:', 40, 100), ocrLine('TIN:', 420, 100), ocrLine('Business Style:', 40, 150)]));
    expect(layout.registeredName).toBeNull();
  });

  it('reads the label however it was printed or read', () => {
    for (const label of ['REGISTERED NAME:', 'Reg. Name:', 'Registered Narne:', 'RegisteredName:', 'Registered Name']) {
      expect(layoutOf(table([ocrLine(`${label} Ana Lim`, 40, 100)])).registeredName?.text).toBe('Ana Lim');
    }
  });

  it('never makes an item row of a label or its value', () => {
    // Without printed headings, "Name: Gasul Store 88" would read as an item with an amount.
    const layout = layoutOf([ocrLine('Registered Name: Gasul Store 88', 40, 40), ocrLine('Date: 11/10/25', 40, 90), ocrLine('2 Solane 11kg 1,960', 40, 160)]);
    expect(layout.method).toBe('lines');
    expect(layout.rows.map((r) => r.cells.item?.text)).toEqual(['Solane 11kg']);
    expect(layout.registeredName?.text).toBe('Gasul Store 88');
  });

  it('puts the name, date and time in the draft', () => {
    const draft = draftFromLines(table([ocrLine('Registered Name: Juan Dela Cruz', 40, 100), ocrLine('Date: 11/10/25 2:30 pm', 640, 100)]), PHOTO, CATALOGUE, {
      today: TODAY,
    });
    expect(draft.registeredName).toMatchObject({ value: 'Juan Dela Cruz', status: 'ok' });
    expect(draft.date).toMatchObject({ value: '2025-11-10', status: 'check' });
    expect(draft.date.note).toMatch(/Nov 10, 2025/);
    expect(draft.time).toMatchObject({ value: '14:30', status: 'ok' });
    const noTime = draftFromLines(table([ocrLine('Date: 11/10/26', 640, 100)]), PHOTO, CATALOGUE, { today: TODAY });
    expect(noTime.date).toMatchObject({ value: TODAY, status: 'ok' });
    expect(noTime.time).toMatchObject({ value: null, status: 'missing' });
    expect(noTime.registeredName.value).toBeNull();
  });
});

describe('dates and times as written in the Philippines', () => {
  it('reads month, day, year', () => {
    expect(parseReceiptDate('11/10/25', TODAY)?.day).toBe('2025-11-10');
    expect(parseReceiptDate('Nov 10, 2026', TODAY)?.day).toBe('2026-11-10');
    expect(parseReceiptDate('10-11-2026', TODAY)?.day).toBe('2026-10-11');
    expect(parseReceiptDate('11/10/25 2:30 pm', TODAY)?.day).toBe('2025-11-10');
  });

  it('reads a time written by the date', () => {
    expect(parseReceiptTime('2:30 pm')).toBe('14:30');
    expect(parseReceiptTime('2:30PM')).toBe('14:30');
    expect(parseReceiptTime('2.30 p.m.')).toBe('14:30');
    expect(parseReceiptTime('2pm')).toBe('14:00');
    expect(parseReceiptTime('14:30')).toBe('14:30');
    expect(parseReceiptTime('12:15 am')).toBe('00:15');
    expect(parseReceiptTime('11/10/25 2:30 pm')).toBe('14:30');
    expect(parseReceiptTime('Nov 10, 2026 9:05 am')).toBe('09:05');
  });

  it("doesn't take a date for a time, or accept one that isn't real", () => {
    expect(parseReceiptTime('10/16/26')).toBeNull();
    expect(parseReceiptTime('10.16.26')).toBeNull();
    expect(parseReceiptTime('Nov 10, 2026')).toBeNull();
    expect(parseReceiptTime('13:00 pm')).toBeNull();
    expect(parseReceiptTime('9:75')).toBeNull();
  });
});

describe('quantity when none was written', () => {
  const draft = (row: [string, string, string, string, string]) => draftFromLines(receiptLines([row], ''), { width: 1000, height: 1000 }, CATALOGUE, { today: TODAY }).lines[0];

  it('is the amount over the written unit price', () => {
    expect(draft(['', 'pc', 'Solane 11kg', '980', '1,960']).qty).toMatchObject({ value: 2, status: 'check' });
  });

  it("is the amount over SGM's refill or new price when no unit price was written", () => {
    expect(draft(['', '', 'Petron Gasul 11kg', '', '1,900']).qty).toMatchObject({ value: 2, status: 'check' });
    const fresh = draft(['', '', 'Petron Gasul 11kg', '', '2,800']);
    expect(fresh.target).toMatchObject({ productId: 'petron-11', type: 'new' });
    expect(fresh.qty).toMatchObject({ value: 1, status: 'check' });
  });

  it('works out new instead of refill from an amount of two new cylinders', () => {
    const line = draft(['', '', 'Petron Gasul 11kg', '', '5,600']);
    expect(line.target).toMatchObject({ productId: 'petron-11', type: 'new' });
    expect(line.targetStatus).toBe('check');
    expect(line.qty).toMatchObject({ value: 2, status: 'check' });
  });

  it('is 1 when nothing says otherwise', () => {
    expect(draft(['', '', 'Petron Gasul 11kg', '', '']).qty).toMatchObject({ value: 1, status: 'check' });
  });
});

describe('product matching', () => {
  it('reads the ways a handwritten size comes back', () => {
    for (const text of ['11K', '11KC', '11K6', 'IIKG', '1lkg', 'llkg', '11 kg', '11kgs']) expect(normalizeItemText(text)).toBe('11 kg');
    expect(normalizeItemText('ok')).toBe('ok');
  });

  it('lets the price choose between brands when only the size is written', () => {
    const match = matchItem('11kg', STORE, { prices: [145000] });
    expect(match.target).toEqual({ kind: 'product', productId: 'solane-11', type: 'refill' });
    expect(match.status).toBe('check');
    expect(matchItem('11kg', STORE, { prices: [310000] }).target).toEqual({ kind: 'product', productId: 'solane-11', type: 'new' });
  });

  it("keeps the size: ₱1,510 is also a new 2.7 kg, but the line says 11 kg", () => {
    expect(matchItem('11KC', STORE, { prices: [151000] }).target).toMatchObject({ productId: 'petron-11', type: 'refill' });
  });

  it('leaves the product for the cashier when the price fits none of the brands', () => {
    const match = matchItem('11kg', STORE, { prices: [99900] });
    expect(match.target).toBeNull();
    expect(match.candidates.length).toBeGreaterThan(1);
  });
});

describe('ink only', () => {
  it('fades pink and magenta and keeps black, blue and red ink, stretched to black and white', () => {
    // Paper, pink speckle, magenta speckle, black, blue and red ink, repeated so the percentiles fall on paper and ink.
    const colours = [
      [250, 250, 250],
      [245, 160, 200],
      [230, 60, 220],
      [30, 30, 30],
      [40, 60, 170],
      [200, 40, 40],
    ];
    const pixels: number[] = [];
    const counts = [60, 10, 10, 10, 5, 5];
    colours.forEach((c, i) => {
      for (let k = 0; k < counts[i]; k += 1) pixels.push(c[0], c[1], c[2], 255);
    });
    const out = inkOnly({ width: 100, height: 1, data: new Uint8ClampedArray(pixels) });
    const at = (index: number) => out.data[index * 4];
    const first = (colour: number) => counts.slice(0, colour).reduce((a, b) => a + b, 0);
    expect(at(first(0))).toBe(255);
    expect(at(first(1))).toBeGreaterThan(180);
    expect(at(first(2))).toBeGreaterThan(180);
    expect(at(first(3))).toBe(0);
    expect(at(first(4))).toBeLessThan(40);
    expect(at(first(5))).toBeLessThan(40);
    // Grey: the three colour channels agree, and alpha is kept.
    expect([out.data[1], out.data[2], out.data[3]]).toEqual([at(0), at(0), 255]);
  });
});

describe('the receipt number', () => {
  const withNumber = (line: OcrLine) => [line, ocrLine('Date: 11/10/26', 40, 100), ocrLine('QTY', 60, 240), ocrLine('ARTICLES', 380, 240), ocrLine('AMOUNT', 860, 240)];

  it('reads the printed "№" however the reader returns it', () => {
    for (const text of ['N? 71901', 'N?71901', 'Nº 71901', 'N° 71901', '№ 71901', 'No. 71901', 'No: 71901']) {
      const layout = layoutOf(withNumber(ocrLine(text, 760, 40)));
      expect([text, layout.receiptNo?.text, layout.receiptNoGuessed]).toEqual([text, '71901', false]);
    }
  });

  it('takes a lone printed number above the table when the "№" was not read, marked for checking', () => {
    const layout = layoutOf(withNumber(ocrLine('71901', 800, 40, { confidence: 0.95 })));
    expect([layout.receiptNo?.text, layout.receiptNoGuessed]).toEqual(['71901', true]);
    const draft = draftFromLines(withNumber(ocrLine('71901', 800, 40, { confidence: 0.95 })), PHOTO, CATALOGUE, { today: TODAY });
    expect(draft.receiptNo).toMatchObject({ value: '71901', status: 'check' });
  });

  it("doesn't take a month, a year, a TIN or an amount for it", () => {
    expect(layoutOf([ocrLine('Date: Nov 10, 2026', 40, 40)]).receiptNo).toBeNull();
    expect(layoutOf(withNumber(ocrLine('TIN 123456', 760, 40))).receiptNo).toBeNull();
    const amountBelow = withNumber(ocrLine('1510', 860, 300, { confidence: 0.95 }));
    expect(layoutOf(amountBelow).receiptNo).toBeNull();
  });
});
