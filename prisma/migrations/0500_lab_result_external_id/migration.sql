-- The identity a lab reading arrived under from Apple Health's Health Records
-- (#1400): a SHA-256 digest over the issuing institution and the FHIR
-- Observation's identifier, never the identifier itself. It lets the same
-- result, arriving again from the export or from the iOS app, be recognised
-- and left alone, and a result the person deleted stay deleted.
--
-- Nullable, no default: every existing reading reads as "no external
-- identity", and adding the column rewrites nothing. The unique index is on
-- (user_id, source, external_id); NULLs never collide, so the readings typed,
-- scanned or imported from CSV are unaffected. IF NOT EXISTS keeps a replay
-- on a database that already ran a build carrying the column harmless.
-- Reversibility: dropping the index and the column restores the previous
-- schema.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);
    ALTER TABLE "lab_results"
        ADD COLUMN IF NOT EXISTS "external_id" TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS "lab_results_user_id_source_external_id_key"
        ON "lab_results" ("user_id", "source", "external_id");
END
$migration$;
