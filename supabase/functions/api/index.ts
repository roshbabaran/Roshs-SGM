// SGM API: the calls in packages/core/src/api.ts, backed by Supabase Postgres, plus app updates
// served from the private releases repo on GitHub (GITHUB_RELEASES_REPO, GITHUB_RELEASES_TOKEN).
// Deploy: npx supabase functions deploy api --no-verify-jwt --use-api
import { Hono, type Context } from 'npm:hono@4';
import { cors } from 'npm:hono@4/cors';
import { jwtVerify, SignJWT } from 'npm:jose@6';
import postgres from 'npm:postgres@3';

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { prepare: false, max: 3 });
const secret = new TextEncoder().encode(Deno.env.get('SGM_JWT_SECRET'));
const REQUIRE_DEVICE_APPROVAL = Deno.env.get('SGM_REQUIRE_DEVICE_APPROVAL') !== 'false';
const TOKEN_HOURS = 72; // OFFLINE_GRACE_HOURS in packages/core/src/config.ts; the apps never refresh a token
const MAX_PER_PULL = 5000;
const RELEASES_REPO = Deno.env.get('GITHUB_RELEASES_REPO') ?? '';
const RELEASES_TOKEN = Deno.env.get('GITHUB_RELEASES_TOKEN') ?? '';
// Each app's releases are tagged desk-v1.2.0 or pocket-v1.2.0; the version file describes the newest one.
const RELEASE_TAG: Record<string, string> = { desk: 'desk-v', android: 'pocket-v' };
const VERSION_FILE: Record<string, string> = { desk: 'latest.yml', android: 'latest.json' };

// Copied from packages/core/src/roles.ts (the function runs on Deno and can't import @sgm/core). Keep them in step.
const PERMISSIONS = [
  'dashboard.view', 'pos.sell', 'pos.discount', 'borrow.manage', 'cheques.manage', 'claims.approve', 'sales.view', 'sales.void',
  'inventory.view', 'inventory.record', 'inventory.receive', 'reports.view', 'products.manage', 'users.manage', 'settings.device',
  'backups.manage',
];
const ROLE_PERMISSIONS: Record<string, string[]> = {
  owner: PERMISSIONS,
  admin: PERMISSIONS,
  manager: [
    'dashboard.view', 'pos.sell', 'pos.discount', 'borrow.manage', 'cheques.manage', 'claims.approve', 'sales.void', 'sales.view',
    'inventory.view', 'inventory.record', 'inventory.receive', 'reports.view',
  ],
  employee: ['dashboard.view', 'pos.sell', 'borrow.manage', 'sales.view', 'inventory.view'],
  warehouse: ['inventory.view', 'inventory.record', 'inventory.receive'],
};
// Only ever come with a role, never given to anyone else (ROLE_ONLY): backups are the owner's and admins', and
// accepting stock from other branches is theirs, the branch managers' and the warehouse staff's.
const ROLE_ONLY = ['backups.manage', 'inventory.receive'];
const MANUAL_MOVEMENTS = ['OPENING', 'DELIVERY_IN', 'TRANSFER_IN', 'TRANSFER_OUT', 'ADJUSTMENT', 'DAMAGED', 'RETURN_TO_SUPPLIER'];
const LEDGERS = ['movements', 'loans']; // entries are only ever added, never changed
const CLAIM_KINDS = ['pickup', 'return', 'defective'];
// Collections an older version of the apps can't store, and the version that added them. SGM Desk 1.0 refuses a
// whole pull that holds one, so pull() leaves them out for it.
const ADDED_IN: Record<string, string> = { claims: '1.1.0' };

type Doc = Record<string, any>;
type Entry = { id: string; collection: string; recordId: string; payload: Doc };
type Auth = { user: Doc; deviceId: string };

const can = (user: Doc, permission: string) =>
  user.active === true && ((ROLE_PERMISSIONS[user.role] ?? []).includes(permission) ||
    (!ROLE_ONLY.includes(permission) && (user.extraPermissions ?? []).includes(permission)));

