/**
 * Reading receipt photos on this PC. The screens send a photo's pixels; this
 * finds and reads the writing with the PaddleOCR models (the reader is in
 * packages/core/src/ocr). The models run with ONNX Runtime on a worker thread,
 * so the window and the database keep answering while a receipt is read.
 *
 * Files it needs, found under resources/ in the installed app (put there by
 * scripts/stage-ocr.cjs and electron-builder's extraResources) or by looking up
 * from this file while developing:
 * - models/ocr/PP-OCRv6_small_{det,rec}/{model.onnx,config.yml} (npm run ocr:models)
 * - node_modules/onnxruntime-node
 */
import { app } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { createOcrEngine, readReceiptText, type OcrEngine, type OcrModel, type OcrRuntime, type PixelImage, type Tensor, type TextResult } from '@sgm/core';

const MODELS = { det: 'PP-OCRv6_small_det', rec: 'PP-OCRv6_small_rec' } as const;
/** Largest photo side accepted from the screens (they send at most 1600). */
const MAX_SIDE = 4096;
/** The worker and the memory the models use are let go after this long without a scan. */
const IDLE_MS = 5 * 60_000;

/**
 * The worker thread. It is plain JavaScript run from this string, so the
 * build doesn't need a second entry point. It loads onnxruntime-node from the
 * path it's given and runs one model at a time.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const ort = require(workerData.ort);
// Photos differ in size, so the memory arena and pattern (tuned for one input size) are turned off.
const options = { graphOptimizationLevel: 'all', enableCpuMemArena: false, enableMemPattern: false };
const sessions = Promise.all([
  ort.InferenceSession.create(workerData.det, options),
  ort.InferenceSession.create(workerData.rec, options),
]);
sessions.catch(() => {});
parentPort.on('message', async ({ id, model, data, dims }) => {
  try {
    const [det, rec] = await sessions;
    const session = model === 'det' ? det : rec;
    const outputs = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', data, dims) });
    const output = outputs[session.outputNames[0]];
    const result = new Float32Array(output.data);
    parentPort.postMessage({ id, data: result, dims: Array.from(output.dims) }, [result.buffer]);
  } catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
`;

type Reply = { id: number; data: Float32Array; dims: number[]; error?: undefined } | { id: number; error: string };

/** Runs the models on the worker thread. */
class WorkerRuntime implements OcrRuntime {
  private readonly worker: Worker;
  private readonly pending = new Map<number, { resolve: (tensor: Tensor) => void; reject: (error: Error) => void }>();
  private nextId = 1;

  constructor(files: { ort: string; det: string; rec: string }) {
    this.worker = new Worker(WORKER_SOURCE, { eval: true, workerData: files });
    this.worker.unref();
    this.worker.on('message', (reply: Reply) => {
      const call = this.pending.get(reply.id);
      if (!call) return;
      this.pending.delete(reply.id);
      if (reply.error !== undefined) call.reject(new Error(reply.error));
      else call.resolve({ data: reply.data, dims: reply.dims });
    });
    this.worker.on('error', (error: unknown) => this.failAll(error instanceof Error ? error : new Error(String(error))));
    this.worker.on('exit', () => this.failAll(new Error('The receipt reader stopped.')));
  }

  run(model: OcrModel, input: Tensor): Promise<Tensor> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      // A copy is handed over (not shared), so the caller's buffer stays usable.
      const data = input.data.slice();
      this.worker.postMessage({ id, model, data, dims: input.dims }, [data.buffer]);
    });
  }

  close(): void {
    void this.worker.terminate();
  }

  private failAll(error: Error): void {
    for (const call of this.pending.values()) call.reject(error);
    this.pending.clear();
  }
}

/** A file shipped with the app: under resources/ once installed, otherwise the nearest match looking up from this file. */
function locate(relative: string): string | null {
  if (app.isPackaged) {
    const file = path.join(process.resourcesPath, relative);
    return existsSync(file) ? file : null;
  }
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    const file = path.join(dir, relative);
    if (existsSync(file)) return file;
    if (path.dirname(dir) === dir) return null;
  }
}

function missing(what: string): Error {
  return new Error(
    app.isPackaged
      ? `This copy of SGM Desk is missing its receipt reader (${what}). Reinstall SGM Desk.`
      : `Receipt scanning needs ${what}. See packages/core/src/ocr/README.md.`,
  );
}

/** Checks the pixels the screens sent. */
export function checkPixels(value: unknown): PixelImage {
  const { width, height, data } = (value ?? {}) as { width?: unknown; height?: unknown; data?: unknown };
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isInteger(width) || !Number.isInteger(height)) {
    throw new Error('Invalid request.');
  }
  if (width < 32 || height < 32 || width > MAX_SIDE || height > MAX_SIDE) throw new Error('That photo is too small or too large to read.');
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || data.length !== width * height * 4) throw new Error('Invalid request.');
  return { width, height, data };
}

/** The receipt reader for the main process. The models load on the first scan and are let go when idle. */
export function createOcrReader(): { read(image: PixelImage): Promise<TextResult>; close(): void } {
  let runtime: WorkerRuntime | null = null;
  let engine: OcrEngine | null = null;
  let idle: NodeJS.Timeout | null = null;

  const close = () => {
    if (idle) clearTimeout(idle);
    idle = null;
    runtime?.close();
    runtime = null;
    engine = null;
  };

  const start = (): OcrEngine => {
    const ort = locate(path.join('node_modules', 'onnxruntime-node', 'package.json'));
    if (!ort) throw missing('onnxruntime-node');
    const files = {
      det: locate(path.join('models', 'ocr', MODELS.det, 'model.onnx')),
      detConfig: locate(path.join('models', 'ocr', MODELS.det, 'config.yml')),
      rec: locate(path.join('models', 'ocr', MODELS.rec, 'model.onnx')),
      recConfig: locate(path.join('models', 'ocr', MODELS.rec, 'config.yml')),
    };
    if (!files.det || !files.detConfig || !files.rec || !files.recConfig) throw missing('the PaddleOCR models in models/ocr');
    const configs = { det: readFileSync(files.detConfig, 'utf8'), rec: readFileSync(files.recConfig, 'utf8') };
    runtime = new WorkerRuntime({ ort: path.dirname(ort), det: files.det, rec: files.rec });
    engine = createOcrEngine(runtime, configs);
    return engine;
  };

  const read = async (image: PixelImage): Promise<TextResult> => {
    if (idle) clearTimeout(idle);
    try {
      // Every line, then a second, closer look at handwriting the first read may have missed or misread.
      return await readReceiptText(image, engine ?? start());
    } catch (error) {
      // Start afresh next time, in case the worker is what failed.
      close();
      throw error;
    } finally {
      if (runtime) {
        idle = setTimeout(close, IDLE_MS);
        idle.unref();
      }
    }
  };

  return { read, close };
}
