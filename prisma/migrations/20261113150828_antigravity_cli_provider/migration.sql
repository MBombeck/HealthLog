-- Antigravity CLI provider: the per-user profile pointer and connection state.
--
-- HealthLog stores no CLI credentials. The login lives in the profile folder
-- on the server; these columns hold only the profile id and the last test
-- result. Each column is added idempotently, so a replay after a partial
-- failure changes nothing that is already there.
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "antigravity_profile_id" TEXT;
    ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "antigravity_model" TEXT;
    ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "antigravity_connection_status" TEXT NOT NULL DEFAULT 'disconnected';
    ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "antigravity_connected_at" TIMESTAMP(3);
    ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "antigravity_capabilities_json" JSONB;
END
$migration$;
