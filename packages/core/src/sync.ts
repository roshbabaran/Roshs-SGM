import { ApiError, type ApiClient } from './api';
import { SYNC_INTERVAL_MS } from './config';
import type { MetaRecord, OutboxEntry, OutboxRecord } from './models';
import { put, remove, type ObservableStore, type StoreOp } from './store';

export type SyncState = 'idle' | 'syncing' | 'offline' | 'error' | 'signed-out';

export interface SyncStatus {
  state: SyncState;
  /** Changes on this device the server hasn't accepted yet. */
  pending: number;
  /** Changes the server refused; someone needs to look at them. */
  rejected: number;
  lastSyncedAt: string | null;
  message: string | null;
  mode: 'demo' | 'server';
}

const PUSH_BATCH_SIZE = 50;
const CURSOR_ID = 'sync-cursor';

type Listener = (status: SyncStatus) => void;

/**
 * Sends this device's changes (the outbox) to the server and brings back
 * changes from other devices. Safe to run any time: if the connection drops,
 * the outbox keeps everything and the next run continues.
 */
export class SyncEngine {
  private status: SyncStatus;
  private readonly listeners = new Set<Listener>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private soon: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<SyncStatus> | null = null;
  private stopWatchingStore: (() => void) | null = null;

  constructor(
    private readonly deps: {
      store: ObservableStore;
      api: ApiClient;
      getToken: () => string | null;
      intervalMs?: number;
      now?: () => Date;
    },
  ) {
    this.status = {
      state: 'idle',
      pending: 0,
      rejected: 0,
      lastSyncedAt: null,
      message: null,
      mode: deps.api.mode,
    };
  }

  getStatus = (): SyncStatus => this.status;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  start(): void {
    if (this.timer) return;
    this.stopWatchingStore = this.deps.store.subscribe((collections) => {
      if (!collections.includes('outbox')) return;
      const before = this.status.pending;
      void this.refreshCounts().then(() => {
        // New work on this device (a sale, a delivery): send it now instead of waiting for the timer.
        if (this.status.pending > before) this.syncSoon();
      });
    });
    void this.syncNow();
    this.timer = setInterval(() => void this.syncNow(), this.deps.intervalMs ?? SYNC_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.soon) clearTimeout(this.soon);
    this.timer = null;
    this.soon = null;
    this.stopWatchingStore?.();
    this.stopWatchingStore = null;
  }

  /** Runs one sync now; calls made while one is running share its result. */
  syncNow(): Promise<SyncStatus> {
    if (!this.running) {
      this.running = this.run().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private syncSoon(): void {
    if (this.soon) return;
    this.soon = setTimeout(() => {
      this.soon = null;
      void this.syncNow();
    }, 1_500);
  }

  async refreshCounts(): Promise<void> {
    const outbox = await this.deps.store.list<OutboxEntry>('outbox');
    const rejected = outbox.filter((entry) => entry.rejectedReason).length;
    this.update({ pending: outbox.length - rejected, rejected });
  }

  private async run(): Promise<SyncStatus> {
    const token = this.deps.getToken();
    if (!token) {
      this.update({ state: 'signed-out', message: null });
      await this.refreshCounts();
      return this.status;
    }
    this.update({ state: 'syncing', message: null });
    try {
      await this.push(token);
      await this.pull(token);
      this.update({ state: 'idle', lastSyncedAt: this.now().toISOString(), message: null });
    } catch (error) {
      if (error instanceof ApiError && error.kind === 'network') {
        this.update({ state: 'offline', message: 'Working offline. Changes will sync when the connection is back.' });
      } else {
        this.update({ state: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    }
    await this.refreshCounts();
    return this.status;
  }

  private async push(token: string): Promise<void> {
    const { store, api } = this.deps;
    const waiting = (await store.list<OutboxEntry>('outbox'))
      .filter((entry) => !entry.rejectedReason)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    for (let start = 0; start < waiting.length; start += PUSH_BATCH_SIZE) {
      const batch = waiting.slice(start, start + PUSH_BATCH_SIZE);
      const result = await api.push(batch, token);
      const acceptedIds = new Set(result.accepted.map((a) => a.id));
      // A record only counts as synced when none of its later changes are still waiting.
      const stillWaiting = new Set(
        waiting.filter((entry) => !acceptedIds.has(entry.id)).map((entry) => `${entry.collection}:${entry.recordId}`),
      );

      const ops: StoreOp[] = [];
      for (const accepted of result.accepted) {
        const entry = batch.find((e) => e.id === accepted.id);
        if (!entry) continue;
        ops.push(remove('outbox', entry.id));
        if (stillWaiting.has(`${entry.collection}:${entry.recordId}`)) continue;
        const current = await store.get<OutboxRecord>(entry.collection, entry.recordId);
        if (current) ops.push(put(entry.collection, { ...current, receivedAt: accepted.receivedAt }));
      }
      for (const rejected of result.rejected) {
        const entry = batch.find((e) => e.id === rejected.id);
        if (entry) ops.push(put('outbox', { ...entry, attempts: entry.attempts + 1, rejectedReason: rejected.reason }));
      }
      await store.batch(ops);
    }
  }

  private async pull(token: string): Promise<void> {
    const { store, api } = this.deps;
    const cursor = (await store.get<MetaRecord<string>>('meta', CURSOR_ID))?.value ?? null;
    const result = await api.pull(cursor, token);
    // Local changes that haven't reached the server yet win over what the server sends.
    const unsent = new Set(
      (await store.list<OutboxEntry>('outbox')).map((entry) => `${entry.collection}:${entry.recordId}`),
    );
    const ops: StoreOp[] = [];
    for (const change of result.changes) {
      for (const record of change.records) {
        if (!unsent.has(`${change.collection}:${record.id}`)) ops.push(put(change.collection, record));
      }
    }
    ops.push(put('meta', { id: CURSOR_ID, value: result.cursor }));
    await store.batch(ops);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private update(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const listener of this.listeners) listener(this.status);
  }
}
