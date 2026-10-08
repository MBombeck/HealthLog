# Measurement table maintenance

Since v1.42 the nightly folds of Apple Health data delete the raw samples they
fold into hourly or daily rows, instead of keeping them as deleted rows for 75
days. On an instance that has synced Apple Health for a while, those leftovers
("compaction tombstones") were most of the `measurements` table and of its
indexes. Two pieces clean them up:

1. **The backlog purge** runs by itself. Every worker boot queues one
   `compaction-tombstone-purge` job. It deletes the leftovers 5,000 rows at a
   time, one account at a time, pausing briefly between batches, and stops
   after 40 batches; a run that stopped with work left queues the next one a
   minute later. Rows a person deleted are never touched by it: they keep the
   75-day retention of the nightly tombstone cleanup.
2. **The table maintenance** is yours to start, after the purge. It runs
   `VACUUM (ANALYZE)` on `measurements` and then rebuilds each of its indexes
   with `REINDEX INDEX CONCURRENTLY`, largest first. The purge leaves the
   indexes full of empty pages, and only a rebuild gives that space back.

## Is the purge finished?

The purge reports every run on the wide event `job.compaction_tombstone_purge`
(`compaction_purge_deleted`, `compaction_purge_drained`,
`compaction_purge_deferred_accounts`). It is finished when a run reports
`drained: true` and deletes nothing. From `psql`:

```sql
SELECT state, count(*)
FROM pgboss.job
WHERE name = 'compaction-tombstone-purge'
GROUP BY state;
```

No `created`, `retry` or `active` rows means nothing is queued or running. The
maintenance refuses to start while one is.

## Before you start

- **Pick a quiet window.** Reads and writes keep working during the rebuild,
  but each rebuild reads the whole table twice and writes a full new copy of
  the index.
- **Free disk.** A concurrent rebuild needs room for one more copy of the
  index it is rebuilding, plus the WAL it writes. Check the largest index:

  ```sql
  SELECT c.relname, pg_size_pretty(pg_relation_size(c.oid))
  FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
  WHERE i.indrelid = 'measurements'::regclass
  ORDER BY pg_relation_size(c.oid) DESC
  LIMIT 3;
  ```

  Have at least twice the largest size free on the database volume.

- **Take a backup** (Settings, Data, Backups), as before any operation on the
  whole table.

## Starting it

In the admin area, or with a signed-in admin session:

```sh
curl -X POST https://<your-instance>/api/admin/maintenance/measurements \
  -H 'content-type: application/json' \
  --cookie 'healthlog_session=<session>' \
  -d '{"vacuum": true, "reindex": true}'
```

The answer is `202` with `{ "enqueued": true }`, or `enqueued: false` when a
run is already queued or running. A Bearer token is refused: the route is
cookie-only, like every admin route. Without a background worker the route
answers `503`.

Either step can be left out (`"reindex": false` runs only the vacuum).

## What it does, and what stops it

The run uses a connection of its own: no statement timeout (a rebuild of a
large index takes longer than the app's 60 seconds), `maintenance_work_mem`
of 128 MB for this session only, and a lock timeout of five minutes, so a
rebuild that cannot get its lock gives up instead of holding writers behind
it.

- It refuses to start while the purge is queued or running.
- Before the first rebuild it drops any invalid `<index>_ccnew` copy an
  interrupted earlier run left behind.
- If a rebuild fails, most likely for lack of disk, it drops that rebuild's
  half-built copy at once and stops. The remaining indexes keep working as
  they are. Free some space and start it again; finished indexes are simply
  rebuilt once more.
- One run at a time. It is never retried automatically.

## Reading the result

The run's wide event `job.measurement_maintenance` carries
`maintenance_outcome` (`completed`, `refused_purge_running`, `failed`), the
table and index sizes before and after, and `maintenance_steps`, one entry
per step with its target, size before and after, and duration. The same
sizes from `psql`:

```sql
SELECT pg_size_pretty(pg_total_relation_size('measurements')) AS total,
       pg_size_pretty(pg_indexes_size('measurements')) AS indexes;
```

## Not part of this

`VACUUM FULL` would shrink the table file as well, but it locks the table for
reads and writes while it runs. After the purge the remaining table is small
and the space inside it is reused by new rows, so it is not needed. If you
want it anyway, run it yourself in a maintenance window with the app stopped.
