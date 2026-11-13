/**
 * Scanning receipts on the phone: a photo from the camera or the gallery, read
 * by the PaddleOCR models with ONNX Runtime, all offline. ONNX Runtime is
 * native code that Expo Go doesn't have, so scanning needs SGM Pocket's
 * development build (`npx expo run:android`); in Expo Go the Scan button is
 * hidden. The reader itself is in packages/core/src/ocr.
 */
import { createOcrEngine, readReceiptText, type OcrEngine, type OcrRuntime, type PixelImage } from '@sgm/core';
import type { PhotoSource, ReceiptScanner, ScanPhoto } from '@sgm/ui';
import { Asset } from 'expo-asset';
import { File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import type { InferenceSession } from 'onnxruntime-react-native';
import { NativeModules } from 'react-native';

type Ort = typeof import('onnxruntime-react-native');
type Skia = typeof import('@shopify/react-native-skia');

/** The photo's long side once shrunk: plenty for handwriting on a receipt, and quick to read. */
const PHOTO_MAX_SIDE = 1600;

/**
 * The two models and their settings, bundled with the app from models/ocr at
 * the repository root (`npm run ocr:models`). The requires sit in a try block,
 * which Metro treats as optional, so the app still builds without the models;
 * scanning then says what's missing.
 */
function modelFiles(): number[] {
  try {
    return [
      require('../../../../models/ocr/PP-OCRv6_small_det/model.onnx'),
      require('../../../../models/ocr/PP-OCRv6_small_det/config.yml'),
      require('../../../../models/ocr/PP-OCRv6_small_rec/model.onnx'),
      require('../../../../models/ocr/PP-OCRv6_small_rec/config.yml'),
    ];
  } catch {
    throw new Error('This build of SGM Pocket has no reading models. Run "npm run ocr:models" and "node scripts/setup-ocr.mjs", then build the app again.');
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The photo upright (the camera's rotation applied), shrunk, and saved as a JPEG in the app's cache, never the gallery. */
async function preparePhoto(uri: string): Promise<string> {
  const upright = await ImageManipulator.manipulate(uri).renderAsync();
  const shrink = Math.max(upright.width, upright.height) > PHOTO_MAX_SIDE;
  const photo = shrink
    ? await ImageManipulator.manipulate(upright)
        .resize(upright.width >= upright.height ? { width: PHOTO_MAX_SIDE } : { height: PHOTO_MAX_SIDE })
        .renderAsync()
    : upright;
  const saved = await photo.saveAsync({ format: SaveFormat.JPEG, compress: 0.92 });
  return saved.uri;
}

/**
 * The photo's pixels. Skia decodes the JPEG in native code: decoding it in
 * JavaScript took about 3 seconds on a PC running JavaScript without a JIT,
 * as phones do.
 */
async function pixelsOf(uri: string): Promise<PixelImage> {
  const { AlphaType, ColorType, Skia } = require('@shopify/react-native-skia') as Skia;
  const encoded = await Skia.Data.fromURI(uri);
  const image = Skia.Image.MakeImageFromEncoded(encoded);
  encoded.dispose();
  if (!image) throw new Error("SGM Pocket couldn't open that photo.");
  try {
    const width = image.width();
    const height = image.height();
    const data = image.readPixels(0, 0, { width, height, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul });
    if (!(data instanceof Uint8Array)) throw new Error("SGM Pocket couldn't read that photo.");
    return { width, height, data };
  } finally {
    // Let go of the decoded photo (several megabytes) now, not whenever JavaScript next collects garbage.
    image.dispose();
  }
}

/** Deletes a photo the app made in its own cache. A photo anywhere else, such as the gallery, is never touched. */
function discard(uri: string | null): void {
  if (!uri?.startsWith(Paths.cache.uri)) return;
  try {
    new File(uri).delete();
  } catch {
    // Already gone.
  }
}

/** The photo the dialog shows. Only the latest is kept, so photos don't pile up in the app's storage. */
let shown: string | null = null;

async function pickPhoto(source: PhotoSource): Promise<ScanPhoto | null> {
  if (source === 'camera') {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) throw new Error("SGM Pocket needs the camera to scan receipts. Allow it in the phone's Settings, then try again.");
  }
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 1, exif: false };
  const result = source === 'camera' ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
  const picked = result.canceled ? null : result.assets[0];
  if (!picked) return null;
  const uri = await preparePhoto(picked.uri);
  // The picker's full-size copy isn't needed once the smaller photo is saved.
  discard(picked.uri);
  const image = await pixelsOf(uri);
  discard(shown);
  shown = uri;
  return { uri, image };
}

function localFile(asset: Asset): string {
  if (!asset.localUri) throw new Error(`The reading model file ${asset.name} isn't on this phone.`);
  return asset.localUri;
}

async function loadEngine(): Promise<OcrEngine> {
  // Required only now: loading onnxruntime-react-native without its native module throws.
  const ort = require('onnxruntime-react-native') as Ort;
  const [detModel, detConfig, recModel, recConfig] = await Asset.loadAsync(modelFiles());
  // Photos differ in size, so the memory arena and pattern (tuned for one input size) are turned off.
  const options: InferenceSession.SessionOptions = { graphOptimizationLevel: 'all', enableCpuMemArena: false, enableMemPattern: false };
  const [det, rec] = await Promise.all([
    ort.InferenceSession.create(localFile(detModel), options),
    ort.InferenceSession.create(localFile(recModel), options),
  ]);
  const runtime: OcrRuntime = {
    async run(model, input) {
      const session = model === 'det' ? det : rec;
      const outputs = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input.data, input.dims) });
      const output = outputs[session.outputNames[0]];
      return { data: output.data as Float32Array, dims: [...output.dims] };
    },
  };
  return createOcrEngine(runtime, {
    det: await new File(localFile(detConfig)).text(),
    rec: await new File(localFile(recConfig)).text(),
  });
}

let engine: Promise<OcrEngine> | null = null;

/** Receipt scanning on this phone, or undefined when the app was built without ONNX Runtime (Expo Go). */
export function createPocketScanner(): ReceiptScanner | undefined {
  if (!NativeModules.Onnxruntime) return undefined;
  return {
    sources: ['camera', 'library'],
    pickPhoto,
    async readText(image) {
      // The models load on the first scan (a second or two) and stay loaded.
      engine ??= loadEngine().catch((e: unknown) => {
        engine = null;
        throw new Error(`Receipt reading couldn't start on this phone. ${messageOf(e)}`);
      });
      // Every line, then a second, closer look at handwriting the first read may have missed or misread.
      return readReceiptText(image, await engine);
    },
  };
}
