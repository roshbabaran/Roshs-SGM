import { describe, expect, it } from 'vitest';

import { HttpApi } from './api';
import { compareVersions } from './app-policy';
import { DemoApi } from './demo';

describe('compareVersions', () => {
  it('compares each part as a number', () => {
    expect(compareVersions('1.2.10', '1.2.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.1')).toBeLessThan(0);
    expect(compareVersions('2.0', '2.0.0')).toBe(0);
  });

  it('treats anything unreadable as zero', () => {
    expect(compareVersions('', '0.0.0')).toBe(0);
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(0);
  });
});

describe('signing in only to update', () => {
  it('asks the server for an update-only sign-in, naming this app, and gets nothing else back', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ token: 't', expiresAt: '2026-10-23T12:30:00.000Z' }), { status: 200 });
    }) as typeof fetch;
    try {
      const api = new HttpApi('https://sgm.example/api/', { app: 'desk/1.1.1' });
      expect(await api.updateLogin('cashier', '2222', 'pc-1')).toEqual({ token: 't', expiresAt: '2026-10-23T12:30:00.000Z' });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls[0]!.url).toBe('https://sgm.example/api/updates/login');
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ username: 'cashier', pin: '2222', deviceId: 'pc-1' });
    expect((calls[0]!.init.headers as Record<string, string>)['X-SGM-App']).toBe('desk/1.1.1');
  });

  it('turns away a wrong PIN in demo mode, and lasts half an hour', async () => {
    const now = new Date('2026-10-23T12:00:00Z');
    const api = new DemoApi({ latencyMs: 0, now: () => now });
    await expect(api.updateLogin('cashier', '0000')).rejects.toThrow('Wrong username or PIN.');
    const signIn = await api.updateLogin(' Cashier ', '2222');
    expect(signIn.expiresAt).toBe('2026-10-23T12:30:00.000Z');
  });
});
