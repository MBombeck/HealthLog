-- The nightly database dump records the application key its rows were
-- written under (the manifest's active key id). A dump is restored only with
-- that key, so the recovery kit and "keys the backups still need" list it for
-- as long as the off-host copy of the dump may still be in the bucket.
--
-- Nullable, no default, no backfill: a run recorded before this column reads
-- as "key not recorded", and its dump ages out of the bucket like any other.
-- Reversibility: dropping the column restores the previous schema.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);
    ALTER TABLE "database_backup_runs"
        ADD COLUMN IF NOT EXISTS "active_key_id" TEXT;
END
$migration$;
