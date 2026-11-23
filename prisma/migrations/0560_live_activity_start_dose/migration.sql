-- The dose a Live Activity start was for, on the start's own outbox row.
--
-- Once per dose used to rest on the device row, which holds only the last
-- start: a second dose's start replaced the first one's record, and the
-- first dose could start again. The start row keeps its dose for as long as
-- the outbox keeps the row (30 days), so the check reads the server's own
-- record of every start, before the device reports the Activity and across
-- restarts.
--
-- Two nullable columns: metadata-only, no rewrite. The index is small (only
-- start rows carry a value) and is built on a table the maintenance pass
-- prunes to 30 days. IF NOT EXISTS keeps a replay harmless. Reversibility:
-- drop the index and the columns.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    ALTER TABLE "push_relay_deliveries"
        ADD COLUMN IF NOT EXISTS "medication_id" TEXT,
        ADD COLUMN IF NOT EXISTS "slot_instant" TIMESTAMP(3);

    CREATE INDEX IF NOT EXISTS "push_relay_deliveries_device_id_medication_id_slot_instant_idx"
        ON "push_relay_deliveries" ("device_id", "medication_id", "slot_instant");
END
$migration$;
