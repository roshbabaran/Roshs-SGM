# Receipt reader

Reads a photo of a handwritten SGM receipt into a draft sale that the cashier checks and saves. It runs offline on the device: PaddleOCR's PP-OCRv6 small models find and read the writing, and the code in this folder works out what the writing means. Both apps share this code. Only how a photo is taken and how the models are run differ:

| | Photo | Models run by |
| --- | --- | --- |
| SGM Pocket | Camera or gallery (`apps/pocket/src/services/ocr.ts`) | onnxruntime-react-native, on the phone |
| SGM Desk | A photo file (`apps/desk/src/services/ocr.ts`) | onnxruntime-node, on a worker thread in Electron's main process (`apps/desk/electron/ocr.ts`) |

The Scan receipt button at the top right of Transactions opens `ReceiptScanDialog` (packages/ui): take or choose a photo, the reader fills in a review window, the cashier checks and corrects it against the photo, then presses Save. Nothing is saved before Save. Save needs only a date that isn't in the future and at least one line with a product and a quantity (incomplete lines are left out). It records the sale with `recordSale`, paid in cash at SGM's prices, with:

- `Sale.slipNo`: the receipt number, so the same receipt can't be entered twice;
- `Sale.registeredName`: the name written on the receipt. A customer is linked only when the name is theirs exactly (ignoring case) or the cashier picks them; a scanned name never adds a customer;
- `Sale.createdAt`: when the sale happened (`saleTimeFor` in operations.ts). A time written on the receipt or typed is used as it is. Otherwise a receipt dated today gets the time Save is pressed, and an earlier one 11:59 PM on its date, so it falls on the right day in every daily report; both set `Sale.timeEstimated`. `Sale.recordedAt` is when it was entered. Its stock movements and account entries carry the same time.

## Stages

| Stage | What happens | File |
| --- | --- | --- |
| 1. Capture | Camera, gallery or file; the photo is turned upright and shrunk to 1600 px on its long side | each app's `services/ocr.ts` |
| 2. Prepare | Brightness and sharpness check; the ink-only copy (`inkOnly`); the detector's input | `preprocess.ts` |
| 3. Find lines | The detector's map turned into boxes (PaddleOCR's DBPostProcess) | `detect.ts` |
| 4. Crop lines | Each box cut out level, 48 px high | `preprocess.ts` |
| 5. Read lines | Recogniser in batches, CTC decoding with the model's own dictionary, Latin characters only. Words are split where the recogniser left out a space (a gap between characters much wider than the line's usual gap, `WORD_GAP`), which it does for handwritten names ("LizaRamos") and printed headings in one box ("SERVICEQUANTITY"); each word keeps where its characters were read | `recognize.ts` |
| 5b. Second look | Places the first read handles badly are cut out closer and read on their own: handwriting that shared a line with its printed label (a handwritten Registered Name read alone instead of with the label), and the empty cells of item rows that have other writing (a "1" under QUANTITY the detector missed). A second read is kept only when it is sure enough and looks like what belongs there (`SECOND_LOOK`) | `layout.ts` (`secondLookOf`), `pipeline.ts` (`readReceiptText`) |
| 6. Fields | The printed headings (QTY or QUANTITY, UNIT, ARTICLES or ITEM DESCRIPTION/NATURE OF SERVICE, UNIT PRICE or UNIT COST/PRICE, AMOUNT, TOTAL) give the columns and rows. The labels Registered Name:, Date: and No. or the printed № (read as "N?", "Nº" or "N°") give those fields, and without a label a lone printed number above the table is taken as the receipt number and marked for checking: the value is the rest of the label's line, else the nearest writing to its right, else the writing just below, and it stops at the next label. Void lines drawn down the price or amount column, and rows that are only one unsure speck, are dropped | `layout.ts` |
| 7. Clean values | Amounts, quantities, dates, times and receipt numbers from handwriting. A date and time run together ("11/1/262:30pm") are separated; a date whose "/" were read as "1", "l" or "\|" ("4124126") is read when exactly one real date fits, marked for checking. Sizes the reader gets wrong ("11K", "11KC", "IIKG", "Gasul2.Fkg") read as "11 kg" or "2.7 kg". Names get their words back ("LizaRamos", "M aria Santos") | `normalize.ts`, `pipeline.ts` |
| 8. Products | Each line matched to a product or set; the written price settles refill or new, and picks the product when the words fit several (just "11kg") or none | `match.ts` |
| 9. Checks | Quantity × unit price = amount, and the amounts add up to the total. A quantity not written is the amount over the unit price, else over SGM's refill or new price, else 1 | `checks.ts`, `pipeline.ts` |
| 10. Review | The cashier confirms each line against the photo, then saves; the total shown and the payment sent come from one helper, with the linked customer's prices. A name a letter or two off from a customer on the list ("loy Navarro" for Joy Navarro) brings that customer up first as a suggestion (`nameSuggestions`); nothing is linked unless the name matches exactly or the cashier picks them, and no customer is ever added | `pipeline.ts`, `sale.ts`, `ReceiptScanDialog` |
| 11. Learn | Products the cashier corrected are remembered on the device | `aliases.ts` |

