/**
 * Stage 5: reading each line. Lines are cut out at the recogniser's height
 * (48 pixels), grouped into batches of similar width so the phone runs a few
 * big passes instead of many small ones, and the output is decoded with CTC:
 * take the likeliest character at each position, merge repeats, drop the
 * "blank" symbol, and look the rest up in the model's own dictionary.
 */
import type { TextBox } from './detect';
import type { RecConfig } from './model-config';
import { framePoint, frameSize, readingFrame, writeLineCrop } from './preprocess';
import type { OcrLine, OcrRuntime, OcrText, PixelImage, Point, Quad, Rect } from './types';

export interface ReadOptions {
  /** Lines per recogniser run. */
  batchSize: number;
  /** Widest line input, in pixels at the recogniser's height (PaddleOCR allows 3200). */
  maxWidth: number;
  /**
   * Which characters the reader may return. PP-OCRv6 knows about 18,700
   * characters, most of them Chinese; on SGM's receipts a handwritten "1" can
   * come back as "一". 'latin' limits the choice to letters, digits and the
   * usual punctuation, so the reader picks the likeliest of those instead.
   */
  charset: 'latin' | 'all';
}

export const DEFAULT_READ_OPTIONS: ReadOptions = { batchSize: 8, maxWidth: 3200, charset: 'latin' };

/** Letters, digits and punctuation written on Philippine receipts. */
const LATIN = /^[\x20-\x7E₱ñÑ°º·×‘’“”–—À-ÿ]$/;

const latinClasses = new WeakMap<string[], Int32Array>();

/** Output classes the decoder may pick: the CTC blank (0) and every allowed character. */
export function allowedClasses(characters: string[], charset: ReadOptions['charset']): Int32Array | null {
  if (charset === 'all') return null;
  let allowed = latinClasses.get(characters);
  if (!allowed) {
    const list: number[] = [0];
    characters.forEach((ch, index) => {
      if (index > 0 && LATIN.test(ch)) list.push(index);
    });
    allowed = Int32Array.from(list);
    latinClasses.set(characters, allowed);
  }
  return allowed;
}

export interface DecodedChar {
  text: string;
  /** Output position (time step) where the character was read. */
  step: number;
  prob: number;
}

export interface DecodedLine {
  text: string;
  confidence: number;
  chars: DecodedChar[];
}

/**
 * Greedy CTC decoding of one line: probs holds `steps` rows of `classes`
 * probabilities. With `allowed`, only those classes are considered.
 */
export function decodeCtc(
  probs: Float32Array,
  offset: number,
  steps: number,
  classes: number,
  characters: string[],
  allowed: Int32Array | null = null,
): DecodedLine {
  const chars: DecodedChar[] = [];
  let previous = -1;
  for (let step = 0; step < steps; step += 1) {
    const row = offset + step * classes;
    let best = 0;
    let bestProb = probs[row];
    if (allowed) {
      for (let k = 1; k < allowed.length; k += 1) {
        const c = allowed[k];
        if (c < classes && probs[row + c] > bestProb) {
          bestProb = probs[row + c];
          best = c;
        }
      }
    } else {
      for (let c = 1; c < classes; c += 1) {
        if (probs[row + c] > bestProb) {
          bestProb = probs[row + c];
          best = c;
        }
      }
    }
    if (best !== 0 && best !== previous && best < characters.length) {
      chars.push({ text: characters[best], step, prob: bestProb });
    }
    previous = best;
  }
  const text = chars.map((c) => c.text).join('');
  const confidence = chars.length ? chars.reduce((sum, c) => sum + c.prob, 0) / chars.length : 0;
  return { text, confidence, chars };
}

interface PendingLine {
  frame: Quad;
  /** Width the line is sampled at for the recogniser. */
  width: number;
  ratio: number;
  index: number;
}

/** Cuts out and reads every box. Lines come back in the boxes' order, each with its words' positions; boxes with nothing in them are left out. */
export async function readLines(
  image: PixelImage,
  boxes: TextBox[],
  runtime: OcrRuntime,
  config: RecConfig,
  options: ReadOptions = DEFAULT_READ_OPTIONS,
): Promise<OcrLine[]> {
  return (await readBoxes(image, boxes, runtime, config, options)).filter((line): line is OcrLine => line !== null);
}

