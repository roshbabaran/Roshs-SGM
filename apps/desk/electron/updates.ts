/**
 * Automatic updates with electron-updater. They work in the installed app once a
 * `publish` target (for example GitHub Releases) is set in electron-builder.yml;
 * until then, checking just says updates aren't set up.
 */
import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import { existsSync } from 'node:fs';
import path from 'node:path';

function updatesConfigured(): boolean {
  return app.isPackaged && existsSync(path.join(process.resourcesPath, 'app-update.yml'));
}

/** Quiet check when the app opens; the update installs the next time SGM Desk closes. */
export function checkForUpdatesInBackground(): void {
  if (!updatesConfigured()) return;
  autoUpdater.checkForUpdates().catch((error: unknown) => console.warn('Update check failed:', error));
}

/** For the "Check for updates" button. Returns a message for the person. */
export async function checkForUpdates(): Promise<string> {
  if (!app.isPackaged) return 'Updates are only checked in the installed app.';
  if (!updatesConfigured()) return 'Automatic updates are not set up yet.';
  const result = await autoUpdater.checkForUpdates();
  if (!result?.isUpdateAvailable) return `SGM Desk ${app.getVersion()} is the latest version.`;
  return `Downloading version ${result.updateInfo.version}. It installs the next time you close SGM Desk.`;
}
