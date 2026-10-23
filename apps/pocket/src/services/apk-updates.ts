/**
 * New versions of SGM Pocket that come as a new APK (anything that changes
 * native code). Screens and logic arrive on their own through expo-updates;
 * this covers the rest. The SGM API (<API>/updates/android) hands latest.json
 * and the APK only to signed-in people on approved phones, and Android asks
 * the person to confirm the install, which keeps the phone's data.
 */
import { SESSION_KEY, type Session } from '@sgm/core';
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

    async install(signIn?: string): Promise<string> {
      const found = await newer(signIn);
      if (!found) return `SGM Pocket ${Application.nativeApplicationVersion ?? ''} is the latest version.`;
      const { info, token } = found;
      const apk = new File(Paths.cache, info.file.replace(/[^\w.-]/g, '_'));
      await File.downloadFileAsync(`${base}/${encodeURIComponent(info.file)}`, apk, {
        headers: { Authorization: `Bearer ${token}` },
        idempotent: true,
      });
      await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
        data: await getContentUriAsync(apk.uri),
        type: 'application/vnd.android.package-archive',
        flags: FLAG_GRANT_READ_URI_PERMISSION,
      });
      return `Installing SGM Pocket ${info.version}. Tap Install when Android asks.`;
    },
  };
}
