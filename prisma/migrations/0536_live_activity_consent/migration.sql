-- The second, separate consent to Live Activity start and update over the
-- push relay, per device: when it was given and under which text version.
-- Off (NULL) for every existing device; it is withdrawn with the relay
-- consent.
--
-- Two nullable columns, no default to rewrite, no index. One DO block, every
-- statement guarded, so a replay after a lock timeout changes nothing.
-- Reversibility: drop both columns.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    ALTER TABLE "devices"
        ADD COLUMN IF NOT EXISTS "live_activity_consent_at" TIMESTAMP(3),
        ADD COLUMN IF NOT EXISTS "live_activity_consent_version" TEXT;

END
$migration$;