// The owner and admins work at every branch and warehouse (worksEverywhere in roles.ts).
const worksAt = (user: Doc, locationId: string) =>
  user.role === 'owner' || user.role === 'admin' || (user.locationIds ?? []).includes(locationId);

/** Only the owner may create or change the owner's and admins' accounts (canManageAccount in roles.ts). */
const canManageAccount = (manager: Doc, role: string) =>
  can(manager, 'users.manage') && (manager.role === 'owner' || (role !== 'owner' && role !== 'admin'));

/** JSON with its keys sorted, to tell whether two records hold the same value. */
const canonical = (value: unknown): string =>
  JSON.stringify(value ?? null, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);

/**
 * The permissions a change needs (any one of `anyOf`, and all of `also`), and the person and branch the record
 * names (see the comment in api.ts). `old` is the record as the server has it, if it has it.
 */
type Rule = { anyOf: string[]; also?: string[]; actorId?: string; locationId?: string };

function ruleFor(collection: string, r: Doc, old: Doc | null): Rule | null {
  switch (collection) {
    case 'sales': {
      // Voided at Transactions, or by an approved return of the whole sale in Claims.
      if (r.status === 'voided') return { anyOf: ['sales.void', 'claims.approve'], actorId: r.voidedBy, locationId: r.locationId };
      const lines: Doc[] = Array.isArray(r.lines) ? r.lines : [];
      const also = [
        ...(lines.some((line) => line.discount?.source === 'counter') ? ['pos.discount'] : []),
        ...(r.payment?.method === 'credit' || lines.some((line) => line.type === 'borrow') ? ['borrow.manage'] : []),
      ];
      return { anyOf: ['pos.sell'], also, actorId: r.cashierId, locationId: r.locationId };
    }
    case 'movements': {
      // Stock sent from another branch is accepted at the receiving branch, and a count that didn't match is settled
      // at the sending one, by its manager or warehouse staff, an admin or the owner (transfers.ts).
      const anyOf = r.type === 'TRANSFER_FIX' || (r.type === 'TRANSFER_IN' && r.transferId !== undefined) ? ['inventory.receive']
        : MANUAL_MOVEMENTS.includes(r.type) ? ['inventory.record']
        : r.type === 'VOID_REVERSAL' ? ['sales.void', 'claims.approve']
        : r.type === 'RETURN_IN' || r.type === 'DEFECTIVE_EXCHANGE' ? ['claims.approve']
        : r.type === 'CYLINDER_RETURN' ? ['borrow.manage']
        : ['pos.sell']; // SALE, EMPTY_IN and PICKUP
      return { anyOf, actorId: r.userId, locationId: r.locationId };
    }
    case 'loans': {
      const anyOf = r.kind === 'cheque_cleared' || r.kind === 'cheque_bounced' ? ['cheques.manage']
        // Voiding a sale on credit takes it off the account too.
        : r.kind === 'void' ? ['borrow.manage', 'sales.void', 'claims.approve']
        : ['borrow.manage'];
      return { anyOf, actorId: r.userId, locationId: r.locationId };
    }
    case 'borrowers': {
      // Anyone selling can add a customer; only someone who sets prices can give or change a customer's discount.
      const discountChanged = canonical(r.discount) !== canonical(old?.discount);
      return { anyOf: ['pos.sell', 'borrow.manage', 'products.manage'], also: discountChanged ? ['products.manage'] : [] };
    }
    case 'claims': {
      if (!CLAIM_KINDS.includes(r.kind)) return null;
      // Returns and defective exchanges are asked for at the counter and decided by the owner, an admin or the
      // branch's manager.
      const decided = r.kind !== 'pickup' && r.status !== 'pending';
      return decided
        ? { anyOf: ['claims.approve'], actorId: r.decidedBy, locationId: r.locationId }
        : { anyOf: ['pos.sell'], actorId: r.requestedBy, locationId: r.locationId };
    }
    case 'products':
    case 'sets':
      return { anyOf: ['products.manage'] };
    default:
      return null;
  }
}

