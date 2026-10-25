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

- **Take a backup**: a database dump, as in
  [Updates](../self-hosting/getting-started.md#updates), as before any
  operation on the whole table.

## Starting it

In the admin area, or with a signed-in admin session:

```sh
curl -X POST https://<your-instance>/api/admin/maintenance/measurements \
  -H 'content-type: application/json' \
  --cookie '__Host-healthlog_session=<session>' \
  -d '{"vacuum": true, "reindex": true}'
```

On a plain-HTTP install the cookie is named `healthlog_session`.

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
`maintenance_outcome` (`completed`, `nothing_due` for the nightly check,
`refused_purge_running`, `failed`), the live and dead rows the run started from, the
table and index sizes before and after, and `maintenance_steps`, one entry
per step with its target, size before and after, and duration. The same
sizes from `psql`:

```sql
SELECT pg_size_pretty(pg_total_relation_size('measurements')) AS total,
       pg_size_pretty(pg_indexes_size('measurements')) AS indexes;
```

## The nightly check

Since v1.43.7 the same queue also runs by itself at 03:40 (Europe/Berlin).
That run names no steps and changes nothing beyond dropping a retired index
(next section): vacuuming the table is
autovacuum's job, which migration 0412 starts at 5 % dead rows instead of
Postgres's 20 %. The check reads the table's live and dead rows and warns
(`maintenance_autovacuum_behind` on the wide event) when there are at least
10,000 dead rows and more than one for every five live ones, four times the
point at which autovacuum should already have run. That means autovacuum is
not keeping up: look for a transaction left open for hours
(`pg_stat_activity`, `state = 'idle in transaction'`) or for autovacuum
workers busy elsewhere. The check never rebuilds an index. It shares the
singleton key with the run you start, so the two never overlap. The admin
card keeps showing only the runs you started.

The check also measures how far the table file has grown past what its live
rows need (`maintenance_bloat_factor` on the wide event, as a factor such as
1.3; `bloat_percent` in the job result, as whole percent such as 130, because a
job fact is a whole number). Past 3 it adds a warning to the event: a vacuum makes the space
reusable but does not shrink the file, and only `VACUUM FULL` does (see
below).

Why the table grew in the first place: until v1.43.7 an update that changed
nothing still moved `updated_at`, which sits in an index, so no update could
stay on its page. Migration 0412 keeps `updated_at` and `sync_version` on such
an update and gives the table `fillfactor = 85` and a 5 % autovacuum
threshold. To check that updates stay on their page:

```sql
SELECT n_tup_upd, n_tup_hot_upd, n_live_tup, n_dead_tup,
       pg_size_pretty(pg_relation_size('measurements')) AS heap
FROM pg_stat_user_tables WHERE relname = 'measurements';
```

`n_tup_hot_upd` should now grow along with `n_tup_upd`. The fill factor
applies to pages written after the migration; a `VACUUM FULL` after the
upgrade applies it to the whole table.

## Retired indexes

An index the schema no longer declares has to leave the database too, and on
`measurements` the obvious migration is the wrong one. A plain `DROP INDEX`
needs an exclusive lock on the table; `DROP INDEX CONCURRENTLY` blocks nobody
but waits, without limit, for every transaction already running on the
table. A migration runs at boot, so either one waits for whatever holds the
table (a `pg_dump`, a long backfill, a `VACUUM FULL`); past the container's
start period the container is replaced with the migration half done, and the
next boot stops at `P3009` until someone runs `prisma migrate resolve`.

So an index is retired in two halves (v1.43.8, migration 0416, for
`measurements_user_id_type_measured_at_idx`):

1. The migration tries a plain `DROP INDEX IF EXISTS` inside a `DO` block with
   a two-second `lock_timeout` and catches the timeout
   (`EXCEPTION WHEN lock_not_available`). When nothing holds the table the
   index is gone at once; otherwise the migration still succeeds and the
   index stays. The longest the table's other statements can wait behind the
   attempt is those two seconds. A new database and Prisma's shadow database
   always take the lock, so the migration history ends without the index,
   exactly as the schema does, and `prisma migrate dev` / `migrate diff` see
   no drift and generate nothing.
2. The index name goes into `RETIRED_MEASUREMENT_INDEXES` in
   `src/lib/jobs/measurement-maintenance.ts`. Every run of this job, the
   nightly 03:40 check included, drops each name still present with
   `DROP INDEX CONCURRENTLY IF EXISTS`, waiting at most 60 seconds for its
   locks. A run that runs out of time leaves the index (possibly marked
   invalid, which the next drop finishes), sets
   `maintenance_retired_index_pending` on the wide event with a warning, and
   the next night tries again. The index costs writes until then, as it did
   before the release; nothing reads it.

Until the job has run, the database holds one index the schema does not
declare. Nothing compares the two at runtime, and the only place they are
compared, a `migrate diff` against the migration history, never sees it. To
check by hand:

```sql
SELECT indexname FROM pg_indexes
 WHERE tablename = 'measurements'
   AND indexname = 'measurements_user_id_type_measured_at_idx';
```

No row: it is gone. To drop it now rather than at night, start a run from the
admin card (any steps), or run the same statement yourself:

```sql
SET lock_timeout = '60s';
DROP INDEX CONCURRENTLY IF EXISTS "measurements_user_id_type_measured_at_idx";
```

For the next large index, follow the same two halves.
`src/__tests__/migration-lock-timeout-guard.test.ts` refuses a
`DROP INDEX CONCURRENTLY` in any migration and requires every retired name to
have a migration that bounds its wait and catches the timeout.

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
reads and writes while it runs, so no job starts it. When the nightly check
warns about the bloat factor, run it yourself in a maintenance window with the
app stopped.
