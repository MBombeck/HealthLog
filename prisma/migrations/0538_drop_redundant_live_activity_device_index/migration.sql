-- `live_activity_tokens_device_id_idx` (device_id) is a prefix of the unique
-- `live_activity_tokens_device_id_push_token_key` (device_id, push_token),
-- which already serves every lookup by device. Dropping it saves a write per
-- token and the space; no query changes plan.
--
-- One guarded statement, so a replay after a lock timeout changes nothing.
-- Reversibility: CREATE INDEX "live_activity_tokens_device_id_idx" ON
-- "live_activity_tokens" ("device_id").
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    DROP INDEX IF EXISTS "live_activity_tokens_device_id_idx";
END
$migration$;
