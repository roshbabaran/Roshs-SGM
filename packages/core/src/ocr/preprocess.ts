/**
 * Stages 1–2 and 4: checking the photo and turning it into what the models
 * expect. The detector takes the whole photo resized to multiples of 32; the
 * recogniser takes each text line cut out at 48 pixels high. Both take floats,
 * channels first, in the blue-green-red order PaddleOCR was trained with.
 * Resizing follows OpenCV's bilinear rule (cv2.resize), as PaddleOCR does.
 */
import type { DetConfig } from './model-config';
import type { PixelImage, Point, Quad, Tensor } from './types';

/** Byte offsets of blue, green and red within a pixel. */
function bgrOffsets(image: PixelImage): [number, number, number] {
  return image.format === 'bgra' ? [0, 1, 2] : [2, 1, 0];
}

// --- Stage 1: is the photo usable? -----------------------------------------

export interface PhotoQuality {
  /** Average brightness, 0 (black) to 255 (white). */
  brightness: number;
  /** Variance of the Laplacian on a small grey copy of the photo; blurry photos score low. */
  sharpness: number;
}

/** Below these, the photo is too dark or too blurry to read. Tune them on real receipts from the low-end phone. */
export const PHOTO_LIMITS = { minBrightness: 55, minSharpness: 20 };

/** Measures brightness and sharpness on a grey copy about 640 pixels across, so it takes milliseconds. */
export function photoQuality(image: PixelImage): PhotoQuality {
  const step = Math.max(1, Math.ceil(Math.max(image.width, image.height) / 640));
  const w = Math.floor(image.width / step);
  const h = Math.floor(image.height / step);
  const grey = new Float32Array(w * h);
  const [bo, go, ro] = bgrOffsets(image);
  const src = image.data;
  let sum = 0;
  for (let y = 0; y < h; y += 1) {
    const sy = y * step + (step >> 1);
    for (let x = 0; x < w; x += 1) {
      const i = (sy * image.width + x * step + (step >> 1)) * 4;
      const v = 0.114 * src[i + bo] + 0.587 * src[i + go] + 0.299 * src[i + ro];
      grey[y * w + x] = v;
      sum += v;
    }
  }
  let lapSum = 0;
  let lapSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      const lap = grey[i - 1] + grey[i + 1] + grey[i - w] + grey[i + w] - 4 * grey[i];
      lapSum += lap;
      lapSq += lap * lap;
      n += 1;
    }
  }
  const mean = n ? lapSum / n : 0;
  return { brightness: w * h ? sum / (w * h) : 0, sharpness: n ? lapSq / n - mean * mean : 0 };
}

/** What's wrong with the photo, in words for the cashier, or null when it looks usable. */
export function photoProblem(quality: PhotoQuality, limits = PHOTO_LIMITS): string | null {
  if (quality.brightness < limits.minBrightness) return 'The photo is too dark. Move to better light and take it again.';
  if (quality.sharpness < limits.minSharpness) return 'The photo is blurry. Hold the phone still and let it focus, then take it again.';
  return null;
}

// --- Stage 2: the detector's input ------------------------------------------

/** The detector's input size: long side at most `maxSide`, both sides rounded to a multiple of 32 (PaddleOCR's DetResizeForTest). */
export function detInputSize(width: number, height: number, maxSide: number): { width: number; height: number } {
  const ratio = Math.max(width, height) > maxSide ? maxSide / Math.max(width, height) : 1;
  return {
    width: Math.max(32, Math.round(Math.trunc(width * ratio) / 32) * 32),
    height: Math.max(32, Math.round(Math.trunc(height * ratio) / 32) * 32),
  };
}

/** Source pixels and weights for bilinear resizing along one axis, with OpenCV's pixel-centre alignment. */
function resizeAxis(src: number, dst: number): { lo: Int32Array; hi: Int32Array; t: Float32Array } {
  const lo = new Int32Array(dst);
  const hi = new Int32Array(dst);
  const t = new Float32Array(dst);
  const scale = src / dst;
  for (let i = 0; i < dst; i += 1) {
    const f = Math.min(Math.max((i + 0.5) * scale - 0.5, 0), src - 1);
    const l = Math.floor(f);
    lo[i] = l;
    hi[i] = Math.min(l + 1, src - 1);
    t[i] = f - l;
  }
  return { lo, hi, t };
}

/** The whole photo as the detector's input tensor (1 × 3 × height × width). */
export function detInput(image: PixelImage, config: DetConfig, maxSide: number): Tensor {
  const { width: dw, height: dh } = detInputSize(image.width, image.height, maxSide);
  const plane = dw * dh;
  const out = new Float32Array(3 * plane);
  const xs = resizeAxis(image.width, dw);
  const ys = resizeAxis(image.height, dh);
  const offsets = bgrOffsets(image);
  const src = image.data;
  const stride = image.width * 4;
  for (let c = 0; c < 3; c += 1) {
    // (value / 255 - mean) / std, folded into one multiply and one add.
    const k = config.scale / config.std[c];
    const m = config.mean[c] / config.std[c];
    const ch = offsets[c];
    const base = c * plane;
    for (let y = 0; y < dh; y += 1) {
      const r0 = ys.lo[y] * stride + ch;
      const r1 = ys.hi[y] * stride + ch;
      const ty = ys.t[y];
      const row = base + y * dw;
      for (let x = 0; x < dw; x += 1) {
        const c0 = xs.lo[x] * 4;
        const c1 = xs.hi[x] * 4;
        const tx = xs.t[x];
        const top = src[r0 + c0] + (src[r0 + c1] - src[r0 + c0]) * tx;
        const bottom = src[r1 + c0] + (src[r1 + c1] - src[r1 + c0]) * tx;
        out[row + x] = (top + (bottom - top) * ty) * k - m;
      }
    }
  }
  return { data: out, dims: [1, 3, dh, dw] };
}

