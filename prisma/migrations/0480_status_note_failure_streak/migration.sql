-- Count the generations in a row that ended without a note, per status note.
--
-- A note whose generation failed opened a fixed five-minute negative window.
-- A model that never answers kept failing every five minutes per note, and a
-- note re-selected by the next data sync ignored the window altogether. The
-- streak sets the next window: five minutes, doubling per failure in a row,
-- up to two hours. A written or re-dated note resets it to zero.
--
-- Existing rows start at zero, which is the five-minute window they had.
--
-- The lock wait is bounded inside a DO block and the file is safe to run
-- again, so the boot retries it on a lock timeout.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);
    ALTER TABLE "insight_status_caches"
        ADD COLUMN IF NOT EXISTS "failure_streak" INTEGER NOT NULL DEFAULT 0;
END
$migration$;
