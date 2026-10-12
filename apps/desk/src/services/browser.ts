/**
 * Stand-ins for running the screens in a normal browser while designing them.
 * Data is kept in this browser's localStorage and the sign-in token is not
 * encrypted, so this is for development only. The real app runs in Electron.
 */
import { MemoryStore, ObservableStore, uuid, type ApiClient, type StoreOp, type StoreSnapshot } from '@sgm/core';
import type { PlatformServices } from '@sgm/ui';
import Constants from 'expo-constants';

const DATA_KEY = 'sgm.preview-data';
const DEVICE_KEY = 'sgm.device-id';

function readJson<T>(key: string): T | undefined {
  try {
    const text = localStorage.getItem(key);
    return text ? (JSON.parse(text) as T) : undefined;
  } catch {
    return undefined;
  }
}

class BrowserStore extends MemoryStore {
  async batch(ops: StoreOp[]): Promise<void> {
    await super.batch(ops);
    try {
      localStorage.setItem(DATA_KEY, JSON.stringify(this.snapshot()));
    } catch {
      // Storage full or blocked: keep working in memory.
    }
  }
}

function deviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = uuid();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

/** Prints through the browser's own print dialog. */
function printInFrame(html: string): Promise<void> {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.style.position = 'fixed';
    frame.style.width = '0';
    frame.style.height = '0';
    frame.style.border = '0';
    frame.srcdoc = html;
    frame.onload = () => {
      frame.contentWindow?.print();
      setTimeout(() => {
        frame.remove();
        resolve();
      }, 500);
    };
    document.body.appendChild(frame);
  });
}

export function browserPlatform(api: ApiClient): PlatformServices {
  return {
    appName: 'SGM Desk',
    platform: 'browser',
    appVersion: `${Constants.expoConfig?.version ?? '0.0.0'} (browser preview)`,
    deviceId: deviceId(),
    store: new ObservableStore(new BrowserStore(readJson<StoreSnapshot>(DATA_KEY))),
    api,
    secure: {
      getItem: async (key) => localStorage.getItem(key),
      setItem: async (key, value) => localStorage.setItem(key, value),
      removeItem: async (key) => localStorage.removeItem(key),
    },
    printer: { print: (html) => printInFrame(html) },
  };
}
