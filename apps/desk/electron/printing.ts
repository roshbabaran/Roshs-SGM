/**
 * Receipt printing for thermal printers. The receipt is laid out in a hidden
 * window, measured, and printed on a page exactly as long as the receipt, so the
 * printer doesn't feed blank paper. With a printer chosen in Settings it prints
 * straight away; otherwise Windows shows its print dialog.
 */
import { BrowserWindow, type WebContents } from 'electron';

import type { PrinterInfo } from './bridge';

const MICRONS_PER_CSS_PIXEL = 25_400 / 96;

export async function listPrinters(contents: WebContents): Promise<PrinterInfo[]> {
  const printers = await contents.getPrintersAsync();
  return printers.map((p) => ({ name: p.name, displayName: p.displayName || p.name, description: p.description || undefined }));
}

export async function printReceipt(html: string, options: { paperWidthMm: 58 | 80; printerName?: string }): Promise<void> {
  const window = new BrowserWindow({
    show: false,
    width: Math.ceil((options.paperWidthMm * 1000) / MICRONS_PER_CSS_PIXEL),
    height: 600,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const heightPx = Number(await window.webContents.executeJavaScript('document.documentElement.scrollHeight')) || 600;
    await new Promise<void>((resolve, reject) => {
      window.webContents.print(
        {
          silent: Boolean(options.printerName),
          deviceName: options.printerName,
          printBackground: false,
          margins: { marginType: 'none' },
          pageSize: {
            width: options.paperWidthMm * 1000,
            // A little extra so the last line clears the cutter.
            height: Math.ceil(heightPx * MICRONS_PER_CSS_PIXEL) + 8_000,
          },
        },
        (success, failureReason) => {
          if (success) resolve();
          else reject(new Error(/cancel/i.test(failureReason) ? 'Printing was cancelled.' : failureReason || 'The printer did not respond.'));
        },
      );
    });
  } finally {
    window.destroy();
  }
}
