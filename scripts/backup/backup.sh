#!/usr/bin/env bash
# Backs up SGM's server data to Google Drive. Run every night by .github/workflows/backup.yml.
#
# Dumps the sgm schema, proves the file restores into an empty database, uploads it to the "SGM Backups" folder
# in Google Drive, then deletes the backups scripts/backup/prune.mjs says are no longer needed.
#
# Needs pg_dump, pg_restore and psql 17 or newer, rclone with a remote called gdrive, and:
#   SGM_BACKUP_DATABASE_URL  the read-only sgm_backup login (scripts/backup/backup-login.sql)
#   CHECK_DATABASE_URL       an empty Postgres 17 database to test the restore in
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
folder="gdrive:${BACKUP_FOLDER:-SGM Backups}"
day=$(TZ=Asia/Manila date +%F)
file="SGM backup $day.dump"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

echo "Dumping the sgm schema"
pg_dump --format=custom --schema=sgm --no-owner --no-privileges --file="$work/$file" "$SGM_BACKUP_DATABASE_URL"

echo "Checking that it restores"
pg_restore --exit-on-error --no-owner --no-privileges --dbname="$CHECK_DATABASE_URL" "$work/$file"
counts=$(psql "$CHECK_DATABASE_URL" -v ON_ERROR_STOP=1 -At -F ': ' \
  -c "select collection, count(*) from sgm.records group by collection order by collection")
if [ -z "$counts" ]; then
  echo "The backup restored, but it has no records. Not uploading it." >&2
  exit 1
fi

echo "Uploading $file"
rclone copyto "$work/$file" "$folder/$file"

rclone lsf --files-only "$folder" | node "$here/prune.mjs" | while IFS= read -r old; do
  echo "Deleting $old"
  rclone deletefile "$folder/$old"
done

size=$(du -k "$work/$file" | cut -f1)
{
  echo "### $file"
  echo
  echo "$size KB, uploaded to ${folder#gdrive:} in Google Drive. Records in it:"
  echo
  echo '```'
  echo "$counts"
  echo '```'
} >> "${GITHUB_STEP_SUMMARY:-/dev/stdout}"
