/**
 * SGM Desk's offline database: one SQLite file in the user's app data folder.
 * Uses Node's built-in SQLite (node:sqlite) that ships inside Electron, so there
 * is no native module to compile on Windows.
 */
import { DatabaseSync } from 'node:sqlite';

import { SQL, SQLITE_SCHEMA, type Collection, type StoreOp, type StoreRecord } from '@sgm/core';

export type LocalDb = ReturnType<typeof openLocalDb>;

export function openLocalDb(file: string) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  db.exec(SQLITE_SCHEMA);

  const getRow = db.prepare(SQL.get);
  const listRows = db.prepare(SQL.list);
  const putRow = db.prepare(SQL.put);
  const deleteRow = db.prepare(SQL.delete);

  return {
    get(collection: Collection, id: string): StoreRecord | null {
      const row = getRow.get(collection, id) as { data: string } | undefined;
      return row ? (JSON.parse(row.data) as StoreRecord) : null;
    },

    list(collection: Collection): StoreRecord[] {
      return (listRows.all(collection) as { data: string }[]).map((row) => JSON.parse(row.data) as StoreRecord);
    },

    /** All operations succeed together or not at all. */
    batch(ops: StoreOp[]): void {
      const now = new Date().toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const op of ops) {
          if (op.type === 'put') putRow.run(op.collection, op.record.id, JSON.stringify(op.record), now);
          else deleteRow.run(op.collection, op.id);
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    close(): void {
      db.close();
    },
  };
}
