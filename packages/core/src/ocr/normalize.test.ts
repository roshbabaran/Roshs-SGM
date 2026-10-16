import { describe, expect, it } from 'vitest';

import { itemSize, lineTypeHint, looksNumeric, normalizeItemText, parseAmount, parseQty, parseReceiptDate, parseReceiptNo } from './normalize';

describe('parseAmount', () => {
  it.each([
    ['980', 98000],
    ['980.00', 98000],
    ['1,960.00', 196000],
    ['1,960', 196000],
    ['1.960', 196000],
    ['₱2,900', 290000],
    ['P950.00', 95000],
    ['PHP 450', 45000],
    ['980.-', 98000],
    ['980=', 98000],
    ['980/-', 98000],
    ['25.5', 2550],
    ['1,35 0.00', 135000],
  ])('reads %s as %i centavos', (text, centavos) => {
    expect(parseAmount(text)).toEqual({ value: centavos, fixed: false });
  });

  it('turns look-alike letters into digits and says so', () => {
    expect(parseAmount('1,9O0')).toEqual({ value: 190000, fixed: true });
    expect(parseAmount('l80')).toEqual({ value: 18000, fixed: true });
  });

  it.each(['', 'pc', 'Hose', '11kg', '0', '12.345.6789', 'Oct'])('rejects %j', (text) => {
    expect(parseAmount(text)).toBeNull();
  });
});

describe('parseQty', () => {
  it.each([
    ['2', 2],
    ['12', 12],
    ['2pcs', 2],
    ['x3', 3],
    ['3 tanks', 3],
  ])('reads %s as %i', (text, qty) => {
    expect(parseQty(text)?.value).toBe(qty);
  });

  it('reads a one-stroke 1 and look-alikes, marked for checking', () => {
    expect(parseQty('—')).toEqual({ value: 1, fixed: true });
    expect(parseQty('l')).toEqual({ value: 1, fixed: true });
  });

  it.each(['', '0', 'pc', '1/2', '1000'])('rejects %j', (text) => {
    expect(parseQty(text)).toBeNull();
  });
});

describe('parseReceiptDate', () => {
  const today = '2026-10-16';
  it.each([
    ['10/16/26', '2026-10-16'],
    ['10/5/2026', '2026-10-05'],
    ['10-3-26', '2026-10-03'],
    ['Oct 7, 2026', '2026-10-07'],
    ['Oct. 15', '2026-10-15'],
    ['Oct, 13', '2026-10-13'],
    ['oct.4', '2026-10-04'],
    ['16 Oct 2026', '2026-10-16'],
    ['2026-10-01', '2026-10-01'],
    ['Date:10/11/26', '2026-10-11'],
    ['1O/9/26', '2026-10-09'],
  ])('reads %s', (text, day) => {
    expect(parseReceiptDate(text, today)).toEqual({ day });
  });

  it('puts a date without a year in the past year when it would be in the future', () => {
    expect(parseReceiptDate('Dec 30', '2027-01-03')?.day).toBe('2026-12-30');
  });

  it('accepts day-first only when the first number cannot be a month, and says so', () => {
    expect(parseReceiptDate('16/10/26', today)).toEqual({ day: '2026-10-16', note: expect.stringContaining('day first') });
  });

  it('flags dates after today', () => {
    expect(parseReceiptDate('10/20/26', today)?.note).toMatch(/after today/);
  });

  it.each(['', 'Sold to', '13/13/26', '2/30/26'])('rejects %j', (text) => {
    expect(parseReceiptDate(text, today)).toBeNull();
  });
});

describe('parseReceiptNo', () => {
  it('takes the longest run of digits', () => {
    expect(parseReceiptNo('7128')).toEqual({ value: '7128', fixed: false });
    expect(parseReceiptNo('No.0627')?.value).toBe('0627');
    expect(parseReceiptNo('O627')).toEqual({ value: '0627', fixed: true });
  });

  it('ignores words', () => {
    expect(parseReceiptNo('Sold')).toBeNull();
  });
});

describe('item text', () => {
  it('writes sizes one way', () => {
    expect(normalizeItemText('Petron 11kg')).toBe('petron 11 kg');
    expect(normalizeItemText('Solane 11 KGS')).toBe('solane 11 kg');
    expect(normalizeItemText('Gasul 11k refill')).toBe('gasul 11 kg refill');
    expect(normalizeItemText('Gasul 2,7kg')).toBe('gasul 2.7 kg');
    expect(normalizeItemText('Fiesta 1ikg new')).toBe('fiesta 11 kg new');
    expect(normalizeItemText('Reg. w/ hose')).toBe('reg with hose');
    expect(normalizeItemText('Hose 1.5m')).toBe('hose 1.5m');
  });

  it('finds the size', () => {
    expect(itemSize('petron 11 kg')).toBe(11);
    expect(itemSize('gasul 2.7 kg')).toBe(2.7);
    expect(itemSize('hose clamp')).toBeNull();
  });

  it('tells refill from new', () => {
    expect(lineTypeHint(normalizeItemText('Fiesta Gas 11kg ref.'))).toBe('refill');
    expect(lineTypeHint(normalizeItemText('Solane 11kg (refill)'))).toBe('refill');
    expect(lineTypeHint(normalizeItemText('Solane 11kg w/ tank'))).toBe('new');
    expect(lineTypeHint(normalizeItemText('Petron Gasul 11 kg brand new'))).toBe('new');
    expect(lineTypeHint(normalizeItemText('Hose clamp'))).toBeNull();
  });

  it('knows numbers from words', () => {
    expect(looksNumeric('1,960.00')).toBe(true);
    expect(looksNumeric('₱980')).toBe(true);
    expect(looksNumeric('11kg')).toBe(false);
    expect(looksNumeric('pc')).toBe(false);
  });
});
