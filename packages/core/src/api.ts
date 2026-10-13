/**
 * The contract between the apps and the SGM API server. The server doesn't
 * exist yet; DemoApi (demo.ts) plays its part until it does. Point the apps at
 * a real server by setting EXPO_PUBLIC_API_URL.
 *
 *   POST /auth/login   { username, pin, deviceId }  -> LoginResult
 *   POST /sync/push    { entries: OutboxEntry[] }   -> PushResult
 *   GET  /sync/pull?cursor=...                      -> PullResult
 *
 * The server must check the user's role and branch on every request. For each
 * pushed entry, the permission depends on its collection:
 *   sales, movements: pos.sell (sales), inventory.record (hand-recorded movements),
 *     sales.void (voided sales)
 *   products, sets: products.manage
 *   borrowers, loans: borrow.manage (credit, cylinders lent and returned, payments)
 */
import type { Borrower, ISODate, LoanEntry, Location, OutboxEntry, Product, ProductSet, Sale, StockMovement, User } from './models';

export interface LoginResult {
  token: string;
  user: User;
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
  | { collection: 'loans'; records: LoanEntry[] };

/** Everything that changed on the server since `cursor`: new prices and sets, users, other devices' sales and loans. */
export interface PullResult {
  cursor: string;
  changes: PulledChange[];
}

export type ApiErrorKind = 'network' | 'auth' | 'rejected' | 'server';

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

export interface ApiClient {
  readonly mode: 'demo' | 'server';
  login(username: string, pin: string, deviceId: string): Promise<LoginResult>;
  push(entries: OutboxEntry[], token: string): Promise<PushResult>;
  pull(cursor: string | null, token: string): Promise<PullResult>;
}

export class HttpApi implements ApiClient {
  readonly mode = 'server';

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 15_000,
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

  private async request<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(this.baseUrl.replace(/\/+$/, '') + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ApiError(response.status >= 500 ? 'server' : 'rejected', text || `Server error ${response.status}`, response.status);
    }
    return (await response.json()) as T;
  }
}
