/**
 * The whole reader on two sample photos with the real PaddleOCR models, run by
 * onnxruntime-node the way SGM Desk runs them. Skipped until the models are in
 * models/ocr (`npm run ocr:models`) and onnxruntime-node is installed (it comes
 * with SGM Desk's dependencies). Node's modules are loaded at run time too, so
 * the rest of core doesn't need Node's types.
 */
import { describe, expect, it } from 'vitest';

import { createOcrEngine, type OcrEngine } from './engine';
import { draftProblem, draftToCart, readReceipt } from './pipeline';
import { CATALOGUE } from './test-helpers';
import type { OcrRuntime, PixelImage } from './types';

const MODELS = new URL('../../../../models/ocr/', import.meta.url);
const SAMPLES = new URL('./samples/', import.meta.url);

/** The parts of Node's fs, onnxruntime-node and jpeg-js used here; the last two are loaded only if installed. */
interface Fs {
  existsSync(path: URL): boolean;
  readFileSync(path: URL): Uint8Array;
  readFileSync(path: URL, encoding: 'utf8'): string;
}
interface OrtSession {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown; dims: readonly number[] }>>;
}
interface Ort {
  InferenceSession: { create(model: Uint8Array, options: Record<string, unknown>): Promise<OrtSession> };
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => unknown;
}
interface Jpeg {
  decode(data: Uint8Array, options: { useTArray: true; formatAsRGBA: true }): { width: number; height: number; data: Uint8Array };
}

interface SampleTruth {
  receiptNo: string;
  date: string;
  total: number;
  lines: { productId: string; type: 'refill' | 'new' | 'item'; qty: number }[];
}

async function load<T>(id: string): Promise<T | null> {
  try {
    const mod = (await import(/* @vite-ignore */ id)) as { default?: T } & T;
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

async function setUp(): Promise<{ engine: OcrEngine; jpeg: Jpeg; fs: Fs } | null> {
  const model = (name: string, file: string) => new URL(`PP-OCRv6_small_${name}/${file}`, MODELS);
  const [fs, ort, jpeg] = await Promise.all([load<Fs>('node:fs'), load<Ort>('onnxruntime-node'), load<Jpeg>('jpeg-js')]);
  if (!fs || !ort || !jpeg) return null;
  if (!['det', 'rec'].every((name) => fs.existsSync(model(name, 'model.onnx')) && fs.existsSync(model(name, 'config.yml')))) return null;
  const options = { graphOptimizationLevel: 'all', enableMemPattern: false, enableCpuMemArena: false };
  const det = await ort.InferenceSession.create(fs.readFileSync(model('det', 'model.onnx')), options);
  const rec = await ort.InferenceSession.create(fs.readFileSync(model('rec', 'model.onnx')), options);
  const runtime: OcrRuntime = {
    async run(name, input) {
      const session = name === 'det' ? det : rec;
      const outputs = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input.data, input.dims) });
      const output = outputs[session.outputNames[0]];
      return { data: output.data as Float32Array, dims: [...output.dims] };
    },
  };
  const engine = createOcrEngine(runtime, {
    det: fs.readFileSync(model('det', 'config.yml'), 'utf8'),
    rec: fs.readFileSync(model('rec', 'config.yml'), 'utf8'),
  });
  return { engine, jpeg, fs };
}

let ready: ReturnType<typeof setUp> | null = null;

describe('reading sample receipts with the real models', () => {
  for (const name of ['receipt_00', 'receipt_11']) {
    it(`reads ${name}.jpg into the right sale`, async (ctx) => {
      const setup = await (ready ??= setUp());
      if (!setup) return ctx.skip();
      const decoded = setup.jpeg.decode(setup.fs.readFileSync(new URL(`${name}.jpg`, SAMPLES)), { useTArray: true, formatAsRGBA: true });
      const image: PixelImage = { width: decoded.width, height: decoded.height, data: decoded.data };
      const truth = JSON.parse(setup.fs.readFileSync(new URL(`${name}.json`, SAMPLES), 'utf8')) as SampleTruth;

      const draft = await readReceipt(image, setup.engine, CATALOGUE, { today: '2026-10-16' });

      expect(draft.method).toBe('headers');
      expect(draft.receiptNo.value).toBe(truth.receiptNo);
      expect(draft.date.value).toBe(truth.date);
      expect(draft.total.value).toBe(truth.total);
      expect(draftProblem(draft.lines)).toBeNull();
      expect(draftToCart(draft.lines)).toEqual(truth.lines.map((line) => ({ type: line.type, productId: line.productId, qty: line.qty })));
    }, 120_000);
  }
});
