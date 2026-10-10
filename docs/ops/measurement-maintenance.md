# Measurement table maintenance

Since v1.42 the nightly folds of Apple Health data delete the raw samples they
fold into hourly or daily rows, instead of keeping them as deleted rows for 75
days. On an instance that has synced Apple Health for a while, those leftovers
("compaction tombstones") were most of the `measurements` table and of its
indexes. Three pieces deal with them, in this order:

1. **The fold repair** runs by itself, once per account, before anything is
   deleted. Up to v1.42 the folds could fold a day in two runs, and the
   second run stored the mean of the later part of the day only. The repair
   recomputes those hourly and daily means from all of the day's samples,
   including the compaction tombstones, and corrects a stored mean only when
   it differs. It does so only where every sample of the day is provably
   still in the table: the last 75 days for daily means, and for hourly
   means (folded 90 days late) the 75 days before that. Older days stay as
   they are, because the deleted rows of their samples have passed the
   75-day retention and what is left can be a fragment of the day. When it
   has finished an account it records that in `measurement_fold_repairs`.
2. **The backlog purge** runs by itself, after the repair. Every worker boot queues one
   `compaction-tombstone-purge` job. It deletes the leftovers 5,000 rows at a
   time, one account at a time, pausing briefly between batches, and stops
   after 40 batches; a run that stopped with work left queues the next one a
   minute later. Rows a person deleted are never touched by it: they keep the
   75-day retention of the nightly tombstone cleanup. The purge leaves an
   account alone until the repair has finished it, and a boot queues no purge
   run while the repair has finished no account.
3. **The table maintenance** is yours to start, after the purge. It runs
   `VACUUM (ANALYZE)` on `measurements` and then rebuilds each of its indexes
   with `REINDEX INDEX CONCURRENTLY`, largest first. The purge leaves the
   indexes full of empty pages, and only a rebuild gives that space back.

## Repair before purge

The order matters because the purge deletes what the repair reads. Do not
delete compaction tombstones by hand, and do not insert rows into
`measurement_fold_repairs` to hurry the purge along: a mean the repair has not
seen keeps its wrong value for good once its tombstones are gone.

The repair reports every run on the wide event `job.measurement_fold_repair`
(`fold_repair_means_checked`, `fold_repair_means_corrected`,
`fold_repair_resting_corrected`, `fold_repair_skipped_beyond_horizon` for the
older windows it left as they are, `fold_repair_samples_absorbed` for live
samples it took into a checked mean, and `fold_repair_by_type` with the same
counts per type; counts only, never a value). A second run over an account
corrects nothing. It is finished when every account has a row:

```sql
SELECT count(*) AS accounts_left
FROM users u
LEFT JOIN measurement_fold_repairs r ON r.user_id = u.id
WHERE r.user_id IS NULL;
```

Each run works on one account, a day at a time, and stops on its time budget
with a follow-up that resumes at the next day; an account under restore is
tried again five minutes later. While accounts are left, purge runs report
them as `compaction_purge_awaiting_repair_accounts`.

A restore of a backup exported before the account's repair finished writes
the compaction tombstones back, removes the account's row and queues the
repair again; the purge follows once the repair is through.

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

## "could not resize shared memory segment"

Up to v1.42.0 the run could stop at once with `could not resize shared memory
segment ... No space left on device`. Postgres ran the vacuum in parallel and
kept its working memory in `/dev/shm`, which Docker limits to 64 MB per
container unless `shm_size` is set. From v1.42.1 the maintenance connection
runs single-process and needs no shared segment, and the bundled
`docker-compose.yml` gives the database `shm_size: 256mb`. On v1.42.0, add
`shm_size: 256mb` to the `db` service and restart the database container.

## Not part of this

`VACUUM FULL` would shrink the table file as well, but it locks the table for
reads and writes while it runs. After the purge the remaining table is small
and the space inside it is reused by new rows, so it is not needed. If you
want it anyway, run it yourself in a maintenance window with the app stopped.
