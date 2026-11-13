import { contextBridge, ipcRenderer } from 'electron';

import { IPC, type SgmBridge, type UpdateDownload } from './bridge';

/**
 * Calls the main process. Electron puts "Error invoking remote method '…': Error: "
 * in front of every error message, so this keeps only the part a person can read.
 */
function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args).catch((e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, ''));
  });
}

const bridge: SgmBridge = {
  app: {
    info: () => invoke(IPC.appInfo),
  },
  store: {
    get: (collection, id) => invoke(IPC.storeGet, collection, id),
    list: (collection) => invoke(IPC.storeList, collection),
    batch: (ops) => invoke(IPC.storeBatch, ops),
  },
  secure: {
    getItem: (key) => invoke(IPC.secureGet, key),
    setItem: (key, value) => invoke(IPC.secureSet, key, value),
    removeItem: (key) => invoke(IPC.secureRemove, key),
  },
  printer: {
    list: () => invoke(IPC.printerList),
    print: (html, options) => invoke(IPC.printerPrint, html, options),
    printDocument: (html) => invoke(IPC.printerPrintDocument, html),
  },
  updates: {
    check: () => invoke(IPC.updatesCheck),
    ready: () => invoke(IPC.updatesReady),
    install: (token) => invoke(IPC.updatesInstall, token),
    watchDownload: (listener) => {
      let moved = false;
      const onChange = (_event: unknown, download: UpdateDownload | null) => {
        moved = true;
        listener(download);
      };
      ipcRenderer.on(IPC.updatesDownloadChanged, onChange);
      // Where it is now, unless the download has already moved on by the time the answer comes.
      invoke<UpdateDownload | null>(IPC.updatesDownload).then(
        (download) => !moved && listener(download),
        () => undefined,
      );
      return () => {
        ipcRenderer.removeListener(IPC.updatesDownloadChanged, onChange);
      };
    },
  },
  backups: {
    info: () => invoke(IPC.backupsInfo),
    create: () => invoke(IPC.backupsCreate),
    openFolder: () => invoke(IPC.backupsOpen),
  },
  ocr: {
    read: (image) => invoke(IPC.ocrRead, { width: image.width, height: image.height, data: image.data }),
  },
};

contextBridge.exposeInMainWorld('sgm', bridge);
