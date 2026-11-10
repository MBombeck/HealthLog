-- How the cycle calendar feed draws a forecast period (#1350):
--
--   EXACT   the calculated period only, no margin
--   MARGIN  the calculated period, plus the days it may start earlier or end
--           later as separate "possible" events
--   BAND    one event covering every day the period may fall on
--
-- The column defaults to BAND, which is what every feed drew until now, so an
-- existing subscription keeps exactly the events it had. A new subscription is
-- given MARGIN by the route that mints it, not by this default.
--
-- One DO block, so the file is one statement that rolls back whole and the
-- lock wait on `cycle_calendar_feeds` is bounded. The type is created only when
-- missing and the column only when missing, so a replay is harmless.
-- Reversibility: dropping the column and the type returns every feed to the
-- single-band forecast.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    IF NOT EXISTS (
        SELECT 1 FROM pg_type WHERE typname = 'cycle_calendar_feed_forecast_style'
    ) THEN
        CREATE TYPE "cycle_calendar_feed_forecast_style" AS ENUM ('EXACT', 'MARGIN', 'BAND');
    END IF;

    ALTER TABLE "cycle_calendar_feeds"
        ADD COLUMN IF NOT EXISTS "forecast_style" "cycle_calendar_feed_forecast_style" NOT NULL DEFAULT 'BAND';
END
$migration$;
