/**
 * SGM Desk's main process. It opens the window and owns everything that touches
 * the PC: the offline database and its backups, the encrypted sign-in token,
 * the printer, the receipt reader and updates.
 * The screens can only reach these through the functions in preload.ts, and
 * every request is checked here first.
 */
import { app, BrowserWindow, ipcMain, Menu, nativeTheme, session, shell, type WebContents } from 'electron';
import path from 'node:path';

import { can, isCollection, SESSION_KEY, type Session, type StoreOp, type User } from '@sgm/core';

import { APP_URL, contentSecurityPolicy, isAppUrl, registerAppScheme, serveApp } from './app-protocol';
import { createBackups } from './backups';
import { IPC } from './bridge';
import { loadDeviceId } from './device';
import { openLocalDb } from './local-db';
import { checkPixels, createOcrReader } from './ocr';
import { listPrinters, printDocument, printReceipt } from './printing';
import { createSecureStore } from './secure-store';
import { checkForUpdates, installUpdate, startUpdates, updateReady } from './updates';

/** Set by scripts/dev.mjs while developing; ignored by the installed app. */
const devServerUrl = !app.isPackaged ? (process.env.SGM_DEV_SERVER_URL ?? null) : null;
/** Baked in at build time from the same variable the screens use. */
const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? '';

registerAppScheme();
if (devServerUrl) {
  app.setPath('userData', path.join(app.getPath('appData'), 'SGM Desk (dev)'));
  // The dev server's screens need 'unsafe-eval' for live reloading, which makes Electron warn about the
  // Content-Security-Policy on every start. The installed app loads app://sgm/ with a strict policy instead.
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
}

let mainWindow: BrowserWindow | null = null;

if (!app.requestSingleInstanceLock()) {
  // SGM Desk is already open: the first copy shows itself (below) and this one quits.
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(start, (error: unknown) => {
    console.error(error);
    app.quit();
  });
}

