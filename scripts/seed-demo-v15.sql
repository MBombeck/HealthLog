-- v1.5.0 demo seed — sliding-window, NOW()-anchored, full iOS+Withings story.
--
-- The pre-v1.5 demo seed shipped only WEIGHT / BLOOD_PRESSURE / PULSE /
-- BODY_FAT / SLEEP / STEPS — and the demo DB on edge-01 had drifted to
-- a static snapshot whose last reading was ten days old. For the iOS
-- public-beta cut we need a fresh picture: data through today, every
-- type the dashboard tiles can render, a source mix that shows the
-- Withings + Apple Health story, stats:* externalIds on the cumulative
-- HK metrics that showcase the v1.5.0 upsert fix (#213), and a weekly
-- medication so the v1.5.0 compliance fix (#214) renders 100% instead
-- of the legacy 13%.
--
-- Re-runnable: every section deletes the demo user's rows before
-- re-inserting, so the script is idempotent and re-anchors to whatever
-- NOW() is at execution time. measurement_rollups + the per-tier
-- compliance / mood rollups are truncated so the next read-path probe
-- falls back to live SQL (the slim rollup-tier reader) and the boot
-- backfill repopulates on the next entrypoint sweep.
--
-- Usage on edge-01:
--   docker exec -i agos0oo88gsgg88kcg4swosw \
--     psql -U healthlog -d healthlog < seed-demo-v15.sql

BEGIN;

-- Resolve the demo user once and reuse via session-local table.
CREATE TEMP TABLE _demo AS
SELECT id AS user_id FROM users WHERE username = 'demo' LIMIT 1;

-- Bail loudly if the user is missing rather than silently no-op.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM _demo) THEN
    RAISE EXCEPTION 'seed-demo-v15: no user with username=demo — run scripts/seed-demo.ts first to create the baseline account.';
  END IF;
END $$;

-- ── Wipe per-user state ───────────────────────────────────────────
DELETE FROM medication_intake_events       WHERE user_id IN (SELECT user_id FROM _demo);
DELETE FROM medication_compliance_rollups  WHERE user_id IN (SELECT user_id FROM _demo);
DELETE FROM medication_schedules           WHERE medication_id IN (
  SELECT id FROM medications WHERE user_id IN (SELECT user_id FROM _demo)
);
DELETE FROM medications                    WHERE user_id IN (SELECT user_id FROM _demo);
DELETE FROM mood_entry_rollups             WHERE user_id IN (SELECT user_id FROM _demo);
DELETE FROM mood_entries                   WHERE user_id IN (SELECT user_id FROM _demo);
DELETE FROM measurement_rollups            WHERE user_id IN (SELECT user_id FROM _demo);
DELETE FROM measurements                   WHERE user_id IN (SELECT user_id FROM _demo);
DELETE FROM user_achievements              WHERE user_id IN (SELECT user_id FROM _demo);

-- ── Measurements ──────────────────────────────────────────────────
-- 90-day sliding window. Each generate_series produces one row per
-- day backwards from NOW(); jitter via random() gives realistic
-- variation. Source mix is intentional:
--   WEIGHT / BP / PULSE      — MANUAL + WITHINGS (alternating days)
--   BODY_FAT + body comp     — WITHINGS only (Body+ scale exclusive)
--   SLEEP / STEPS / energy   — APPLE_HEALTH (iOS HealthKit) with stats:*
--                              externalIds on cumulative metrics
--   OXYGEN_SATURATION         — WITHINGS (ScanWatch)
--   BLOOD_GLUCOSE             — MANUAL (fingerstick)

WITH demo AS (SELECT user_id FROM _demo),
     days AS (SELECT generate_series(0, 89) AS d)
INSERT INTO measurements (
  id, user_id, type, value, unit, source, measured_at, external_id, created_at, updated_at
)
SELECT
  'm_w_' || replace(gen_random_uuid()::text, '-', ''),
  (SELECT user_id FROM demo),
  'WEIGHT'::measurement_type,
  -- 82.0 kg trending down to 79.0 across 90 days + small daily jitter
  round((82.0 - (90 - d) * 0.033 + (random() - 0.5) * 0.6)::numeric, 1),
  'kg',
  CASE WHEN d % 2 = 0 THEN 'WITHINGS'::measurement_source ELSE 'MANUAL'::measurement_source END,
  NOW() - (d || ' days')::interval - (random() * 4 || ' hours')::interval,
  CASE WHEN d % 2 = 0 THEN 'withings-weight-' || (NOW() - (d || ' days')::interval)::date ELSE NULL END,
  NOW() - (d || ' days')::interval,
  NOW() - (d || ' days')::interval
FROM days;

WITH demo AS (SELECT user_id FROM _demo),
     days AS (SELECT generate_series(0, 89) AS d)
INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, external_id, created_at, updated_at)
SELECT
  'm_sys_' || replace(gen_random_uuid()::text, '-', ''),
  (SELECT user_id FROM demo),
  'BLOOD_PRESSURE_SYS'::measurement_type,
  round((128.0 - (90 - d) * 0.05 + (random() - 0.5) * 6)::numeric, 0),
  'mmHg',
  CASE WHEN d % 3 = 0 THEN 'WITHINGS'::measurement_source ELSE 'MANUAL'::measurement_source END,
  NOW() - (d || ' days')::interval - INTERVAL '8 hours',
  CASE WHEN d % 3 = 0 THEN 'withings-bp-sys-' || (NOW() - (d || ' days')::interval)::date ELSE NULL END,
  NOW() - (d || ' days')::interval,
  NOW() - (d || ' days')::interval
