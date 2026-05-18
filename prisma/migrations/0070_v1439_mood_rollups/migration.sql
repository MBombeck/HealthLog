-- v1.4.39 W-MOOD — persistent mood rollup table.
--
-- Second cache tier behind the 60-s LRU on /api/mood/analytics. Per-
-- (userId, granularity, bucketStart) stats so the read path skips the
-- unbounded MoodEntry.findMany walk that drove the 12.7 s cold mount on
-- power-user accounts.
--
-- Granularity reuses the existing `measurement_rollup_granularity` enum
-- so the worker / cross-granularity readers share a single type.
--
-- Additive only — no ALTER on existing tables, no DROP. The primary key
-- `(user_id, granularity, bucket_start)` guarantees idempotent upserts
-- under re-run; the IF NOT EXISTS guard makes the migration replay-safe
-- on partially-applied environments (mirrors 0061 / 0067 / 0068 / 0069).

CREATE TABLE IF NOT EXISTS "mood_entry_rollups" (
    "user_id"      TEXT                              NOT NULL,
    "granularity"  "measurement_rollup_granularity"  NOT NULL,
    "bucket_start" TIMESTAMPTZ(3)                    NOT NULL,
    "count"        INTEGER                           NOT NULL,
    "mean"         DOUBLE PRECISION                  NOT NULL,
    "min_score"    INTEGER                           NOT NULL,
    "max_score"    INTEGER                           NOT NULL,
    "sd"           DOUBLE PRECISION,
    "computed_at"  TIMESTAMPTZ(3)                    NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mood_entry_rollups_pkey"
        PRIMARY KEY ("user_id", "granularity", "bucket_start")
);

CREATE INDEX IF NOT EXISTS "mood_entry_rollups_user_granularity_bucket_desc_idx"
    ON "mood_entry_rollups" ("user_id", "granularity", "bucket_start" DESC);

DO $$ BEGIN
    ALTER TABLE "mood_entry_rollups"
        ADD CONSTRAINT "mood_entry_rollups_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
