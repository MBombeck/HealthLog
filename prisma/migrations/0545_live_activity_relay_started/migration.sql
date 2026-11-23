-- Marks a Live Activity the server started over the push relay. The relay
-- pass sent updates to every registered Activity, including ones the app
-- started itself under its own attributes type, whose content state the
-- relay's template does not decode. Updates over the relay now go only to
-- Activities registered with `relayStart: true`; app-started ones keep the
-- direct path and the end push.
--
-- One column with a constant default on a table this release creates
-- (0515); no rewrite. Existing rows are app-started until the app registers
-- them again. Guarded, so a replay changes nothing.
-- Reversibility: drop the column.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    ALTER TABLE "live_activity_tokens"
        ADD COLUMN IF NOT EXISTS "relay_started" BOOLEAN NOT NULL DEFAULT false;
END
$migration$;