FROM days;

WITH demo AS (SELECT user_id FROM _demo),
     days AS (SELECT generate_series(0, 89) AS d)
INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, external_id, created_at, updated_at)
SELECT
  'm_dia_' || replace(gen_random_uuid()::text, '-', ''),
  (SELECT user_id FROM demo),
  'BLOOD_PRESSURE_DIA'::measurement_type,
  round((84.0 - (90 - d) * 0.03 + (random() - 0.5) * 4)::numeric, 0),
  'mmHg',
  CASE WHEN d % 3 = 0 THEN 'WITHINGS'::measurement_source ELSE 'MANUAL'::measurement_source END,
  NOW() - (d || ' days')::interval - INTERVAL '8 hours',
  CASE WHEN d % 3 = 0 THEN 'withings-bp-dia-' || (NOW() - (d || ' days')::interval)::date ELSE NULL END,
  NOW() - (d || ' days')::interval,
  NOW() - (d || ' days')::interval
FROM days;

WITH demo AS (SELECT user_id FROM _demo),
     days AS (SELECT generate_series(0, 89) AS d)
INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, external_id, created_at, updated_at)
SELECT
  'm_pulse_' || replace(gen_random_uuid()::text, '-', ''),
  (SELECT user_id FROM demo),
  'PULSE'::measurement_type,
  round((70.0 - (90 - d) * 0.04 + (random() - 0.5) * 5)::numeric, 0),
  'bpm',
  CASE WHEN d % 3 = 0 THEN 'WITHINGS'::measurement_source ELSE 'MANUAL'::measurement_source END,
  NOW() - (d || ' days')::interval - INTERVAL '8 hours',
  NULL,
  NOW() - (d || ' days')::interval,
  NOW() - (d || ' days')::interval
FROM days;

-- BODY_FAT — Withings Body+ exclusive, every other day
WITH demo AS (SELECT user_id FROM _demo),
     days AS (SELECT generate_series(0, 89, 2) AS d)
INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, external_id, created_at, updated_at)
SELECT
  'm_bf_' || replace(gen_random_uuid()::text, '-', ''),
  (SELECT user_id FROM demo),
  'BODY_FAT'::measurement_type,
  round((24.0 - (90 - d) * 0.022 + (random() - 0.5) * 0.4)::numeric, 1),
  '%',
  'WITHINGS'::measurement_source,
  NOW() - (d || ' days')::interval - INTERVAL '7 hours 30 minutes',
  'withings-bf-' || (NOW() - (d || ' days')::interval)::date,
  NOW() - (d || ' days')::interval,
  NOW() - (d || ' days')::interval
FROM days;

-- SLEEP_DURATION — APPLE_HEALTH, stored in minutes (v1.4.23 unit shift),
-- per-night ≈ 6.5–8 h. Daily.
WITH demo AS (SELECT user_id FROM _demo),
     days AS (SELECT generate_series(0, 89) AS d)
INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, external_id, created_at, updated_at)
SELECT
  'm_sleep_' || replace(gen_random_uuid()::text, '-', ''),
  (SELECT user_id FROM demo),
  'SLEEP_DURATION'::measurement_type,
  round((420 + (90 - d) * 0.5 + (random() - 0.5) * 90)::numeric, 0),
  'minutes',
  'APPLE_HEALTH'::measurement_source,
  NOW() - (d || ' days')::interval - INTERVAL '21 hours',
  'apple-sleep-' || (NOW() - (d || ' days')::interval)::date,
  NOW() - (d || ' days')::interval,
  NOW() - (d || ' days')::interval
FROM days;

-- ACTIVITY_STEPS — APPLE_HEALTH stats:* externalId (showcases v1.5.0
-- upsert: per-day cumulative). Daily, drifts 5000 → 9000.
WITH demo AS (SELECT user_id FROM _demo),
     days AS (SELECT generate_series(0, 89) AS d)
INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, external_id, created_at, updated_at)
SELECT
  'm_steps_' || replace(gen_random_uuid()::text, '-', ''),
  (SELECT user_id FROM demo),
  'ACTIVITY_STEPS'::measurement_type,
  round((5200 + (90 - d) * 40 + (random() - 0.5) * 2500)::numeric, 0),
  'count',
  'APPLE_HEALTH'::measurement_source,
  NOW() - (d || ' days')::interval - INTERVAL '20 hours',
  'stats:HKQuantityTypeIdentifierStepCount:' || (NOW() - (d || ' days')::interval)::date,
  NOW() - (d || ' days')::interval,
  NOW() - (d || ' days')::interval
FROM days;

-- ACTIVE_ENERGY_BURNED — APPLE_HEALTH stats:*, kcal, daily.
WITH demo AS (SELECT user_id FROM _demo),
     days AS (SELECT generate_series(0, 89) AS d)
INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, external_id, created_at, updated_at)
SELECT
  'm_aeb_' || replace(gen_random_uuid()::text, '-', ''),
  (SELECT user_id FROM demo),
  'ACTIVE_ENERGY_BURNED'::measurement_type,
  round((380 + (90 - d) * 1.5 + (random() - 0.5) * 180)::numeric, 0),
  'kcal',
  'APPLE_HEALTH'::measurement_source,
  NOW() - (d || ' days')::interval - INTERVAL '20 hours',
  'stats:HKQuantityTypeIdentifierActiveEnergyBurned:' || (NOW() - (d || ' days')::interval)::date,
  NOW() - (d || ' days')::interval,
  NOW() - (d || ' days')::interval
FROM days;

-- WALKING_RUNNING_DISTANCE — APPLE_HEALTH stats:*, metres, daily.
WITH demo AS (SELECT user_id FROM _demo),
     days AS (SELECT generate_series(0, 89) AS d)
INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, external_id, created_at, updated_at)
SELECT
  'm_dist_' || replace(gen_random_uuid()::text, '-', ''),
  (SELECT user_id FROM demo),
  'WALKING_RUNNING_DISTANCE'::measurement_type,
  round((3800 + (90 - d) * 30 + (random() - 0.5) * 1800)::numeric, 0),
  'm',
  'APPLE_HEALTH'::measurement_source,
  NOW() - (d || ' days')::interval - INTERVAL '20 hours',
  'stats:HKQuantityTypeIdentifierDistanceWalkingRunning:' || (NOW() - (d || ' days')::interval)::date,
  NOW() - (d || ' days')::interval,
  NOW() - (d || ' days')::interval
FROM days;

-- FLIGHTS_CLIMBED — APPLE_HEALTH stats:*, daily (0–25 range).
WITH demo AS (SELECT user_id FROM _demo),
     days AS (SELECT generate_series(0, 59) AS d)
INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, external_id, created_at, updated_at)
SELECT
  'm_flt_' || replace(gen_random_uuid()::text, '-', ''),
  (SELECT user_id FROM demo),
  'FLIGHTS_CLIMBED'::measurement_type,
  round((6 + (random() * 14))::numeric, 0),
  'count',
  'APPLE_HEALTH'::measurement_source,
  NOW() - (d || ' days')::interval - INTERVAL '20 hours',
  'stats:HKQuantityTypeIdentifierFlightsClimbed:' || (NOW() - (d || ' days')::interval)::date,
  NOW() - (d || ' days')::interval,
  NOW() - (d || ' days')::interval
FROM days;

