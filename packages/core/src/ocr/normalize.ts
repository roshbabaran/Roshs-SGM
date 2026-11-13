/**
 * Stage 7: turning what was read into clean values. Handwritten numbers come
 * back with look-alike letters (O for 0, l for 1, S for 5), peso signs and
 * separators; dates come in whatever form the cashier wrote; sizes come as
 * "11kg", "11 kg" or "11k". These are plain functions on strings.
 */
import { localDay } from '../dates';
import type { Centavos } from '../money';

/** Letters the reader gives for handwritten digits. Only applied where a number is expected. */
const LOOKALIKES: Record<string, string> = {
  O: '0',
  o: '0',
  D: '0',
  Q: '0',
  l: '1',
  I: '1',
  i: '1',
  '|': '1',
  '!': '1',
  L: '1',
  ']': '1',
  Z: '2',
  z: '2',
  S: '5',
  s: '5',
  G: '6',
  b: '6',
  T: '7',
  B: '8',
  g: '9',
  q: '9',
};

/** A peso sign in front of an amount: ₱, P, PHP, or the look-alikes the reader returns for a handwritten ₱. */
const CURRENCY_PREFIX = /^(?:₱|php\.?|p\.?|f|\$)\s*/i;
/** Endings cashiers add after an amount: "980.-", "980=", "980/-", "980.". */
const AMOUNT_SUFFIX = /(?:\.?\s*[-=~_]+|\/[-=]|\.)$/;

export interface FixedValue<T> {
  value: T;
  /** True when look-alike letters were turned into digits, so the cashier should check it. */
  fixed: boolean;
}

/** Turns look-alike letters into digits. */
function fixDigits(text: string): FixedValue<string> {
  let fixed = false;
  let out = '';
  for (const ch of text) {
    const digit = LOOKALIKES[ch];
    if (digit !== undefined) {
      out += digit;
      fixed = true;
    } else {
      out += ch;
    }
  }
  return { value: out, fixed };
}

/** The text without a peso sign in front or a dash or equals sign after. */
function stripMoneyMarks(text: string): string {
  let t = text.trim().replace(/\s+/g, '');
  // Only treat a leading letter as a peso sign when a number follows it.
  const prefix = CURRENCY_PREFIX.exec(t);
  if (prefix && /^[\d.,OoIlSsB]/.test(t.slice(prefix[0].length))) t = t.slice(prefix[0].length);
  while (AMOUNT_SUFFIX.test(t) && t.length > 1) t = t.replace(AMOUNT_SUFFIX, '');
  return t;
}

/**
 * Whether a word reads as a number (an amount, a price or a quantity), allowing
 * for a peso sign, separators and a few look-alike letters, but not for words
 * such as "11kg" or "pc".
 */
export function looksNumeric(text: string): boolean {
  const t = stripMoneyMarks(text);
  if (!t) return false;
  let digits = 0;
  let lookalikes = 0;
  let separators = 0;
  for (const ch of t) {
    if (ch >= '0' && ch <= '9') digits += 1;
    else if (ch === ',' || ch === '.') separators += 1;
    else if (LOOKALIKES[ch] !== undefined) lookalikes += 1;
    else return false;
  }
  return digits > 0 && digits >= lookalikes && separators < t.length;
}

/**
 * Reads a handwritten amount in pesos: "1,960.00", "₱980", "980.-", "1.960",
 * "1,9O0". Returns centavos, or null when it isn't a usable amount.
 */
export function parseAmount(text: string): FixedValue<Centavos> | null {
  const stripped = stripMoneyMarks(text);
  if (!stripped || !looksNumeric(stripped)) return null;
  const { value: t, fixed } = fixDigits(stripped);
  if (!/^[\d.,]+$/.test(t) || !/\d/.test(t)) return null;

  let whole = t;
  let cents = '';
  const last = Math.max(t.lastIndexOf('.'), t.lastIndexOf(','));
  if (last >= 0) {
    const after = t.slice(last + 1);
    if (after.length === 1 || after.length === 2) {
      // The last separator is the decimal point; any before it group thousands.
      whole = t.slice(0, last);
      cents = after.padEnd(2, '0');
    } else if (after.length !== 3) {
      return null;
    }
  }
  whole = whole.replace(/[.,]/g, '');
  if (!/^\d*$/.test(whole) || whole.length > 8) return null;
  const value = parseInt(whole || '0', 10) * 100 + (cents ? parseInt(cents, 10) : 0);
  return value > 0 ? { value, fixed } : null;
}

