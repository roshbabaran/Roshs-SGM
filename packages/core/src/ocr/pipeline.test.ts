import { describe, expect, it } from 'vitest';

import { MemoryStore, ObservableStore } from '../store';
import { learnedAliases, loadOcrAliases, saveOcrAliases } from './aliases';
import { checkLine, checkTotal, type LineFields } from './checks';
import { layoutOf } from './layout';
import { matchItem } from './match';
import { draftFromLines, draftProblem, draftToCart } from './pipeline';
import { CATALOGUE, ocrLine, receiptLines } from './test-helpers';
import type { DraftField, DraftLine } from './types';

const TODAY = '2026-10-16';

describe('layout (stage 6)', () => {
  const rows: [string, string, string, string, string][] = [
    ['2', 'pc', 'Solane 11kg', '980.00', '1,960.00'],
    ['1', 'tank', 'Petron Gasul 11kg w/ tank', '2,800', '2,800'],
    ['3', 'pc', 'Hose clamp', '25', '75'],
  ];

  it('reads columns from the printed headings', () => {
    const layout = layoutOf(receiptLines(rows, '4,835.00'));
    expect(layout.method).toBe('headers');
    expect(layout.rows.map((r) => [r.cells.qty?.text, r.cells.unit?.text, r.cells.item?.text, r.cells.unitPrice?.text, r.cells.amount?.text])).toEqual(rows);
    expect(layout.total?.text).toBe('4,835.00');
    expect(layout.receiptNo?.text).toBe('7128');
    expect(layout.date?.text).toBe('10/16/26');
  });

  it('copes with a photo taken at an angle', () => {
    const layout = layoutOf(receiptLines(rows, '4,835.00', { angle: 4 }));
    expect(Math.round(layout.skew)).toBe(4);
    expect(layout.rows.map((r) => r.cells.item?.text)).toEqual(rows.map((r) => r[2]));
    expect(layout.rows.map((r) => r.cells.amount?.text)).toEqual(rows.map((r) => r[4]));
  });

  it('reads each row on its own when there are no headings', () => {
    const layout = layoutOf(receiptLines(rows, '4,835.00', { headings: false }));
    expect(layout.method).toBe('lines');
    expect(layout.rows.map((r) => [r.cells.qty?.text, r.cells.item?.text, r.cells.amount?.text])).toEqual(rows.map((r) => [r[0], r[2], r[4]]));
  });

  it('splits a unit price and amount the reader ran together', () => {
    const lines = receiptLines([['3', 'cyl', 'Petron Gasul 11 kg', '', '']], '8,400.00');
    lines.push(ocrLine('2,800.008,400.00', 670, 300));
    const [row] = layoutOf(lines).rows;
    expect(row.cells.unitPrice?.text).toBe('2,800.00');
    expect(row.cells.amount?.text).toBe('8,400.00');
  });

  it('joins a second line of the same item', () => {
    const lines = receiptLines([['1', 'pc', 'Petron 11kg', '950', '950']], '950');
    lines.push(ocrLine('(refill)', 250, 335));
    const layout = layoutOf(lines);
    expect(layout.rows).toHaveLength(1);
    expect(layout.rows[0].cells.item?.text).toBe('Petron 11kg (refill)');
  });
});

describe('matching (stage 8)', () => {
  it('matches misspelled names and sizes', () => {
    expect(matchItem('Petrn Gasul 11k', CATALOGUE, { prices: [] }).target).toEqual({ kind: 'product', productId: 'petron-11', type: 'refill' });
    expect(matchItem('Solane 11 KG', CATALOGUE, { prices: [] }).target).toMatchObject({ productId: 'solane-11' });
    expect(matchItem('Reg.', CATALOGUE, { prices: [] }).target).toMatchObject({ productId: 'regulator', type: 'item' });
  });

  it('lets the size tell cylinders of the same brand apart', () => {
    expect(matchItem('Gasul 2.7kg', CATALOGUE, { prices: [] }).target).toMatchObject({ productId: 'petron-2.7' });
    expect(matchItem('Gasul 11kg', CATALOGUE, { prices: [] }).target).toMatchObject({ productId: 'petron-11' });
  });

  it('lets the price decide refill or new, and says when the words disagree', () => {
    expect(matchItem('Solane 11kg', CATALOGUE, { prices: [290000] }).target).toMatchObject({ type: 'new' });
    expect(matchItem('Solane 11kg', CATALOGUE, { prices: [98000] }).target).toMatchObject({ type: 'refill' });
    const conflict = matchItem('Solane 11kg new', CATALOGUE, { prices: [98000] });
    expect(conflict.target).toMatchObject({ type: 'refill' });
    expect(conflict.status).toBe('check');
  });

  it('uses the price when the name is unreadable', () => {
    const match = matchItem('5lnxe 11kg', CATALOGUE, { prices: [98000] });
    expect(match.target).toMatchObject({ productId: 'solane-11', type: 'refill' });
  });

  it('leaves the line for the cashier when nothing fits', () => {
    const match = matchItem('Stove', CATALOGUE, { prices: [] });
    expect(match.target).toBeNull();
    expect(match.status).toBe('missing');
  });

  it('matches sets by name and price', () => {
    expect(matchItem('Starter kit 11kg', CATALOGUE, { prices: [320000] }).target).toEqual({ kind: 'set', setId: 'starter' });
  });

  it('uses what the cashier taught it first', () => {
    const aliases = { 'ptrn big': { kind: 'product' as const, productId: 'petron-11', type: 'new' as const } };
    expect(matchItem('Ptrn BIG', { ...CATALOGUE, aliases }, { prices: [] })).toMatchObject({ target: aliases['ptrn big'], status: 'ok' });
  });
});

