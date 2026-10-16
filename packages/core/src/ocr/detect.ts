/**
 * Stage 3: finding the text lines. The detector gives, for every pixel of its
 * input, the probability that it is part of text. This turns that map into
 * boxes the way PaddleOCR's DBPostProcess does: threshold the map, find each
 * connected region, fit the smallest rotated rectangle around it, drop regions
 * whose average probability is low, then grow each box a little ("unclip")
 * because the model draws them tight.
 */
import type { DetConfig } from './model-config';
import type { Point, Quad } from './types';

export interface TextBox {
  /** Corners in photo pixels: top-left, top-right, bottom-right, bottom-left. */
  quad: Quad;
  /** Average text probability inside the box, 0–1. */
  score: number;
}

type DetParams = Pick<DetConfig, 'thresh' | 'boxThresh' | 'unclipRatio' | 'maxCandidates'>;

/** PaddleOCR ignores boxes with a side under 3 map pixels before growing them, and under 5 after. */
const MIN_SIDE = 3;

/**
 * Turns the detector's probability map (mapWidth × mapHeight) into boxes in the
 * coordinates of the photo (imageWidth × imageHeight), sorted in reading order.
 */
export function boxesFromMap(
  map: Float32Array,
  mapWidth: number,
  mapHeight: number,
  imageWidth: number,
  imageHeight: number,
  params: DetParams,
): TextBox[] {
  const w = mapWidth;
  const h = mapHeight;
  const n = w * h;
  const seen = new Uint8Array(n);
  // Breadth-first fill; the queue doubles as the list of the region's pixels.
  const queue = new Int32Array(n);
  const boxes: TextBox[] = [];
  let regions = 0;

  for (let start = 0; start < n && regions < params.maxCandidates; start += 1) {
    if (seen[start] || !(map[start] > params.thresh)) continue;
    regions += 1;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    let minY = h;
    let maxY = -1;
    while (head < tail) {
      const p = queue[head++];
      const x = p % w;
      const y = (p - x) / w;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      // The 8 neighbours, as OpenCV's contours connect pixels.
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (!seen[q] && map[q] > params.thresh) {
            seen[q] = 1;
            queue[tail++] = q;
          }
        }
      }
    }
    if (tail < 4) continue;

    // The leftmost and rightmost pixel of each row are enough for the convex hull.
    const rows = maxY - minY + 1;
    const left = new Int32Array(rows).fill(w);
    const right = new Int32Array(rows).fill(-1);
    for (let i = 0; i < tail; i += 1) {
      const p = queue[i];
      const x = p % w;
      const r = (p - x) / w - minY;
      if (x < left[r]) left[r] = x;
      if (x > right[r]) right[r] = x;
    }
    const points: Point[] = [];
    for (let r = 0; r < rows; r += 1) {
      if (right[r] < 0) continue;
      points.push({ x: left[r], y: r + minY });
      if (right[r] !== left[r]) points.push({ x: right[r], y: r + minY });
    }

    const rect = minAreaRect(convexHull(points));
    if (Math.min(rect.width, rect.height) < MIN_SIDE) continue;
    const quad = rectCorners(rect);
    const score = meanInQuad(map, w, h, quad);
    if (score < params.boxThresh) continue;

    // Growing a rectangle by a fixed distance on every side is what PaddleOCR's
    // polygon offset does to it, followed by the smallest rectangle around that.
    const grow = (rect.width * rect.height * params.unclipRatio) / (2 * (rect.width + rect.height));
    const grown = { ...rect, width: rect.width + 2 * grow, height: rect.height + 2 * grow };
    if (Math.min(grown.width, grown.height) < MIN_SIDE + 2) continue;
    const corners = rectCorners(grown).map((pt) => ({
      x: clamp(Math.round((pt.x / w) * imageWidth), 0, imageWidth),
      y: clamp(Math.round((pt.y / h) * imageHeight), 0, imageHeight),
    })) as Quad;
    boxes.push({ quad: corners, score });
  }
  return sortBoxes(boxes);
}

/** Top to bottom, then left to right for boxes on the same line (PaddleOCR's sorted_boxes). */
export function sortBoxes(boxes: TextBox[]): TextBox[] {
  const sorted = boxes.slice().sort((a, b) => a.quad[0].y - b.quad[0].y || a.quad[0].x - b.quad[0].x);
  for (let i = 0; i < sorted.length - 1; i += 1) {
    for (let j = i; j >= 0; j -= 1) {
      const next = sorted[j + 1].quad[0];
      const current = sorted[j].quad[0];
      if (Math.abs(next.y - current.y) < 10 && next.x < current.x) {
        [sorted[j], sorted[j + 1]] = [sorted[j + 1], sorted[j]];
      } else {
        break;
      }
    }
  }
  return sorted;
}

