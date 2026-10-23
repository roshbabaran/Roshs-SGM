-- SGM 1.1.0 server upgrade. Run it once in the Supabase SQL Editor, then deploy the 1.1.0 API
-- (npx supabase functions deploy api --no-verify-jwt --use-api). Running it again changes nothing.
-- A new project needs only schema.sql, which already has all of this.

-- Users & Devices: each device can be placed at a branch or warehouse, for finding it in the list.
alter table sgm.devices add column if not exists location_id text;

-- The admin and branch manager roles, the new permissions (pos.discount, cheques.manage, claims.approve,
-- inventory.receive), backups only for the owner and admins (backups.manage can't be given to anyone else), and
-- accepting stock from other branches only for the owner, admins, branch managers and warehouse staff.
create or replace function sgm.add_user(p_username text, p_name text, p_role text, p_locations text[], p_pin text)
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

create or replace function sgm.set_extra_permissions(p_username text, p_permissions text[]) returns void language plpgsql set search_path = '' as $$
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

-- When every PC and phone has 1.1.0, or to make them update: SGM 1.0 sells a set that holds other sets with only
-- its own items (so stock comes out wrong), doesn't know the admin and branch manager roles (they can't sign in on it),
-- doesn't count defective stock apart, and doesn't receive Claims. Run this after
-- the 1.1.0 installer and APK are released:
--
-- update sgm.app_policy set min_version = '1.1.0', message = 'Update SGM to version 1.1.0 to keep working.', updated_at = now()
-- where platform in ('desk', 'android');
