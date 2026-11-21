-- Live Activity start and update over the push relay.
--
-- 1. `devices` keeps the ActivityKit push-to-start token with the device's
--    signed `hl-la-start-v1` statement, and the dose the last relay start
--    was for.
-- 2. `live_activity_tokens` keeps the content state the last relay update
--    sent, so an unchanged state is not sent again.
--
-- Nullable columns only, no default to rewrite, no index. One DO block,
-- every statement guarded, so a replay after a lock timeout changes nothing.
-- Reversibility: drop the seven columns.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    ALTER TABLE "devices"
        ADD COLUMN IF NOT EXISTS "la_start_token" TEXT,
        ADD COLUMN IF NOT EXISTS "la_start_statement" JSONB,
        ADD COLUMN IF NOT EXISTS "la_start_signature" TEXT,
        ADD COLUMN IF NOT EXISTS "la_started_medication_id" TEXT,
        ADD COLUMN IF NOT EXISTS "la_started_slot" TIMESTAMP(3),
        ADD COLUMN IF NOT EXISTS "la_started_at" TIMESTAMP(3);

    ALTER TABLE "live_activity_tokens"
        ADD COLUMN IF NOT EXISTS "last_relay_state" JSONB;

END
$migration$;
