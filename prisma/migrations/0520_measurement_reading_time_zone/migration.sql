-- The IANA time zone a reading was taken in (iOS #181).
--
-- Optional per row: NULL means the profile zone, which is what every
-- existing row and every writer that does not send a zone keeps meaning.
-- The iOS app sends HealthKit's `HKMetadataKeyTimeZone`, so a night slept
-- or a reading taken while travelling lands on the local day it happened.
--
-- A nullable column without a default is a catalogue change only: no table
-- rewrite, no row is touched. IF NOT EXISTS keeps a replay after a lock
-- timeout harmless. The down path is `DROP COLUMN "time_zone"`.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);
    ALTER TABLE "measurements" ADD COLUMN IF NOT EXISTS "time_zone" TEXT;
END
$migration$;
