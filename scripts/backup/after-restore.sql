-- Runs straight after a backup is restored (scripts/backup/restore.sh), in the same transaction.
--
-- Each PC and phone remembers how far through the sync order (sgm.records.seq) it has downloaded, and only asks for
-- what comes after that. They have all seen more than the backup holds, so the restored records are numbered again,
-- starting 50,000 past the backup's last number: more changes than the store makes in months. Each device then
-- downloads the restored data again by itself over its next few syncs (up to 5,000 numbers per sync, one a minute).
update sgm.records r
set seq = s.last_seq + 50000 + n.position
from sgm.sync_state s,
     (select collection, id, row_number() over (order by seq) as position from sgm.records) n
where s.id = 1 and r.collection = n.collection and r.id = n.id;

update sgm.sync_state set last_seq = coalesce((select max(seq) from sgm.records), last_seq + 50000) where id = 1;

select setval('sgm.sync_seq', last_seq) from sgm.sync_state where id = 1;
