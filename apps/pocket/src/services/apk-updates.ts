/**
 * New versions of SGM Pocket that come as a new APK (anything that changes
 * native code). Screens and logic arrive on their own through expo-updates;
 * this covers the rest. The SGM API (<API>/updates/android) hands latest.json
 * and the APK only to signed-in people on approved phones, and Android asks
 * the person to confirm the install, which keeps the phone's data.
 */
import { SESSION_KEY, type Session } from '@sgm/core';
import type { UpdateDownload } from '@sgm/ui';
import * as Application from 'expo-application';
import { File, Paths } from 'expo-file-system';
import { getContentUriAsync } from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/** What scripts/release.mjs uploads next to each APK. */
interface LatestApk {
  version: string;
  versionCode: number;
  file: string;
}

const FLAG_GRANT_READ_URI_PERMISSION = 1;

async function signedInToken(): Promise<string | null> {
  try {
    const session = JSON.parse((await SecureStore.getItemAsync(SESSION_KEY)) ?? 'null') as Session | null;
    return session?.token ?? null;
  } catch {
    return null;
  }
}

export function createApkUpdates(apiUrl: string) {
  const base = `${apiUrl.replace(/\/+$/, '')}/updates/android`;
  const installed = Number(Application.nativeBuildVersion ?? 0);

  // The APK download in progress, for the progress bars on the Update required screen and in Settings.
  let download: UpdateDownload | null = null;
  const listeners = new Set<(download: UpdateDownload | null) => void>();
  const report = (next: UpdateDownload | null) => {
    download = next;
    for (const listener of listeners) listener(next);
  };
  // One download at a time, even when Update is pressed in two places.
  let installing: Promise<string> | null = null;

  async function downloadAndInstall(signIn?: string): Promise<string> {
    const found = await newer(signIn);
    if (!found) return `SGM Pocket ${Application.nativeApplicationVersion ?? ''} is the latest version.`;
    const { info, token } = found;
    const apk = new File(Paths.cache, info.file.replace(/[^\w.-]/g, '_'));
    if (apk.exists) apk.delete();
    report({ version: info.version, received: 0, total: null });
    try {
      const task = File.createDownloadTask(`${base}/${encodeURIComponent(info.file)}`, apk, {
        headers: { Authorization: `Bearer ${token}` },
        onProgress: ({ bytesWritten, totalBytes }) =>
          report({ version: info.version, received: bytesWritten, total: totalBytes > 0 ? totalBytes : null }),
      });
      if (!(await task.downloadAsync())) throw new Error('The download stopped. Try again.');
      await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
        data: await getContentUriAsync(apk.uri),
        type: 'application/vnd.android.package-archive',
        flags: FLAG_GRANT_READ_URI_PERMISSION,
      });
    } finally {
      report(null);
    }
    return `Installing SGM Pocket ${info.version}. Tap Install when Android asks.`;
  }

  /**
   * The newer APK on the server, or null when this phone is up to date or isn't Android. `signIn` is a sign-in from
   * /updates/login, for when nobody is signed in; without either, it rejects.
   */
  async function newer(signIn?: string): Promise<{ info: LatestApk; token: string } | null> {
    if (Platform.OS !== 'android') return null;
    const token = signIn ?? (await signedInToken());
    if (!token) throw new Error('Sign in to download the update.');
    const response = await fetch(`${base}/latest.json`, { headers: { Authorization: `Bearer ${token}` } });
    if (response.status === 404) return null; // nothing released yet
    if (!response.ok) throw new Error((await response.text().catch(() => '')) || `Server error ${response.status}`);
    const info = (await response.json()) as LatestApk;
    return info.versionCode > installed ? { info, token } : null;
  }

  return {
    async available(): Promise<string | null> {
      try {
        return (await newer())?.info.version ?? null;
      } catch {
        return null;
      }
    },

    install(signIn?: string): Promise<string> {
      installing ??= downloadAndInstall(signIn).finally(() => {
        installing = null;
      });
      return installing;
    },

    watchDownload(listener: (download: UpdateDownload | null) => void): () => void {
      listeners.add(listener);
      listener(download);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
