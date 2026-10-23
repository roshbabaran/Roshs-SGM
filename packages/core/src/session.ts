import { ApiError, type ApiClient } from './api';
import { OFFLINE_GRACE_HOURS } from './config';
import { uuid } from './ids';
import type { ISODate, User } from './models';
import { needsServerToSignIn } from './roles';
import { sha256Hex } from './sha256';

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
  /** Signed in without the server (see OFFLINE_SIGN_IN_KEY). */
  offline?: boolean;
}

/** Where the session is saved in SecureStorage. SGM Desk's main process and SGM Pocket's updater read the token from it. */
export const SESSION_KEY = 'sgm.session';

/**
 * The one account that may sign in on this device while the server can't be
 * reached: the last employee or warehouse staff who signed in here, never the
 * owner, an admin or a branch manager. It holds their last session and a salted
 * hash of their PIN, and is forgotten after too many wrong PINs, when someone
 * else signs in, or when the server turns the token down.
 */
export const OFFLINE_SIGN_IN_KEY = 'sgm.offline-sign-in';

/** Wrong PINs allowed offline before the device needs the server to sign in again. */
export const OFFLINE_PIN_TRIES = 5;

const PIN_ROUNDS = 1000;

interface OfflineSignIn {
  username: string;
  salt: string;
  pinHash: string;
  /** Wrong PINs typed offline since the last good sign-in. */
  failures: number;
  session: Session;
}

function hashPin(pin: string, salt: string): string {
  let hash = '';
  for (let i = 0; i < PIN_ROUNDS; i++) hash = sha256Hex(`${hash}:${salt}:${pin}`);
  return hash;
}

const OFFLINE_HELP =
  "Can't reach the SGM server. Without a connection, only the last employee who signed in on this device can sign in, never the owner, an admin or a branch manager.";

type Listener = (session: Session | null) => void;

export class SessionManager {
  private session: Session | null = null;
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly deps: {
      api: ApiClient;
      secure: SecureStorage;
      deviceId: string;
      /** This device's copy of an account, so an offline sign-in follows changes synced since (disabled, new role). */
      findUser?: (id: string) => Promise<User | null>;
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

  /**
   * Signing in checks the PIN with the server. When the server can't be reached,
   * only the last employee who signed in here can sign in, with the session they
   * had (see OFFLINE_SIGN_IN_KEY); their work syncs once the connection is back.
   */
  async login(username: string, pin: string): Promise<Session> {
    const name = username.trim().toLowerCase();
    let result;
    try {
      result = await this.deps.api.login(name, pin, this.deps.deviceId);
    } catch (error) {
      if (error instanceof ApiError && error.kind === 'network') return this.loginOffline(name, pin);
      throw error;
    }
    const now = this.now();
    const session: Session = {
      token: result.token,
      user: result.user,
      signedInAt: now.toISOString(),
      expiresAt: result.expiresAt,
      offlineUntil: this.graceFrom(now),
    };
    await this.save(session);
    // Whoever signs in last is the only one who may sign in offline next; the owner, admins and managers never can.
    if (needsServerToSignIn(session.user)) {
      await this.forgetOfflineSignIn();
    } else {
      const salt = uuid();
      await this.saveOffline({ username: name, salt, pinHash: hashPin(pin, salt), failures: 0, session });
    }
    return session;
  }

  /** Called when the server turns the token down (the account was disabled, or the token ran out). */
  async forgetOfflineSignIn(): Promise<void> {
    await this.deps.secure.removeItem(OFFLINE_SIGN_IN_KEY);
  }

  private async loginOffline(username: string, pin: string): Promise<Session> {
    const saved = await this.deps.secure.getItem(OFFLINE_SIGN_IN_KEY);
    let offline: OfflineSignIn | null = null;
    try {
      offline = saved ? (JSON.parse(saved) as OfflineSignIn) : null;
    } catch {
      offline = null;
    }
    const now = this.now();
    const usable =
      offline &&
      offline.username === username &&
      !needsServerToSignIn(offline.session.user) &&
      new Date(offline.session.expiresAt) > now &&
      new Date(offline.session.offlineUntil) > now;
    if (!offline || !usable) {
      if (offline && offline.username === username) await this.forgetOfflineSignIn();
      throw new ApiError('network', OFFLINE_HELP);
    }
    // The account as this device last synced it: disabled, or made a manager, means no offline sign-in.
    const user = (await this.deps.findUser?.(offline.session.user.id)) ?? offline.session.user;
    if (!user.active || needsServerToSignIn(user)) {
      await this.forgetOfflineSignIn();
      throw new ApiError('network', OFFLINE_HELP);
    }
    if (hashPin(pin, offline.salt) !== offline.pinHash) {
      const failures = offline.failures + 1;
      if (failures >= OFFLINE_PIN_TRIES) {
        await this.forgetOfflineSignIn();
        throw new ApiError('auth', 'Too many wrong PINs. Connect to the internet to sign in.', 401);
      }
      await this.saveOffline({ ...offline, failures });
      const left = OFFLINE_PIN_TRIES - failures;
      throw new ApiError('auth', `Wrong username or PIN. ${left} ${left === 1 ? 'try' : 'tries'} left before this device needs the internet to sign in.`, 401);
    }
    const session: Session = { ...offline.session, user, signedInAt: now.toISOString(), offline: true };
    await this.save(session);
    if (offline.failures > 0) await this.saveOffline({ ...offline, failures: 0 });
    return session;
  }

  /** Called after a successful sync: the server still accepts this device, so restart the offline clock. */
  async touch(): Promise<void> {
    if (!this.session) return;
    const { offline: _offline, ...session } = this.session;
    await this.save({ ...session, offlineUntil: this.graceFrom(this.now()) });
  }

  async logout(): Promise<void> {
    await this.deps.secure.removeItem(SESSION_KEY);
    this.set(null);
  }

  private async save(session: Session): Promise<void> {
    await this.deps.secure.setItem(SESSION_KEY, JSON.stringify(session));
    this.set(session);
  }

  private async saveOffline(offline: OfflineSignIn): Promise<void> {
    await this.deps.secure.setItem(OFFLINE_SIGN_IN_KEY, JSON.stringify(offline));
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