/** The receipt booklet's serial number: the longest run of digits, look-alike letters included. */
export function parseReceiptNo(text: string): FixedValue<string> | null {
  const runs = text.match(/[0-9OoDQlI|SsB]{3,}/g);
  if (!runs) return null;
  // At least half real digits, so words such as "Sold" don't turn into numbers.
  const best = runs
    .filter((run) => (run.match(/\d/g)?.length ?? 0) * 2 >= run.length)
    .map((run) => fixDigits(run))
    .filter((run) => /^\d+$/.test(run.value));
  best.sort((a, b) => b.value.length - a.value.length);
  return best[0] && best[0].value.length <= 12 ? best[0] : null;
}

/** Words written next to a quantity: "2pcs", "x2", "3 tanks". */
const QTY_MARKS = /^(?:x\s*)?(.*?)\s*(?:x|pcs?|pieces?|cyls?|tanks?|units?|sets?|ea)?\.?$/i;

/** A "1" written as a single stroke often reads as a dash. */
const ONE_STROKE = /^[-–—_一]$/;

/** Reads a handwritten quantity: a whole number from 1 to 999. */
export function parseQty(text: string): FixedValue<number> | null {
  if (ONE_STROKE.test(text.trim())) return { value: 1, fixed: true };
  const marks = QTY_MARKS.exec(text.trim().replace(/\s+/g, ' '));
  const core = (marks ? marks[1] : text).trim();
  if (!core || core.length > 3) return null;
  const { value, fixed } = fixDigits(core);
  if (!/^\d{1,3}$/.test(value)) return null;
  const qty = parseInt(value, 10);
  return qty >= 1 ? { value: qty, fixed } : null;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const MONTH_NAME = '(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*[.,]?';

export interface ReadDate {
  /** YYYY-MM-DD */
  day: string;
  /** Set when the date needs a look, written for the cashier. */
  note?: string;
}

const pad = (n: number) => n.toString().padStart(2, '0');

function isRealDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(year, month - 1, day);
  return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day;
}

/**
 * Reads the date written on a receipt: "10/16/26", "10-16-2026", "Oct 16",
 * "Oct. 16, 2026", "16 Oct 2026". Philippine receipts put the month first; a
 * day-first date is accepted only when the first number can't be a month.
 * A date without a year is taken to be the latest such day up to today.
 * `today` is YYYY-MM-DD in the device's time zone.
 */
export function parseReceiptDate(text: string, today: string = localDay(new Date())): ReadDate | null {
  const read = readDate(separateDateTime(text), today);
  if (read) return read;
  const guessed = slashesFromLookalikes(separateDateTime(text), today);
  return guessed ? { day: guessed.day, note: 'A "/" may have been read as a "1" or "|". Check the date.' } : null;
}

/** Characters a quickly written "/" is read as, the more likely first. */
const SLASH_LOOKALIKES: Record<string, number> = { '|': 3, l: 2, I: 2, '1': 1 };

/**
 * A date whose "/" were read as "1", "l" or "|" ("4124126" for 4/24/26,
 * "8|17|26" for 8/17/26): each way of turning one or two of them into "/"
 * that gives month/day/year with a two- or four-digit year, on a real day not
 * after today. When more than one way works, the one using the likelier
 * look-alikes wins; a tie gives nothing.
 */
