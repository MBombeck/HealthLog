-- The client ids of removed GLP-1 titration steps. Removing a step deletes
-- its row, and a device that still held the step as pending upload sent it
-- again under the same client id, which created it anew. The step's DELETE now
-- records the id here, and a POST under a recorded id answers 410 and writes
-- nothing. A row goes with its medication.
--
-- A new, empty table: nothing existing changes shape and nothing is
-- backfilled. Every statement is guarded, so a replay changes nothing.
-- Reversibility: drop the table.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    CREATE TABLE IF NOT EXISTS "medication_dose_change_tombstones" (
        "id" TEXT NOT NULL,
        "medication_id" TEXT NOT NULL,
        "client_id" TEXT NOT NULL,
        "deleted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "medication_dose_change_tombstones_pkey" PRIMARY KEY ("id")
    );

    CREATE UNIQUE INDEX IF NOT EXISTS "medication_dose_change_tombstones_medication_id_client_id_key"
        ON "medication_dose_change_tombstones" ("medication_id", "client_id");

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'medication_dose_change_tombstones_medication_id_fkey'
    ) THEN
        ALTER TABLE "medication_dose_change_tombstones"
            ADD CONSTRAINT "medication_dose_change_tombstones_medication_id_fkey"
            FOREIGN KEY ("medication_id") REFERENCES "medications"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$migration$;