-- OXYGEN_SATURATION — Withings ScanWatch, every 2 days, percent.
WITH demo AS (SELECT user_id FROM _demo),
     days AS (SELECT generate_series(0, 89, 2) AS d)
INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, external_id, created_at, updated_at)
SELECT
  'm_spo2_' || replace(gen_random_uuid()::text, '-', ''),
  (SELECT user_id FROM demo),
  'OXYGEN_SATURATION'::measurement_type,
  round((97 + (random() * 2.5))::numeric, 1),
  '%',
  'WITHINGS'::measurement_source,
  NOW() - (d || ' days')::interval - INTERVAL '6 hours',
  'withings-spo2-' || (NOW() - (d || ' days')::interval)::date,
  NOW() - (d || ' days')::interval,
  NOW() - (d || ' days')::interval
FROM days;

-- BLOOD_GLUCOSE — MANUAL fingerstick, every other day, mg/dL (canonical).
-- Mix of fasting + postprandial; the row-level glucose_context column
-- is required (CHECK constraint `measurements_glucose_context_requires_type`).
WITH demo AS (SELECT user_id FROM _demo),
     days AS (SELECT generate_series(0, 59, 2) AS d)
INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, external_id, glucose_context, created_at, updated_at)
SELECT
  'm_bg_' || replace(gen_random_uuid()::text, '-', ''),
  (SELECT user_id FROM demo),
  'BLOOD_GLUCOSE'::measurement_type,
  CASE
    WHEN d % 4 = 0 THEN round((96 + random() * 14)::numeric, 0)   -- fasting
    ELSE                round((128 + random() * 22)::numeric, 0)  -- postprandial
  END,
  'mg/dL',
  'MANUAL'::measurement_source,
  NOW() - (d || ' days')::interval - INTERVAL '7 hours',
  NULL,
  CASE WHEN d % 4 = 0 THEN 'FASTING'::glucose_context ELSE 'POSTPRANDIAL'::glucose_context END,
  NOW() - (d || ' days')::interval,
  NOW() - (d || ' days')::interval
FROM days;

-- TOTAL_BODY_WATER — Withings Body+, every 3 days, kg.
WITH demo AS (SELECT user_id FROM _demo),
     days AS (SELECT generate_series(0, 89, 3) AS d)
INSERT INTO measurements (id, user_id, type, value, unit, source, measured_at, external_id, created_at, updated_at)
SELECT
  'm_tbw_' || replace(gen_random_uuid()::text, '-', ''),
  (SELECT user_id FROM demo),
  'TOTAL_BODY_WATER'::measurement_type,
  round((48 + (random() - 0.5) * 2)::numeric, 1),
  'kg',
  'WITHINGS'::measurement_source,
  NOW() - (d || ' days')::interval - INTERVAL '7 hours 30 minutes',
  'withings-tbw-' || (NOW() - (d || ' days')::interval)::date,
  NOW() - (d || ' days')::interval,
  NOW() - (d || ' days')::interval
FROM days;