const field = <T>(value: T | null, status: DraftField<T>['status'] = 'ok'): DraftField<T> => ({ value, read: String(value ?? ''), status });

function line(qty: number | null, unitPrice: number | null, amount: number | null): LineFields {
  return { qty: field(qty), unitPrice: field(unitPrice), amount: field(amount) };
}

describe('checks (stage 9)', () => {
  it('leaves consistent lines alone', () => {
    const l = line(2, 98000, 196000);
    checkLine(l, 98000);
    expect([l.qty.status, l.unitPrice.status, l.amount.status]).toEqual(['ok', 'ok', 'ok']);
  });

  it('fills in a missing value and marks it', () => {
    const noQty = line(null, 98000, 196000);
    checkLine(noQty, 98000);
    expect(noQty.qty).toMatchObject({ value: 2, status: 'check' });
    const noAmount = line(3, 2500, null);
    checkLine(noAmount, 2500);
    expect(noAmount.amount).toMatchObject({ value: 7500, status: 'check' });
  });

  it('proposes the value that disagrees with the other two and the price list', () => {
    const wrongPrice = line(2, 98800, 196000);
    checkLine(wrongPrice, 98000);
    expect(wrongPrice.unitPrice).toMatchObject({ value: 98000, status: 'check' });

    const wrongAmount = line(2, 95000, 19000);
    checkLine(wrongAmount, 95000);
    expect(wrongAmount.amount).toMatchObject({ value: 190000, status: 'check' });
  });

  it('catches cents written twice', () => {
    const l = line(1, 98000, 9800000);
    checkLine(l, 98000);
    expect(l.amount).toMatchObject({ value: 98000, status: 'check' });
  });

  it('compares the total with the amounts and with SGM prices', () => {
    const total = field(300000);
    const notes = checkTotal(total, [196000, 95000], 291000);
    expect(total.status).toBe('check');
    expect(notes.join(' ')).toMatch(/add up to ₱2,910.00/);
  });
});

describe('draftFromLines', () => {
  it('turns a receipt into lines the cashier can add to the sale', () => {
    const draft = draftFromLines(
      receiptLines(
        [
          ['2', 'pc', 'Solane 11kg', '980.00', '1,960.00'],
          ['1', 'tank', 'Petron Gasul 11kg w/ tank', '2,800', '2,800'],
          ['3', 'pc', 'Hose clamp', '25', '75'],
        ],
        '4,835.00',
      ),
      { width: 1000, height: 1000 },
      CATALOGUE,
      { today: TODAY },
    );
    expect(draft.receiptNo).toMatchObject({ value: '7128', status: 'ok' });
    expect(draft.date).toMatchObject({ value: TODAY, status: 'ok' });
    expect(draft.total).toMatchObject({ value: 483500, status: 'ok' });
    expect(draft.notes).toEqual([]);
    expect(draftProblem(draft.lines)).toBeNull();
    expect(draftToCart(draft.lines)).toEqual([
      { type: 'refill', productId: 'solane-11', qty: 2 },
      { type: 'new', productId: 'petron-11', qty: 1 },
      { type: 'item', productId: 'clamp', qty: 3 },
    ]);
  });

  it('says what to do when nothing was found', () => {
    const draft = draftFromLines([ocrLine('SIBUGAY GAS MARKETING', 300, 40)], { width: 1000, height: 1000 }, CATALOGUE, { today: TODAY });
    expect(draft.lines).toEqual([]);
    expect(draft.notes[0]).toMatch(/No item lines/);
    expect(draftProblem(draft.lines)).toMatch(/no items/);
  });
});

describe('draftToCart and draftProblem', () => {
  const qty = (n: number) => field(n);
  it('merges the same product sold the same way', () => {
    const cart = draftToCart([
      { target: { kind: 'product', productId: 'hose', type: 'item' }, qty: qty(1) },
      { target: { kind: 'product', productId: 'hose', type: 'item' }, qty: qty(2) },
      { target: { kind: 'set', setId: 'starter' }, qty: qty(1) },
    ]);
    expect(cart).toEqual([
      { type: 'item', productId: 'hose', qty: 3 },
      { type: 'set', setId: 'starter', qty: 1 },
    ]);
  });

  it('blocks lines without a product', () => {
    expect(draftProblem([{ target: null, qty: qty(1) }])).toMatch(/Pick the product/);
  });
});

describe('learning from corrections (stage 11)', () => {
  it('remembers a spelling the cashier corrected, on this device', async () => {
    const store = new ObservableStore(new MemoryStore());
    const read = draftFromLines(receiptLines([['1', 'pc', 'Ptrn big', '', '']], ''), { width: 1000, height: 1000 }, CATALOGUE, { today: TODAY }).lines;
    expect(read[0].target).toBeNull();
    const reviewed: DraftLine[] = [{ ...read[0], target: { kind: 'product', productId: 'petron-11', type: 'new' } }];
    await saveOcrAliases(store, learnedAliases(read, reviewed));
    const aliases = await loadOcrAliases(store);
    expect(aliases).toEqual({ 'ptrn big': { kind: 'product', productId: 'petron-11', type: 'new' } });
    const again = draftFromLines(receiptLines([['1', 'pc', 'Ptrn big', '', '']], ''), { width: 1000, height: 1000 }, { ...CATALOGUE, aliases }, { today: TODAY });
    expect(again.lines[0]).toMatchObject({ target: { productId: 'petron-11', type: 'new' }, targetStatus: 'ok' });
  });
});
