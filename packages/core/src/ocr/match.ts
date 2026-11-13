/**
 * Stage 8: which product each line is. Every product and set is scored against
 * the item text: the cylinder size has to agree, brand and name words count by
 * how closely they are spelled ("Petrn" is still Petron), and corrections the
 * cashier made on earlier receipts are checked first. The written price is the
 * strongest clue: a unit price equal to a product's refill price or its
 * new-cylinder price settles both which product it is and how it was sold.
 */
import { unitPrice } from '../cart';
import type { Product, ProductSet } from '../models';
import type { Centavos } from '../money';
import { editDistance } from './layout';
import { DESCRIPTIVE_WORDS, itemSize, lineTypeHint, normalizeItemText } from './normalize';
import type { DraftTarget, FieldStatus } from './types';

export interface Catalogue {
  products: Product[];
  sets: ProductSet[];
  /** What the cashier corrected item texts to on earlier receipts, by normalized item text. */
  aliases?: Record<string, DraftTarget>;
}

export interface ItemMatch {
  target: DraftTarget | null;
  status: FieldStatus;
  note?: string;
  /** Other likely products or sets, best first. */
  candidates: DraftTarget[];
}

/** Clues read from the receipt line besides the item text. */
export interface LineClues {
  /** What one of the item cost as written: the unit price, and the amount divided by the quantity. */
  prices: Centavos[];
  /** Text of the UNIT column, which sometimes holds the size ("11kg"). */
  unit?: string;
}

/** A clear winner needs this score and this lead over the next product. */
const SURE = { score: 0.9, lead: 0.2 };
/** Below this, the line is left for the cashier to pick. */
const LIKELY = 0.5;
/** Two words count as the same when at least this similar. */
const SAME_WORD = 0.6;

/** The words that name a product: no sizes, no "refill", "pc", "lpg" and the like. */
function nameWords(normalized: string): string[] {
  const words = new Set<string>();
  for (const word of normalized.split(' ')) {
    if (!word || DESCRIPTIVE_WORDS.has(word) || /^\d+(?:\.\d+)?$/.test(word)) continue;
    words.add(word);
  }
  return Array.from(words);
}

/** How alike two words are, 0 to 1. A word cut short ("reg" for "regulator") counts as close. */
export function wordSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const longest = Math.max(a.length, b.length);
  let similarity = 1 - editDistance(a, b) / longest;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length >= 3 && long.startsWith(short)) similarity = Math.max(similarity, 0.75 + (0.25 * short.length) / long.length);
  return similarity;
}

/** How much of `from` is found in `to`, weighted by word length. */
function coverage(from: string[], to: string[]): number {
  let found = 0;
  let total = 0;
  for (const word of from) {
    const best = Math.max(0, ...to.map((other) => wordSimilarity(word, other)));
    found += (best >= SAME_WORD ? best : 0) * word.length;
    total += word.length;
  }
  return total > 0 ? found / total : 0;
}

/** How well the written words name this product or set, 0 to 1. */
function textScore(written: string[], name: string[]): number {
  if (written.length === 0 || name.length === 0) return 0;
  return (coverage(name, written) + coverage(written, name)) / 2;
}

/** Size agreement: a match helps, a different size all but rules the product out. */
function sizeScore(writtenSize: number | null, productSize: number | null): number {
  if (writtenSize === null) return 0;
  if (productSize === null) return -0.5;
  return Math.abs(writtenSize - productSize) < 0.05 ? 0.5 : -0.8;
}

const PRICE_MATCH = 0.6;

interface Scored {
  target: DraftTarget;
  /** How well the written words and size fit, without the price. */
  text: number;
  /** The written price is this product's price, sold this way. */
  priced: boolean;
  score: number;
  /** Set when the price says refill but the words say new, or the other way round. */
  conflict?: string;
}

function sameTarget(a: DraftTarget | null, b: DraftTarget | null): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  return a.kind === 'product' ? b.kind === 'product' && a.productId === b.productId : b.kind === 'set' && a.setId === b.setId;
}

function scored(target: DraftTarget, text: number, priced: boolean, conflict?: string): Scored {
  return { target, text, priced, score: text + (priced ? PRICE_MATCH : 0), ...(conflict ? { conflict } : {}) };
}

function scoreProduct(product: Product, written: string[], size: number | null, hint: 'refill' | 'new' | null, clues: LineClues): Scored {
  const name = nameWords(normalizeItemText(`${product.brand ?? ''} ${product.name}`));
  const text = textScore(written, name) + sizeScore(size, product.sizeKg ?? null);
  if (product.kind === 'accessory') {
    return scored({ kind: 'product', productId: product.id, type: 'item' }, text, clues.prices.includes(product.price));
  }
  let type: 'refill' | 'new' = hint ?? 'refill';
  let conflict: string | undefined;
  let priced = false;
  if (clues.prices.length > 0) {
    const refill = unitPrice(product, 'refill');
    const fresh = unitPrice(product, 'new');
    const by = clues.prices.includes(refill) ? 'refill' : clues.prices.includes(fresh) ? 'new' : null;
    if (by) {
      priced = true;
      if (hint && hint !== by) conflict = `Written as ${hint === 'new' ? 'a new cylinder' : 'a refill'}, but priced as ${by === 'new' ? 'a new cylinder' : 'a refill'}.`;
      type = by;
    }
  }
  return scored({ kind: 'product', productId: product.id, type }, text, priced, conflict);
}