`engine.ts` runs stages 2–5 (`readText`), `pipeline.ts` adds the second look (`readReceiptText`) and runs 6–9 (`draftFromLines`, or `readReceipt` for everything at once). Both apps' scanners read `readingImage(photo)`, the ink-only copy, with `readReceiptText`, as `readReceipt` does. A value the reader is unsure of, or worked out from the others, is marked `check` with a note for the cashier; nothing is corrected silently.

## Setting up

The models aren't kept in git. `npm run ocr:models` downloads them into `models/ocr/` at the repository root, pinned to exact uploads and checked by SHA-256 (`scripts/fetch-ocr-models.mjs`). PaddleOCR names the files `inference.onnx` and `inference.yml`; they're saved as `model.onnx` and `config.yml` because an Android app can't hold two bundled files whose names differ only in their extension. The models are © the PaddlePaddle authors under the Apache License 2.0.

- **SGM Pocket** needs its development build (`npx expo run:android`), since Expo Go doesn't have ONNX Runtime; in Expo Go the Scan button is hidden. `patches/onnxruntime-react-native+1.24.3.patch` (applied by patch-package after every `npm install`) lets that package build with Gradle 9, the same change ONNX Runtime made upstream, and links it the way Expo SDK 57 expects. Skia decodes the photo in native code. The models add about 31 MB to the app.
- **SGM Desk** loads onnxruntime-node from `node_modules` and the models from `models/ocr` while developing. For the installer, `apps/desk/scripts/stage-ocr.cjs` runs before electron-builder packs and gathers both into `build/ocr`, which `extraResources` copies into the app's `resources` folder. That adds about 95 MB before compression.

`node scripts/setup-ocr.mjs` makes the config changes for both apps.

## Tests

`npm test` runs the reader's unit tests (`*.test.ts` in this folder). `handwriting.test.ts` covers words run together or broken apart, dates read with look-alikes, a label read into the name, and name suggestions. `receipt-fields.test.ts` uses what the models read from a photo of a real booklet (the ITEM DESCRIPTION/NATURE OF SERVICE table), with and without the ink-only step. `receipt.e2e.test.ts` reads `samples/receipt_00.jpg` and `receipt_11.jpg` with the real models through onnxruntime-node and checks every field, and reads two parts of a photo of SGM's real booklet: the printed receipt number (`booklet_number.jpg`) and the item table (`booklet_table.jpg`). It is skipped until the models are downloaded and onnxruntime-node and jpeg-js are installed.

The samples are written in a handwriting font, not by a person. Measure the reader on real receipts from the store before relying on it, and keep the photos the cashier corrected: they show which stage to tune.

## Tuning

| Setting | Where | Default |
| --- | --- | --- |
| Ink only | `ReceiptOptions.inkOnly` (`pipeline.ts`), stretch in `INK_STRETCH` (`preprocess.ts`) | On. Each pixel becomes min(red, blue), so pink and magenta print and speckle fade and black, blue and red ink stay; then the 1st percentile becomes black and the 90th white |
| Detector input size | `DEFAULT_ENGINE_OPTIONS.detMaxSide` (`engine.ts`) | 960 px. Larger finds smaller writing, but is slower |
| Detector thresholds | `thresh`, `boxThresh`, `unclipRatio` in the engine options | From the model's `config.yml` |
| Characters allowed | `charset` (`recognize.ts`) | `'latin'` |
| Photo too dark or blurry | `PHOTO_LIMITS` (`preprocess.ts`) | brightness 55, sharpness 20 |
| Unsure below | `MIN_CONFIDENCE` (`checks.ts`) | 0.8 |
| Word gap | `WORD_GAP` (`recognize.ts`) | A gap 2.4 times the usual gap between characters, and at least 3 output steps |
| Name suggestions | `NAME_SUGGEST` (`sale.ts`) | Suggested from 0.7 alike, shown as the likely customer from 0.88 (spaces and case ignored, look-alike letters counted as the same) |
| Second look kept from | `SECOND_LOOK` (`pipeline.ts`) | 0.5 for a value after a label or a quantity, 0.6 for a price, amount or item (prices need two digits, so a void stroke isn't read as "1") |

Each `TextResult` carries `timings` in milliseconds for the prepare, detect and read stages, so speed can be measured on a real phone.
