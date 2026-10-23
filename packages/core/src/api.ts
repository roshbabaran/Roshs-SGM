/**
 * The contract between the apps and the SGM API server. The server doesn't
 * exist yet; DemoApi (demo.ts) plays its part until it does. Point the apps at
 * a real server by setting EXPO_PUBLIC_API_URL.
 *
 *   POST /auth/login   { username, pin, deviceId }  -> LoginResult
 *   POST /sync/push    { entries: OutboxEntry[] }   -> PushResult
 *   GET  /sync/pull?cursor=...                      -> PullResult
 *   GET  /app/status                                -> AppStatus (app-policy.ts)
 *   POST /updates/login { username, pin, deviceId } -> UpdateSignIn (works on a version too old to sign in)
 *
 * Users & Devices (users.manage; only the owner may change the owner's and admins' accounts):
 *   POST /admin/users                { user: UserInput }      -> User
 *   GET  /admin/devices                                       -> Device[]
 *   POST /admin/devices              { device: DeviceInput }  -> Device
 *   POST /admin/devices/remove       { id }                   -> { ok: true }
 *
 * Every request names the app and its version in the X-SGM-App header
 * ("desk/1.2.0"). When the owner has turned SGM off or this version is too old,
 * the server refuses sign-in and sync with 423 or 426.
 *
 * The server must check the user's role and branch on every request. For each
 * pushed entry, the permission depends on its collection:
 *   sales, movements: pos.sell (sales), inventory.record (hand-recorded movements),
 *     sales.void (voided sales)
 *   products, sets: products.manage
 *   borrowers (customers): pos.sell or borrow.manage; products.manage to change a customer's discount
 *   loans: borrow.manage (credit, cylinders lent and returned, payments); cheques.manage to mark
 *     a post-dated cheque cleared or bounced
 *   claims: pos.sell (pick ups, and returns and defectives waiting for approval); claims.approve
 *     to approve or reject them
 *   sales with a discount given at the counter: pos.discount too
 *   movements: PICKUP pos.sell; RETURN_IN and DEFECTIVE_EXCHANGE claims.approve; a Stocks In that accepts a
 *     Stocks Out, and TRANSFER_FIX, inventory.receive, at the branch it names, and they must match that Stocks Out
 *     (transfers.ts)
 */
import type { AppStatus } from './app-policy';
import type { Borrower, Claim, Device, ISODate, LoanEntry, Location, OutboxEntry, Product, ProductSet, Sale, StockMovement, User } from './models';
import type { Permission, Role } from './roles';

export interface LoginResult {
  token: string;
  user: User;
  expiresAt: ISODate;
}

/** A sign-in that only downloads the newest version of the app, for a while. */
export interface UpdateSignIn {
  token: string;
  expiresAt: ISODate;
}

export interface PushResult {
  accepted: { id: string; receivedAt: ISODate }[];
  rejected: { id: string; reason: string }[];
}

export type PulledChange =
  | { collection: 'products'; records: Product[] }
  | { collection: 'sets'; records: ProductSet[] }
  | { collection: 'locations'; records: Location[] }
  | { collection: 'users'; records: User[] }
  | { collection: 'sales'; records: Sale[] }
  | { collection: 'movements'; records: StockMovement[] }
  | { collection: 'borrowers'; records: Borrower[] }
  | { collection: 'loans'; records: LoanEntry[] }
  | { collection: 'claims'; records: Claim[] };

/** Everything that changed on the server since `cursor`: new prices and sets, users, other devices' sales and loans. */
export interface PullResult {
  cursor: string;
  changes: PulledChange[];
}

/** "blocked": the owner turned SGM off, or this version must update first. */
export type ApiErrorKind = 'network' | 'auth' | 'rejected' | 'server' | 'blocked';

