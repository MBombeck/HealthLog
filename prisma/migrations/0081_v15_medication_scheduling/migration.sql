-- v1.5 — richer medication-scheduling cadences.
--
-- Adds three medication-level fields (course window + one-shot flag)
-- and four schedule-level fields (times-of-day, reminder grace,
-- RRULE string, rolling-interval-days) alongside the legacy
-- `days_of_week` / `window_start` / `window_end` columns. Existing
-- rows are backfilled in-line so the new readers (v1.5.1 onward)
-- see a populated `rrule` and `times_of_day` for every legacy
-- schedule.
--
-- The migration is additive only; v1.5.x continues to read legacy
-- columns as the source of truth. v1.5.1 flips the readers to the
-- new fields with legacy as fallback; v1.6.0 drops the legacy
-- columns + the `parse/serializeScheduleRecurrence` helpers.

-- ── Medication course window + one-shot flag ───────────────────
ALTER TABLE "medications"
  ADD COLUMN "starts_on" DATE,
  ADD COLUMN "ends_on" DATE,
  ADD COLUMN "one_shot" BOOLEAN NOT NULL DEFAULT FALSE;

-- ── MedicationSchedule v1.5 fields ─────────────────────────────
ALTER TABLE "medication_schedules"
  ADD COLUMN "times_of_day" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "reminder_grace_minutes" INT,
  ADD COLUMN "rrule" TEXT,
  ADD COLUMN "rolling_interval_days" INT;

-- ── Backfill: legacy `days_of_week` → RRULE string + times_of_day ──
-- The encoding rules (per `src/lib/medication-schedule.ts`):
--   NULL / empty                 → daily
--   "1,3,5"                      → weekly Mon/Wed/Fri (0=Sun..6=Sat)
--   "i2;1,3,5"                   → every 2 weeks Mon/Wed/Fri (interval 1..4)
--
-- Weekday mapping HealthLog (Sun=0..Sat=6) → RFC 5545 BYDAY codes
-- (SU, MO, TU, WE, TH, FR, SA). The helper below converts the
-- comma-separated decimal list into the BYDAY substring.

-- Helper: HealthLog weekday number → RFC 5545 code.
CREATE OR REPLACE FUNCTION pg_temp.hl_weekday_to_byday(n int) RETURNS text AS $$
BEGIN
  RETURN CASE n
    WHEN 0 THEN 'SU'
    WHEN 1 THEN 'MO'
    WHEN 2 THEN 'TU'
    WHEN 3 THEN 'WE'
    WHEN 4 THEN 'TH'
    WHEN 5 THEN 'FR'
    WHEN 6 THEN 'SA'
    ELSE NULL
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Helper: comma-separated decimal list → comma-separated BYDAY codes
-- ("1,3,5" → "MO,WE,FR"). Filters out anything outside the 0..6 range
-- so a legacy row carrying garbage decodes to NULL (the v1.5.1 read-
-- flip then falls back to the legacy decoder, which has its own
-- defensive filter).
CREATE OR REPLACE FUNCTION pg_temp.hl_days_to_byday(days text) RETURNS text AS $$
DECLARE
  result text;
BEGIN
  IF days IS NULL OR length(trim(days)) = 0 THEN
    RETURN NULL;
  END IF;
  SELECT string_agg(pg_temp.hl_weekday_to_byday(part::int), ',' ORDER BY part::int)
    INTO result
    FROM unnest(string_to_array(days, ',')) AS part
    WHERE part ~ '^[0-6]$';
  RETURN result;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Backfill: each existing schedule row gets a populated `rrule` plus
-- a single-entry `times_of_day` derived from `window_start`. The
-- encoder branches on the three legacy shapes.
UPDATE "medication_schedules" SET
  "times_of_day" = ARRAY["window_start"],
  "rrule" = CASE
    -- Daily (the convention for null / empty / "no valid weekdays")
    WHEN "days_of_week" IS NULL
      OR length(trim("days_of_week")) = 0
      THEN 'FREQ=DAILY'
    -- Multi-week with weekday subset ("i2;1,3,5")
    WHEN "days_of_week" ~ '^i[1-4];[0-6](,[0-6])*$' THEN
      'FREQ=WEEKLY;INTERVAL=' ||
      substring("days_of_week" FROM 2 FOR 1) ||
      ';BYDAY=' ||
      pg_temp.hl_days_to_byday(substring("days_of_week" FROM position(';' IN "days_of_week") + 1))
    -- Multi-week, interval prefix only ("i2;")
    WHEN "days_of_week" ~ '^i[1-4];$' THEN
      'FREQ=WEEKLY;INTERVAL=' ||
      substring("days_of_week" FROM 2 FOR 1)
    -- Legacy weekday-list ("1,3,5")
    WHEN "days_of_week" ~ '^[0-6](,[0-6])*$' THEN
      'FREQ=WEEKLY;BYDAY=' || pg_temp.hl_days_to_byday("days_of_week")
    -- Anything unexpected stays NULL so the v1.5.1 read-flip falls
    -- back to the legacy decoder.
    ELSE NULL
  END
WHERE TRUE;

-- ── XOR constraint: rrule and rolling_interval_days are mutually
-- exclusive. Both NULL is allowed (legacy rows + future migrations).
ALTER TABLE "medication_schedules"
  ADD CONSTRAINT "medication_schedules_rrule_xor_rolling"
  CHECK ("rrule" IS NULL OR "rolling_interval_days" IS NULL);

-- ── Indexes ────────────────────────────────────────────────────
-- A targeted index on `rolling_interval_days IS NOT NULL` lets the
-- reminder worker quickly find every rolling-cadence schedule in
-- the system on the cron tick (rolling cadences are event-driven so
-- the worker needs to fan in over them on every intake).
CREATE INDEX "medication_schedules_rolling_idx"
  ON "medication_schedules" ("rolling_interval_days")
  WHERE "rolling_interval_days" IS NOT NULL;

-- Documentation comment on the legacy column so a future reader
-- understands the v1.5 → v1.6 migration plan.
COMMENT ON COLUMN "medication_schedules"."days_of_week" IS
  'Legacy v1.4 cadence string encoding. Backfilled into `rrule` by the v1.5 migration; readers consult `rrule` first as of v1.5.1; column drops in v1.6.0.';
COMMENT ON COLUMN "medication_schedules"."window_start" IS
  'Legacy v1.4 reminder-window start. `times_of_day[0]` is the v1.5 first-class equivalent; column kept through v1.5.x for backwards-compat.';
COMMENT ON COLUMN "medication_schedules"."window_end" IS
  'Legacy v1.4 reminder-window end. `reminder_grace_minutes` is the v1.5 first-class equivalent; column kept through v1.5.x for backwards-compat.';
