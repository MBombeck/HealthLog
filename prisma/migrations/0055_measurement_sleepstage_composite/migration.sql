-- v1.4.25 W17b/c — extend the measurement dedup composite with sleep_stage.
--
-- The Withings Sleep v2 sync writes one Measurement row per stage segment
-- (AWAKE | LIGHT/CORE | DEEP | REM) for the same night. Every segment
-- shares (user_id, type=SLEEP_DURATION, measured_at, source=WITHINGS) —
-- only the per-stage label differentiates them. The legacy composite
-- (user_id, type, measured_at, source) collapses them onto a single row;
-- including sleep_stage in the unique key keeps every stage distinct
-- while preserving idempotency on a re-sync.
--
-- Postgres NULL semantics: a unique index treats two NULL entries as
-- DISTINCT by default, which would re-break dedup for every non-sleep
-- row (where sleep_stage IS NULL). PG15+ ships `NULLS NOT DISTINCT` as
-- a native unique-index option that flips that behaviour — two rows
-- with NULL sleep_stage now collide just like any other duplicate. The
-- application stack runs Postgres 16 (docker-compose pins
-- postgres:16-alpine), so the syntax is available everywhere HealthLog
-- deploys.
--
-- Prisma 7 still defaults to the NULLS-DISTINCT shape when it
-- regenerates the index, so this migration is hand-written. Future
-- `prisma migrate dev --create-only` runs that touch this index need to
-- preserve the `NULLS NOT DISTINCT` clause manually.

-- Drop the legacy NULLS-DISTINCT composite. The index name is the
-- Prisma 0001_init default — verified via grep on the migrations tree.
DROP INDEX IF EXISTS "measurements_user_id_type_measured_at_source_key";

-- Recreate with sleep_stage as the fifth axis and NULLS NOT DISTINCT
-- so non-sleep rows (sleep_stage IS NULL) continue to dedup on the
-- first four columns alone — same effective semantics as before for
-- every meastype that is not SLEEP_DURATION.
CREATE UNIQUE INDEX "measurements_user_id_type_measured_at_source_sleep_stage_key"
  ON "measurements" ("user_id", "type", "measured_at", "source", "sleep_stage")
  NULLS NOT DISTINCT;
