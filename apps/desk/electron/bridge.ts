/**
 * The only door between SGM Desk's screens and the PC. The screens get exactly
 * these functions (as window.sgm) and nothing else: no file system, no Node.js.
 * Shared by preload.ts (which builds it) and the screens (which call it).
 */
import type { Collection, PaperWidth, StoreOp, StoreRecord } from '@sgm/core';

export interface PrinterInfo {
  name: string;
  displayName: string;
  description?: string;
}

export interface SgmBridge {
  app: {
    info(): Promise<{ version: string; deviceId: string; platform: string }>;
  };
  /** The local SQLite database (offline mode). */
  store: {
    get(collection: Collection, id: string): Promise<StoreRecord | null>;
    list(collection: Collection): Promise<StoreRecord[]>;
    batch(ops: StoreOp[]): Promise<void>;
  };
  /** Small secrets (the sign-in token), encrypted with Windows' own encryption. */
  secure: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
  };
  printer: {
    list(): Promise<PrinterInfo[]>;
    print(html: string, options: { paperWidthMm: PaperWidth; printerName?: string }): Promise<void>;
    /** A4 pages such as reports, through the Windows print dialog. Resolves "sent" or "cancelled"; rejects when it fails. */
    printDocument(html: string): Promise<'sent' | 'cancelled'>;
  };
  updates: {
    check(): Promise<string>;
  };
}

/** IPC channel names. */
export const IPC = {
  appInfo: 'sgm:app-info',
  storeGet: 'sgm:store-get',
  storeList: 'sgm:store-list',
  storeBatch: 'sgm:store-batch',
  secureGet: 'sgm:secure-get',
  secureSet: 'sgm:secure-set',
  secureRemove: 'sgm:secure-remove',
  printerList: 'sgm:printer-list',
  printerPrint: 'sgm:printer-print',
  printerPrintDocument: 'sgm:printer-print-document',
  updatesCheck: 'sgm:updates-check',
} as const;
