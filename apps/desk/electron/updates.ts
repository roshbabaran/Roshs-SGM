/**
 * Automatic updates with electron-updater. New versions are uploaded to the
 * private releases repo on GitHub (npm run desk:release), and SGM Desk fetches
 * them through the SGM API at <API>/updates/desk, which only answers signed-in
 * people on approved PCs. A downloaded update installs when SGM Desk closes,
 * or straight away from the "Update" button.
 */
import { app } from 'electron';
import { autoUpdater, type UpdateCheckResult } from 'electron-updater';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** How often the screens' polling (updateReady) may start a new check. */
const CHECK_EVERY_MS = 30 * 60_000;

let token: () => string | null = () => null;
let readyVersion: string | null = null;
let installWhenReady = false;
let lastCheckAt = 0;

/** app-update.yml is written into installed copies by electron-builder's publish setting. */
function updatesConfigured(): boolean {
  return app.isPackaged && existsSync(path.join(process.resourcesPath, 'app-update.yml'));
}

/** Points the updater at the SGM API and checks once now. */
export function startUpdates(options: { apiUrl: string; token: () => string | null }): void {
  token = options.token;
  if (!updatesConfigured()) return;
  if (options.apiUrl) autoUpdater.setFeedURL({ provider: 'generic', url: `${options.apiUrl.replace(/\/+$/, '')}/updates/desk` });
  autoUpdater.on('update-downloaded', (info) => {
    readyVersion = info.version;
    if (installWhenReady) autoUpdater.quitAndInstall(true, true);
  });
  autoUpdater.on('error', (error) => console.warn('Update failed:', error));
  void quietCheck();
}

/**
 * Asks the SGM API for a newer version and starts downloading it; null when nobody is signed in. `signIn` is a
 * sign-in from /updates/login, for when nobody is.
 */
async function check(signIn?: string): Promise<UpdateCheckResult | null> {
  const current = signIn ?? token();
  if (!current) return null;
  lastCheckAt = Date.now();
  // Lower case on purpose: electron-updater drops a header named exactly "authorization" when GitHub redirects
  // the download to its file servers, which refuse a request that carries one.
  autoUpdater.requestHeaders = { authorization: `Bearer ${current}` };
  return autoUpdater.checkForUpdates();
}

async function quietCheck(): Promise<void> {
  try {
    await check();
  } catch (error) {
    console.warn('Update check failed:', error);
  }
}

type Found =
  | { kind: 'off'; message: string }
  | { kind: 'signed-out' }
  | { kind: 'latest' }
  | { kind: 'downloading'; version: string }
  | { kind: 'ready'; version: string };

async function lookForUpdate(signIn?: string): Promise<Found> {
  if (!app.isPackaged) return { kind: 'off', message: 'Updates are only checked in the installed app.' };
  if (!updatesConfigured()) return { kind: 'off', message: 'Automatic updates are not set up yet.' };
  if (readyVersion) return { kind: 'ready', version: readyVersion };
  const result = await check(signIn);
  if (!result) return { kind: 'signed-out' };
  return result.isUpdateAvailable ? { kind: 'downloading', version: result.updateInfo.version } : { kind: 'latest' };
}

function describe(found: Found): string {
  switch (found.kind) {
    case 'off':
      return found.message;
    case 'signed-out':
      return 'Sign in first, then check for updates.';
    case 'latest':
      return `SGM Desk ${app.getVersion()} is the latest version.`;
    case 'downloading':
      return `Downloading version ${found.version}. It installs the next time you close SGM Desk.`;
    case 'ready':
      return `Version ${found.version} is ready. It installs the next time you close SGM Desk.`;
  }
}

/** For the "Check for updates" button. Returns a message for the person. */
export async function checkForUpdates(): Promise<string> {
  return describe(await lookForUpdate());
}

/** The downloaded version waiting to install. Also checks again when the last check is old enough. */
export function updateReady(): string | null {
  if (!readyVersion && updatesConfigured() && Date.now() - lastCheckAt > CHECK_EVERY_MS) void quietCheck();
  return readyVersion;
}

/**
 * Restarts on the downloaded version, or downloads it and then restarts. Returns a message for the person. Rejects
 * when nobody is signed in and there is no `signIn` from /updates/login, so the screens can ask for one.
 */
export async function installUpdate(signIn?: string): Promise<string> {
  const found = await lookForUpdate(signIn);
  if (found.kind === 'signed-out') throw new Error('Sign in to download the update.');
  if (found.kind === 'downloading') {
    installWhenReady = true;
    // The download may already have finished while the check was answering.
    if (!readyVersion) return `Downloading version ${found.version}. SGM Desk restarts on its own when it's done.`;
  }
  if (found.kind === 'ready' || readyVersion) {
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 500);
    return `Restarting on version ${readyVersion}…`;
  }
  return describe(found);
}