/** Like readLines, but one result per box, in the boxes' order: null where nothing was read. */
export async function readBoxes(
  image: PixelImage,
  boxes: TextBox[],
  runtime: OcrRuntime,
  config: RecConfig,
  options: ReadOptions = DEFAULT_READ_OPTIONS,
): Promise<(OcrLine | null)[]> {
  const height = config.height;
  const allowed = allowedClasses(config.characters, options.charset);
  const pending: PendingLine[] = boxes.map((box, index) => {
    const frame = readingFrame(box.quad);
    const size = frameSize(frame);
    const ratio = size.width / Math.max(1, size.height);
    return { frame, ratio, width: Math.min(options.maxWidth, Math.max(1, Math.ceil(height * ratio))), index };
  });
  const results: (OcrLine | null)[] = new Array(boxes.length).fill(null);

  for (const batch of batchesByWidth(pending, options.batchSize, config.minWidth)) {
    const maxRatio = Math.max(config.minWidth / height, ...batch.map((line) => line.ratio));
    const batchWidth = Math.min(options.maxWidth, Math.max(config.minWidth, Math.trunc(height * maxRatio)));
    const data = new Float32Array(batch.length * 3 * height * batchWidth);
    batch.forEach((line, i) => {
      line.width = Math.min(line.width, batchWidth);
      writeLineCrop(image, line.frame, line.width, height, data, i, batchWidth);
    });
    const output = await runtime.run('rec', { data, dims: [batch.length, 3, height, batchWidth] });
    const [count, steps, classes] = output.dims;
    if (count !== batch.length || output.dims.length !== 3) {
      throw new Error(`The recognition model returned an unexpected shape [${output.dims.join(', ')}].`);
    }
    batch.forEach((line, i) => {
      const decoded = decodeCtc(output.data, i * steps * classes, steps, classes, config.characters, allowed);
      results[line.index] = toOcrLine(decoded, line.frame, line.width, batchWidth / steps);
    });
  }
  return results.map((line) => (line && line.text.trim() !== '' ? line : null));
}

/**
 * Groups lines of similar width. Every line in a batch is padded to the widest
 * one, so one long line (a printed footer, say) shouldn't drag short ones along.
 */
function batchesByWidth(lines: PendingLine[], size: number, minWidth: number): PendingLine[][] {
  const batches: PendingLine[][] = [];
  let batch: PendingLine[] = [];
  for (const line of lines.slice().sort((a, b) => a.width - b.width)) {
    const narrowest = Math.max(minWidth, batch[0]?.width ?? 0);
    if (batch.length === size || (batch.length > 0 && line.width > narrowest * 1.5)) {
      batches.push(batch);
      batch = [];
    }
    batch.push(line);
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/**
 * Where the recogniser left out a space: a gap between two characters at
 * least this many times the usual gap between characters of the line. The
 * recogniser often runs handwritten words together ("LizaRamos") and printed
 * column headings that the detector put in one box ("SERVICEQUANTITY").
 */
export const WORD_GAP = { ratio: 2.4, minSteps: 3 };

/** Splits the characters into words at spaces, and at gaps much wider than the line's usual gap between characters. */
export function wordsOf(chars: DecodedChar[]): DecodedChar[][] {
  const gaps: number[] = [];
  for (let i = 1; i < chars.length; i += 1) {
    if (chars[i].text.trim() !== '' && chars[i - 1].text.trim() !== '') gaps.push(chars[i].step - chars[i - 1].step);
  }
  const sorted = gaps.slice().sort((a, b) => a - b);
  const usual = sorted.length >= 3 ? sorted[Math.floor(sorted.length / 2)] : Infinity;
  const words: DecodedChar[][] = [];
  let current: DecodedChar[] = [];
  chars.forEach((char, i) => {
    if (char.text.trim() === '') {
      if (current.length > 0) words.push(current);
      current = [];
      return;
    }
    const previous = chars[i - 1];
    const gap = previous && previous.text.trim() !== '' ? char.step - previous.step : 0;
    if (current.length > 0 && gap >= WORD_GAP.minSteps && gap >= WORD_GAP.ratio * usual) {
      words.push(current);
      current = [];
    }
    current.push(char);
  });
  if (current.length > 0) words.push(current);
  return words;
}

/**
 * Places the decoded characters back on the photo. Each output step covers a
 * fixed slice of the recogniser's input (`pixelsPerStep`), so a word's first and
 * last characters tell where along the line it sits.
 */
function toOcrLine(decoded: DecodedLine, frame: Quad, width: number, pixelsPerStep: number): OcrLine {
  const at = (step: number) => ((step + 0.5) * pixelsPerStep) / width;
  const words: OcrText[] = wordsOf(decoded.chars).map((chars) => {
    // A character's peak sits inside it, so pad a step either side to cover the whole word.
    const from = Math.max(0, ((chars[0].step - 0.5) * pixelsPerStep) / width);
    const to = Math.min(1, ((chars[chars.length - 1].step + 1.5) * pixelsPerStep) / width);
    return {
      text: chars.map((c) => c.text).join(''),
      confidence: chars.reduce((sum, c) => sum + c.prob, 0) / chars.length,
      rect: boundsOf([framePoint(frame, from, 0), framePoint(frame, to, 0), framePoint(frame, to, 1), framePoint(frame, from, 1)]),
      at: chars.map((c) => Math.min(1, at(c.step))),
    };
  });
  return {
    text: words.map((w) => w.text).join(' '),
    confidence: decoded.confidence,
    quad: frame,
    rect: boundsOf(frame),
    words,
  };
}

export function boundsOf(points: Point[]): Rect {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