function scoreSet(set: ProductSet, written: string[], size: number | null, clues: LineClues): Scored {
  const normalized = normalizeItemText(set.name);
  let text = textScore(written, nameWords(normalized));
  const setSize = itemSize(normalized);
  if (size !== null && setSize !== null) text += sizeScore(size, setSize);
  return scored({ kind: 'set', setId: set.id }, text, clues.prices.includes(set.price));
}

/** Two scores this close count as a tie. */
const TIE = 0.05;

/**
 * Finds the product or set an item line is, with how sure the match is. When
 * the words fit several products equally (just "11kg", with several brands of
 * 11 kg) or fit none, the written price decides: the one product whose refill
 * or new price it is, which also says how it was sold. That match is marked
 * for checking. When the price fits more than one too, or none, the line is
 * left for the cashier, with the likeliest products first.
 */
export function matchItem(itemText: string, catalogue: Catalogue, clues: LineClues): ItemMatch {
  const normalized = normalizeItemText(itemText);
  const alias = catalogue.aliases?.[normalized];
  if (alias && targetExists(alias, catalogue)) return { target: alias, status: 'ok', candidates: [] };

  const unitText = clues.unit ? normalizeItemText(clues.unit) : '';
  const size = itemSize(normalized) ?? (unitText ? itemSize(unitText) : null);
  const written = nameWords(normalized);
  const hint = lineTypeHint(normalized);
  const products = catalogue.products.filter((p) => p.active);
  const byId = new Set(catalogue.products.map((p) => p.id));
  const sets = catalogue.sets.filter((s) => s.active && s.items.every((item) => byId.has(item.productId)));

  const all = [...products.map((p) => scoreProduct(p, written, size, hint, clues)), ...sets.map((s) => scoreSet(s, written, size, clues))].sort(
    (a, b) => b.score - a.score,
  );
  const candidatesOf = (first: Scored[]): DraftTarget[] => {
    const rest = all.filter((s) => s.score > 0.2 && !first.includes(s));
    return [...first, ...rest].slice(0, 6).map((s) => s.target);
  };

  // The words alone: do they single out one product?
  const topText = Math.max(-Infinity, ...all.map((s) => s.text));
  const tied = all.filter((s) => topText - s.text < TIE);
  if (clues.prices.length > 0 && (topText < LIKELY || tied.length > 1)) {
    const pool = topText < LIKELY ? all : tied;
    const priced = pool.filter((s) => s.priced);
    if (priced.length === 1) {
      const [best] = priced;
      return {
        target: best.target,
        status: 'check',
        note: best.conflict ?? 'Picked by the written price. Check that this is the right product.',
        candidates: candidatesOf([]).filter((c) => !sameTarget(c, best.target)),
      };
    }
    if (priced.length > 1) {
      return { target: null, status: 'missing', note: 'More than one product has this price. Pick the right one.', candidates: candidatesOf(priced) };
    }
  }

  const [best, second] = all;
  const candidates = candidatesOf([]);
  if (!best || best.score < LIKELY) {
    return { target: null, status: 'missing', note: 'Pick the product for this line.', candidates };
  }
  const lead = best.score - (second?.score ?? 0);
  if (lead < TIE) {
    return { target: null, status: 'missing', note: 'More than one product fits. Pick the right one.', candidates };
  }
  const others = candidates.filter((c) => !sameTarget(c, best.target));
  if (best.score >= SURE.score && lead >= SURE.lead && !best.conflict) {
    return { target: best.target, status: 'ok', candidates: others };
  }
  return { target: best.target, status: 'check', note: best.conflict ?? 'Check that this is the right product.', candidates: others };
}

export function targetExists(target: DraftTarget, catalogue: Catalogue): boolean {
  if (target.kind === 'set') return catalogue.sets.some((s) => s.id === target.setId && s.active);
  return catalogue.products.some((p) => p.id === target.productId && p.active);
}

/** SGM's price for one of what the line sells: what the sale will charge. */
export function listPriceOf(target: DraftTarget, catalogue: Catalogue): Centavos | null {
  if (target.kind === 'set') return catalogue.sets.find((s) => s.id === target.setId)?.price ?? null;
  const product = catalogue.products.find((p) => p.id === target.productId);
  return product ? unitPrice(product, target.type) : null;
}

/** A short name for a match, e.g. "Petron Gasul 11 kg (refill)". */
export function targetLabel(target: DraftTarget, catalogue: Catalogue): string {
  if (target.kind === 'set') return catalogue.sets.find((s) => s.id === target.setId)?.name ?? 'Unknown set';
  const product = catalogue.products.find((p) => p.id === target.productId);
  if (!product) return 'Unknown product';
  return product.kind === 'cylinder' ? `${product.name} (${target.type === 'new' ? 'new' : 'refill'})` : product.name;
}
