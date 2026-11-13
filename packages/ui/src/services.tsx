/**
 * Everything a screen needs from the device (database, server, printer...),
 * provided once by each app. Screens stay the same on SGM Desk and SGM Pocket;
 * only the services behind them differ.
 */
import {
  can,
  loadDeviceSettings,
  seedDemoData,
  SessionManager,
  SyncEngine,
  workLocationFor,
  type ApiClient,
  type Collection,
  type DeviceSettings,
  type Location,
  type MetaRecord,
  type ObservableStore,
  type OpContext,
  type PaperWidth,
  type Permission,
  type PixelImage,
  type SecureStorage,
  type Session,
  type StoreRecord,
  type SyncStatus,
  type TextResult,
  type User,
} from '@sgm/core';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { AppGate } from './AppGate';
import { ServicesContext, useServices } from './services-context';
import { Text } from './Text';
import { spacing, useTheme } from './theme';

export interface PrinterInfo {
  name: string;
  displayName: string;
  /** Usually the printer model, e.g. "XP-58". */
  description?: string;
}

/**
 * How printing a report ended: "sent" once the pages have gone to the printer,
 * "cancelled" when the person closed the print dialog, or "opened" when the
 * device only opens its print screen and can't tell what happened next.
 */
export type PrintOutcome = 'sent' | 'cancelled' | 'opened';

export interface ReceiptPrinter {
  /** Printers installed on this PC (SGM Desk only). */
  listPrinters?: () => Promise<PrinterInfo[]>;
  /** Prints a receipt: silently when printerName is given, otherwise through the system print dialog. */
  print(html: string, options: { paperWidthMm: PaperWidth; printerName?: string }): Promise<void>;
  /** Prints a full page (A4), such as a report, through the system print dialog. Rejects when it fails. */
  printDocument(html: string): Promise<PrintOutcome>;
}

/** Where a receipt photo comes from: the phone's camera or gallery, or a file on the PC. */
export type PhotoSource = 'camera' | 'library' | 'file';

/** A photo picked for scanning. */
export interface ScanPhoto {
  /** For showing the photo on screen. */
  uri: string;
  /** Its pixels, already shrunk to the size the reader works on. */
  image: PixelImage;
}

/** Reads photos of handwritten receipts on this device (the reader is in packages/core/src/ocr). */
export interface ReceiptScanner {
  /** Where photos can come from here, in the order to offer them. */
  sources: PhotoSource[];
  /** Asks for a photo; resolves null when the person cancels. */
  pickPhoto(source: PhotoSource): Promise<ScanPhoto | null>;
  /**
   * Finds and reads every line of writing on a receipt, with a second look at handwriting (readReceiptText in
   * @sgm/core). Rejects with a message for the person when it can't.
   */
  readText(image: PixelImage): Promise<TextResult>;
}

/** An update being downloaded, for the progress bar (UpdateProgress). */
export interface UpdateDownload {
  /** The version on its way, when known. */
  version: string | null;
  /** Bytes received so far. */
  received: number;
  /** The whole download in bytes, or null when the server didn't say. */
  total: number | null;
}

/** Where this device keeps its backups, how many there are and when the newest was made. */
export interface BackupInfo {
  folder: string;
  count: number;
  lastAt: string | null;
}

export interface PlatformServices {
  appName: string;
  platform: 'desk' | 'pocket' | 'browser';
  appVersion: string;
  deviceId: string;
  store: ObservableStore;
  api: ApiClient;
  secure: SecureStorage;
  printer: ReceiptPrinter;
  /** Copies text, such as the Device ID, for pasting elsewhere. Missing where there is no clipboard. */
  copyText?: (text: string) => Promise<void>;
  /** Checks for a new version of the app. Returns a message for the person. */
  checkForUpdates?: () => Promise<string>;
  /** Newer versions of the installed app (missing in development and the browser preview). */
  updates?: {
    /** Looks for a newer version; resolves its number once it can be installed, otherwise null. */
    available(): Promise<string | null>;
    /**
     * Installs it (SGM Desk restarts; SGM Pocket opens Android's installer). Resolves a message for the person.
     * Without `token`, a sign-in from api.updateLogin, it needs someone signed in.
     */
    install(token?: string): Promise<string>;
    /**
     * Calls `listener` with the download in progress, straight away and then as it moves, and with null when no
     * update is downloading. Returns a function that stops listening.
     */
    watchDownload?(listener: (download: UpdateDownload | null) => void): () => void;
  };
  /** Copies of this device's data, weekly and on demand (SGM Desk only; needs backups.manage). */
  backups?: {
    info(): Promise<BackupInfo>;
    create(): Promise<BackupInfo>;
    openFolder(): Promise<void>;
  };
  /** Scanning handwritten receipts into a sale. Missing where the reader can't run (Expo Go, the browser preview). */
  ocr?: ReceiptScanner;
}

