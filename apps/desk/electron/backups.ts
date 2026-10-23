/**
 * Copies of SGM Desk's local database: one every week on its own, and more
 * whenever the owner or an admin presses "Back up now".
 * They go into the Backups folder in this Windows account's app data, which
 * other Windows accounts on the PC can't open. The newest 12 are kept.
 *
 * A backup holds everything this PC has synced (products, sets, branches,
 * people without their PINs, sales, stock movements, borrowers and loans) plus
 * changes not yet sent to the server. Open one with any SQLite viewer.
 */
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';

import type { BackupInfo } from './bridge';
import type { LocalDb } from './local-db';

const WEEK_MS = 7 * 24 * 3_600_000;
const CHECK_EVERY_MS = 6 * 3_600_000;
const KEEP = 12;
const NAME = /^SGM backup .+\.db$/;

export function createBackups(folder: string, db: LocalDb) {
  mkdirSync(folder, { recursive: true });

  /** Backups in the folder, newest first. */
  const files = () =>
    readdirSync(folder)
      .filter((name) => NAME.test(name))
      .map((name) => ({ name, at: statSync(path.join(folder, name)).mtime }))
      .sort((a, b) => b.at.getTime() - a.at.getTime());

  const info = (): BackupInfo => {
    const all = files();
    return { folder, count: all.length, lastAt: all[0]?.at.toISOString() ?? null };
  };

  const create = (): BackupInfo => {
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '');
    db.copyTo(path.join(folder, `SGM backup ${stamp}.db`));
    for (const old of files().slice(KEEP)) unlinkSync(path.join(folder, old.name));
    return info();
  };

  const createIfDue = () => {
    const last = files()[0];
    if (last && Date.now() - last.at.getTime() < WEEK_MS) return;
    try {
      create();
    } catch (error) {
      console.warn('Weekly backup failed:', error);
    }
  };

  return {
    info,
    create,
    /** Makes the weekly backup when one is due: now, and every few hours while SGM Desk stays open. */
    startWeekly(): void {
      createIfDue();
      setInterval(createIfDue, CHECK_EVERY_MS).unref();
    },
  };
}
