-- Pulse: a day is the mean of its hours' means, a coarser bucket the mean of
-- its days.
--
-- A watch samples pulse about every 5 to 10 minutes at rest and about every
-- 5 seconds in a workout, so the plain mean over a day's readings let one
-- workout hour outweigh the other twenty-three. The rollup writer now stores a
-- PULSE DAY bucket's `mean` as the mean of its per-hour means, and a WEEK /
-- MONTH / YEAR bucket's as the mean of its days' values (see
-- `src/lib/measurements/day-statistic.ts`). Nothing rewrites a stored bucket
-- on its own: the boot backfill and the freshness check fill only missing
-- days, so rows written before this release would keep the reading mean
-- until a write happened to touch their day. This migration recomputes them.
--
-- Scope, exactly:
--   - only rows of type PULSE, in every granularity;
--   - only the `mean` column. `count`, `min_value`, `max_value`, `sum_value`,
--     `sd`, `slope`, `r2` and the regression sums stay over every reading, as
--     the writer keeps them;
--   - hours, days, weeks, months and years are `date_trunc` on `measured_at`
--     in the session zone, exactly as the writer groups them, per user / source
--     over non-deleted readings.
--
-- Recomputing from `measurements` makes the migration idempotent: a rerun
-- derives the same means whatever the column held before. A stored row whose
-- readings are all gone is left as it is; the writer prunes such rows on the
-- next fold of their range.
--
-- The hour means are built once into a temporary table, so the readings are
-- scanned once for all four granularities.
--
-- Reversibility (down): recompute `mean` as `AVG(value)` over the same groups,
-- or refold the PULSE rollups on a release before this one. No column changes
-- shape.

CREATE TEMPORARY TABLE pulse_hour_means AS
SELECT
  m."user_id"                         AS user_id,
  m."source"                          AS source,
  date_trunc('hour', m."measured_at") AS hr,
  AVG(m."value")                      AS hour_mean
FROM measurements m
WHERE m."type" = 'PULSE'
  AND m."deleted_at" IS NULL
GROUP BY m."user_id", m."source", date_trunc('hour', m."measured_at");

CREATE TEMPORARY TABLE pulse_day_means AS
SELECT
  h.user_id,
  h.source,
  date_trunc('day', h.hr) AS day,
  AVG(h.hour_mean)        AS day_mean
FROM pulse_hour_means h
GROUP BY h.user_id, h.source, date_trunc('day', h.hr);

CREATE INDEX pulse_day_means_key ON pulse_day_means (user_id, source, day);

-- DAY buckets: the mean of the day's hour means.
UPDATE "measurement_rollups" r
SET "mean" = d.day_mean
FROM pulse_day_means d
WHERE r."granularity" = 'DAY'
  AND r."type"         = 'PULSE'
  AND r."user_id"      = d.user_id
  AND r."source"       = d.source
  AND r."bucket_start" = d.day;

-- WEEK buckets: the mean of the week's day values.
UPDATE "measurement_rollups" r
SET "mean" = s.mean
FROM (
  SELECT d.user_id, d.source, date_trunc('week', d.day) AS bucket_start,
         AVG(d.day_mean) AS mean
  FROM pulse_day_means d
  GROUP BY d.user_id, d.source, date_trunc('week', d.day)
) s
WHERE r."granularity" = 'WEEK'
  AND r."type"         = 'PULSE'
  AND r."user_id"      = s.user_id
  AND r."source"       = s.source
  AND r."bucket_start" = s.bucket_start;

-- MONTH buckets.
UPDATE "measurement_rollups" r
SET "mean" = s.mean
FROM (
  SELECT d.user_id, d.source, date_trunc('month', d.day) AS bucket_start,
         AVG(d.day_mean) AS mean
  FROM pulse_day_means d
  GROUP BY d.user_id, d.source, date_trunc('month', d.day)
) s
WHERE r."granularity" = 'MONTH'
  AND r."type"         = 'PULSE'
  AND r."user_id"      = s.user_id
  AND r."source"       = s.source
  AND r."bucket_start" = s.bucket_start;

-- YEAR buckets.
UPDATE "measurement_rollups" r
SET "mean" = s.mean
FROM (
  SELECT d.user_id, d.source, date_trunc('year', d.day) AS bucket_start,
         AVG(d.day_mean) AS mean
  FROM pulse_day_means d
  GROUP BY d.user_id, d.source, date_trunc('year', d.day)
) s
WHERE r."granularity" = 'YEAR'
  AND r."type"         = 'PULSE'
  AND r."user_id"      = s.user_id
  AND r."source"       = s.source
  AND r."bucket_start" = s.bucket_start;

DROP TABLE pulse_day_means;
DROP TABLE pulse_hour_means;
