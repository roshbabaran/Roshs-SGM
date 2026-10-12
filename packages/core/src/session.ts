import type { ApiClient } from './api';
import { OFFLINE_GRACE_HOURS } from './config';
import type { ISODate, User } from './models';

/**
 * Where each app keeps the sign-in token:
 * SGM Desk uses Electron safeStorage (Windows encryption), SGM Pocket uses expo-secure-store.
 */
export interface SecureStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface Session {
  token: string;
  user: User;
  signedInAt: ISODate;
  /** When the server stops accepting the token. */
  expiresAt: ISODate;
  /** After this, the device must reach the server and sign in again. */
  offlineUntil: ISODate;
}

const SESSION_KEY = 'sgm.session';

type Listener = (session: Session | null) => void;

export class SessionManager {
  private session: Session | null = null;
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly deps: {
      api: ApiClient;
      secure: SecureStorage;
      deviceId: string;
      offlineGraceHours?: number;
      now?: () => Date;
    },
  ) {}

  current = (): Session | null => this.session;

  token = (): string | null => this.session?.token ?? null;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Reopens the saved session, unless the device has been offline longer than allowed. */
  async restore(): Promise<Session | null> {
    const saved = await this.deps.secure.getItem(SESSION_KEY);
    if (saved) {
      try {
        const session = JSON.parse(saved) as Session;
        if (new Date(session.offlineUntil) > this.now()) {
          this.set(session);
          return session;
        }
      } catch {
        // Unreadable session: fall through and sign out.
      }
      await this.deps.secure.removeItem(SESSION_KEY);
    }
    return null;
  }

  /** Signing in needs the server, so a fired employee can't start a new session offline. */
  async login(username: string, pin: string): Promise<Session> {
    const result = await this.deps.api.login(username.trim().toLowerCase(), pin, this.deps.deviceId);
    const now = this.now();
    const session: Session = {
      token: result.token,
      user: result.user,
      signedInAt: now.toISOString(),
      expiresAt: result.expiresAt,
      offlineUntil: this.graceFrom(now),
    };
    await this.save(session);
    return session;
  }

  /** Called after a successful sync: the server still accepts this device, so restart the offline clock. */
  async touch(): Promise<void> {
    if (!this.session) return;
    await this.save({ ...this.session, offlineUntil: this.graceFrom(this.now()) });
  }

  async logout(): Promise<void> {
    await this.deps.secure.removeItem(SESSION_KEY);
    this.set(null);
  }

  private async save(session: Session): Promise<void> {
    await this.deps.secure.setItem(SESSION_KEY, JSON.stringify(session));
    this.set(session);
  }

  private graceFrom(now: Date): ISODate {
    const hours = this.deps.offlineGraceHours ?? OFFLINE_GRACE_HOURS;
    return new Date(now.getTime() + hours * 3_600_000).toISOString();
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private set(session: Session | null): void {
    this.session = session;
    for (const listener of this.listeners) listener(session);
  }
}