function start(): void {
  app.setAppUserModelId('ph.sibugaygas.sgmdesk');
  const dataDir = app.getPath('userData');
  const db = openLocalDb(path.join(dataDir, 'sgm.db'));
  const secure = createSecureStore(path.join(dataDir, 'secure.json'));
  // Closing SGM Desk signs the person out. A window closed with X signs out as the app quits; after a crash or
  // End task in Task Manager nothing runs on the way out, so every start signs out too. Sales waiting to sync
  // stay in the offline database and are sent after the next sign-in.
  secure.removeItem(SESSION_KEY);
  const deviceId = loadDeviceId(path.join(dataDir, 'device.json'));
  const ocr = createOcrReader();
  const backups = createBackups(path.join(dataDir, 'Backups'), db);
  app.on('will-quit', () => {
    secure.removeItem(SESSION_KEY);
    db.close();
    ocr.close();
  });

  serveApp(path.join(__dirname, 'renderer'), contentSecurityPolicy(apiUrl));
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(permission === 'clipboard-sanitized-write'),
  );

  handle(IPC.appInfo, () => ({ version: app.getVersion(), deviceId, platform: process.platform }));

  handle(IPC.storeGet, ([collection, id]) => {
    if (!isCollection(collection) || !isId(id)) throw new Error('Invalid request.');
    return db.get(collection, id);
  });
  handle(IPC.storeList, ([collection]) => {
    if (!isCollection(collection)) throw new Error('Invalid request.');
    return db.list(collection);
  });
  handle(IPC.storeBatch, ([ops]) => {
    if (!Array.isArray(ops) || !ops.every(isStoreOp)) throw new Error('Invalid request.');
    db.batch(ops);
  });

  handle(IPC.secureGet, ([key]) => secure.getItem(checkKey(key)));
  handle(IPC.secureSet, ([key, value]) => {
    if (typeof value !== 'string' || value.length > 64_000) throw new Error('Invalid request.');
    secure.setItem(checkKey(key), value);
  });
  handle(IPC.secureRemove, ([key]) => secure.removeItem(checkKey(key)));

  handle(IPC.printerList, (_args, sender) => listPrinters(sender));
  handle(IPC.printerPrint, ([html, options]) => {
    const { paperWidthMm, printerName } = (options ?? {}) as { paperWidthMm?: unknown; printerName?: unknown };
    if (typeof html !== 'string' || html.length > 500_000) throw new Error('Invalid request.');
    if (paperWidthMm !== 58 && paperWidthMm !== 80) throw new Error('Invalid request.');
    if (printerName !== undefined && typeof printerName !== 'string') throw new Error('Invalid request.');
    return printReceipt(html, { paperWidthMm, printerName: printerName || undefined });
  });
  handle(IPC.printerPrintDocument, ([html]) => {
    if (typeof html !== 'string' || html.length > 2_000_000) throw new Error('Invalid request.');
    return printDocument(html);
  });

  /** The signed-in session, while it is still allowed offline. */
  const currentSession = (): Session | null => {
    try {
      const session = JSON.parse(secure.getItem(SESSION_KEY) ?? 'null') as Session | null;
      return session && new Date(session.offlineUntil) > new Date() ? session : null;
    } catch {
      return null;
    }
  };
  /** Backups hold every sale and loan, so only the owner and admins may make or open them (backups.manage). */
  const requireBackupRights = () => {
    const session = currentSession();
    const user = session ? ((db.get('users', session.user.id) as User | null) ?? session.user) : null;
    if (!can(user, 'backups.manage')) throw new Error('Only the owner or an admin can make and open backups.');
  };

  handle(IPC.updatesCheck, () => checkForUpdates());
  handle(IPC.updatesReady, () => updateReady());
  handle(IPC.updatesInstall, () => installUpdate());

  handle(IPC.backupsInfo, () => {
    requireBackupRights();
    return backups.info();
  });
  handle(IPC.backupsCreate, () => {
    requireBackupRights();
    return backups.create();
  });
  handle(IPC.backupsOpen, async () => {
    requireBackupRights();
    const problem = await shell.openPath(backups.info().folder);
    if (problem) throw new Error(problem);
  });

  handle(IPC.ocrRead, ([image]) => ocr.read(checkPixels(image)));

  if (!devServerUrl) Menu.setApplicationMenu(null);
  createWindow();
  startUpdates({ apiUrl, token: () => currentSession()?.token ?? null });
  backups.startWeekly();
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    title: 'SGM Desk',
    width: 1366,
    height: 820,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0E1116' : '#F4F5F7',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  void mainWindow.loadURL(devServerUrl ?? APP_URL);
}

app.on('window-all-closed', () => app.quit());

// The window may only show SGM's own pages. Links to websites open in the normal browser.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event) => {
    if (!isOwnPage(event.url)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

function isOwnPage(url: string): boolean {
  if (isAppUrl(url)) return true;
  if (!devServerUrl) return false;
  try {
    return new URL(url).origin === new URL(devServerUrl).origin;
  } catch {
    return false;
  }
}

/** Registers an IPC handler that only answers SGM's own window. */
function handle(channel: string, listener: (args: unknown[], sender: WebContents) => unknown): void {
  ipcMain.handle(channel, (event, ...args) => {
    const frame = event.senderFrame;
    if (!frame || frame.parent || !isOwnPage(frame.url)) throw new Error('Blocked: this request did not come from SGM Desk.');
    return listener(args, event.sender);
  });
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200;
}

function checkKey(key: unknown): string {
  if (typeof key !== 'string' || !/^[\w.-]{1,64}$/.test(key)) throw new Error('Invalid request.');
  return key;
}

function isStoreOp(value: unknown): value is StoreOp {
  if (!value || typeof value !== 'object') return false;
  const op = value as { type?: unknown; collection?: unknown; id?: unknown; record?: unknown };
  if (!isCollection(op.collection)) return false;
  if (op.type === 'delete') return isId(op.id);
  if (op.type !== 'put' || !op.record || typeof op.record !== 'object') return false;
  return isId((op.record as { id?: unknown }).id);
}
