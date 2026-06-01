-- v1.7.0 — per-time-of-day reminder dispatch dedup.
--
-- The reminder worker dispatches one reminder per (medication, schedule,
-- day, phase). With first-class `times_of_day` (multiple per day) a
-- schedule like `["08:00","20:00"]` must dispatch TWICE a day, not once.
-- The dedup ledger therefore needs the time-of-day in its key.
--
-- Add `time_of_day` (TEXT, default '') and re-key the unique index to
-- include it. Existing rows backfill to '' via the default, which keeps
-- the pre-v1.7 single-window behaviour byte-stable: a single-time
-- schedule mints `time_of_day = ''` (or its lone HH:mm) and dedupes
-- exactly as before.

ALTER TABLE "telegram_reminder_messages"
  ADD COLUMN "time_of_day" TEXT NOT NULL DEFAULT '';

DROP INDEX IF EXISTS "telegram_reminder_messages_medication_id_schedule_id_date_phase_key";

CREATE UNIQUE INDEX "telegram_reminder_messages_med_sched_date_phase_tod_key"
  ON "telegram_reminder_messages" ("medication_id", "schedule_id", "date", "phase", "time_of_day");
