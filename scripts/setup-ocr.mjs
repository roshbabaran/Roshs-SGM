#!/usr/bin/env node
/**
 * One-time setup for receipt scanning: `node scripts/setup-ocr.mjs` from the
 * repository root. It makes only the changes below, skips any already made,
 * and lists anything it couldn't change so it can be done by hand.
 *
 * - package.json: the "ocr:models" script, and patch-package after every
 *   install (it applies patches/, which lets onnxruntime-react-native build
 *   with Gradle 9 and link in Expo SDK 57)
 * - .gitignore: models/ocr/, which `npm run ocr:models` fills
 * - apps/pocket/app.json: the camera permission text, and no microphone
 * - apps/pocket/metro.config.js: bundle the .onnx and .yml model files
 * - apps/desk/electron-builder.yml: put the models and ONNX Runtime in the installer
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const changed = [];
const byHand = [];

const at = (rel) => path.join(ROOT, rel);
const read = (rel) => (existsSync(at(rel)) ? readFileSync(at(rel), 'utf8') : null);

/** Writes JSON with the file's own indentation. */
function writeJson(rel, value, original) {
  const indent = /^([ \t]+)"/m.exec(original)?.[1] ?? '  ';
  writeFileSync(at(rel), `${JSON.stringify(value, null, indent)}\n`);
}

function appendLines(rel, original, lines) {
  const before = original && !original.endsWith('\n') ? `${original}\n` : (original ?? '');
  writeFileSync(at(rel), `${before}${before ? '\n' : ''}${lines.join('\n')}\n`);
}

// package.json
{
  const rel = 'package.json';
  const text = read(rel);
  const pkg = JSON.parse(text);
  const scripts = (pkg.scripts ??= {});
  const before = JSON.stringify(scripts);
  scripts['ocr:models'] ??= 'node scripts/fetch-ocr-models.mjs';
  if (!scripts.postinstall) scripts.postinstall = 'patch-package';
  else if (!scripts.postinstall.includes('patch-package')) scripts.postinstall += ' && patch-package';
  if (JSON.stringify(scripts) !== before) {
    writeJson(rel, pkg, text);
    changed.push(`${rel}: "ocr:models" script, patch-package after installs`);
  }
}

// .gitignore
{
  const rel = '.gitignore';
  const text = read(rel);
  if (!/^\/?models\/ocr\/?\s*$/m.test(text ?? '')) {
    appendLines(rel, text, ['# Receipt reading models (npm run ocr:models)', '/models/ocr/']);
    changed.push(`${rel}: /models/ocr/`);
  }
}

// apps/pocket/app.json
{
  const rel = 'apps/pocket/app.json';
  const picker = [
    'expo-image-picker',
    {
      cameraPermission: 'SGM Pocket uses the camera to scan handwritten receipts into a sale.',
      photosPermission: 'SGM Pocket opens the receipt photos you choose so it can scan them into a sale.',
      microphonePermission: false,
    },
  ];
  const text = read(rel);
  if (text === null) {
    byHand.push(`SGM Pocket's Expo config: add to "plugins": ${JSON.stringify(picker)}`);
  } else {
    const json = JSON.parse(text);
    const expo = json.expo ?? json;
    const plugins = (expo.plugins ??= []);
    if (!plugins.some((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin) === picker[0])) {
      plugins.push(picker);
      writeJson(rel, json, text);
      changed.push(`${rel}: expo-image-picker plugin (camera permission text, no microphone)`);
    }
  }
}

// apps/pocket/metro.config.js
{
  const rel = 'apps/pocket/metro.config.js';
  const text = read(rel);
  if (text === null) {
    writeFileSync(
      at(rel),
      [
        "// Metro (the bundler) settings for SGM Pocket. The receipt reader's model",
        '// files in models/ocr at the repository root are bundled as assets.',
        "const { getDefaultConfig } = require('expo/metro-config');",
        '',
        'const config = getDefaultConfig(__dirname);',
        "config.resolver.assetExts.push('onnx', 'yml');",
        '',
        'module.exports = config;',
        '',
      ].join('\n'),
    );
    changed.push(`${rel}: created, bundles .onnx and .yml files`);
  } else if (!/['"]onnx['"]/.test(text)) {
    byHand.push(`${rel}: add  config.resolver.assetExts.push('onnx', 'yml');  after the config is created`);
  }
}

// apps/desk/electron-builder.yml
{
  const rel = 'apps/desk/electron-builder.yml';
  const lines = [
    '# Receipt scanning: scripts/stage-ocr.cjs gathers the models and ONNX Runtime',
    '# into build/ocr before packing, and these copy them into resources/.',
    'beforePack: scripts/stage-ocr.cjs',
    'extraResources:',
    '  - from: build/ocr/models',
    '    to: models',
    '  - from: build/ocr/node_modules',
    '    to: node_modules',
  ];
  const text = read(rel);
  if (text === null) {
    byHand.push(`SGM Desk's electron-builder config: add\n${lines.join('\n')}`);
  } else if (!text.includes('stage-ocr')) {
    if (/^(beforePack|extraResources)\s*:/m.test(text)) {
      byHand.push(`${rel} already has beforePack or extraResources. Merge in:\n${lines.join('\n')}`);
    } else {
      appendLines(rel, text, lines);
      changed.push(`${rel}: stage and ship the receipt reader`);
    }
  }
}

console.log(changed.length ? `Changed:\n${changed.map((line) => `  - ${line}`).join('\n')}` : 'Nothing to change: already set up.');
if (byHand.length) {
  console.log(`\nPlease change by hand:\n${byHand.map((line) => `  - ${line.replace(/\n/g, '\n      ')}`).join('\n')}`);
  process.exitCode = 1;
}
