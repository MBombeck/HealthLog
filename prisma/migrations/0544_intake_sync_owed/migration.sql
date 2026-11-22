-- The intake sync a device's silent budget held back. `MEDICATION_INTAKE_SYNC`
-- over the budget used to be skipped without a trace; it is now owed on the
-- device's `push_data_changes` row and sent by the minute job once the
-- budget frees up.
--
-- One nullable column on a table this release creates (0535); no rewrite,
-- no default. Guarded, so a replay changes nothing.
-- Reversibility: drop the column.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    ALTER TABLE "push_data_changes"
        ADD COLUMN IF NOT EXISTS "intake_sync_owed_at" TIMESTAMP(3);
END
$migration$;
