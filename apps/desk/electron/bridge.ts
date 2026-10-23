/**
 * The only door between SGM Desk's screens and the PC. The screens get exactly
 * these functions (as window.sgm) and nothing else: no file system, no Node.js.
 * Shared by preload.ts (which builds it) and the screens (which call it).
 */
import type { Collection, PaperWidth, PixelImage, StoreOp, StoreRecord, TextResult } from '@sgm/core';

export interface PrinterInfo {
  name: string;
  displayName: string;
  description?: string;
}

/** The backups made on this PC (electron/backups.ts). */
export interface BackupInfo {
  folder: string;
  count: number;
  lastAt: string | null;
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
    /** For the "Check for updates" button: a message for the person. */
    check(): Promise<string>;
    /** The downloaded version waiting to install, or null. */
    ready(): Promise<string | null>;
    /**
     * Restarts on the downloaded version, or downloads it first. Resolves a message for the person. `token` is a
     * sign-in from /updates/login, for when nobody is signed in.
     */
    install(token?: string): Promise<string>;
  };
  /** Weekly and on-demand copies of the local database. Only for the owner and admins (backups.manage). */
  backups: {
    info(): Promise<BackupInfo>;
    create(): Promise<BackupInfo>;
    openFolder(): Promise<void>;
  };
  /** Reads the writing on a receipt photo (electron/ocr.ts). */
  ocr: {
    read(image: PixelImage): Promise<TextResult>;
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
  updatesReady: 'sgm:updates-ready',
  updatesInstall: 'sgm:updates-install',
  backupsInfo: 'sgm:backups-info',
  backupsCreate: 'sgm:backups-create',
  backupsOpen: 'sgm:backups-open',
  ocrRead: 'sgm:ocr-read',
} as const;