// --- Stage 4: cutting out a line for the recogniser -------------------------

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * The box's corners in the order the text reads. A box much taller than wide
 * holds vertical text; like PaddleOCR, read it turned a quarter turn.
 */
export function readingFrame(quad: Quad): Quad {
  const [a, b, c, d] = quad;
  const width = Math.max(distance(a, b), distance(d, c));
  const height = Math.max(distance(a, d), distance(b, c));
  return height >= 1.5 * width ? [b, c, d, a] : quad;
}

/** Width and height of a reading frame, in photo pixels. */
export function frameSize(frame: Quad): { width: number; height: number } {
  const [a, b, c, d] = frame;
  return {
    width: Math.max(distance(a, b), distance(d, c)),
    height: Math.max(distance(a, d), distance(b, c)),
  };
}

/** The point at fractions (s across, t down) of a reading frame. */
export function framePoint(frame: Quad, s: number, t: number): Point {
  const [a, b, c, d] = frame;
  const topX = a.x + (b.x - a.x) * s;
  const topY = a.y + (b.y - a.y) * s;
  const bottomX = d.x + (c.x - d.x) * s;
  const bottomY = d.y + (c.y - d.y) * s;
  return { x: topX + (bottomX - topX) * t, y: topY + (bottomY - topY) * t };
}

/**
 * Cuts a line out of the photo straight into a recogniser batch: the frame is
 * sampled at `width` × `height` pixels, normalised to -1..1 (PaddleOCR's
 * (x / 255 - 0.5) / 0.5), and written into item `index` of a batch tensor
 * that is `batchWidth` wide. The rest of the row stays 0, which is the padding
 * PaddleOCR uses.
 */
export function writeLineCrop(
  image: PixelImage,
  frame: Quad,
  width: number,
  height: number,
  batch: Float32Array,
  index: number,
  batchWidth: number,
): void {
  const [a, b, c, d] = frame;
  const [bo, go, ro] = bgrOffsets(image);
  const src = image.data;
  const iw = image.width;
  const ih = image.height;
  const plane = height * batchWidth;
  const base = index * 3 * plane;
  for (let v = 0; v < height; v += 1) {
    const t = (v + 0.5) / height;
    // Left and right ends of this row of the frame.
    const lx = a.x + (d.x - a.x) * t;
    const ly = a.y + (d.y - a.y) * t;
    const rx = b.x + (c.x - b.x) * t;
    const ry = b.y + (c.y - b.y) * t;
    for (let u = 0; u < width; u += 1) {
      const s = (u + 0.5) / width;
      let x = lx + (rx - lx) * s - 0.5;
      let y = ly + (ry - ly) * s - 0.5;
      x = x < 0 ? 0 : x > iw - 1 ? iw - 1 : x;
      y = y < 0 ? 0 : y > ih - 1 ? ih - 1 : y;
      const x0 = x | 0;
      const y0 = y | 0;
      const x1 = x0 < iw - 1 ? x0 + 1 : x0;
      const y1 = y0 < ih - 1 ? y0 + 1 : y0;
      const fx = x - x0;
      const fy = y - y0;
      const i00 = (y0 * iw + x0) * 4;
      const i01 = (y0 * iw + x1) * 4;
      const i10 = (y1 * iw + x0) * 4;
      const i11 = (y1 * iw + x1) * 4;
      const o = base + v * batchWidth + u;
      batch[o] = sample(src, i00, i01, i10, i11, bo, fx, fy) / 127.5 - 1;
      batch[o + plane] = sample(src, i00, i01, i10, i11, go, fx, fy) / 127.5 - 1;
      batch[o + 2 * plane] = sample(src, i00, i01, i10, i11, ro, fx, fy) / 127.5 - 1;
    }
  }
}

function sample(
  src: PixelImage['data'],
  i00: number,
  i01: number,
  i10: number,
  i11: number,
  ch: number,
  fx: number,
  fy: number,
): number {
  const top = src[i00 + ch] + (src[i01 + ch] - src[i00 + ch]) * fx;
  const bottom = src[i10 + ch] + (src[i11 + ch] - src[i10 + ch]) * fx;
  return top + (bottom - top) * fy;
}

// --- Helpers for the apps ---------------------------------------------------

/**
 * Shrinks a photo so its long side is at most `maxSide`, averaging the pixels
 * each output pixel covers so thin pen strokes survive. Photos already small
 * enough are returned as they are.
 */
export function fitImage(image: PixelImage, maxSide: number): PixelImage {
  const scale = maxSide / Math.max(image.width, image.height);
  if (scale >= 1) return image;
  const w = Math.max(1, Math.round(image.width * scale));
  const h = Math.max(1, Math.round(image.height * scale));
  const out = new Uint8ClampedArray(w * h * 4);
  const src = image.data;
  const sx = image.width / w;
  const sy = image.height / h;
  for (let y = 0; y < h; y += 1) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(image.height, Math.floor((y + 1) * sy)));
    for (let x = 0; x < w; x += 1) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(image.width, Math.floor((x + 1) * sx)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let yy = y0; yy < y1; yy += 1) {
        let i = (yy * image.width + x0) * 4;
        for (let xx = x0; xx < x1; xx += 1, i += 4) {
          r += src[i];
          g += src[i + 1];
          b += src[i + 2];
          a += src[i + 3];
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * w + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = a / n;
    }
  }
  return { width: w, height: h, data: out, format: image.format };
}
