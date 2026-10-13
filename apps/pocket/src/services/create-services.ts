/**
 * Connects the shared screens to the phone: SQLite for offline data, the
 * phone's secure storage for the sign-in token, and the system print dialog.
 */
import { DemoApi, HttpApi, ObservableStore, setUuidGenerator } from '@sgm/core';
import { createAppServices, once } from '@sgm/ui';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as Print from 'expo-print';
import * as SecureStore from 'expo-secure-store';

import { openSqliteStore } from './sqlite-store';

// Phones have no global `crypto`, so record IDs come from expo-crypto.
setUuidGenerator(Crypto.randomUUID);

const DEVICE_KEY = 'sgm.device-id';

/** A permanent ID for this phone, made on first launch; the owner approves it once on the server. */
async function loadDeviceId(): Promise<string> {
  let id = await SecureStore.getItemAsync(DEVICE_KEY);
  if (!id) {
    id = Crypto.randomUUID();
    await SecureStore.setItemAsync(DEVICE_KEY, id);
  }
  return id;
}

export const createPocketServices = once(async () => {
  const apiUrl = process.env.EXPO_PUBLIC_API_URL;
  return createAppServices({
    appName: 'SGM Pocket',
    platform: 'pocket',
    appVersion: Constants.expoConfig?.version ?? '0.0.0',
    deviceId: await loadDeviceId(),
    store: new ObservableStore(await openSqliteStore('sgm.db')),
    api: apiUrl ? new HttpApi(apiUrl) : new DemoApi(),
    secure: {
      getItem: (key) => SecureStore.getItemAsync(key),
      setItem: (key, value) => SecureStore.setItemAsync(key, value),
      removeItem: (key) => SecureStore.deleteItemAsync(key),
    },
    // The system print dialog (Android print service, AirPrint). Bluetooth receipt printers need their own library.
    // Android only opens its print screen, so a report can't be confirmed as printed.
    printer: {
      print: (html) => Print.printAsync({ html }),
      printDocument: (html) => Print.printAsync({ html }).then(() => 'opened' as const),
    },
  });
});
