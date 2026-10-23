/**
 * Connects the shared screens to the phone: SQLite for offline data, the
 * phone's secure storage for the sign-in token, the system print dialog, and
 * the camera and on-phone reader for scanning handwritten receipts.
 */
import { appHeader, DemoApi, HttpApi, ObservableStore, setUuidGenerator } from '@sgm/core';
import { createAppServices, once } from '@sgm/ui';
import * as Application from 'expo-application';
import * as Clipboard from 'expo-clipboard';
import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as Print from 'expo-print';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { createApkUpdates } from './apk-updates';
import { loadDeviceId } from './device-id';
import { createPocketScanner } from './ocr';
import { openSqliteStore } from './sqlite-store';

// Phones have no global `crypto`, so record IDs come from expo-crypto.
setUuidGenerator(Crypto.randomUUID);

export const createPocketServices = once(async () => {
  const apiUrl = process.env.EXPO_PUBLIC_API_URL;
  // The installed APK's version, which only a new APK changes (screen updates over the air keep it).
  const appVersion = Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? '0.0.0';
  const platform = Platform.OS === 'ios' ? 'ios' : 'android';
  const apkUpdates = apiUrl && Platform.OS === 'android' && !__DEV__ ? createApkUpdates(apiUrl) : undefined;
  return createAppServices({
    appName: 'SGM Pocket',
    platform: 'pocket',
    appVersion,
    deviceId: await loadDeviceId(),
    store: new ObservableStore(await openSqliteStore('sgm.db')),
    api: apiUrl ? new HttpApi(apiUrl, { app: appHeader(platform, appVersion) }) : new DemoApi(),
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
    copyText: (text) => Clipboard.setStringAsync(text).then(() => undefined),
    checkForUpdates: apkUpdates?.install,
    updates: apkUpdates,
    ocr: createPocketScanner(),
  });
});
