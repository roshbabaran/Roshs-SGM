/**
 * Holds the app back when the owner says so (sgm.app_policy on the server):
 * an old version must update first, or SGM is turned off for everyone. It also
 * offers a newer version once one can be installed. The last answer from the
 * server is kept on the device, so a block still holds while offline.
 */
import { ApiError, APP_STATUS_OK, loginFormSchema, put, type AppStatus, type MetaRecord, type UpdateSignIn } from '@sgm/core';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View, type TextInput } from 'react-native';

import { Banner } from './Basics';
import { Button } from './Button';
import { DeviceIdField } from './DeviceIdField';
import { useServices } from './services-context';
import { Text } from './Text';
import { TextField } from './TextField';
import { radius, spacing, useTheme } from './theme';
import { useZodForm } from './useZodForm';

const STATUS_ID = 'app-status';
const STATUS_EVERY_MS = 15 * 60_000;
const UPDATE_EVERY_MS = 30 * 60_000;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
      setNote(`Couldn't update: ${message(e)}`);
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
        {updateRequired ? <UpdateNow /> : null}
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

/**
 * Update now, on the Update required screen. When nobody is signed in (SGM Desk signs out when it closes), it asks
 * for a username and PIN first: a sign-in that only downloads the update, which the server takes even from a
 * version too old to sign in.
 */
function UpdateNow() {
  const { api, session, updates, deviceId } = useServices();
  const form = useZodForm(loginFormSchema, { username: session.current()?.user.username ?? '', pin: '' });
  const [asking, setAsking] = useState(false);
  const [signIn, setSignIn] = useState<UpdateSignIn | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The server turned this device away until the owner or an admin approves it.
  const [needsApproval, setNeedsApproval] = useState(false);
  const pinRef = useRef<TextInput>(null);

  if (!updates) {
    return (
      <Text muted align="center">
        Ask the owner for the new version.
      </Text>
    );
  }

  const install = async (token?: string) => {
    setNote(await updates.install(token));
    setAsking(false);
  };

  const start = async () => {
    setError(null);
    const fresh = signIn && new Date(signIn.expiresAt).getTime() > Date.now() + 60_000 ? signIn.token : undefined;
    if (!fresh && !session.token()) {
      setAsking(true);
      return;
    }
    setBusy(true);
    try {
      await install(fresh);
    } catch (e) {
      // The sign-in on this device may have run out: sign in again for the update.
      setError(message(e));
      setAsking(true);
    } finally {
      setBusy(false);
    }
  };

  const signInAndUpdate = form.handleSubmit(async ({ username, pin }) => {
    setBusy(true);
    setError(null);
    setNeedsApproval(false);
    try {
      const fresh = await api.updateLogin(username, pin, deviceId);
      setSignIn(fresh);
      form.set('pin', '');
      await install(fresh.token);
    } catch (e) {
      setError(message(e));
      setNeedsApproval(e instanceof ApiError && e.status === 403);
    } finally {
      setBusy(false);
    }
  });

  if (!asking) {
    return (
      <>
        <Button title="Update now" icon="download-outline" onPress={() => void start()} loading={busy} />
        {error ? <Banner tone="danger">{error}</Banner> : null}
        {note ? (
          <Text muted align="center">
            {note}
          </Text>
        ) : null}
      </>
    );
  }

  return (
    <View style={styles.signIn}>
      <Text align="center">Sign in to download the update. SGM opens again once it is installed.</Text>
      <TextField
        label="Username"
        value={form.values.username}
        onChangeText={(v) => form.set('username', v)}
        error={form.errors.username}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="username"
        autoFocus
        returnKeyType="next"
        onSubmitEditing={() => pinRef.current?.focus()}
      />
      <TextField
        ref={pinRef}
        label="PIN"
        value={form.values.pin}
        onChangeText={(v) => form.set('pin', v.replace(/\D/g, ''))}
        error={form.errors.pin}
        secureTextEntry
        keyboardType="number-pad"
        maxLength={8}
        returnKeyType="go"
        onSubmitEditing={signInAndUpdate}
      />
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {needsApproval ? <DeviceIdField /> : null}
      <Button title="Sign in and update" icon="download-outline" onPress={signInAndUpdate} loading={busy} fullWidth />
      <Button title="Cancel" variant="ghost" onPress={() => setAsking(false)} disabled={busy} fullWidth />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  signIn: { width: '100%', maxWidth: 360, gap: spacing.md },
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
