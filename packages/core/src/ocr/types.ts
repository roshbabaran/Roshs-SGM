/**
 * Shapes shared by the receipt reader. The models turn a photo into lines of
 * text with positions and confidence scores (stages 1–5); SGM's own logic turns
 * those lines into a draft sale the cashier confirms (stages 6–10).
 */
import type { ProductLineType } from '../models';
import type { Centavos } from '../money';

/** A photo as raw pixels, 4 bytes per pixel, row by row. */
export interface PixelImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
  /** Byte order of each pixel. JPEG decoders and canvases give RGBA (the default); Electron's nativeImage gives BGRA. */
  format?: 'rgba' | 'bgra';
}

export interface Point {
  x: number;
  y: number;
}

/** A box's corners in reading order: top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Point, Point, Point, Point];

/** An upright rectangle in photo pixels. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A piece of text the reader found, with where it is in the photo. */
export interface OcrText {
  text: string;
  /** Average probability of the characters read, from 0 to 1. */
  confidence: number;
  rect: Rect;
}

/** One line found by the detector and read by the recogniser. */
export interface OcrLine extends OcrText {
  /** The detected box, which may be slightly rotated. */
  quad: Quad;
  /** The line split at its spaces, each word with its own position. */
  words: OcrText[];
}

/** A float tensor in the layout ONNX Runtime uses. */
export interface Tensor {
  data: Float32Array;
  dims: number[];
}

/** The detector ('det') finds text lines; the recogniser ('rec') reads them. */
export type OcrModel = 'det' | 'rec';

/**
 * Runs the PaddleOCR models. Each app supplies its own: SGM Pocket uses
 * onnxruntime-react-native on the phone, SGM Desk uses onnxruntime-node in
 * Electron's main process.
 */
export interface OcrRuntime {
  run(model: OcrModel, input: Tensor): Promise<Tensor>;
}

/** ok: read clearly and consistent. check: corrected or unsure, so the cashier should look. missing: not found. */
export type FieldStatus = 'ok' | 'check' | 'missing';

/** One value on the receipt: what the app made of it, what it actually read, and whether to trust it. */
export interface DraftField<T> {
  value: T | null;
  /** The text as read from the photo ('' when nothing was found). */
  read: string;
  status: FieldStatus;
  /** Why the field needs a look, written for the cashier. */
  note?: string;
  /** Where the value is in the photo, for the review screen's crop. */
  rect?: Rect;
  /** How sure the reader was of the text, 0 to 1. */
  confidence?: number;
}

/** What a receipt line sells: a product sold one way, or a set. Like a cart line without the quantity. */
export type DraftTarget =
  | { kind: 'product'; productId: string; type: Exclude<ProductLineType, 'borrow'> }
  | { kind: 'set'; setId: string };

/** One item row of the receipt. */
export interface DraftLine {
  /** The item as written, e.g. "Petron 11kg refill". */
  item: DraftField<string>;
  /** What the line sells, or null when the cashier has to pick it. */
  target: DraftTarget | null;
  /** ok: a clear match. check: the likeliest match, but unsure. missing: nothing matched. */
  targetStatus: FieldStatus;
  targetNote?: string;
  /** Other likely products or sets, best first, for the picker. */
  candidates: DraftTarget[];
  qty: DraftField<number>;
  /** The handwritten unit price. The sale itself uses SGM's price list. */
  unitPrice: DraftField<Centavos>;
  /** The handwritten amount for the line. */
  amount: DraftField<Centavos>;
  /** SGM's price for the matched product or set, which the sale will charge; null until matched. */
  listPrice: Centavos | null;
  /** The whole row in the photo. */
  rect: Rect;
}

/** What the app read from a receipt photo, ready for the cashier to review. Nothing is saved from it directly. */
export interface ReceiptDraft {
  /** The receipt booklet's printed serial number. */
  receiptNo: DraftField<string>;
  /** Day written on the receipt, YYYY-MM-DD. */
  date: DraftField<string>;
  /** The written total. */
  total: DraftField<Centavos>;
  lines: DraftLine[];
  /** Messages about the receipt as a whole, e.g. totals that don't add up. */
  notes: string[];
  /** 'headers': rows and columns came from the printed column headings. 'lines': none were found, so each line was read on its own. */
  method: 'headers' | 'lines';
  /** Size of the photo the positions refer to. */
  image: { width: number; height: number };
  /** Every line the reader found, for the review screen and for learning from corrections. */
  ocrLines: OcrLine[];
  /** Milliseconds spent in each stage. */
  timings: Record<string, number>;
}
