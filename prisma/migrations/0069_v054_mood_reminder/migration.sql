-- v0.5.4 ios-coord — daily mood reminder.
--
-- Two additions:
--   1. `users.mood_reminder_enabled` — per-user opt-in flag. Default
--      `false` because mood capture is an emotionally-loaded surface;
--      we never want a fresh-install user to receive a 22:00 nudge
--      without first toggling the preference in Settings.
--   2. `mood_reminder_dispatches` — per-(user, local date) ledger
--      enforcing one push per day. Unique constraint doubles as the
--      idempotency anchor for parallel workers + cron re-ticks inside
--      the 22:00 window (cron fires every 15 min).
--
-- Both additions are additive — existing rows stay on the
-- "opt-out-of-everything" path byte-identical to v1.4.38 behaviour.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "mood_reminder_enabled" BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS "mood_reminder_dispatches" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "dispatched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "mood_reminder_dispatches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "mood_reminder_dispatches_user_id_date_key"
  ON "mood_reminder_dispatches"("user_id", "date");

CREATE INDEX IF NOT EXISTS "mood_reminder_dispatches_user_id_dispatched_at_idx"
  ON "mood_reminder_dispatches"("user_id", "dispatched_at");

DO $$ BEGIN
  ALTER TABLE "mood_reminder_dispatches"
    ADD CONSTRAINT "mood_reminder_dispatches_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
