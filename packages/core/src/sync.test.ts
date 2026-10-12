import { describe, expect, it, vi } from 'vitest';

import { ApiError } from './api';
import { DEMO_USERS, DemoApi, seedDemoData } from './demo';
import type { OutboxEntry, Sale } from './models';
import { recordSale } from './operations';
import { SessionManager, type SecureStorage } from './session';
import { MemoryStore, ObservableStore } from './store';
import { SyncEngine } from './sync';

function memorySecureStorage(): SecureStorage {
  const items = new Map<string, string>();
  return {
    getItem: async (key) => items.get(key) ?? null,
    setItem: async (key, value) => {
      items.set(key, value);
    },
    removeItem: async (key) => {
      items.delete(key);
    },
  };
}

async function setup() {
  const store = new ObservableStore(new MemoryStore());
  await seedDemoData(store);
  const api = new DemoApi({ latencyMs: 0 });
  const sale = await recordSale(
    { store, user: DEMO_USERS[1], deviceId: 'device-1', locationId: 'branch-main' },
    {
      cart: [{ productId: 'acc-hose', type: 'item', qty: 1 }],
      payment: { method: 'cash', amount: 18000, tendered: 20000, change: 2000 },
    },
  );
  return { store, api, sale };
}

describe('SyncEngine', () => {
  it('sends the outbox and records when the server received each change', async () => {
    const { store, api, sale } = await setup();
    const sync = new SyncEngine({ store, api, getToken: () => 'token' });
    await sync.refreshCounts();
    expect(sync.getStatus().pending).toBe(2);

    const status = await sync.syncNow();

    expect(status.state).toBe('idle');
    expect(status.pending).toBe(0);
    expect(await store.list<OutboxEntry>('outbox')).toHaveLength(0);
    expect((await store.get<Sale>('sales', sale.id))?.receivedAt).not.toBeNull();
  });

  it('keeps changes on the device while offline', async () => {
    const { store, api } = await setup();
    api.online = false;
    const sync = new SyncEngine({ store, api, getToken: () => 'token' });

    const status = await sync.syncNow();

    expect(status.state).toBe('offline');
    expect(status.pending).toBe(2);
    expect(await store.list<OutboxEntry>('outbox')).toHaveLength(2);
  });

  it('sends a new sale right away instead of waiting for the timer', async () => {
    vi.useFakeTimers();
    try {
      const { store, api } = await setup();
      const sync = new SyncEngine({ store, api, getToken: () => 'token', intervalMs: 3_600_000 });
      sync.start();
      await vi.advanceTimersByTimeAsync(100);
      expect(sync.getStatus().pending).toBe(0);

      await recordSale(
        { store, user: DEMO_USERS[1], deviceId: 'device-1', locationId: 'branch-main' },
        {
          cart: [{ productId: 'acc-hose', type: 'item', qty: 1 }],
          payment: { method: 'cash', amount: 18000, tendered: 18000, change: 0 },
        },
      );
      await vi.advanceTimersByTimeAsync(3_000);

      expect(await store.list<OutboxEntry>('outbox')).toHaveLength(0);
      sync.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for someone to sign in', async () => {
    const { store, api } = await setup();
    const sync = new SyncEngine({ store, api, getToken: () => null });
    expect((await sync.syncNow()).state).toBe('signed-out');
  });
});

describe('SessionManager', () => {
  it('signs in and reopens the session within the offline limit', async () => {
    const secure = memorySecureStorage();
    let now = new Date('2026-10-12T00:00:00Z');
    const make = () =>
      new SessionManager({ api: new DemoApi({ latencyMs: 0 }), secure, deviceId: 'device-1', offlineGraceHours: 72, now: () => now });

    const session = await make().login('Cashier ', '2222');
    expect(session.user.role).toBe('employee');

    now = new Date('2026-10-14T00:00:00Z');
    expect(await make().restore()).not.toBeNull();

    now = new Date('2026-10-16T00:00:00Z');
    expect(await make().restore()).toBeNull();
  });

  it('rejects a wrong PIN', async () => {
    const sessions = new SessionManager({ api: new DemoApi({ latencyMs: 0 }), secure: memorySecureStorage(), deviceId: 'd' });
    await expect(sessions.login('owner', '0000')).rejects.toBeInstanceOf(ApiError);
  });
});
