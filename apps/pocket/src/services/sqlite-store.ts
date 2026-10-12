/**
 * SGM Pocket's offline database: the same table and SQL as SGM Desk (see
 * SQLITE_SCHEMA in @sgm/core), stored on the phone with expo-sqlite.
 */
import { SQL, SQLITE_SCHEMA, type Collection, type LocalStore, type StoreOp, type StoreRecord } from '@sgm/core';
import * as SQLite from 'expo-sqlite';

export async function openSqliteStore(name: string): Promise<LocalStore> {
  const db = await SQLite.openDatabaseAsync(name);
  await db.execAsync(`PRAGMA journal_mode = WAL; ${SQLITE_SCHEMA}`);

  return {
    async get<T extends StoreRecord>(collection: Collection, id: string): Promise<T | null> {
      const row = await db.getFirstAsync<{ data: string }>(SQL.get, collection, id);
      return row ? (JSON.parse(row.data) as T) : null;
    },

    async list<T extends StoreRecord>(collection: Collection): Promise<T[]> {
      const rows = await db.getAllAsync<{ data: string }>(SQL.list, collection);
      return rows.map((row) => JSON.parse(row.data) as T);
    },

    /** All operations succeed together or not at all. */
    async batch(ops: StoreOp[]): Promise<void> {
      const now = new Date().toISOString();
      await db.withExclusiveTransactionAsync(async (txn) => {
        const putRow = await txn.prepareAsync(SQL.put);
        const deleteRow = await txn.prepareAsync(SQL.delete);
        try {
          for (const op of ops) {
            if (op.type === 'put') await putRow.executeAsync(op.collection, op.record.id, JSON.stringify(op.record), now);
            else await deleteRow.executeAsync(op.collection, op.id);
          }
        } finally {
          await putRow.finalizeAsync();
          await deleteRow.finalizeAsync();
        }
      });
    },
  };
}
