-- Apple Health ingest v2: eight more measurement types, the low-fitness
-- verdict, and the deletion ledger for Apple Health workouts and ECGs.
--
--   1. `measurement_type` gains LOW_CARDIO_FITNESS_EVENT, MENOPAUSAL_STATE,
--      BLEEDING_AFTER_MENOPAUSE, INSULIN_DELIVERY, INHALER_USAGE, FEV1, FVC
--      and PEAK_EXPIRATORY_FLOW; `rhythm_classification` gains LOW_FITNESS.
--   2. The CHECK that limits `rhythm_classification` to the EVENT types is
--      re-created NOT VALID with LOW_CARDIO_FITNESS_EVENT in its list, then
--      validated. The new values are compared as text, because Postgres does
--      not allow an enum value to be used in the transaction that adds it. The
--      new list only widens the old one, so every existing row passes.
--   3. `apple_health_tombstones`, a new and empty table: the HealthKit sample
--      ids of the workouts and ECG recordings the phone reported deleted, so a
--      late re-post answers `duplicate` instead of inserting again.
--
-- Every statement is guarded, so a replay changes nothing, and the file is
-- marked for the boot's lock-timeout retry.
--
-- Reversibility: delete the rows of the new types and re-create the CHECK
-- without LOW_CARDIO_FITNESS_EVENT; drop the table. Postgres cannot remove an
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

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    CREATE TABLE IF NOT EXISTS "apple_health_tombstones" (
        "id" TEXT NOT NULL,
        "user_id" TEXT NOT NULL,
        "domain" TEXT NOT NULL,
        "external_id" TEXT NOT NULL,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "apple_health_tombstones_pkey" PRIMARY KEY ("id")
    );

    CREATE UNIQUE INDEX IF NOT EXISTS "apple_health_tombstones_user_id_domain_external_id_key"
        ON "apple_health_tombstones" ("user_id", "domain", "external_id");

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'apple_health_tombstones_user_id_fkey'
    ) THEN
        ALTER TABLE "apple_health_tombstones"
            ADD CONSTRAINT "apple_health_tombstones_user_id_fkey"
            FOREIGN KEY ("user_id") REFERENCES "users"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$migration$;
