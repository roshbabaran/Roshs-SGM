-- The read-only login the nightly backup uses (.github/workflows/backup.yml). It can read the sgm schema and
-- nothing else; bypassrls lets pg_dump read the tables, which have row level security turned on. Create it once in
-- the SQL Editor with a long random password, then run this file:
--
--   create role sgm_backup login bypassrls password '<password>';
--
-- Restoring a backup drops and recreates the tables, which takes these grants away, so scripts/backup/restore.sh
-- runs this file again afterwards. It does nothing on a server without the login.
do $$
begin
  if exists (select from pg_roles where rolname = 'sgm_backup') then
    grant usage on schema sgm to sgm_backup;
    grant select on all tables in schema sgm to sgm_backup;
    grant select on all sequences in schema sgm to sgm_backup;
    -- Tables added to schema.sql later are included without running this again.
    alter default privileges for role postgres in schema sgm grant select on tables to sgm_backup;
    alter default privileges for role postgres in schema sgm grant select on sequences to sgm_backup;
  end if;
end $$;
