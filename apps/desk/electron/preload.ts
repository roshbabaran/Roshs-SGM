import { contextBridge, ipcRenderer } from 'electron';

import { IPC, type SgmBridge } from './bridge';

const bridge: SgmBridge = {
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo),
  },
  store: {
    get: (collection, id) => ipcRenderer.invoke(IPC.storeGet, collection, id),
    list: (collection) => ipcRenderer.invoke(IPC.storeList, collection),
    batch: (ops) => ipcRenderer.invoke(IPC.storeBatch, ops),
  },
  secure: {
    getItem: (key) => ipcRenderer.invoke(IPC.secureGet, key),
    setItem: (key, value) => ipcRenderer.invoke(IPC.secureSet, key, value),
    removeItem: (key) => ipcRenderer.invoke(IPC.secureRemove, key),
  },
  printer: {
    list: () => ipcRenderer.invoke(IPC.printerList),
    print: (html, options) => ipcRenderer.invoke(IPC.printerPrint, html, options),
  },
  updates: {
    check: () => ipcRenderer.invoke(IPC.updatesCheck),
  },
};

contextBridge.exposeInMainWorld('sgm', bridge);