function slashesFromLookalikes(text: string, today: string): ReadDate | null {
  const word = /[\dlI|/]{5,10}/.exec(text.replace(/\s+/g, ''));
  if (!word) return null;
  const t = word[0];
  const spots: number[] = [];
  for (let i = 1; i < t.length - 2; i += 1) if (SLASH_LOOKALIKES[t[i]] !== undefined) spots.push(i);
  const found = new Map<string, number>();
  const tryWith = (chosen: number[]) => {
    const chars = t.split('');
    for (const i of chosen) chars[i] = '/';
    const candidate = chars.join('');
    if (!/^\d{1,2}\/\d{1,2}\/(?:\d{2}|\d{4})$/.test(candidate)) return;
    const read = readDate(candidate, today);
    if (!read || read.note) return;
    const weight = chosen.reduce((sum, i) => sum + SLASH_LOOKALIKES[t[i]], 0);
    found.set(read.day, Math.max(found.get(read.day) ?? 0, weight));
  };
  const slashes = (t.match(/\//g) ?? []).length;
  for (let a = 0; a < spots.length; a += 1) {
    if (slashes === 1) tryWith([spots[a]]);
    if (slashes === 0) for (let b = a + 1; b < spots.length; b += 1) tryWith([spots[a], spots[b]]);
  }
  const ranked = [...found.entries()].sort((x, y) => y[1] - x[1]);
  if (ranked.length === 0 || (ranked.length > 1 && ranked[0][1] === ranked[1][1])) return null;
  return { day: ranked[0][0] };
}

/**
 * A date and a time the reader ran together: "11/1/262:30pm" is 11/1/26
 * 2:30pm, and "10/21/20269:15" is 10/21/2026 9:15. The year takes two digits,
 * or four when there are enough left for the hour.
 */
export function separateDateTime(text: string): string {
  return text.replace(/(\d{1,2}\s*[/\-.]\s*\d{1,2}\s*[/\-.]\s*)(\d{3,6})(?=\s*[:.]\s*\d{2})/, (_, head: string, run: string) => {
    const year = run.length >= 5 ? 4 : 2;
    return `${head}${run.slice(0, year)} ${run.slice(year)}`;
  });
}

function readDate(text: string, today: string): ReadDate | null {
  const t = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const [ty, tm, td] = today.split('-').map((n) => parseInt(n, 10));
  let year: number | null = null;
  let month: number;
  let day: number;
  let swapped = false;

  const numeric = /(\d{1,2})\s*[/\-.]\s*(\d{1,2})(?:\s*[/\-.]\s*(\d{2,4}))?/.exec(fixDigits(t.replace(/[a-z]{3,}/g, ' ')).value);
  const iso = /(\d{4})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{1,2})/.exec(t);
  const monthFirst = new RegExp(`\\b${MONTH_NAME}\\s*(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?,?\\s*(\\d{2,4})?`).exec(t);
  const dayFirst = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*${MONTH_NAME},?\\s*(\\d{2,4})?`).exec(t);

  if (iso) {
    year = parseInt(iso[1], 10);
    month = parseInt(iso[2], 10);
    day = parseInt(iso[3], 10);
  } else if (monthFirst) {
    month = MONTHS[monthFirst[1]];
    day = parseInt(monthFirst[2], 10);
    if (monthFirst[3]) year = parseInt(monthFirst[3], 10);
  } else if (dayFirst) {
    day = parseInt(dayFirst[1], 10);
    month = MONTHS[dayFirst[2]];
    if (dayFirst[3]) year = parseInt(dayFirst[3], 10);
  } else if (numeric) {
    month = parseInt(numeric[1], 10);
    day = parseInt(numeric[2], 10);
    if (numeric[3]) year = parseInt(numeric[3], 10);
    if (month > 12 && day <= 12) {
      [month, day] = [day, month];
      swapped = true;
    }
  } else {
    return null;
  }

  if (year !== null && year < 100) year += 2000;
  if (year === null) {
    // No year: this year, unless that day hasn't come yet.
    year = month > tm || (month === tm && day > td) ? ty - 1 : ty;
  }
  if (!isRealDay(year, month, day)) return null;

  const result: ReadDate = { day: `${year}-${pad(month)}-${pad(day)}` };
  if (result.day > today) result.note = "This date is after today. Check what's written.";
  else if (swapped) result.note = 'Read as day first, then month. Check the date.';
  return result;
}

/** "2:30 pm", "2:30PM", "2.30 p.m.", "2pm", "14:30". The number before it mustn't be part of a date ("10/16" or "10.16"). */
const TIMES = [
  /(^|[^\d/.\-:])(\d{1,2})\s*:\s*(\d{2})(?!\d)(?:\s*([ap])\.?\s*m\b\.?)?/,
  /(^|[^\d/.\-:])(\d{1,2})\s*\.\s*(\d{2})\s*([ap])\.?\s*m\b\.?/,
  /(^|[^\d/.\-:])(\d{1,2})()\s*([ap])\.?\s*m\b\.?/,
];

/**
 * Reads a time written on a receipt or typed by the cashier, such as "2:30 pm"
 * or "14:30", as 24-hour "HH:MM". Null when there is no time in the text, or
 * it isn't a real time ("13:00 pm", "9:75").
 */
export function parseReceiptTime(text: string): string | null {
  const t = separateDateTime(text).toLowerCase();
  for (const pattern of TIMES) {
    const match = pattern.exec(t);
    if (!match) continue;
    let hours = parseInt(match[2], 10);
    const minutes = match[3] ? parseInt(match[3], 10) : 0;
    const half = match[4];
    if (minutes > 59) return null;
    if (half) {
      if (hours < 1 || hours > 12) return null;
      hours = (hours % 12) + (half === 'p' ? 12 : 0);
    } else if (hours > 23) {
      return null;
    }
    return `${pad(hours)}:${pad(minutes)}`;
  }
  return null;
}

// --- Item text ---------------------------------------------------------------

/**
 * "11kg", "11 kg", "11k", "11 kgs", "11kilos", "2,7kg", and the ways the
 * reader gets a handwritten size wrong: "llkg", "IIKG", "1lkg", "11KC",
 * "11K6", "11KS" → "11 kg" / "2.7 kg". The digits may be read as I or l, and
 * the g as C, 6 or S.
 */
const SIZE = /(^|[^a-z0-9.])([0-9oil]{1,3}(?:[.,][0-9oilft]{1,2})?)\s*-?\s*(?:kilos?|kgs?|k[gc6s]?)(?![a-z])/g;

/**
 * Item text made comparable: lower case, "w/" spelled out, sizes written one
 * way ("11 kg"), punctuation dropped.
 */
export function normalizeItemText(text: string): string {
  return text
    .toLowerCase()
    .replace(/w\s*\//g, 'with ')
    // A word run into its size ("gasul2.7kg"): the size starts a new word.
    .replace(/([a-z]{2,})(?=\d)/g, '$1 ')
    .replace(SIZE, (whole: string, before: string, size: string) => {
      // A 7 after the point is often read as "f" or "t" ("2.fkg").
      const digits = fixDigits(size.replace(/([.,])[ft]/, '$17')).value.replace(',', '.');
      // "ok" or "ik" aren't sizes: at least one real digit, or a size above zero.
      return /\d/.test(size) || parseFloat(digits) > 0 ? `${before}${digits} kg` : whole;
    })
    .replace(/(\d)\.(?=\d)/g, '$1\u0000')
    .replace(/[^a-z0-9\u0000]+/g, ' ')
    .replace(/\u0000/g, '.')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The cylinder size in kilograms written in normalized item text, if any. */
export function itemSize(normalized: string): number | null {
  const match = /(?:^|\s)(\d{1,3}(?:\.\d{1,2})?) kg(?:\s|$)/.exec(normalized);
  return match ? parseFloat(match[1]) : null;
}

/** Words cashiers write to mark a refill (empty cylinder swapped for a full one). */
const REFILL_WORDS = ['refill', 'refil', 'refll', 'ref', 'rf', 'rfl', 'palit', 'swap', 'exchange'];
/** Words and phrases that mark a new cylinder (cylinder and content). */
const NEW_WORDS = ['new', 'bago', 'brandnew'];
const NEW_PHRASES = ['with tank', 'with cyl', 'with cylinder', 'w tank', 'plus tank', 'and tank'];

/** Whether the item text says refill or new cylinder, or neither. */
export function lineTypeHint(normalized: string): 'refill' | 'new' | null {
  const words = normalized.split(' ');
  if (NEW_PHRASES.some((phrase) => normalized.includes(phrase)) || words.some((w) => NEW_WORDS.includes(w))) return 'new';
  if (words.some((w) => REFILL_WORDS.includes(w))) return 'refill';
  return null;
}

/** Words that say how a quantity is counted ("pc", "tank"); they go in the UNIT column. */
const UNIT_WORDS = new Set([
  'pc',
  'pcs',
  'piece',
  'pieces',
  'cyl',
  'cyls',
  'cylinder',
  'cylinders',
  'tank',
  'tanks',
  'set',
  'sets',
  'unit',
  'units',
  'ea',
  'each',
  'box',
  'roll',
  'pack',
  'btl',
  'bottle',
]);

export function isUnitWord(text: string): boolean {
  return UNIT_WORDS.has(text.toLowerCase().replace(/[^a-z]/g, ''));
}

/** Words that only describe the line, not the product, so they don't count when matching. */
export const DESCRIPTIVE_WORDS = new Set([...REFILL_WORDS, ...NEW_WORDS, ...UNIT_WORDS, 'with', 'w', 'kg', 'lpg', 'gas', 'and', 'plus', 'the']);
