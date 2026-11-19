-- Apple Health ingest v2: eight more measurement types and the low-fitness
-- verdict.
--
--   1. `measurement_type` gains LOW_CARDIO_FITNESS_EVENT, MENOPAUSAL_STATE,
--      BLEEDING_AFTER_MENOPAUSE, INSULIN_DELIVERY, INHALER_USAGE, FEV1, FVC
--      and PEAK_EXPIRATORY_FLOW; `rhythm_classification` gains LOW_FITNESS.
--   2. The CHECK that limits `rhythm_classification` to the EVENT types is
--      re-created NOT VALID with LOW_CARDIO_FITNESS_EVENT in its list, then
--      validated. The new values are compared as text, because Postgres does
--      not allow an enum value to be used in the transaction that adds it. The
--      new list only widens the old one, so every existing row passes.
--
-- Every statement is guarded, so a replay changes nothing, and the file is
-- marked for the boot's lock-timeout retry.
--
-- Reversibility: delete the rows of the new types and re-create the CHECK
-- without LOW_CARDIO_FITNESS_EVENT. Postgres cannot remove an
-- enum value; with no rows carrying it the value is inert.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'LOW_CARDIO_FITNESS_EVENT';
    ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'MENOPAUSAL_STATE';
    ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'BLEEDING_AFTER_MENOPAUSE';
    ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'INSULIN_DELIVERY';
    ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'INHALER_USAGE';
    ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'FEV1';
    ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'FVC';
    ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'PEAK_EXPIRATORY_FLOW';
    ALTER TYPE "rhythm_classification" ADD VALUE IF NOT EXISTS 'LOW_FITNESS';
END
$migration$;

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);
    ALTER TABLE "measurements"
        DROP CONSTRAINT IF EXISTS "measurements_rhythm_classification_requires_event_type";
    ALTER TABLE "measurements"
        ADD CONSTRAINT "measurements_rhythm_classification_requires_event_type"
        CHECK (
            "rhythm_classification" IS NULL
            OR "type"::text IN (
                'IRREGULAR_RHYTHM_NOTIFICATION',
                'HIGH_HEART_RATE_EVENT',
                'LOW_HEART_RATE_EVENT',
                'WALKING_STEADINESS_EVENT',
                'BREATHING_DISTURBANCE_EVENT',
                'HYPERTENSION_EVENT',
                'LOW_CARDIO_FITNESS_EVENT'
            )
        ) NOT VALID;
END
$migration$;

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);
    ALTER TABLE "measurements"
        VALIDATE CONSTRAINT "measurements_rhythm_classification_requires_event_type";
END
$migration$;
