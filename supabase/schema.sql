-- SGM's tables live in their own schema. Supabase's public Data API only exposes "public",
-- so nothing here can be read or changed with the project's API keys; only the SGM function can.
create schema if not exists sgm;
create extension if not exists pgcrypto with schema extensions;

-- Every synced record, in the same shape as the "records" table on each device.
create table sgm.records (
  collection  text not null,          -- products, sets, locations, users, sales, movements, borrowers, loans, claims
  id          text not null,
  doc         jsonb not null,         -- the record exactly as the apps use it (packages/core/src/models.ts)
  seq         bigint not null,        -- sync order: GET /sync/pull?cursor=N returns seq > N
  received_at timestamptz not null default now(),
  primary key (collection, id)
);
create index records_seq on sgm.records (seq);

create sequence sgm.sync_seq;

-- The highest seq saved so far. Writers lock this row, so a pull never skips a record that commits late.
create table sgm.sync_state (id int primary key check (id = 1), last_seq bigint not null);
insert into sgm.sync_state values (1, 0);

-- Sign-in details, kept apart from the user records the apps receive.
create table sgm.logins (
  user_id       text primary key,
  username      text not null unique,
  pin_hash      text not null,
  failed_logins int not null default 0
);

-- Every PC and phone that has tried to sign in, or was added in Users & Devices. The owner or an admin approves
-- each one once.
create table sgm.devices (
  id            text primary key,
  label         text,
  approved      boolean not null default false,
  location_id   text,                  -- the branch or warehouse it is used at, for finding it in the list
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz,
  last_user_id  text
);

-- Who has signed in on which device, so a shared PC can still send the previous cashier's offline sales.
create table sgm.device_users (
  device_id text not null,
  user_id   text not null,
  primary key (device_id, user_id)
);

-- Outbox entries already accepted, so a retried push is answered the same way and never saved twice.
create table sgm.sync_receipts (
  entry_id    text primary key,
  collection  text not null,
  record_id   text not null,
  user_id     text not null,
  device_id   text not null,
  received_at timestamptz not null
);

-- Saves a record the server owns (locations, users) and moves the sync cursor.
create function sgm.save(p_collection text, p_doc jsonb) returns void language plpgsql set search_path = '' as $$
declare v_seq bigint;
begin
  perform 1 from sgm.sync_state where id = 1 for update;
  v_seq := nextval('sgm.sync_seq');
  insert into sgm.records (collection, id, doc, seq) values (p_collection, p_doc->>'id', p_doc, v_seq)
  on conflict (collection, id) do update set doc = excluded.doc, seq = excluded.seq, received_at = now();
  update sgm.sync_state set last_seq = v_seq where id = 1;
end $$;

create function sgm.add_location(p_id text, p_name text, p_kind text) returns void language plpgsql set search_path = '' as $$
begin
  if p_kind not in ('branch', 'warehouse') then raise exception 'Kind must be branch or warehouse'; end if;
  perform sgm.save('locations', jsonb_build_object('id', p_id, 'name', p_name, 'kind', p_kind));
end $$;

-- Creates a user, or changes an existing one's name, role, locations and PIN.
create function sgm.add_user(p_username text, p_name text, p_role text, p_locations text[], p_pin text)
returns text language plpgsql set search_path = '' as $$
declare
  v_username text := lower(trim(p_username));
  v_id text := coalesce((select user_id from sgm.logins where username = lower(trim(p_username))), gen_random_uuid()::text);
  v_unknown text;
begin
  if p_role not in ('owner', 'admin', 'manager', 'employee', 'warehouse') then raise exception 'Role must be owner, admin, manager, employee or warehouse'; end if;
  if p_pin !~ '^[0-9]{4,8}$' then raise exception 'PIN must be 4 to 8 digits'; end if;
  select string_agg(l, ', ') into v_unknown from unnest(p_locations) l
  where not exists (select 1 from sgm.records r where r.collection = 'locations' and r.id = l);
  if v_unknown is not null then raise exception 'Unknown location: %', v_unknown; end if;

  insert into sgm.logins (user_id, username, pin_hash) values (v_id, v_username, extensions.crypt(p_pin, extensions.gen_salt('bf', 10)))
  on conflict (user_id) do update set pin_hash = excluded.pin_hash, failed_logins = 0;
  perform sgm.save('users', jsonb_build_object(
    'id', v_id, 'username', v_username, 'displayName', p_name, 'role', p_role,
    'locationIds', to_jsonb(p_locations), 'active', true,
    -- Keep anything granted with sgm.set_extra_permissions.
    'extraPermissions', coalesce((select r.doc->'extraPermissions' from sgm.records r where r.collection = 'users' and r.id = v_id), '[]'::jsonb)));
  return v_id;
