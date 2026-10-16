/**
 * Stages 2–5 put together: photo in, lines of text with positions out. This is
 * the part every scan shares (receipts now, GCash screenshots later); what the
 * text means is decided afterwards.
 */
import { boxesFromMap } from './detect';
import { parseDetConfig, parseRecConfig, type DetConfig, type RecConfig } from './model-config';
import { detInput } from './preprocess';
import { DEFAULT_READ_OPTIONS, readLines, type ReadOptions } from './recognize';
import type { OcrLine, OcrRuntime, PixelImage } from './types';

export interface OcrEngineOptions extends ReadOptions {
  /**
   * Long side of the detector's input. Larger finds smaller writing but takes
   * longer. 960 found every line on the test receipts with 56% of the pixels
   * of 1280. Lines are still read from the full photo.
   */
  detMaxSide: number;
  /** Overrides for the detector's thresholds from inference.yml, for tuning on SGM's receipts. */
  thresh?: number;
  boxThresh?: number;
  unclipRatio?: number;
}

export const DEFAULT_ENGINE_OPTIONS: OcrEngineOptions = { ...DEFAULT_READ_OPTIONS, detMaxSide: 960 };

export interface OcrEngine {
  runtime: OcrRuntime;
  det: DetConfig;
  rec: RecConfig;
  options: OcrEngineOptions;
}

/** Sets up the reader from a runtime and the text of the two models' inference.yml files (config.yml in models/ocr). */
export function createOcrEngine(
  runtime: OcrRuntime,
  configs: { det: string; rec: string },
  options: Partial<OcrEngineOptions> = {},
): OcrEngine {
  return {
    runtime,
    det: parseDetConfig(configs.det),
    rec: parseRecConfig(configs.rec),
    options: { ...DEFAULT_ENGINE_OPTIONS, ...options },
  };
}

export interface TextResult {
  lines: OcrLine[];
  /** Milliseconds per stage: prepare, detect, read. */
  timings: Record<string, number>;
}

export function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Finds and reads every line of text in the photo. */
export async function readText(image: PixelImage, engine: OcrEngine): Promise<TextResult> {
  const { det, options } = engine;
  const timings: Record<string, number> = {};
  let t = now();
  const input = detInput(image, det, options.detMaxSide);
  timings.prepare = now() - t;

  t = now();
  const map = await engine.runtime.run('det', input);
  const mapHeight = map.dims[map.dims.length - 2];
  const mapWidth = map.dims[map.dims.length - 1];
  const boxes = boxesFromMap(map.data, mapWidth, mapHeight, image.width, image.height, {
    thresh: options.thresh ?? det.thresh,
    boxThresh: options.boxThresh ?? det.boxThresh,
    unclipRatio: options.unclipRatio ?? det.unclipRatio,
    maxCandidates: det.maxCandidates,
  });
  timings.detect = now() - t;

  t = now();
  const lines = await readLines(image, boxes, engine.runtime, engine.rec, options);
  timings.read = now() - t;
  return { lines, timings };
}
