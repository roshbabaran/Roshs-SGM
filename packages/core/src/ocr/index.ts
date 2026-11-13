/**
 * Reading handwritten receipts with PaddleOCR (PP-OCRv6), offline on the
 * device. See README.md in this folder for how the stages fit together.
 */
export type { DraftField, DraftLine, DraftTarget, FieldStatus, OcrLine, OcrModel, OcrRuntime, OcrText, PixelImage, ReceiptDraft, Rect, Tensor } from './types';
export { DEFAULT_ENGINE_OPTIONS, createOcrEngine, readText, type OcrEngine, type OcrEngineOptions, type TextResult } from './engine';
export { INK_STRETCH, PHOTO_LIMITS, fitImage, inkOnly, photoProblem, photoQuality, type PhotoQuality } from './preprocess';
export { SECOND_LOOK, draftFromLines, draftProblem, draftToCart, readReceipt, readReceiptText, readingImage, type ReceiptOptions } from './pipeline';
export { parseReceiptDate, parseReceiptTime } from './normalize';
export { listPriceOf, targetExists, targetLabel, type Catalogue } from './match';
export { learnedAliases, loadOcrAliases, saveOcrAliases, type OcrAliases } from './aliases';
export { NAME_SUGGEST, linkedCustomer, nameSimilarity, nameSuggestions, scannedSaleInput, scannedTotal, type ScannedSale } from './sale';
