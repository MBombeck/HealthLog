-- v1.4.39 W-SUM — cumulative-metric sumValue column on measurement_rollups.
--
-- Cumulative measurement types (ACTIVITY_STEPS, FLIGHTS_CLIMBED,
-- WALKING_RUNNING_DISTANCE, TIME_IN_DAYLIGHT, ACTIVE_ENERGY) report
-- per-event slices; the analytics + dashboard hot paths need the
-- per-day SUM, not the per-day MEAN. Today those paths fall through to
-- `pickCumulativeDaySum` in JS over the chunked per-type series.
--
-- Adding `sum_value` directly on the rollup row lets the read path
-- consume it via a single bounded findMany. Nullable because existing
-- rows pre-date the writer change; the boot-time backfill folds NULLs
-- into populated values on first reach (deterministic upsert with the
-- same composite PK).
--
-- Additive only — IF NOT EXISTS guard mirrors 0068.

ALTER TABLE "measurement_rollups"
  ADD COLUMN IF NOT EXISTS "sum_value" DOUBLE PRECISION;