/** Why the server refuses this change, in words a person can act on; null when it's allowed. */
async function problemWith(tx: postgres.TransactionSql, auth: Auth, e: Entry, old: Doc | null): Promise<string | null> {
  const r = e.payload;
  const rule = r && r.id === e.recordId ? ruleFor(e.collection, r, old) : null;
  if (!rule) return 'The server does not accept this kind of change.';
  let actor = auth.user;
  if (rule.actorId && rule.actorId !== auth.user.id) {
    // Work queued offline by someone who signed in on this device before the current person.
    const [row] = await tx`
      select r.doc from sgm.records r
      join sgm.device_users du on du.user_id = r.id and du.device_id = ${auth.deviceId}
      where r.collection = 'users' and r.id = ${rule.actorId}`;
    if (!row) return 'The person named on this record has never signed in on this device.';
    actor = row.doc;
  }
  const missing = rule.anyOf.some((p) => can(actor, p)) ? (rule.also ?? []).find((p) => !can(actor, p)) : rule.anyOf.join(' or ');
  if (missing) return `${actor.displayName} isn't allowed to do this (${missing}).`;
  if (rule.locationId && !worksAt(actor, rule.locationId)) return `${actor.displayName} isn't assigned to ${rule.locationId}.`;
  if (e.collection === 'movements' && (r.transferId !== undefined || r.type === 'TRANSFER_FIX')) return await transferProblem(tx, r);
  return null;
}

/**
 * A Stocks Out that waits to be accepted, and the movements that accept and settle it, must agree (transfers.ts):
 * the same product and condition, the two branches the right way round, and ids made from the Stocks Out's id, so
 * that stock accepted twice (on two devices while offline) is kept once.
 */
async function transferProblem(tx: postgres.TransactionSql, r: Doc): Promise<string | null> {
  if (r.type === 'TRANSFER_OUT') {
    const filledIn = r.transferId === r.id && typeof r.counterpartLocationId === 'string' && r.counterpartLocationId !== r.locationId && r.qty < 0;
    return filledIn ? null : 'This Stocks Out is not filled in right.';
  }
  if (r.type !== 'TRANSFER_IN' && r.type !== 'TRANSFER_FIX') return 'The server does not accept this kind of change.';
  const movement = async (id: string): Promise<Doc | undefined> =>
    (await tx`select doc from sgm.records where collection = 'movements' and id = ${id}`)[0]?.doc;
  const sent = typeof r.transferId === 'string' ? await movement(r.transferId) : undefined;
  if (!sent || sent.type !== 'TRANSFER_OUT' || sent.transferId !== sent.id) return 'The Stocks Out this answers is not on the server.';
  const wrong = "This doesn't match the Stocks Out it answers.";
  const same = r.productId === sent.productId && r.condition === sent.condition && Number.isInteger(r.qty);
  if (r.type === 'TRANSFER_IN') {
    const accepts = r.id === `${sent.id}-in` && r.locationId === sent.counterpartLocationId && r.counterpartLocationId === sent.locationId && r.qty >= 0;
    return same && accepts ? null : wrong;
  }
  const accepted = await movement(`${sent.id}-in`);
  if (!accepted) return 'This stock has not been accepted yet, so there is nothing to settle.';
  // What didn't arrive goes back on the sender's count, or more sent than recorded comes off it; or nothing changes.
  const difference = -sent.qty - accepted.qty;
  const settles = r.id === `${sent.id}-settled` && r.locationId === sent.locationId && r.counterpartLocationId === sent.counterpartLocationId &&
    difference !== 0 && (r.qty === 0 || r.qty === difference);
  return same && settles ? null : wrong;
}

