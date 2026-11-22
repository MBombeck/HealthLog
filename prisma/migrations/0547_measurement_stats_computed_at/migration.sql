-- When the phone computed a `stats:` day total (`computedAt` on a
-- `POST /api/measurements/batch` entry). A write of the same row carrying an
-- earlier `computedAt` than the stored one is refused as `stale`, so an
-- out-of-order replay never replaces a newer total. A write without one
-- behaves as before.
--
-- One nullable column without a default: metadata-only, no rewrite.
-- Reversibility: drop the column.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    ALTER TABLE "measurements"
        ADD COLUMN IF NOT EXISTS "stats_computed_at" TIMESTAMP(3);
END
$migration$;
