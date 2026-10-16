# Receipt reader

Reads a photo of a handwritten SGM receipt into a draft sale that the cashier checks before it goes into the cart. It runs offline on the device: PaddleOCR's PP-OCRv6 small models find and read the writing, and the code in this folder works out what the writing means. Both apps share this code. Only how a photo is taken and how the models are run differ:

| | Photo | Models run by |
| --- | --- | --- |
| SGM Pocket | Camera or gallery (`apps/pocket/src/services/ocr.ts`) | onnxruntime-react-native, on the phone |
| SGM Desk | A photo file (`apps/desk/src/services/ocr.ts`) | onnxruntime-node, on a worker thread in Electron's main process (`apps/desk/electron/ocr.ts`) |

The Scan receipt button on the Sell screen opens `ReceiptScanDialog` (packages/ui). Nothing is saved from a scan: the confirmed lines become the cart, and the sale is charged and saved through `recordSale` like any other, with the receipt number in `Sale.slipNo` so the same receipt can't be entered twice.

## Stages

| Stage | What happens | File |
| --- | --- | --- |
| 1. Capture | Camera, gallery or file; the photo is turned upright and shrunk to 1600 px on its long side | each app's `services/ocr.ts` |
| 2. Prepare | Brightness and sharpness check; the detector's input | `preprocess.ts` |
| 3. Find lines | The detector's map turned into boxes (PaddleOCR's DBPostProcess) | `detect.ts` |
| 4. Crop lines | Each box cut out level, 48 px high | `preprocess.ts` |
| 5. Read lines | Recogniser in batches, CTC decoding with the model's own dictionary, Latin characters only | `recognize.ts` |
| 6. Fields | The printed headings (QTY, UNIT, ARTICLES, UNIT PRICE, AMOUNT, TOTAL, Date, No.) give the columns and rows | `layout.ts` |
| 7. Clean values | Amounts, quantities, dates and receipt numbers from handwriting | `normalize.ts` |
| 8. Products | Each line matched to a product or set; the written price settles refill or new | `match.ts` |
| 9. Checks | Quantity × unit price = amount, and the amounts add up to the total | `checks.ts` |
| 10. Review | The cashier confirms each line against the photo | `pipeline.ts`, `ReceiptScanDialog` |
| 11. Learn | Products the cashier corrected are remembered on the device | `aliases.ts` |

`engine.ts` runs stages 2–5 (`readText`) and `pipeline.ts` runs 6–9 (`draftFromLines`, or `readReceipt` for everything at once). A value the reader is unsure of, or worked out from the others, is marked `check` with a note for the cashier; nothing is corrected silently.

## Setting up

The models aren't kept in git. `npm run ocr:models` downloads them into `models/ocr/` at the repository root, pinned to exact uploads and checked by SHA-256 (`scripts/fetch-ocr-models.mjs`). PaddleOCR names the files `inference.onnx` and `inference.yml`; they're saved as `model.onnx` and `config.yml` because an Android app can't hold two bundled files whose names differ only in their extension. The models are © the PaddlePaddle authors under the Apache License 2.0.

- **SGM Pocket** needs its development build (`npx expo run:android`), since Expo Go doesn't have ONNX Runtime; in Expo Go the Scan button is hidden. `patches/onnxruntime-react-native+1.24.3.patch` (applied by patch-package after every `npm install`) lets that package build with Gradle 9, the same change ONNX Runtime made upstream, and links it the way Expo SDK 57 expects. Skia decodes the photo in native code. The models add about 31 MB to the app.
- **SGM Desk** loads onnxruntime-node from `node_modules` and the models from `models/ocr` while developing. For the installer, `apps/desk/scripts/stage-ocr.cjs` runs before electron-builder packs and gathers both into `build/ocr`, which `extraResources` copies into the app's `resources` folder. That adds about 95 MB before compression.

`node scripts/setup-ocr.mjs` makes the config changes for both apps.

## Tests

`npm test` runs the reader's unit tests (`*.test.ts` in this folder). `receipt.e2e.test.ts` reads `samples/receipt_00.jpg` and `receipt_11.jpg` with the real models through onnxruntime-node and checks every field. It is skipped until the models are downloaded and onnxruntime-node and jpeg-js are installed.

The samples are written in a handwriting font, not by a person. Measure the reader on real receipts from the store before relying on it, and keep the photos the cashier corrected: they show which stage to tune.

## Tuning

| Setting | Where | Default |
| --- | --- | --- |
| Detector input size | `DEFAULT_ENGINE_OPTIONS.detMaxSide` (`engine.ts`) | 960 px. Larger finds smaller writing, but is slower |
| Detector thresholds | `thresh`, `boxThresh`, `unclipRatio` in the engine options | From the model's `config.yml` |
| Characters allowed | `charset` (`recognize.ts`) | `'latin'` |
| Photo too dark or blurry | `PHOTO_LIMITS` (`preprocess.ts`) | brightness 55, sharpness 20 |
| Unsure below | `MIN_CONFIDENCE` (`checks.ts`) | 0.8 |

Each `TextResult` carries `timings` in milliseconds for the prepare, detect and read stages, so speed can be measured on a real phone.
