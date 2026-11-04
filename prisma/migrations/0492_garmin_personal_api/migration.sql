-- Garmin Personal API (#1333): a per-user key pasted once, a new measurement
-- source for the rows the sync writes, Garmin's own day scores (Body Battery,
-- stress level), and two types a bridge pushes through the ingest token
-- because the Personal API does not carry them (Training Readiness, acute
-- training load).
--
-- One DO block, so the lock wait is bounded and the file is one statement
-- that rolls back whole. Adding an enum value inside a transaction is fine
-- since PostgreSQL 12 as long as the value is not used in it, and nothing
-- here uses them.
--
-- Purely additive: nullable columns, no default, no backfill. IF NOT EXISTS
-- keeps a replay harmless. Enum values cannot be dropped in PostgreSQL, so
-- there is no down path for them; dropping the six columns undoes the rest.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);
    ALTER TYPE "measurement_source" ADD VALUE IF NOT EXISTS 'GARMIN';
    ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'BODY_BATTERY';
    ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'STRESS_LEVEL';
    ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'TRAINING_READINESS';
    ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'ACUTE_TRAINING_LOAD';
    ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "garmin_api_key_encrypted" TEXT,
        ADD COLUMN IF NOT EXISTS "garmin_key_expires_at" TIMESTAMP(3),
        ADD COLUMN IF NOT EXISTS "garmin_connected_at" TIMESTAMP(3),
        ADD COLUMN IF NOT EXISTS "garmin_region" TEXT,
        ADD COLUMN IF NOT EXISTS "garmin_backfill_progress" JSONB,
        ADD COLUMN IF NOT EXISTS "garmin_backfill_completed_at" TIMESTAMP(3);
END
$migration$;
