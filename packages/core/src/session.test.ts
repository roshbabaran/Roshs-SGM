import { describe, expect, it } from 'vitest';

import { ApiError } from './api';
import { DEMO_USERS, DemoApi } from './demo';
import type { User } from './models';
import { OFFLINE_PIN_TRIES, OFFLINE_SIGN_IN_KEY, SESSION_KEY, SessionManager, type SecureStorage } from './session';

class MemorySecure implements SecureStorage {
  readonly items = new Map<string, string>();
  async getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  async setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  async removeItem(key: string) {
    this.items.delete(key);
  }
}

function setup(users: User[] = DEMO_USERS) {
  let now = new Date('2026-10-20T01:00:00.000Z');
  const api = new DemoApi({ now: () => now, latencyMs: 0 });
  const secure = new MemorySecure();
  const session = new SessionManager({
    api,
    secure,
    deviceId: 'device-1',
    now: () => now,
    findUser: async (id) => users.find((u) => u.id === id) ?? null,
  });
  const later = (hours: number) => {
    now = new Date(now.getTime() + hours * 3_600_000);
  };
  return { api, secure, session, later };
}

describe('offline sign-in', () => {
  it('lets the last employee who signed in sign in again without the server, and syncs with their token', async () => {
    const { api, secure, session } = setup();
    const online = await session.login('cashier', '2222');
    await session.logout();
    api.online = false;
    const offline = await session.login('Cashier ', '2222');
    expect(offline).toMatchObject({ token: online.token, offline: true, user: { id: 'u-cashier' } });
    expect(JSON.parse(secure.items.get(SESSION_KEY)!)).toMatchObject({ offline: true });
    // The next sync proves the server still takes the token.
    await session.touch();
    expect(session.current()?.offline).toBeUndefined();
  });

  it('never lets the owner, an admin or a branch manager sign in offline, and they clear the saved sign-in', async () => {
    const { api, secure, session } = setup();
    await session.login('cashier', '2222');
    expect(secure.items.has(OFFLINE_SIGN_IN_KEY)).toBe(true);
    for (const [username, pin] of [
      ['owner', '1111'],
      ['admin', '4444'],
      ['manager', '5555'],
    ]) {
      api.online = true;
      await session.login(username, pin);
      expect(secure.items.has(OFFLINE_SIGN_IN_KEY)).toBe(false);
      await session.logout();
      api.online = false;
      await expect(session.login(username, pin)).rejects.toThrow('only the last employee');
    }
    // The cashier was not the last to sign in, so they can't sign in offline either.
    await expect(session.login('cashier', '2222')).rejects.toThrow('only the last employee');
  });

  it('only works for the most recent account', async () => {
    const { api, session } = setup();
    await session.login('cashier', '2222');
    await session.login('warehouse', '3333');
    await session.logout();
    api.online = false;
    await expect(session.login('cashier', '2222')).rejects.toThrow('only the last employee');
    await expect(session.login('warehouse', '3333')).resolves.toMatchObject({ user: { id: 'u-warehouse' }, offline: true });
  });

  it('forgets the saved sign-in after too many wrong PINs', async () => {
    const { api, secure, session } = setup();
    await session.login('cashier', '2222');
    await session.logout();
    api.online = false;
    for (let i = 1; i < OFFLINE_PIN_TRIES; i++) {
      await expect(session.login('cashier', '9999')).rejects.toThrow(`${OFFLINE_PIN_TRIES - i} ${OFFLINE_PIN_TRIES - i === 1 ? 'try' : 'tries'} left`);
    }
    await expect(session.login('cashier', '9999')).rejects.toThrow('Too many wrong PINs');
    expect(secure.items.has(OFFLINE_SIGN_IN_KEY)).toBe(false);
    await expect(session.login('cashier', '2222')).rejects.toBeInstanceOf(ApiError);
  });

  it('stops once the token runs out, and follows the account as last synced', async () => {
    const disabled = DEMO_USERS.map((u) => (u.id === 'u-cashier' ? { ...u, active: false } : u));
    const first = setup();
    await first.session.login('cashier', '2222');
    first.api.online = false;
    first.later(13); // the demo server's tokens last 12 hours
    await expect(first.session.login('cashier', '2222')).rejects.toThrow('only the last employee');

    const second = setup(disabled);
    await second.session.login('cashier', '2222');
    second.api.online = false;
    await expect(second.session.login('cashier', '2222')).rejects.toThrow('only the last employee');
    expect(second.secure.items.has(OFFLINE_SIGN_IN_KEY)).toBe(false);
  });

  it('is forgotten when the server turns the token down', async () => {
    const { secure, session } = setup();
    await session.login('cashier', '2222');
    await session.forgetOfflineSignIn();
    expect(secure.items.has(OFFLINE_SIGN_IN_KEY)).toBe(false);
    expect(secure.items.get(OFFLINE_SIGN_IN_KEY)).toBeUndefined();
  });

  it('keeps the PIN out of storage', async () => {
    const { secure, session } = setup();
    await session.login('cashier', '2222');
    const saved = secure.items.get(OFFLINE_SIGN_IN_KEY)!;
    expect(saved).not.toContain('"2222"');
    expect(JSON.parse(saved).pinHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
