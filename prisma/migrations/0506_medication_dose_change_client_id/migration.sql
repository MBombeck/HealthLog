-- An optional client id on a GLP-1 titration step (#169), so a step that two
-- devices hold locally is created once when both upload it: a second POST
-- with the same id answers the stored row.
--
-- Unique per medication. A medication belongs to one account, so this is
-- unique per account and medication. NULL stays allowed any number of times
-- (Postgres treats NULLs as distinct), which keeps every existing row and
-- every create without an id valid. The column is nullable with no default,
-- so adding it rewrites nothing; the table holds a handful of rows per
-- medication, so the index builds in place under the short lock timeout.
-- IF NOT EXISTS keeps a replay harmless. Reversibility: drop the index, then
-- the column.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);
    ALTER TABLE "medication_dose_changes"
        ADD COLUMN IF NOT EXISTS "client_id" TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS "medication_dose_changes_medication_id_client_id_key"
        ON "medication_dose_changes" ("medication_id", "client_id");
END
$migration$;
