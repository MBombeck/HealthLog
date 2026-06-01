-- v1.5.6 — accelerate the legacy step-consolidation discovery query.
--
-- The boot-time consolidation pass (`enqueueBootTimeStepConsolidation`
-- in src/lib/jobs/step-consolidation.ts) repeatedly scans for users
-- still holding live pre-v1.5.0 granular step rows: `ACTIVITY_STEPS`
-- rows that are not tombstoned and whose `external_id` is NULL or does
-- not carry the `stats:HKQuantityTypeIdentifierStepCount:` daily-total
-- prefix. On an account with a multi-year HealthKit history that
-- predicate matches hundreds-of-thousands of rows before the
-- consolidation tombstones them.
--
-- A partial index keyed on the legacy-candidate predicate keeps both
-- the per-boot discovery scan and the per-user `findMany` cheap, and —
-- because the index only covers `deleted_at IS NULL` rows — it shrinks
-- to (eventually) empty as the pass converges, so it carries no
-- steady-state write cost once every legacy row is consolidated.
--
-- Additive + order-safe: a pure `CREATE INDEX IF NOT EXISTS`, no column
-- add, no backfill, no rewrite of `measurements`.
--
-- Lock note (conscious trade-off): this is a plain, non-`CONCURRENTLY`
-- index build, so it runs inside Prisma's migration transaction and
-- holds an ACCESS EXCLUSIVE lock on `measurements` for the duration of
-- the build — reads and writes to the table block until it completes.
-- The `deleted_at IS NULL` + `type = 'ACTIVITY_STEPS'` partial predicate
-- keeps the index tiny (most tenants carry no legacy step rows at all,
-- and the covered set shrinks to empty as the pass converges), so on a
-- typical self-host the build is sub-second and the lock is not felt.
-- The largest multi-year HealthKit tenants are the ones who both need
-- this index and would feel a longer lock; for those, run the deploy at
-- a low-traffic window. A `CONCURRENTLY` build cannot run inside the
-- migration transaction and is not warranted given the partial-index
-- size on the overwhelming majority of deployments.

CREATE INDEX IF NOT EXISTS "measurements_legacy_step_consolidation_idx"
  ON "measurements" ("user_id", "measured_at")
  WHERE "type" = 'ACTIVITY_STEPS'
    AND "deleted_at" IS NULL;
