/**
 * How the reader copes with handwriting it gets slightly wrong: words run
 * together or broken apart, a date's "/" read as "1", a label read into the
 * name after it, and names a letter off from a customer on the list. Every
 * name here is made up.
 */
import { describe, expect, it } from 'vitest';

import type { Customer } from '../models';
import { layoutOf, secondLookOf } from './layout';
import { normalizeItemText, parseReceiptDate, parseReceiptTime, separateDateTime } from './normalize';
import { separateNameWords } from './pipeline';
import { wordsOf, type DecodedChar } from './recognize';
import { NAME_SUGGEST, nameSimilarity, nameSuggestions } from './sale';
import { ocrLine } from './test-helpers';
import type { OcrLine } from './types';

const TODAY = '2026-11-13';

/** Characters the recogniser decoded, each at the output step given. */
const chars = (spec: [string, number][]): DecodedChar[] => spec.map(([text, step]) => ({ text, step, prob: 0.9 }));

describe('words the recogniser ran together', () => {
  it('splits at a gap much wider than the gaps between letters', () => {
    // "Liza" and "Ramos" written apart, with no space decoded between them.
    const words = wordsOf(chars([['L', 0], ['i', 3], ['z', 6], ['a', 9], ['R', 20], ['a', 23], ['m', 26], ['o', 29], ['s', 32]]));
    expect(words.map((w) => w.map((c) => c.text).join(''))).toEqual(['Liza', 'Ramos']);
  });

  it('keeps evenly spaced letters together, and still splits at a decoded space', () => {
    expect(wordsOf(chars([['1', 0], ['1', 4], ['k', 8], ['g', 11]])).map((w) => w.length)).toEqual([4]);
    expect(wordsOf(chars([['N', 0], ['o', 2], [' ', 4], ['7', 6], ['1', 8]])).map((w) => w.map((c) => c.text).join(''))).toEqual(['No', '71']);
  });
});

describe('dates and times read with look-alikes', () => {
  it('separates a date and a time run together', () => {
    expect(separateDateTime('11/1/262:30pm')).toBe('11/1/26 2:30pm');
    expect(separateDateTime('10/21/20269:15')).toBe('10/21/2026 9:15');
    expect(parseReceiptDate('11/1/262:30pm', TODAY)?.day).toBe('2026-11-01');
    expect(parseReceiptTime('11/1/262:30pm')).toBe('14:30');
    expect(parseReceiptTime('2/27/269:15am')).toBe('09:15');
  });

  it('reads a "/" read as "1", "l" or "|", and asks for a check', () => {
    for (const [text, day] of [
      ['8125/26', '2026-08-25'],
      ['4124126', '2026-04-24'],
      ['818126', '2026-08-08'],
      ['8|17|26', '2026-08-17'],
      ['9l3l26', '2026-09-03'],
    ]) {
      const read = parseReceiptDate(text, TODAY);
      expect([text, read?.day]).toEqual([text, day]);
      expect(read?.note).toMatch(/Check the date/);
    }
  });

  it("guesses nothing when the digits don't make one clear date", () => {
    expect(parseReceiptDate('123456', TODAY)).toBeNull();
    expect(parseReceiptDate('11111', TODAY)).toBeNull();
  });
});

describe('names read from handwriting', () => {
  it('puts back the space between words written apart', () => {
    expect(separateNameWords('LizaRamos')).toBe('Liza Ramos');
    expect(separateNameWords('MarkTan')).toBe('Mark Tan');
  });

  it('joins a name the reader broke into pieces', () => {
    expect(separateNameWords('M aria Santos')).toBe('Maria Santos');
    expect(separateNameWords('Liza Ra m os')).toBe('Liza Ramos');
    expect(separateNameWords('Mila O ca m po')).toBe('Mila Ocampo');
  });

  it('leaves names as written when nothing shows they were broken', () => {
    expect(separateNameWords('Juan dela Cruz')).toBe('Juan dela Cruz');
    expect(separateNameWords('Rosa delos Santos')).toBe('Rosa delos Santos');
    expect(separateNameWords('Mila ts')).toBe('Mila ts');
    expect(separateNameWords('pedro reyes')).toBe('pedro reyes');
  });
});

