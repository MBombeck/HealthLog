-- v1.5.0 — persistent measurement rollup table.
--
-- Second cache tier behind the 60-s LRU. Carries the
-- count / min / max / mean / sd / slope / r2 stats per
-- (userId, type, granularity, bucketStart). The DAY granularity is
-- recomputed inline with every measurement write so the next read is
-- correct; WEEK / MONTH / YEAR granularities are recomputed via the
-- pg-boss `rollup-recompute` queue so the write path stays sub-ms.
--
-- Additive only — no ALTER on existing tables, no DROP. Adds one
-- enum type, one table, and one composite-descending index. The
-- primary key is `(user_id, type, granularity, bucket_start)`, which
-- guarantees idempotent upserts under re-run.

-- Granularity enum. `DO $$ … EXCEPTION WHEN duplicate_object` is the
-- canonical guard for `CREATE TYPE` because Postgres does not accept
-- `CREATE TYPE IF NOT EXISTS`.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_type
        WHERE typname = 'measurement_rollup_granularity'
    ) THEN
        CREATE TYPE "measurement_rollup_granularity"
            AS ENUM ('DAY', 'WEEK', 'MONTH', 'YEAR');
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "measurement_rollups" (
    "user_id"      TEXT                              NOT NULL,
    "type"         "measurement_type"                NOT NULL,
    "granularity"  "measurement_rollup_granularity"  NOT NULL,
    "bucket_start" TIMESTAMPTZ(3)                    NOT NULL,
    "count"        INTEGER                           NOT NULL,
    "mean"         DOUBLE PRECISION                  NOT NULL,
    "min_value"    DOUBLE PRECISION                  NOT NULL,
    "max_value"    DOUBLE PRECISION                  NOT NULL,
    "sd"           DOUBLE PRECISION,
    "slope"        DOUBLE PRECISION,
    "r2"           DOUBLE PRECISION,
    "computed_at"  TIMESTAMPTZ(3)                    NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "measurement_rollups_pkey"
        PRIMARY KEY ("user_id", "type", "granularity", "bucket_start")
);

CREATE INDEX IF NOT EXISTS "measurement_rollups_user_type_granularity_bucket_desc_idx"
    ON "measurement_rollups" ("user_id", "type", "granularity", "bucket_start" DESC);

ALTER TABLE "measurement_rollups"
    ADD CONSTRAINT "measurement_rollups_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