async function push(auth: Auth, entries: Entry[]) {
  const accepted: { id: string; receivedAt: string }[] = [];
  const rejected: { id: string; reason: string }[] = [];
  for (const e of entries) {
    const outcome = await sql.begin(async (tx) => {
      await tx`select last_seq from sgm.sync_state where id = 1 for update`;
      const [seen] = await tx`select received_at from sgm.sync_receipts where entry_id = ${e.id}`;
      if (seen) return { receivedAt: seen.received_at as Date };

      const [old] = await tx`select doc, received_at from sgm.records where collection = ${e.collection} and id = ${e.recordId}`;
      const problem = await problemWith(tx, auth, e, old?.doc ?? null);
      if (problem) {
        console.warn(`Rejected ${e.collection} ${e.recordId} from ${auth.user.username}: ${problem}`);
        return { problem };
      }

      const r = e.payload;
      // Ledger entries never change; a sale may only change from completed to voided; a claim only while it waits
      // for approval.
      const keepOld = old && (
        LEDGERS.includes(e.collection) ||
        (e.collection === 'sales' && !(old.doc.status === 'completed' && r.status === 'voided')) ||
        (e.collection === 'claims' && old.doc.status !== 'pending'));
      let receivedAt: Date = old?.received_at;
      if (!keepOld) {
        const [row] = await tx`
          insert into sgm.records (collection, id, doc, seq)
          values (${e.collection}, ${e.recordId}, ${tx.json(r)}, nextval('sgm.sync_seq'))
          on conflict (collection, id) do update set doc = excluded.doc, seq = excluded.seq, received_at = now()
          returning seq, received_at`;
        await tx`update sgm.sync_state set last_seq = ${row.seq} where id = 1`;
        receivedAt = row.received_at;
      }
      await tx`insert into sgm.sync_receipts values (${e.id}, ${e.collection}, ${e.recordId}, ${auth.user.id}, ${auth.deviceId}, ${receivedAt})`;
      return { receivedAt };
    });
    if ('problem' in outcome) rejected.push({ id: e.id, reason: outcome.problem! });
    else accepted.push({ id: e.id, receivedAt: outcome.receivedAt.toISOString() });
  }
  return { accepted, rejected };
}

/** Changes after `cursor`, leaving out collections the app named in the X-SGM-App header can't store. */
async function pull(cursor: string | undefined, appHeader: string | undefined) {
  const from = Number(cursor ?? 0) || 0;
  const [state] = await sql`select last_seq from sgm.sync_state where id = 1`;
  const upTo = Math.min(Number(state.last_seq), from + MAX_PER_PULL);
  const rows = await sql`select collection, doc, received_at from sgm.records where seq > ${from} and seq <= ${upTo} order by seq`;
  // The browser preview sends no header; it is always the current version.
  const version = (appHeader ?? '').split('/')[1];
  const changes = new Map<string, Doc[]>();
  for (const row of rows) {
    const addedIn = ADDED_IN[row.collection];
    if (version && addedIn && compareVersions(version, addedIn) < 0) continue;
    // Locations and users have no receivedAt; everything else gets the server's time.
    const record = row.collection === 'locations' || row.collection === 'users' ? row.doc : { ...row.doc, receivedAt: row.received_at.toISOString() };
    if (!changes.has(row.collection)) changes.set(row.collection, []);
    changes.get(row.collection)!.push(record);
  }
  return { cursor: String(upTo), changes: [...changes].map(([collection, records]) => ({ collection, records })) };
}

type AppStatus = { state: 'ok' | 'update_required' | 'disabled'; message: string | null; minVersion: string | null };

