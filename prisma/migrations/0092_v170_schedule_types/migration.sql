-- v1.7.0 — medication schedule-type discriminator + cyclic on/off weeks.
--
-- Adds a Prisma enum `medication_schedule_type` (matching the
-- `medication_delivery_form` precedent — DB-level validation rather than
-- a free TEXT column) plus three columns on `medication_schedules`:
--
--   * schedule_type — SCHEDULED (default; rrule / rolling / legacy cadence
--     as today), PRN (as-needed: never projected, never reminded, excluded
--     from compliance expected-count, still loggable), CYCLIC (N weeks on /
--     M weeks off from the anchor; within an on-week the rrule / legacy
--     cadence applies as usual).
--
--   * cyclic_on_weeks / cyclic_off_weeks — only meaningful when
--     schedule_type = CYCLIC. The phase repeats (on, then off) from the
--     medication's startsOn ?? createdAt anchor.
--
-- Every existing row backfills to SCHEDULED via the column default and
-- NULL cyclic weeks, so the ALTERs are non-blocking metadata operations
-- on Postgres 11+ (the default is a constant).

CREATE TYPE "medication_schedule_type" AS ENUM ('SCHEDULED', 'PRN', 'CYCLIC');

ALTER TABLE "medication_schedules"
  ADD COLUMN "schedule_type" "medication_schedule_type" NOT NULL DEFAULT 'SCHEDULED',
  ADD COLUMN "cyclic_on_weeks" INTEGER,
  ADD COLUMN "cyclic_off_weeks" INTEGER;