export interface AppServices extends PlatformServices {
  session: SessionManager;
  sync: SyncEngine;
}

/** Wires up sign-in and sync on top of what the platform provides, then starts syncing. */
export async function createAppServices(platform: PlatformServices): Promise<AppServices> {
  if (platform.api.mode === 'demo') await seedDemoData(platform.store);

  const session = new SessionManager({
    api: platform.api,
    secure: platform.secure,
    deviceId: platform.deviceId,
    findUser: (id) => platform.store.get<User>('users', id),
  });
  await session.restore();
  const sync = new SyncEngine({
    store: platform.store,
    api: platform.api,
    getToken: session.token,
    // A disabled account, or a token the server no longer takes, can't be used to sign in offline again.
    onAuthError: () => void session.forgetOfflineSignIn(),
  });

  // Sync right after someone signs in or out.
  let token = session.token();
  session.subscribe((current) => {
    if ((current?.token ?? null) === token) return;
    token = current?.token ?? null;
    void sync.syncNow();
  });
  // Each successful sync proves the server still accepts this device, so the offline clock restarts.
  let lastSyncedAt = sync.getStatus().lastSyncedAt;
  sync.subscribe((status) => {
    if (!status.lastSyncedAt || status.lastSyncedAt === lastSyncedAt) return;
    lastSyncedAt = status.lastSyncedAt;
    void session.touch();
  });

  sync.start();
  return { ...platform, session, sync };
}

/** Runs an async setup function once, however many times it's called. */
export function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let result: Promise<T> | null = null;
  return () => (result ??= fn());
}

/** Shows a loading screen while the app opens its database, then provides the services (behind AppGate, the owner's on/off switch). */
export function ServicesBoundary({ create, children }: { create: () => Promise<AppServices>; children: ReactNode }) {
  const { colors } = useTheme();
  const [services, setServices] = useState<AppServices | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    create().then(
      (s) => !cancelled && setServices(s),
      (e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [create]);

  if (error) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <Text variant="subheading">SGM couldn't start</Text>
        <Text muted align="center">
          {error}
        </Text>
      </View>
    );
  }
  if (!services) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.primary} />
        <Text muted>Opening SGM…</Text>
      </View>
    );
  }
  return (
    <ServicesContext.Provider value={services}>
      <AppGate>{children}</AppGate>
    </ServicesContext.Provider>
  );
}

export { useServices };

export function useSession(): Session | null {
  const { session } = useServices();
  return useSyncExternalStore(session.subscribe, session.current, session.current);
}

export function useSyncStatus(): SyncStatus {
  const { sync } = useServices();
  return useSyncExternalStore(sync.subscribe, sync.getStatus, sync.getStatus);
}

/** All records in a collection; refreshes whenever that collection changes. */
export function useCollection<T extends StoreRecord>(collection: Collection): { data: T[]; loading: boolean } {
  const { store } = useServices();
  const [state, setState] = useState<{ data: T[]; loading: boolean }>({ data: [], loading: true });

  useEffect(() => {
    let active = true;
    const load = () =>
      store.list<T>(collection).then((data) => {
        if (active) setState({ data, loading: false });
      });
    void load();
    const unsubscribe = store.subscribe((changed) => {
      if (changed.includes(collection)) void load();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [store, collection]);

  return state;
}

/** This device's settings (branch, printer, paper width). */
export function useDeviceSettings(): DeviceSettings | null {
  const { store } = useServices();
  const { data: meta } = useCollection<MetaRecord>('meta');
  const { data: locations } = useCollection<Location>('locations');
  const [settings, setSettings] = useState<DeviceSettings | null>(null);
  const defaultLocation = locations[0]?.id ?? '';

  useEffect(() => {
    let active = true;
    void loadDeviceSettings(store, defaultLocation).then((s) => {
      if (active) setSettings(s);
    });
    return () => {
      active = false;
    };
  }, [store, meta, defaultLocation]);

  return settings;
}

/** Who is working, where, and what they may do: the context every operation needs. */
export function useWork() {
  const { store, deviceId } = useServices();
  const session = useSession();
  const settings = useDeviceSettings();
  const { data: locations } = useCollection<Location>('locations');
  const user = session?.user ?? null;
  const deviceLocationId = settings?.locationId ?? '';
  const locationId = user && deviceLocationId ? workLocationFor(user, deviceLocationId) : deviceLocationId;
  const location = locations.find((l) => l.id === locationId) ?? null;

  const ctx: OpContext = useMemo(() => ({ store, user, deviceId, locationId }), [store, user, deviceId, locationId]);
  const allowed = useCallback((permission: Permission) => can(user, permission), [user]);

  return { user, locationId, location, locations, settings, ctx, can: allowed };
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, padding: spacing.xl },
});
