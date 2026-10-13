/** The local database each device keeps for offline mode. */

export type Collection =
  | 'products'
  | 'sets'
  | 'locations'
  | 'users'
  | 'movements'
  | 'sales'
  | 'borrowers'
  | 'loans'
  | 'outbox'
  | 'meta';

export const COLLECTIONS: readonly Collection[] = [
  'products',
  'sets',
  'locations',
  'users',
  'movements',
  'sales',
  'borrowers',
  'loans',
  'outbox',
  'meta',
];

export function isCollection(value: unknown): value is Collection {
  return typeof value === 'string' && (COLLECTIONS as readonly string[]).includes(value);
}

export type StoreRecord = { id: string };

export type StoreOp =
  | { type: 'put'; collection: Collection; record: StoreRecord }
  | { type: 'delete'; collection: Collection; id: string };

/**
 * Implemented three times with the same behaviour:
 * - SGM Desk: SQLite in Electron's main process (node:sqlite), reached through the preload bridge
 * - SGM Pocket: expo-sqlite on the phone
 * - MemoryStore: tests and the browser preview
 */
export interface LocalStore {
  get<T extends StoreRecord>(collection: Collection, id: string): Promise<T | null>;
  /** All records in a collection, oldest first. */
  list<T extends StoreRecord>(collection: Collection): Promise<T[]>;
  /** Applies every operation in one transaction: all of them are saved, or none are. */
  batch(ops: StoreOp[]): Promise<void>;
}

/** SQL shared by both SQLite adapters, so desktop and phone store data the same way. */
export const SQLITE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS records (
    collection TEXT NOT NULL,
    id TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (collection, id)
  );
`;

export const SQL = {
  get: 'SELECT data FROM records WHERE collection = ? AND id = ?',
  list: 'SELECT data FROM records WHERE collection = ? ORDER BY rowid',
  put: `INSERT INTO records (collection, id, data, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (collection, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
  delete: 'DELETE FROM records WHERE collection = ? AND id = ?',
} as const;

export type StoreSnapshot = Partial<Record<Collection, Record<string, string>>>;

/** Keeps records as JSON text, like the SQLite stores, so callers can't mutate stored data by accident. */
export class MemoryStore implements LocalStore {
  private readonly data = new Map<Collection, Map<string, string>>();

  constructor(snapshot?: StoreSnapshot) {
    for (const collection of COLLECTIONS) {
      this.data.set(collection, new Map(Object.entries(snapshot?.[collection] ?? {})));
    }
  }

  async get<T extends StoreRecord>(collection: Collection, id: string): Promise<T | null> {
    const json = this.table(collection).get(id);
    return json === undefined ? null : (JSON.parse(json) as T);
  }

  async list<T extends StoreRecord>(collection: Collection): Promise<T[]> {
    return Array.from(this.table(collection).values(), (json) => JSON.parse(json) as T);
  }

  async batch(ops: StoreOp[]): Promise<void> {
    // Validate everything first so a bad operation can't leave half a batch applied.
    const prepared = ops.map((op) => ({ op, json: op.type === 'put' ? JSON.stringify(op.record) : '' }));
    for (const { op, json } of prepared) {
      if (op.type === 'put') this.table(op.collection).set(op.record.id, json);
      else this.table(op.collection).delete(op.id);
    }
  }

  snapshot(): StoreSnapshot {
    const result: StoreSnapshot = {};
    for (const [collection, rows] of this.data) result[collection] = Object.fromEntries(rows);
    return result;
  }

  private table(collection: Collection): Map<string, string> {
    const table = this.data.get(collection);
    if (!table) throw new Error(`Unknown collection: ${collection}`);
    return table;
  }
}

export type StoreListener = (collections: Collection[]) => void;

/** Wraps a store and tells screens when data changed, so lists refresh by themselves. */
export class ObservableStore implements LocalStore {
  private readonly listeners = new Set<StoreListener>();

  constructor(private readonly inner: LocalStore) {}

  get<T extends StoreRecord>(collection: Collection, id: string): Promise<T | null> {
    return this.inner.get<T>(collection, id);
  }

  list<T extends StoreRecord>(collection: Collection): Promise<T[]> {
    return this.inner.list<T>(collection);
  }

  async batch(ops: StoreOp[]): Promise<void> {
    if (ops.length === 0) return;
    await this.inner.batch(ops);
    const changed = Array.from(new Set(ops.map((op) => op.collection)));
    for (const listener of this.listeners) listener(changed);
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export function put<T extends StoreRecord>(collection: Collection, record: T): StoreOp {
  return { type: 'put', collection, record };
}

export function remove(collection: Collection, id: string): StoreOp {
  return { type: 'delete', collection, id };
}
