/**
 * The owner's remote switch for the apps, kept on the server in sgm.app_policy:
 * a minimum version for each app (older copies must update before they can be
 * used) and an on/off switch for every copy at once. The apps ask with
 * ApiClient.appStatus(), and the server refuses sign-in and sync the same way.
 */

/** How each app names itself to the server, in the X-SGM-App header ("desk/1.2.0"). */
export type AppPlatform = 'desk' | 'android' | 'ios';

export interface AppStatus {
  /** ok: carry on. update_required: this version is too old. disabled: the owner turned SGM off. */
  state: 'ok' | 'update_required' | 'disabled';
  /** The owner's note for the people using the app. */
  message: string | null;
  /** The oldest version still allowed. */
  minVersion: string | null;
}

export const APP_STATUS_OK: AppStatus = { state: 'ok', message: null, minVersion: null };

/** The X-SGM-App header for this app, e.g. "android/1.2.0". */
export function appHeader(platform: AppPlatform, version: string): string {
  return `${platform}/${version}`;
}

/** Compares dotted version numbers ("1.2.10" is newer than "1.2.9"): negative when a is older than b. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split('.').slice(0, 3).map((p) => parseInt(p, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
