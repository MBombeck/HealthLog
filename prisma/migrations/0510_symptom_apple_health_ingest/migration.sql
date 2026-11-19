-- Apple Health symptom samples as symptom occurrences.
--
-- `symptom_definitions.code` names a built-in symptom (`FEVER`, `COUGHING`,
-- ...) an imported sample lands on; NULL for a symptom the person named, and
-- unique per account when set (Postgres treats NULLs as distinct, so every
-- existing row stays valid).
--
-- `symptom_events` gains the import's provenance: `source` (default MANUAL,
-- so every existing row and every manual create keeps its meaning),
-- `external_id` (the HealthKit sample UUID), `end_at` (the sample's end) and
-- `deleted_at` (the tombstone that keeps a deleted sample from coming back on
-- a late re-post). `(user_id, source, external_id)` is unique; NULL ids stay
-- allowed any number of times.
--
-- Every column is nullable or carries a constant default, so adding it
-- rewrites nothing, and both tables hold a few rows per account, so the
-- indexes build in place under the short lock timeout. IF NOT EXISTS keeps a
-- replay harmless. Reversibility: drop the two indexes, then the five
-- columns.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    ALTER TABLE "symptom_definitions"
        ADD COLUMN IF NOT EXISTS "code" TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS "symptom_definitions_user_id_code_key"
        ON "symptom_definitions" ("user_id", "code");

    ALTER TABLE "symptom_events"
        ADD COLUMN IF NOT EXISTS "end_at" TIMESTAMP(3),
        ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'MANUAL',
        ADD COLUMN IF NOT EXISTS "external_id" TEXT,
        ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3);
    CREATE UNIQUE INDEX IF NOT EXISTS "symptom_events_user_id_source_external_id_key"
        ON "symptom_events" ("user_id", "source", "external_id");
END
$migration$;
