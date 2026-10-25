-- Drop the per-user preview-feature opt-ins.
--
-- `users.preview_features_json` (0440) stored one flag, `topics`, for the
-- topic overview pages. Those pages were dropped before they shipped, so no
-- surface ever read the flag; `/api/settings/preview-features` is retired
-- with this release and answers 410.
--
-- What is lost is a switch that switched nothing. A backup written by a
-- release that still had the column carries the field, and the restore
-- accepts and ignores it.
--
-- Dropping a column takes an ACCESS EXCLUSIVE lock on `users` for a catalogue
-- update only (no rewrite). The lock wait is bounded so a long-running reader
-- cannot queue every sign-in behind this statement; the deploy retries a
-- timed-out attempt.
--
-- Reversibility: re-adding the nullable column restores the shape; every
-- account then reads as all flags off, which is what every account had.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);
    ALTER TABLE "users" DROP COLUMN IF EXISTS "preview_features_json";
END
$migration$;
