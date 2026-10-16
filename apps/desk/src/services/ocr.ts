/**
 * Scanning receipts on this PC: the cashier picks a photo of the receipt (sent
 * from a phone, or from a scanner), the screens shrink it, and Electron's main
 * process reads it (electron/ocr.ts). The browser preview has no reader, so
 * its Scan button is hidden.
 */
import type { PixelImage } from '@sgm/core';
import type { ReceiptScanner, ScanPhoto } from '@sgm/ui';

import type { SgmBridge } from '../../electron/bridge';

/** The photo's long side once shrunk, as on SGM Pocket: plenty for handwriting on a receipt, and quick to read. */
const PHOTO_MAX_SIDE = 1600;

/** Asks for a photo file. Resolves null when the person closes the window without picking one. */
function chooseFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/webp';
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}

/** The photo's pixels: upright (Chromium applies the camera's rotation when decoding), shrunk, on white. */
async function pixelsOf(file: File): Promise<PixelImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("SGM Desk couldn't open that file. Choose a JPEG, PNG or WebP photo of the receipt.");
  }
  try {
    const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error("SGM Desk couldn't read that photo.");
    // Transparent parts of a PNG become white paper instead of black.
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    return { width, height, data: context.getImageData(0, 0, width, height).data };
  } finally {
    bitmap.close();
  }
}

/** The address the dialog shows the photo from. Only the latest is kept, so earlier photos don't pile up in memory. */
let shown: string | null = null;

function showPhoto(file: File): string {
  if (shown) URL.revokeObjectURL(shown);
  shown = URL.createObjectURL(file);
  return shown;
}

async function pickPhoto(): Promise<ScanPhoto | null> {
  const file = await chooseFile();
  if (!file) return null;
  const image = await pixelsOf(file);
  return { uri: showPhoto(file), image };
}

/** Receipt scanning in SGM Desk's window. */
export function createDeskScanner(bridge: SgmBridge): ReceiptScanner {
  return { sources: ['file'], pickPhoto, readText: (image) => bridge.ocr.read(image) };
}
