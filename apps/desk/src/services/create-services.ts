/**
 * Connects the shared screens to this PC. Inside Electron everything goes
 * through the preload bridge (window.sgm). In a plain browser ("npm run
 * desk:web", for working on screens) a stand-in keeps data in the browser.
 */
import { DemoApi, HttpApi, ObservableStore, type ApiClient, type Collection, type LocalStore, type StoreOp, type StoreRecord } from '@sgm/core';
import { createAppServices, once, type PlatformServices } from '@sgm/ui';

import type { SgmBridge } from '../../electron/bridge';
import { browserPlatform } from './browser';

declare global {
  interface Window {
    sgm?: SgmBridge;
  }
}

/** The SGM API server, or the built-in demo server when no address is set. */
export function createApi(): ApiClient {
  const url = process.env.EXPO_PUBLIC_API_URL;
  return url ? new HttpApi(url) : new DemoApi();
}

/** The SQLite database in Electron's main process. */
class DesktopStore implements LocalStore {
  constructor(private readonly bridge: SgmBridge) {}

  get<T extends StoreRecord>(collection: Collection, id: string): Promise<T | null> {
    return this.bridge.store.get(collection, id) as Promise<T | null>;
  }

  list<T extends StoreRecord>(collection: Collection): Promise<T[]> {
    return this.bridge.store.list(collection) as Promise<T[]>;
  }

  batch(ops: StoreOp[]): Promise<void> {
    return this.bridge.store.batch(ops);
  }
}

async function electronPlatform(bridge: SgmBridge): Promise<PlatformServices> {
  const info = await bridge.app.info();
  return {
    appName: 'SGM Desk',
    platform: 'desk',
    appVersion: info.version,
    deviceId: info.deviceId,
    store: new ObservableStore(new DesktopStore(bridge)),
    api: createApi(),
    secure: bridge.secure,
    printer: {
      listPrinters: () => bridge.printer.list(),
      print: (html, options) => bridge.printer.print(html, options),
      printDocument: (html) => bridge.printer.printDocument(html),
    },
    checkForUpdates: () => bridge.updates.check(),
  };
}

export const createDeskServices = once(async () => {
  const bridge = typeof window === 'undefined' ? undefined : window.sgm;
  return createAppServices(bridge ? await electronPlatform(bridge) : browserPlatform(createApi()));
});