/** Compares dotted version numbers ("1.2.10" is newer than "1.2.9"), as compareVersions in packages/core/src/app-policy.ts. */
function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split('.').slice(0, 3).map((p) => parseInt(p, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/** What sgm.app_policy says about the app named in the X-SGM-App header ("desk/1.2.0", "android/1.2.0"). */
async function appStatusOf(header: string | undefined): Promise<AppStatus> {
  const [platform, version] = (header ?? '').split('/');
  // The browser preview sends no header; it is only used while developing.
  if (!platform || !version) return { state: 'ok', message: null, minVersion: null };
  const [policy] = await sql`select min_version, enabled, message from sgm.app_policy where platform = ${platform}`;
  if (!policy) return { state: 'ok', message: null, minVersion: null };
  const state = !policy.enabled ? 'disabled' : compareVersions(version, policy.min_version) < 0 ? 'update_required' : 'ok';
  return { state, message: state === 'ok' ? null : policy.message, minVersion: policy.min_version };
}

const githubHeaders = () => ({
  Authorization: `Bearer ${RELEASES_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'sgm-api',
});

type Release = { tag_name: string; draft: boolean; prerelease: boolean; assets: { id: number; name: string }[] };

/** One app's published releases in the private repo, newest version first. */
async function releasesOf(platform: string): Promise<Release[]> {
  const response = await fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=30`, { headers: githubHeaders() });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} when listing releases.`);
  const prefix = RELEASE_TAG[platform];
  const version = (r: Release) => r.tag_name.slice(prefix.length);
  return ((await response.json()) as Release[])
    .filter((r) => !r.draft && !r.prerelease && r.tag_name.startsWith(prefix))
    .sort((a, b) => compareVersions(version(b), version(a)));
}

/** A download link for one release file that works for a few minutes, without the GitHub token. */
async function downloadLink(assetId: number): Promise<string> {
  const response = await fetch(`https://api.github.com/repos/${RELEASES_REPO}/releases/assets/${assetId}`, {
    headers: { ...githubHeaders(), Accept: 'application/octet-stream' },
    redirect: 'manual',
  });
  await response.body?.cancel();
  const location = response.headers.get('location');
  if (!location) throw new Error(`GitHub answered ${response.status} for release file ${assetId}.`);
  return location;
}

/** The signed-in person, or null when the token is bad, the user is disabled or the device isn't approved. */
async function authOf(header: string | undefined): Promise<Auth | null> {
  if (!header?.startsWith('Bearer ')) return null;
  try {
    const { payload } = await jwtVerify(header.slice(7), secret);
    const deviceId = String(payload.dev);
    const [row] = await sql`
      select r.doc, d.approved from sgm.records r
      left join sgm.devices d on d.id = ${deviceId}
      where r.collection = 'users' and r.id = ${payload.sub ?? ''}`;
    if (!row || row.doc.active !== true || (REQUIRE_DEVICE_APPROVAL && !row.approved)) return null;
    return { user: row.doc, deviceId };
  } catch {
    return null;
  }
}

const app = new Hono().basePath('/api');

// SGM Desk's screens load from app://sgm; the Expo dev server is http://localhost:8081. Phones send no origin.
app.use('*', cors({ origin: ['app://sgm', 'http://localhost:8081'], allowHeaders: ['Content-Type', 'Authorization', 'X-SGM-App'], allowMethods: ['GET', 'POST', 'OPTIONS'] }));

// When the owner turns SGM off or raises the minimum version, sign-in and sync stop until the app is allowed again.
// 423 and 426, not 401: HttpApi turns every 401 into "Your sign-in has expired".
for (const path of ['/auth/*', '/sync/*', '/admin/*']) {
  app.use(path, async (c, next) => {
    const status = await appStatusOf(c.req.header('X-SGM-App'));
    if (status.state === 'disabled') return c.text(status.message ?? 'The owner has turned SGM off for now.', 423);
    if (status.state === 'update_required') return c.text(status.message ?? 'This version of SGM is too old. Update it to keep working.', 426);
    await next();
  });
}

app.onError((error, c) => {
  console.error(error);
  return c.text('The SGM server ran into a problem. Try again in a moment.', 500);
});

app.get('/health', async (c) => {
  await sql`select 1`;
  return c.text('ok');
});

