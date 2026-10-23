/**
 * Holds the app back when the owner says so (sgm.app_policy on the server):
 * an old version must update first, or SGM is turned off for everyone. It also
 * offers a newer version once one can be installed. The last answer from the
 * server is kept on the device, so a block still holds while offline.
 */
import { APP_STATUS_OK, put, type AppStatus, type MetaRecord } from '@sgm/core';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button } from './Button';
import { useServices } from './services-context';
import { Text } from './Text';
import { radius, spacing, useTheme } from './theme';

const STATUS_ID = 'app-status';
const STATUS_EVERY_MS = 15 * 60_000;
const UPDATE_EVERY_MS = 30 * 60_000;

export function AppGate({ children }: { children: ReactNode }) {
  const { api, store, sync, updates, appName, appVersion } = useServices();
  const { colors } = useTheme();
  const [status, setStatus] = useState<AppStatus>(APP_STATUS_OK);
  const [newVersion, setNewVersion] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // What the server says, falling back to the last answer while offline.
  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const fresh = await api.appStatus();
        if (!active) return;
        setStatus(fresh);
        await store.batch([put('meta', { id: STATUS_ID, value: fresh })]);
      } catch {
        const saved = await store.get<MetaRecord<AppStatus>>('meta', STATUS_ID);
        if (active && saved) setStatus(saved.value);
      }
    };
    void check();
    const timer = setInterval(() => void check(), STATUS_EVERY_MS);
    // A sync the server refused may mean SGM was just turned off or this version is now too old.
    let lastMessage = sync.getStatus().message;
    const unsubscribe = sync.subscribe((s) => {
      if (s.state === 'error' && s.message !== lastMessage) void check();
      lastMessage = s.message;
    });
    return () => {
      active = false;
      clearInterval(timer);
      unsubscribe();
    };
  }, [api, store, sync]);

  // A newer version that is ready to install.
  useEffect(() => {
    if (!updates) return;
    let active = true;
    const look = () => updates.available().then((version) => active && setNewVersion(version), () => undefined);
    void look();
    const timer = setInterval(() => void look(), UPDATE_EVERY_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [updates]);

  const install = useCallback(async () => {
    if (!updates) return;
    setInstalling(true);
    try {
      setNote(await updates.install());
    } catch (e) {
      setNote(`Couldn't update: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setInstalling(false);
    }
  }, [updates]);

  if (status.state !== 'ok') {
    const updateRequired = status.state === 'update_required';
    return (
      <View style={[styles.blocked, { backgroundColor: colors.background }]}>
        <Text variant="heading" align="center">
          {updateRequired ? 'Update required' : 'SGM is turned off'}
        </Text>
        <Text muted align="center">
          {status.message ??
            (updateRequired
              ? `This version of ${appName} is too old. Update it to keep working.`
              : 'The owner has turned SGM off for now. Try again later.')}
        </Text>
        <Text variant="small" muted align="center">
          {updateRequired && status.minVersion ? `You have ${appVersion}; ${status.minVersion} or newer is needed.` : `${appName} ${appVersion}`}
        </Text>
        {updateRequired ? (
          updates ? (
            <Button title="Update now" icon="download-outline" onPress={install} loading={installing} />
          ) : (
            <Text muted align="center">
              Ask the owner for the new version.
            </Text>
          )
        ) : null}
        {note ? (
          <Text muted align="center">
            {note}
          </Text>
        ) : null}
        <Text variant="small" muted align="center">
          Sales recorded on this device are kept and sync once it can be used again.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      {children}
      {newVersion ? (
        <View style={[styles.banner, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={styles.bannerText}>{note ?? `${appName} ${newVersion} is ready to install.`}</Text>
          <Button title="Update" icon="download-outline" size="sm" onPress={install} loading={installing} />
          <Button title="Later" variant="ghost" size="sm" onPress={() => setNewVersion(null)} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  blocked: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, padding: spacing.xl },
  banner: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    bottom: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderWidth: 1,
    borderRadius: radius.md,
    alignSelf: 'center',
    maxWidth: 560,
  },
  bannerText: { flex: 1 },
});