describe('the label read into the name after it', () => {
  const table = (lines: OcrLine[]) => [...lines, ocrLine('QTY', 60, 240), ocrLine('ARTICLES', 380, 240), ocrLine('AMOUNT', 860, 240)];

  it('finds "Name" at the start of a word', () => {
    expect(layoutOf(table([ocrLine('Registered NameGrace Aquino', 40, 100)])).registeredName?.text).toBe('Grace Aquino');
    expect(layoutOf(table([ocrLine('RegisteredNameAna Lim', 40, 100)])).registeredName?.text).toBe('Ana Lim');
    expect(layoutOf(table([ocrLine('Registered Name:Pedro Reyes', 40, 100)])).registeredName?.text).toBe('Pedro Reyes');
  });

  it('still reads the handwriting again on its own, starting where the label ends', () => {
    const line = ocrLine('Registered Name:Pedro Reyes', 40, 100);
    // Where the recogniser put each character of "Name:Pedro": evenly across the word.
    const word = line.words[1];
    const lineWidth = line.rect.width;
    word.at = word.text.split('').map((_, i) => (word.rect.x - line.rect.x + (i + 0.5) * (word.rect.width / word.text.length)) / lineWidth);
    const look = secondLookOf(table([line]), { width: 1000, height: 1000 });
    expect(look.splits).toHaveLength(1);
    const [split] = look.splits;
    expect(split).toMatchObject({ line: 0, keep: 2, cut: 5 });
    // The cut-out starts after "Name:", not after the whole word "Name:Pedro".
    const colonEnd = word.rect.x + 5 * (word.rect.width / word.text.length);
    expect(split.quad[0].x).toBeGreaterThan(colonEnd - 1);
    expect(split.quad[0].x).toBeLessThan(word.rect.x + word.rect.width - 20);
  });
});

describe('names close to a customer on the list', () => {
  const customer = (id: string, name: string): Customer => ({ id, name, createdAt: '', receivedAt: null });
  const customers = [customer('c1', 'Joy Navarro'), customer('c2', 'Joel Navarro'), customer('c3', 'Ana Lima'), customer('c4', 'Lito Garcia (Garcia Eatery)')];

  it('treats letters handwriting is confused for as the same', () => {
    expect(nameSimilarity('loy Navarro', 'Joy Navarro')).toBe(1);
    expect(nameSimilarity('Lito Garcia', 'Lito Garcia (Garcia Eatery)')).toBe(1);
  });

  it('suggests the closest customers first, only as suggestions', () => {
    const [first, ...rest] = nameSuggestions('loy Navarro', customers);
    expect(first.customer.id).toBe('c1');
    expect(first.similarity).toBeGreaterThanOrEqual(NAME_SUGGEST.likely);
    expect(rest.map((s) => s.customer.id)).toContain('c2');
  });

  it("doesn't call a different person likely", () => {
    const [close] = nameSuggestions('Ana Lim', customers);
    expect(close.customer.id).toBe('c3');
    expect(close.similarity).toBeLessThan(NAME_SUGGEST.likely);
    expect(nameSuggestions('Ramon Bautista', customers)).toEqual([]);
  });
});

describe('item text the reader got slightly wrong', () => {
  it('separates a size run into the word before it, and reads a 7 read as "f" or "t"', () => {
    expect(normalizeItemText('Gasul2.7kg')).toBe('gasul 2.7 kg');
    expect(normalizeItemText('Gasul 2.Fkg')).toBe('gasul 2.7 kg');
    expect(normalizeItemText('Petron11kg')).toBe('petron 11 kg');
  });
});