app.post('/auth/login', async (c) => {
  const { username, pin, deviceId } = await c.req.json().catch(() => ({}));
  // Answer refusals with 400, not 401: HttpApi turns every 401 into "Your sign-in has expired".
  if (typeof username !== 'string' || typeof pin !== 'string' || typeof deviceId !== 'string' || !deviceId) {
    return c.text('Enter your username and PIN.', 400);
  }
  const [login] = await sql`
    select l.user_id, l.failed_logins, l.pin_hash = extensions.crypt(${pin}, l.pin_hash) as pin_ok, r.doc
    from sgm.logins l join sgm.records r on r.collection = 'users' and r.id = l.user_id
    where l.username = ${username.trim().toLowerCase()}`;
  if (login?.failed_logins >= 5) return c.text('Too many wrong PINs. Ask the owner to reset yours.', 400);
  if (!login || !login.pin_ok || login.doc.active !== true) {
    if (login) await sql`update sgm.logins set failed_logins = failed_logins + 1 where user_id = ${login.user_id}`;
    return c.text('Wrong username or PIN.', 400);
  }
  await sql`update sgm.logins set failed_logins = 0 where user_id = ${login.user_id}`;

  const [device] = await sql`
    insert into sgm.devices (id, last_seen_at, last_user_id) values (${deviceId}, now(), ${login.user_id})
    on conflict (id) do update set last_seen_at = now(), last_user_id = excluded.last_user_id
    returning approved`;
  if (REQUIRE_DEVICE_APPROVAL && !device.approved) {
    return c.text(`This device is new. Ask the owner to approve it (Device ID ${deviceId}), then sign in again.`, 403);
  }
  await sql`insert into sgm.device_users values (${deviceId}, ${login.user_id}) on conflict do nothing`;

  const expiresAt = new Date(Date.now() + TOKEN_HOURS * 3_600_000);
  const token = await new SignJWT({ dev: deviceId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(login.user_id)
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(secret);
  return c.json({ token, user: login.doc, expiresAt: expiresAt.toISOString() });
});

app.post('/sync/push', async (c) => {
  const auth = await authOf(c.req.header('Authorization'));
  if (!auth) return c.text('Sign in again.', 401);
  const body = await c.req.json().catch(() => ({}));
  const entries: Entry[] = Array.isArray(body.entries) ? body.entries.slice(0, 100) : [];
  return c.json(await push(auth, entries));
});

app.get('/sync/pull', async (c) => {
  const auth = await authOf(c.req.header('Authorization'));
  if (!auth) return c.text('Sign in again.', 401);
  return c.json(await pull(c.req.query('cursor'), c.req.header('X-SGM-App')));
});

// Users & Devices (packages/core/src/api.ts): the owner and admins manage accounts and devices from the apps.
// Refusals are 400, 403, 404 or 409 with a message the window shows as it is.

/** The signed-in person, when they may manage users and devices; otherwise the response to send. */
async function managerOf(c: Context): Promise<Auth | Response> {
  const auth = await authOf(c.req.header('Authorization'));
  if (!auth) return c.text('Sign in again.', 401);
  if (!can(auth.user, 'users.manage')) return c.text('Only the owner or an admin can manage users and devices.', 403);
  return auth;
}

const USERNAME = /^[a-z0-9._-]{3,30}$/;
const PIN = /^[0-9]{4,8}$/;

/** Reads a UserInput, or says what is wrong with it. */
function userInput(body: unknown): Doc | string {
  const u = (body as Doc)?.user as Doc | undefined;
  if (!u || typeof u !== 'object') return 'Send the account to save.';
  if (u.id !== undefined && (typeof u.id !== 'string' || !u.id)) return 'Unknown account.';
  if (typeof u.username !== 'string' || !USERNAME.test(u.username.trim().toLowerCase())) {
    return 'Usernames are 3 to 30 letters, numbers, dots, dashes or underscores, like maria.s.';
  }
  if (typeof u.displayName !== 'string' || u.displayName.trim().length < 2 || u.displayName.length > 60) return 'Enter their name.';
  if (!Object.hasOwn(ROLE_PERMISSIONS, u.role)) return 'Choose a role.';
  if (!Array.isArray(u.locationIds) || u.locationIds.length === 0 || !u.locationIds.every((l: unknown) => typeof l === 'string')) {
    return 'Choose at least one branch or warehouse they work at.';
  }
  if (!Array.isArray(u.extraPermissions) || !u.extraPermissions.every((p: unknown) => PERMISSIONS.includes(p as string))) return 'Unknown permission.';
  if (typeof u.active !== 'boolean') return 'Say whether the account is active.';
  if (u.pin !== undefined && (typeof u.pin !== 'string' || !PIN.test(u.pin))) return 'A PIN is 4 to 8 digits.';
  return u;
}

app.post('/admin/users', async (c) => {
  const auth = await managerOf(c);
  if (auth instanceof Response) return auth;
  const input = userInput(await c.req.json().catch(() => null));
  if (typeof input === 'string') return c.text(input, 400);
  const manager = auth.user;
  const username = input.username.trim().toLowerCase();

  const outcome = await sql.begin(async (tx): Promise<{ status: 400 | 403 | 404 | 409; message: string } | { user: Doc }> => {
    const [current] = input.id ? await tx`select doc from sgm.records where collection = 'users' and id = ${input.id} for update` : [];
    if (input.id && !current) return { status: 404, message: 'That account no longer exists.' };
    const old: Doc | null = current?.doc ?? null;
    if (!canManageAccount(manager, input.role) || (old && !canManageAccount(manager, old.role))) {
      return { status: 403, message: "Only the owner can change the owner's and admins' accounts." };
    }
    if (old && old.id === manager.id && (!input.active || input.role !== old.role)) {
      return { status: 400, message: "You can't disable your own account or change your own role." };
    }
    const hadUsersManage = (old?.extraPermissions ?? []).includes('users.manage');
    if (manager.role !== 'owner' && input.extraPermissions.includes('users.manage') && !hadUsersManage) {
      return { status: 403, message: 'Only the owner can let someone else manage users and devices.' };
    }
    if (!old && !input.pin) return { status: 400, message: 'Give them a PIN of 4 to 8 digits.' };
    const known = await tx`select id from sgm.records where collection = 'locations' and id in ${tx(input.locationIds)}`;
    if (known.length !== new Set(input.locationIds).size) return { status: 400, message: 'One of those branches or warehouses no longer exists.' };
    const [taken] = await tx`select user_id from sgm.logins where username = ${username} and user_id <> ${old?.id ?? ''}`;
    if (taken) return { status: 409, message: `The username ${username} is taken.` };

    const user: Doc = {
      id: old?.id ?? crypto.randomUUID(),
      username,
      displayName: input.displayName.trim().replace(/\s+/g, ' '),
      role: input.role,
      extraPermissions: input.extraPermissions.filter((p: string) => !ROLE_PERMISSIONS[input.role].includes(p) && !ROLE_ONLY.includes(p)),
      locationIds: [...new Set(input.locationIds as string[])],
      active: input.active,
    };
    if (input.pin) {
      // A new PIN also clears the wrong-PIN lock.
      await tx`
        insert into sgm.logins (user_id, username, pin_hash)
        values (${user.id}, ${username}, extensions.crypt(${input.pin}, extensions.gen_salt('bf', 10)))
        on conflict (user_id) do update set username = excluded.username, pin_hash = excluded.pin_hash, failed_logins = 0`;
    } else {
      await tx`update sgm.logins set username = ${username} where user_id = ${user.id}`;
    }
    await tx`select sgm.save('users', ${tx.json(user)})`;
    return { user };
  });
  if ('user' in outcome) return c.json(outcome.user);
  return c.text(outcome.message, outcome.status);
});

/** A row of sgm.devices as the apps' Device. */
const deviceOf = (row: Doc) => ({
  id: row.id,
  label: row.label ?? null,
  approved: row.approved,
  locationId: row.location_id ?? null,
  firstSeenAt: new Date(row.first_seen_at).toISOString(),
  lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
  lastUserId: row.last_user_id ?? null,
});

app.get('/admin/devices', async (c) => {
  const auth = await managerOf(c);
  if (auth instanceof Response) return auth;
  const rows = await sql`select * from sgm.devices order by last_seen_at desc nulls last, first_seen_at desc`;
  return c.json(rows.map(deviceOf));
});

app.post('/admin/devices', async (c) => {
  const auth = await managerOf(c);
  if (auth instanceof Response) return auth;
  const d = ((await c.req.json().catch(() => null)) as Doc | null)?.device as Doc | undefined;
  if (!d || typeof d.id !== 'string' || !d.id.trim()) return c.text('Choose a device.', 400);
  if (typeof d.label !== 'string' || d.label.length > 60) return c.text('Keep the name under 60 characters.', 400);
  if (typeof d.approved !== 'boolean') return c.text('Say whether the device is approved.', 400);
  if (d.locationId !== null && typeof d.locationId !== 'string') return c.text('Unknown branch or warehouse.', 400);
  const id = d.id.trim();
  const [seen] = await sql`select 1 from sgm.devices where id = ${id}`;
  // A device added ahead of its first sign-in is named by the ID its Settings page shows.
  if (!seen && !/^[A-Za-z0-9-]{8,64}$/.test(id)) return c.text("Paste the Device ID from the device's Settings page.", 400);
  if (id === auth.deviceId && !d.approved) return c.text("You can't take away approval from the device you are using.", 400);
  if (d.locationId) {
    const [known] = await sql`select 1 from sgm.records where collection = 'locations' and id = ${d.locationId}`;
    if (!known) return c.text('That branch or warehouse no longer exists.', 400);
  }
  const [row] = await sql`
    insert into sgm.devices (id, label, approved, location_id) values (${id}, ${d.label.trim() || null}, ${d.approved}, ${d.locationId ?? null})
    on conflict (id) do update set label = excluded.label, approved = excluded.approved, location_id = excluded.location_id
    returning *`;
  return c.json(deviceOf(row));
});

app.post('/admin/devices/remove', async (c) => {
  const auth = await managerOf(c);
  if (auth instanceof Response) return auth;
  const { id } = ((await c.req.json().catch(() => null)) ?? {}) as Doc;
  if (typeof id !== 'string' || !id) return c.text('Choose a device.', 400);
  if (id === auth.deviceId) return c.text("You can't remove the device you are using.", 400);
  // Its sign-in history goes too, so offline work queued on it can't be sent until it is approved again.
  await sql.begin(async (tx) => {
    await tx`delete from sgm.device_users where device_id = ${id}`;
    await tx`delete from sgm.devices where id = ${id}`;
  });
  return c.json({ ok: true });
});

app.get('/app/status', async (c) => c.json(await appStatusOf(c.req.header('X-SGM-App'))));

// App updates, only for signed-in people on approved devices. SGM Desk's updater reads latest.yml, then the
// installer (and the previous version's .blockmap, to download only what changed); SGM Pocket reads latest.json,
// then the APK. Large files are a redirect to GitHub, so they never pass through this function.
app.get('/updates/:platform/:file', async (c) => {
  const auth = await authOf(c.req.header('Authorization'));
  if (!auth) return c.text('Sign in again.', 401);
  const { platform, file } = c.req.param();
  if (!Object.hasOwn(RELEASE_TAG, platform)) return c.text('There is no such app.', 404);
  if (!RELEASES_REPO || !RELEASES_TOKEN) return c.text('Updates are not set up on the server yet.', 503);

  const releases = await releasesOf(platform);
  const isVersionFile = file === VERSION_FILE[platform];
  const asset = (isVersionFile ? releases.slice(0, 1) : releases).flatMap((r) => r.assets).find((a) => a.name === file);
  if (!asset) return c.text('There is no such update.', 404);
  const link = await downloadLink(asset.id);
  if (!isVersionFile) return c.redirect(link, 302);

  const response = await fetch(link);
  if (!response.ok) throw new Error(`Downloading ${file} from GitHub failed with ${response.status}.`);
  c.header('Cache-Control', 'no-store');
  c.header('Content-Type', file.endsWith('.json') ? 'application/json' : 'text/yaml');
  return c.body(await response.text());
});

Deno.serve(app.fetch);