export class ApiError extends Error {
  constructor(
    public readonly kind: ApiErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** A new account (no id) or changes to one, from the Users & Devices window. */
export interface UserInput {
  id?: string;
  username: string;
  displayName: string;
  role: Role;
  locationIds: string[];
  extraPermissions: Permission[];
  active: boolean;
  /** Required for a new account; when changing one, a new PIN or nothing to keep the old one. */
  pin?: string;
}

/** Approving, naming or placing a device; a device can be added by its ID before it first signs in. */
export interface DeviceInput {
  id: string;
  label: string;
  locationId: string | null;
  approved: boolean;
}

export interface ApiClient {
  readonly mode: 'demo' | 'server';
  login(username: string, pin: string, deviceId: string): Promise<LoginResult>;
  push(entries: OutboxEntry[], token: string): Promise<PushResult>;
  pull(cursor: string | null, token: string): Promise<PullResult>;
  /** Whether the owner lets this version of the app run (sgm.app_policy). */
  appStatus(): Promise<AppStatus>;
  /** Signs in only to download the newest version, when this one is too old to sign in (AppGate's Update now). */
  updateLogin(username: string, pin: string, deviceId: string): Promise<UpdateSignIn>;
  /** Creates or changes an account. Needs a connection; returns the user record as every device will receive it. */
  saveUser(input: UserInput, token: string): Promise<User>;
  /** Every PC and phone that has signed in or was added. */
  listDevices(token: string): Promise<Device[]>;
  saveDevice(input: DeviceInput, token: string): Promise<Device>;
  /** Removes a device: it can't sign in or sync until it is added again. */
  removeDevice(id: string, token: string): Promise<void>;
}

export class HttpApi implements ApiClient {
  readonly mode = 'server';

  constructor(
    private readonly baseUrl: string,
    private readonly options: { /** This app and its version, from appHeader(). */ app?: string; timeoutMs?: number } = {},
  ) {}

  login(username: string, pin: string, deviceId: string): Promise<LoginResult> {
    return this.request<LoginResult>('POST', '/auth/login', { username, pin, deviceId });
  }

  push(entries: OutboxEntry[], token: string): Promise<PushResult> {
    return this.request<PushResult>('POST', '/sync/push', { entries }, token);
  }

  pull(cursor: string | null, token: string): Promise<PullResult> {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return this.request<PullResult>('GET', `/sync/pull${query}`, undefined, token);
  }

  appStatus(): Promise<AppStatus> {
    return this.request<AppStatus>('GET', '/app/status');
  }

  updateLogin(username: string, pin: string, deviceId: string): Promise<UpdateSignIn> {
    return this.request<UpdateSignIn>('POST', '/updates/login', { username, pin, deviceId });
  }

  saveUser(input: UserInput, token: string): Promise<User> {
    return this.request<User>('POST', '/admin/users', { user: input }, token);
  }

  listDevices(token: string): Promise<Device[]> {
    return this.request<Device[]>('GET', '/admin/devices', undefined, token);
  }

  saveDevice(input: DeviceInput, token: string): Promise<Device> {
    return this.request<Device>('POST', '/admin/devices', { device: input }, token);
  }

  async removeDevice(id: string, token: string): Promise<void> {
    await this.request<{ ok: true }>('POST', '/admin/devices/remove', { id }, token);
  }

  private async request<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000);
    let response: Response;
    try {
      response = await fetch(this.baseUrl.replace(/\/+$/, '') + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(this.options.app ? { 'X-SGM-App': this.options.app } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      throw new ApiError('network', "Can't reach the SGM server.");
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 401) throw new ApiError('auth', 'Your sign-in has expired. Sign in again.', 401);
    if (response.status === 423 || response.status === 426) {
      const text = await response.text().catch(() => '');
      throw new ApiError('blocked', text || 'SGM is not available on this device right now.', response.status);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ApiError(response.status >= 500 ? 'server' : 'rejected', text || `Server error ${response.status}`, response.status);
    }
    return (await response.json()) as T;
  }
}
