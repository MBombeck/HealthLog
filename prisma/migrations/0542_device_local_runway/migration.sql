-- How long a device that delivers its own medication reminders has them
-- planned (`POST /api/devices` `localRunwayUntil`). Past it, or without it
-- past three days with no request from the device, the server's reminder
-- push goes to the device again (`client-managed-apns.ts`).
--
-- One nullable column, no default to rewrite, no index: the dispatcher reads
-- it on the handful of device rows of one account. Guarded, so a replay after
-- a lock timeout changes nothing. Reversibility: drop the column.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    ALTER TABLE "devices"
        ADD COLUMN IF NOT EXISTS "local_runway_until" TIMESTAMP(3);

END
$migration$;
