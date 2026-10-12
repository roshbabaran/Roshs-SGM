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
  type SecureStorage,
  type Session,
  type StoreRecord,
  type SyncStatus,
} from '@sgm/core';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { Text } from './Text';
import { spacing, useTheme } from './theme';

export interface PrinterInfo {
  name: string;
  displayName: string;
  /** Usually the printer model, e.g. "XP-58". */
  description?: string;
}

export interface ReceiptPrinter {
  /** Printers installed on this PC (SGM Desk only). */
  listPrinters?: () => Promise<PrinterInfo[]>;
  /** Prints silently when printerName is given, otherwise shows the system print dialog. */
  print(html: string, options: { paperWidthMm: PaperWidth; printerName?: string }): Promise<void>;
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
  /** Checks for a new version of the app (SGM Desk only). Returns a message for the person. */
  checkForUpdates?: () => Promise<string>;
}

export interface AppServices extends PlatformServices {
  session: SessionManager;
  sync: SyncEngine;
}

/** Wires up sign-in and sync on top of what the platform provides, then starts syncing. */
export async function createAppServices(platform: PlatformServices): Promise<AppServices> {
  if (platform.api.mode === 'demo') await seedDemoData(platform.store);

  const session = new SessionManager({ api: platform.api, secure: platform.secure, deviceId: platform.deviceId });
  await session.restore();
  const sync = new SyncEngine({ store: platform.store, api: platform.api, getToken: session.token });

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

const ServicesContext = createContext<AppServices | null>(null);

/** Shows a loading screen while the app opens its database, then provides the services. */
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
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

export function useServices(): AppServices {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('useServices must be used inside <ServicesBoundary>.');
  return services;
}

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
