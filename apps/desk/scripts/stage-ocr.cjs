/**
 * Gathers what SGM Desk's receipt reader needs into build/ocr/, for
 * electron-builder to put in the installed app's resources folder (see the
 * receipt scanning lines in electron-builder.yml). electron-builder runs it
 * before packing each build (beforePack), so the right ONNX Runtime files go
 * in for the target CPU. `node scripts/stage-ocr.cjs` runs it by hand.
 *
 * - models/ocr: the two PaddleOCR models (npm run ocr:models)
 * - node_modules/onnxruntime-node: its code and the binaries for the target
 *   only, with the onnxruntime-common it was installed with
 */
const fs = require('node:fs');
const path = require('node:path');

const DESK = path.resolve(__dirname, '..');
const ROOT = path.resolve(DESK, '..', '..');
const OUT = path.join(DESK, 'build', 'ocr');
const MODELS = ['PP-OCRv6_small_det', 'PP-OCRv6_small_rec'];
/** electron-builder's Arch numbers, as Node names them. */
const ARCH_NAMES = ['ia32', 'x64', 'arm', 'arm64'];

/** The folder of the package `name` that `from` would load. */
function packageRoot(name, from) {
  let dir;
  try {
    dir = path.dirname(require.resolve(name, { paths: [from] }));
  } catch {
    return null;
  }
  for (; path.dirname(dir) !== dir; dir = path.dirname(dir)) {
    const file = path.join(dir, 'package.json');
    if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).name === name) return dir;
  }
  return null;
}

function copy(fromDir, toDir, parts) {
  for (const part of parts) {
    const from = path.join(fromDir, part);
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.dirname(path.join(toDir, part)), { recursive: true });
    fs.cpSync(from, path.join(toDir, part), { recursive: true });
  }
}

function stage(platform = process.platform, arch = process.arch) {
  fs.rmSync(OUT, { recursive: true, force: true });

  for (const model of MODELS) {
    const dir = path.join(ROOT, 'models', 'ocr', model);
    for (const file of ['model.onnx', 'config.yml']) {
      if (!fs.existsSync(path.join(dir, file))) {
        throw new Error(`Receipt scanning: models/ocr/${model}/${file} is missing. Run "npm run ocr:models" first.`);
      }
    }
    copy(dir, path.join(OUT, 'models', 'ocr', model), ['model.onnx', 'config.yml']);
  }

  const ort = packageRoot('onnxruntime-node', DESK);
  if (!ort) throw new Error('Receipt scanning: onnxruntime-node is not installed. Run "npm install -D -w apps/desk onnxruntime-node@1.30.0".');
  const bin = path.join('bin', 'napi-v6', platform, arch);
  if (!fs.existsSync(path.join(ort, bin))) throw new Error(`Receipt scanning: onnxruntime-node has no build for ${platform} ${arch}.`);
  copy(ort, path.join(OUT, 'node_modules', 'onnxruntime-node'), ['package.json', 'LICENSE', 'ThirdPartyNotices.txt', 'dist', bin]);

  const common = packageRoot('onnxruntime-common', ort);
  if (!common) throw new Error('Receipt scanning: onnxruntime-common (installed with onnxruntime-node) was not found.');
  copy(common, path.join(OUT, 'node_modules', 'onnxruntime-common'), ['package.json', 'LICENSE', path.join('dist', 'cjs')]);
  return OUT;
}

/** electron-builder's beforePack hook. */
module.exports = async function beforePack(context) {
  const arch = ARCH_NAMES[context.arch];
  if (!arch) throw new Error(`Receipt scanning: no ONNX Runtime build for this target (arch ${context.arch}).`);
  stage(context.electronPlatformName, arch);
};

if (require.main === module) {
  try {
    console.log(`Receipt reader files ready in ${path.relative(process.cwd(), stage()) || '.'}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