-- ── Medications ──────────────────────────────────────────────────
-- Four meds covering the full cadence matrix: daily-morning,
-- daily-evening, daily-with-narrow-window, and weekly-on-Monday
-- (showcases v1.5.0 daysOfWeek compliance fix #214).

-- 1. Ramipril 5 mg — daily morning, 96% compliance
WITH demo AS (SELECT user_id FROM _demo)
INSERT INTO medications (id, user_id, name, dose, active, notifications_enabled, created_at, updated_at)
VALUES (
  'demo_med_ramipril', (SELECT user_id FROM demo), 'Ramipril', '5 mg',
  true, true, NOW() - INTERVAL '120 days', NOW() - INTERVAL '120 days'
);
INSERT INTO medication_schedules (id, medication_id, window_start, window_end, label)
VALUES ('demo_sched_ramipril', 'demo_med_ramipril', '08:00', '10:00', 'Morgens');

-- 2. Vitamin D3 — daily morning, 92% compliance
WITH demo AS (SELECT user_id FROM _demo)
INSERT INTO medications (id, user_id, name, dose, active, notifications_enabled, created_at, updated_at)
VALUES (
  'demo_med_vitd', (SELECT user_id FROM demo), 'Vitamin D3', '2000 IE',
  true, true, NOW() - INTERVAL '95 days', NOW() - INTERVAL '95 days'
);
INSERT INTO medication_schedules (id, medication_id, window_start, window_end, label)
VALUES ('demo_sched_vitd', 'demo_med_vitd', '08:00', '10:00', 'Morgens');

-- 3. Magnesium 400 mg — daily evening, 88% compliance
WITH demo AS (SELECT user_id FROM _demo)
INSERT INTO medications (id, user_id, name, dose, active, notifications_enabled, created_at, updated_at)
VALUES (
  'demo_med_mg', (SELECT user_id FROM demo), 'Magnesium', '400 mg',
  true, true, NOW() - INTERVAL '70 days', NOW() - INTERVAL '70 days'
);
INSERT INTO medication_schedules (id, medication_id, window_start, window_end, label)
VALUES ('demo_sched_mg', 'demo_med_mg', '20:00', '22:00', 'Abends');

-- 4. Ozempic 0.5 mg — WEEKLY Mondays (daysOfWeek="1"), 100% compliance.
-- Pre-v1.5.0 the compliance calculation reported ~13% for this
-- cadence; the #214 fix now honours daysOfWeek so this med shows
-- 100% on the per-medication card, the Health Score pillar, and
-- the AI Coach prompt context.
WITH demo AS (SELECT user_id FROM _demo)
INSERT INTO medications (id, user_id, name, dose, treatment_class, doses_per_unit, active, notifications_enabled, created_at, updated_at)
VALUES (
  'demo_med_ozempic', (SELECT user_id FROM demo), 'Ozempic', '0.5 mg',
  'GLP1', 4, true, true, NOW() - INTERVAL '85 days', NOW() - INTERVAL '85 days'
);
INSERT INTO medication_schedules (id, medication_id, window_start, window_end, label, days_of_week)
VALUES ('demo_sched_ozempic', 'demo_med_ozempic', '19:00', '21:00', 'Montagabend', '1');

-- ── Medication intake events ─────────────────────────────────────
-- Generated against `medications.created_at + N days` so the user's
-- compliance window starts from when they began the med, not an
-- absolute date.

-- Ramipril: 90 days, 96% taken
WITH demo AS (SELECT user_id FROM _demo),
     days AS (SELECT generate_series(0, 89) AS d)
INSERT INTO medication_intake_events (id, user_id, medication_id, scheduled_for, taken_at, skipped, source, created_at)
SELECT
  'ie_rmp_' || replace(gen_random_uuid()::text, '-', ''),
  (SELECT user_id FROM demo),
  'demo_med_ramipril',
  date_trunc('day', NOW() - (d || ' days')::interval) + INTERVAL '8 hours',
  CASE WHEN random() < 0.96
       THEN date_trunc('day', NOW() - (d || ' days')::interval) + INTERVAL '8 hours' + (random() * 45 || ' minutes')::interval
       ELSE NULL END,
  CASE WHEN random() < 0.96 THEN false ELSE true END,
  'WEB',
  NOW() - (d || ' days')::interval
FROM days;

-- Vitamin D3: 90 days, 92% taken
WITH demo AS (SELECT user_id FROM _demo),
     days AS (SELECT generate_series(0, 89) AS d)
INSERT INTO medication_intake_events (id, user_id, medication_id, scheduled_for, taken_at, skipped, source, created_at)
SELECT
  'ie_vitd_' || replace(gen_random_uuid()::text, '-', ''),
  (SELECT user_id FROM demo),
  'demo_med_vitd',
  date_trunc('day', NOW() - (d || ' days')::interval) + INTERVAL '8 hours 30 minutes',
  CASE WHEN random() < 0.92
       THEN date_trunc('day', NOW() - (d || ' days')::interval) + INTERVAL '8 hours 30 minutes' + (random() * 50 || ' minutes')::interval
       ELSE NULL END,
  CASE WHEN random() < 0.92 THEN false ELSE true END,
  'WEB',
  NOW() - (d || ' days')::interval
FROM days;

-- Magnesium: last 60 days only (med started 70 days ago, ramp-up), 88% taken
WITH demo AS (SELECT user_id FROM _demo),
     days AS (SELECT generate_series(0, 59) AS d)
INSERT INTO medication_intake_events (id, user_id, medication_id, scheduled_for, taken_at, skipped, source, created_at)
SELECT
  'ie_mg_' || replace(gen_random_uuid()::text, '-', ''),
  (SELECT user_id FROM demo),
  'demo_med_mg',
  date_trunc('day', NOW() - (d || ' days')::interval) + INTERVAL '20 hours',
  CASE WHEN random() < 0.88
       THEN date_trunc('day', NOW() - (d || ' days')::interval) + INTERVAL '20 hours' + (random() * 60 || ' minutes')::interval
       ELSE NULL END,
  CASE WHEN random() < 0.88 THEN false ELSE true END,
  'WEB',
  NOW() - (d || ' days')::interval
FROM days;

-- Ozempic: every Monday in the last 84 days (≈12 Mondays), all taken
WITH demo AS (SELECT user_id FROM _demo),
     mondays AS (
       SELECT generate_series(
         date_trunc('week', NOW())::date - 84,
         date_trunc('week', NOW())::date,
         INTERVAL '7 days'
       )::date AS day
     )
INSERT INTO medication_intake_events (id, user_id, medication_id, scheduled_for, taken_at, skipped, source, created_at)
SELECT
  'ie_oz_' || replace(gen_random_uuid()::text, '-', ''),
  (SELECT user_id FROM demo),
  'demo_med_ozempic',
  day + INTERVAL '19 hours 30 minutes',
  day + INTERVAL '19 hours 30 minutes' + (random() * 60 || ' minutes')::interval,
  false,
  'WEB',
  day::timestamp
FROM mondays;

-- ── Mood entries ─────────────────────────────────────────────────
-- 90 days, ~95% logged; trends from OKAY/GUT toward SUPER_GUT.
WITH demo AS (SELECT user_id FROM _demo),
     days AS (SELECT generate_series(0, 89) AS d)
INSERT INTO mood_entries (
  id, user_id, date, mood, score, tags, note, source, mood_logged_at, tz, synced_at, created_at, updated_at
)
SELECT
  'mo_' || replace(gen_random_uuid()::text, '-', ''),
  (SELECT user_id FROM demo),
  (NOW() - (d || ' days')::interval)::date::text,
  CASE
    WHEN sc = 5 THEN 'SUPER_GUT'
    WHEN sc = 4 THEN 'GUT'
    WHEN sc = 3 THEN 'OKAY'
    WHEN sc = 2 THEN 'SCHLECHT'
    ELSE              'LAUSIG'
  END,
  sc,
  CASE sc
    WHEN 5 THEN '["productive","exercise","well-rested"]'
    WHEN 4 THEN '["focused","social","creative"]'
    WHEN 3 THEN '["okay","quiet"]'
    WHEN 2 THEN '["tired","stressed"]'
    ELSE        '["exhausted","pain"]'
  END,
  NULL,
  'WEB',
  date_trunc('day', NOW() - (d || ' days')::interval) + INTERVAL '21 hours' + (random() * 50 || ' minutes')::interval,
  'Europe/Berlin',
  NOW() - (d || ' days')::interval,
  NOW() - (d || ' days')::interval,
  NOW() - (d || ' days')::interval
FROM (
  SELECT d,
    -- Score trends upward from ~3 to ~4.5 over 90 days + noise.
    LEAST(5, GREATEST(1,
      round((3.0 + (90 - d) * 0.018 + (random() - 0.5) * 1.2))::int
    )) AS sc
  FROM days
  WHERE random() > 0.05  -- ~5% missed days
) ranked;

COMMIT;

-- ── Summary report ───────────────────────────────────────────────
SELECT 'measurements_total'   AS scope, COUNT(*)::text AS n FROM measurements      WHERE user_id IN (SELECT id FROM users WHERE username = 'demo')
UNION ALL
SELECT 'measurements_by_type', COUNT(DISTINCT type)::text FROM measurements        WHERE user_id IN (SELECT id FROM users WHERE username = 'demo')
UNION ALL
SELECT 'mood_entries',         COUNT(*)::text             FROM mood_entries        WHERE user_id IN (SELECT id FROM users WHERE username = 'demo')
UNION ALL
SELECT 'medications',          COUNT(*)::text             FROM medications         WHERE user_id IN (SELECT id FROM users WHERE username = 'demo')
UNION ALL
SELECT 'intake_events',        COUNT(*)::text             FROM medication_intake_events WHERE user_id IN (SELECT id FROM users WHERE username = 'demo')
UNION ALL
SELECT 'measurement_rollups',  COUNT(*)::text             FROM measurement_rollups WHERE user_id IN (SELECT id FROM users WHERE username = 'demo');
