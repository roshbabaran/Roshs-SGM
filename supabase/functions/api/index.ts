// SGM API: the calls in packages/core/src/api.ts, backed by Supabase Postgres, plus app updates
// served from the private releases repo on GitHub (GITHUB_RELEASES_REPO, GITHUB_RELEASES_TOKEN).
// Deploy: npx supabase functions deploy api --no-verify-jwt --use-api
import { Hono } from 'npm:hono@4';
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
const ROLE_PERMISSIONS: Record<string, string[]> = {
  owner: ['dashboard.view', 'pos.sell', 'borrow.manage', 'sales.view', 'sales.void', 'inventory.view', 'inventory.record', 'reports.view', 'products.manage', 'users.manage', 'settings.device', 'backups.manage'],
  employee: ['dashboard.view', 'pos.sell', 'borrow.manage', 'sales.view', 'inventory.view'],
  warehouse: ['inventory.view', 'inventory.record'],
};
const MANUAL_MOVEMENTS = ['OPENING', 'DELIVERY_IN', 'TRANSFER_IN', 'TRANSFER_OUT', 'ADJUSTMENT', 'DAMAGED', 'RETURN_TO_SUPPLIER'];
const LEDGERS = ['movements', 'loans']; // entries are only ever added, never changed

type Doc = Record<string, any>;
type Entry = { id: string; collection: string; recordId: string; payload: Doc };
type Auth = { user: Doc; deviceId: string };

const can = (user: Doc, permission: string) =>
  user.active === true && ((ROLE_PERMISSIONS[user.role] ?? []).includes(permission) || (user.extraPermissions ?? []).includes(permission));

const worksAt = (user: Doc, locationId: string) => user.role === 'owner' || (user.locationIds ?? []).includes(locationId);

/** The permission a change needs, and the person and branch the record names (see the comment in api.ts). */
function ruleFor(collection: string, r: Doc): { permission: string; actorId?: string; locationId?: string } | null {
  switch (collection) {
    case 'sales':
      return r.status === 'voided'
        ? { permission: 'sales.void', actorId: r.voidedBy, locationId: r.locationId }
        : { permission: 'pos.sell', actorId: r.cashierId, locationId: r.locationId };
    case 'movements': {
      const permission = MANUAL_MOVEMENTS.includes(r.type) ? 'inventory.record'
        : r.type === 'VOID_REVERSAL' ? 'sales.void'
        : r.type === 'CYLINDER_RETURN' ? 'borrow.manage'
        : 'pos.sell';
      return { permission, actorId: r.userId, locationId: r.locationId };
    }
    case 'loans':
      return { permission: 'borrow.manage', actorId: r.userId, locationId: r.locationId };
    case 'borrowers':
      return { permission: 'borrow.manage' };
    case 'products':
    case 'sets':
      return { permission: 'products.manage' };
    default:
      return null;
  }
}

/** Why the server refuses this change, in words a person can act on; null when it's allowed. */
async function problemWith(tx: postgres.TransactionSql, auth: Auth, e: Entry): Promise<string | null> {
  const r = e.payload;
  const rule = r && r.id === e.recordId ? ruleFor(e.collection, r) : null;
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
  if (!can(actor, rule.permission)) return `${actor.displayName} isn't allowed to do this (${rule.permission}).`;
  if (rule.locationId && !worksAt(actor, rule.locationId)) return `${actor.displayName} isn't assigned to ${rule.locationId}.`;
  return null;
}

async function push(auth: Auth, entries: Entry[]) {
  const accepted: { id: string; receivedAt: string }[] = [];
  const rejected: { id: string; reason: string }[] = [];
  for (const e of entries) {
    const outcome = await sql.begin(async (tx) => {
      await tx`select last_seq from sgm.sync_state where id = 1 for update`;
      const [seen] = await tx`select received_at from sgm.sync_receipts where entry_id = ${e.id}`;
      if (seen) return { receivedAt: seen.received_at as Date };

      const problem = await problemWith(tx, auth, e);
      if (problem) {
        console.warn(`Rejected ${e.collection} ${e.recordId} from ${auth.user.username}: ${problem}`);
        return { problem };
      }

      const r = e.payload;
      const [old] = await tx`select doc, received_at from sgm.records where collection = ${e.collection} and id = ${e.recordId}`;
      // Ledger entries never change; a sale may only change from completed to voided.
      const keepOld = old && (LEDGERS.includes(e.collection) || (e.collection === 'sales' && !(old.doc.status === 'completed' && r.status === 'voided')));
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

async function pull(cursor: string | undefined) {
  const from = Number(cursor ?? 0) || 0;
  const [state] = await sql`select last_seq from sgm.sync_state where id = 1`;
  const upTo = Math.min(Number(state.last_seq), from + MAX_PER_PULL);
  const rows = await sql`select collection, doc, received_at from sgm.records where seq > ${from} and seq <= ${upTo} order by seq`;
  const changes = new Map<string, Doc[]>();
  for (const row of rows) {
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
for (const path of ['/auth/*', '/sync/*']) {
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
  return c.json(await pull(c.req.query('cursor')));
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
