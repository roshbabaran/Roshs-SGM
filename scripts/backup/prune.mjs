#!/usr/bin/env node
/**
 * Decides which backups in Google Drive to delete, for scripts/backup/backup.sh.
 * Reads the folder's file names on stdin and prints the ones to delete, one per
 * line. Keeps the newest 30 backups, plus the first backup of each of the 12
 * most recent months. Files not named like "SGM backup 2026-10-22.dump" are
 * never deleted.
 *
 *   printf 'SGM backup 2026-10-22.dump\n...' | node scripts/backup/prune.mjs
 */
import { readFileSync } from 'node:fs';

const KEEP_NEWEST = 30;
const KEEP_MONTHS = 12;
const NAME = /^SGM backup (\d{4}-\d{2})-\d{2}\.dump$/;

// The dates in the names sort the same way as the text, so this is newest first.
const backups = readFileSync(0, 'utf8')
  .split(/\r?\n/)
  .filter((name) => NAME.test(name))
  .sort()
  .reverse();

const keep = new Set(backups.slice(0, KEEP_NEWEST));

// Going from newest to oldest, the last backup seen in each month is its first.
const firstOfMonth = new Map();
for (const name of backups) firstOfMonth.set(NAME.exec(name)[1], name);
for (const month of [...firstOfMonth.keys()].slice(0, KEEP_MONTHS)) keep.add(firstOfMonth.get(month));

for (const name of backups) if (!keep.has(name)) console.log(name);