// --- Geometry ----------------------------------------------------------------

export interface RotatedRect {
  cx: number;
  cy: number;
  width: number;
  height: number;
  /** Unit vector along the width. */
  ux: number;
  uy: number;
}

/** Andrew's monotone chain; returns the hull counter-clockwise without repeating the first point. */
export function convexHull(points: Point[]): Point[] {
  const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i -= 1) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** The smallest-area rectangle around a convex hull: one of its sides lies along a hull edge. */
export function minAreaRect(hull: Point[]): RotatedRect {
  if (hull.length === 0) return { cx: 0, cy: 0, width: 0, height: 0, ux: 1, uy: 0 };
  if (hull.length === 1) return { cx: hull[0].x, cy: hull[0].y, width: 0, height: 0, ux: 1, uy: 0 };
  let best: RotatedRect | null = null;
  let bestArea = Infinity;
  for (let i = 0; i < hull.length; i += 1) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len === 0) continue;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of hull) {
      const u = p.x * ux + p.y * uy;
      const v = -p.x * uy + p.y * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < bestArea) {
      bestArea = area;
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      best = { cx: cu * ux - cv * uy, cy: cu * uy + cv * ux, width: maxU - minU, height: maxV - minV, ux, uy };
    }
  }
  return best ?? { cx: hull[0].x, cy: hull[0].y, width: 0, height: 0, ux: 1, uy: 0 };
}

/** A rectangle's corners ordered as PaddleOCR's get_mini_boxes orders them. */
export function rectCorners(rect: RotatedRect): Quad {
  const { cx, cy, ux, uy } = rect;
  const hw = rect.width / 2;
  const hh = rect.height / 2;
  const vx = -uy;
  const vy = ux;
  const pts: Point[] = [
    { x: cx - ux * hw - vx * hh, y: cy - uy * hw - vy * hh },
    { x: cx + ux * hw - vx * hh, y: cy + uy * hw - vy * hh },
    { x: cx + ux * hw + vx * hh, y: cy + uy * hw + vy * hh },
    { x: cx - ux * hw + vx * hh, y: cy - uy * hw + vy * hh },
  ];
  return orderCorners(pts);
}

/** Sort by x; of the two leftmost the upper is top-left, of the two rightmost the upper is top-right. */
export function orderCorners(points: Point[]): Quad {
  const p = points.slice().sort((a, b) => a.x - b.x);
  const [topLeft, bottomLeft] = p[1].y > p[0].y ? [p[0], p[1]] : [p[1], p[0]];
  const [topRight, bottomRight] = p[3].y > p[2].y ? [p[2], p[3]] : [p[3], p[2]];
  return [topLeft, topRight, bottomRight, bottomLeft];
}

/** Average of the map inside a box, as PaddleOCR's box_score_fast measures it (corners truncated to whole pixels). */
export function meanInQuad(map: Float32Array, w: number, h: number, quad: Quad): number {
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  const xmin = clamp(Math.floor(Math.min(...xs)), 0, w - 1);
  const xmax = clamp(Math.ceil(Math.max(...xs)), 0, w - 1);
  const ymin = clamp(Math.floor(Math.min(...ys)), 0, h - 1);
  const ymax = clamp(Math.ceil(Math.max(...ys)), 0, h - 1);
  const poly = quad.map((p) => ({ x: Math.trunc(p.x), y: Math.trunc(p.y) }));
  let sum = 0;
  let count = 0;
  for (let y = ymin; y <= ymax; y += 1) {
    // Where this row of pixel centres crosses the box's edges.
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 4; i += 1) {
      const a = poly[i];
      const b = poly[(i + 1) % 4];
      if ((y < a.y && y < b.y) || (y > a.y && y > b.y)) continue;
      if (a.y === b.y) {
        lo = Math.min(lo, a.x, b.x);
        hi = Math.max(hi, a.x, b.x);
      } else {
        const x = a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y);
        lo = Math.min(lo, x);
        hi = Math.max(hi, x);
      }
    }
    if (lo > hi) continue;
    const from = Math.max(xmin, Math.ceil(lo - 1e-6));
    const to = Math.min(xmax, Math.floor(hi + 1e-6));
    for (let x = from; x <= to; x += 1) {
      sum += map[y * w + x];
      count += 1;
    }
  }
  return count ? sum / count : 0;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
