-- When a medication's snooze was set, beside the medication row.
--
-- A snooze answers the dose that was open when it was set, and that instant
-- was read from the medication row's `updated_at`. Every later write to the
-- row moved it, so a low-stock notice or an edit in the afternoon carried a
-- morning snooze over to the afternoon dose. `medication_snoozes` keeps the
-- instant per medication, written with `snoozed_until` by every snooze write.
--
-- A new table; nothing existing changes. A snooze already running reads the
-- row's `updated_at` as before until it ends. One DO block, every statement
-- guarded, so a replay after a lock timeout changes nothing. Reversibility:
-- drop the table.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    CREATE TABLE IF NOT EXISTS "medication_snoozes" (
        "medication_id" TEXT NOT NULL,
        "snoozed_at" TIMESTAMP(3) NOT NULL,
        CONSTRAINT "medication_snoozes_pkey" PRIMARY KEY ("medication_id"),
        CONSTRAINT "medication_snoozes_medication_id_fkey" FOREIGN KEY ("medication_id")
            REFERENCES "medications" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );
END
$migration$;
