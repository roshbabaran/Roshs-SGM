#!/usr/bin/env node
/**
 * Downloads the PaddleOCR models that read receipts into models/ocr/ (not kept
 * in git). Each file is pinned to an exact upload and checked against its
 * SHA-256, so every PC and phone build reads with the same models. Files that
 * are already there and match are kept. Run with `npm run ocr:models`.
 *
 * PP-OCRv6 small detector and recogniser by the PaddlePaddle authors, Apache
 * License 2.0 (https://github.com/PaddlePaddle/PaddleOCR). PaddleOCR names the
 * files inference.onnx and inference.yml; they are saved as model.onnx and
 * config.yml because an Android app can't hold two bundled files whose names
 * differ only in their extension.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'models', 'ocr');

const DET = { model: 'PP-OCRv6_small_det', repo: 'PaddlePaddle/PP-OCRv6_small_det_onnx', revision: '28fe5895c24fd108c19eb3e8479f4ab385fbfc62' };
const REC = { model: 'PP-OCRv6_small_rec', repo: 'PaddlePaddle/PP-OCRv6_small_rec_onnx', revision: 'b8f84f0b80c529de40b4fbb3544b84fa7233a513' };

const FILES = [
  { ...DET, from: 'inference.onnx', to: 'model.onnx', bytes: 9_880_512, sha256: 'd73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e' },
  { ...DET, from: 'inference.yml', to: 'config.yml', bytes: 885, sha256: '193f435274bf9f0b5f71a929bbfbcf148282df7e633b34e7c373e8f44741b516' },
  { ...REC, from: 'inference.onnx', to: 'model.onnx', bytes: 21_159_378, sha256: '5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634' },
  { ...REC, from: 'inference.yml', to: 'config.yml', bytes: 150_579, sha256: 'ab078671bb49f06228eadccd34f1bb501e157f7a047095ffb943ba81512c77d1' },
];

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const size = (bytes) => (bytes < 1_000_000 ? `${Math.ceil(bytes / 1000)} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`);

async function fetchFile(file) {
  const name = `${file.model}/${file.to}`;
  const dest = path.join(OUT, file.model, file.to);
  const existing = await readFile(dest).catch(() => null);
  if (existing && sha256(existing) === file.sha256) {
    console.log(`  ${name}: already downloaded`);
    return;
  }
  const url = `https://huggingface.co/${file.repo}/resolve/${file.revision}/${file.from}`;
  console.log(`  ${name}: downloading ${size(file.bytes)}…`);
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(`Couldn't reach huggingface.co (${error.cause?.code ?? error.message}). Check the internet connection and try again.`);
  }
  if (!response.ok) throw new Error(`${url} answered ${response.status} ${response.statusText}.`);
  const data = Buffer.from(await response.arrayBuffer());
  const hash = sha256(data);
  if (hash !== file.sha256) {
    throw new Error(`${name} isn't the expected file (got ${data.length} bytes, SHA-256 ${hash}). Nothing was saved.`);
  }
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(`${dest}.part`, data);
  await rename(`${dest}.part`, dest);
}

console.log(`Receipt reading models → ${path.relative(process.cwd(), OUT) || OUT}`);
try {
  for (const file of FILES) await fetchFile(file);
  console.log('Done.');
} catch (error) {
  console.error(`\n${error.message}`);
  console.error('Behind a proxy? With Node 24, set HTTPS_PROXY and NODE_USE_ENV_PROXY=1, then run this again.');
  process.exitCode = 1;
}
