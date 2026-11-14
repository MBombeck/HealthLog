-- A free-text note on a medication (#1371), for directions such as "30 to 60
-- minutes before food". Shown on the medication and when a dose is logged.
--
-- Sealed at rest like every other free-text column (AES-256-GCM, the shared
-- Bytes codec); there is no plaintext twin and nothing to backfill. Nullable,
-- no default: every existing medication reads as "no note", and adding the
-- column rewrites nothing. IF NOT EXISTS keeps a replay on a database that
-- already ran a build carrying the column harmless. Reversibility: dropping
-- the column restores the previous schema.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);
    ALTER TABLE "medications"
        ADD COLUMN IF NOT EXISTS "note_encrypted" BYTEA;
END
$migration$;
