#!/usr/bin/env bash
# Replaces SGM's server data with a backup. Run by .github/workflows/restore.yml, or by hand:
#
#   SGM_RESTORE_DATABASE_URL='postgresql://...' bash scripts/backup/restore.sh "SGM backup 2026-10-22.dump"
#
# Everything in the sgm schema is replaced in one transaction, so a restore that fails changes nothing. Then
# after-restore.sql renumbers the sync order so every PC and phone downloads the restored data, and
# backup-login.sql gives the backup login back its access.
#
# Needs pg_restore and psql 17 or newer, and SGM_RESTORE_DATABASE_URL: the project's postgres login.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
backup=${1:?Pass the backup file to restore}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Written out in full first, so a damaged backup stops here before anything reaches the server.
pg_restore --clean --if-exists --no-owner --no-privileges --file="$work/restore.sql" "$backup"
cat "$here/after-restore.sql" "$here/backup-login.sql" >> "$work/restore.sql"
psql "$SGM_RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction --quiet --file="$work/restore.sql" > /dev/null

psql "$SGM_RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -At -F ': ' \
  -c "select collection, count(*) from sgm.records group by collection order by collection"