end $$;

-- Gives someone permissions beyond their role, for example reports.view so an employee can see reports. Pass the
-- whole list each time; an empty array takes them all away. Users & Devices does the same. Backups stay the owner's
-- and admins', and accepting stock from other branches stays with the roles that have it.
create function sgm.set_extra_permissions(p_username text, p_permissions text[]) returns void language plpgsql set search_path = '' as $$
declare
  v_doc jsonb;
  v_unknown text;
begin
  -- PERMISSIONS in packages/core/src/roles.ts. Keep them in step.
  select string_agg(p, ', ') into v_unknown from unnest(p_permissions) p
  where p not in ('dashboard.view', 'pos.sell', 'pos.discount', 'borrow.manage', 'cheques.manage', 'claims.approve',
                  'sales.view', 'sales.void', 'inventory.view', 'inventory.record', 'inventory.receive', 'reports.view',
                  'products.manage', 'users.manage', 'settings.device', 'backups.manage');
  if v_unknown is not null then raise exception 'Unknown permission: %', v_unknown; end if;
  -- ROLE_ONLY in roles.ts: these come only with a role. Backups hold every sale and loan.
  if 'backups.manage' = any(p_permissions) then raise exception 'Only the owner and admins make and open backups'; end if;
  if 'inventory.receive' = any(p_permissions) then
    raise exception 'Only the owner, admins, branch managers and warehouse staff accept stock from other branches';
  end if;
  select r.doc into v_doc from sgm.records r join sgm.logins l on l.user_id = r.id
  where r.collection = 'users' and l.username = lower(trim(p_username));
  if v_doc is null then raise exception 'No user named %', p_username; end if;
  perform sgm.save('users', v_doc || jsonb_build_object('extraPermissions', to_jsonb(p_permissions)));
end $$;

-- Disables (false) or re-enables (true) a user. Their next sync signs them out.
create function sgm.set_user_active(p_username text, p_active boolean) returns void language plpgsql set search_path = '' as $$
declare v_doc jsonb;
begin
  select r.doc into v_doc from sgm.records r join sgm.logins l on l.user_id = r.id
  where r.collection = 'users' and l.username = lower(trim(p_username));
  if v_doc is null then raise exception 'No user named %', p_username; end if;
  perform sgm.save('users', v_doc || jsonb_build_object('active', p_active));
end $$;

-- Sets a new PIN and clears the wrong-PIN lock.
create function sgm.reset_pin(p_username text, p_pin text) returns void language plpgsql set search_path = '' as $$
begin
  if p_pin !~ '^[0-9]{4,8}$' then raise exception 'PIN must be 4 to 8 digits'; end if;
  update sgm.logins set pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf', 10)), failed_logins = 0
  where username = lower(trim(p_username));
  if not found then raise exception 'No user named %', p_username; end if;
end $$;

create function sgm.approve_device(p_device_id text, p_label text) returns void language plpgsql set search_path = '' as $$
begin
  update sgm.devices set approved = true, label = p_label where id = p_device_id;
  if not found then raise exception 'No device % yet. Try signing in on it first.', p_device_id; end if;
end $$;

-- The owner's switch for the apps (packages/core/src/app-policy.ts): the oldest version still allowed, and whether
-- SGM may be used at all. The API refuses sign-in and sync, and the apps show why, until this allows them again.
create table sgm.app_policy (
  platform       text primary key check (platform in ('desk', 'android')),
  min_version    text not null default '0.0.0',
  enabled        boolean not null default true,
  message        text,
  updated_at     timestamptz not null default now()
);
insert into sgm.app_policy (platform) values ('desk'), ('android');

-- Stock on hand is the sum of movements, as packages/core/src/ledger.ts computes it.
create view sgm.stock_on_hand as
  select doc->>'locationId' as location_id, doc->>'productId' as product_id, doc->>'condition' as condition,
         sum((doc->>'qty')::int) as qty
  from sgm.records where collection = 'movements'
  group by 1, 2, 3;

-- Completed sales per branch per day (Philippine time), in pesos.
create view sgm.daily_sales as
  select doc->>'locationId' as location_id,
         ((doc->>'createdAt')::timestamptz at time zone 'Asia/Manila')::date as sale_day,
         count(*) as sales, sum((doc->>'total')::bigint) / 100.0 as total_pesos
  from sgm.records where collection = 'sales' and doc->>'status' = 'completed'
  group by 1, 2;
