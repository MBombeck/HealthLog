-- Apple Watch hypertension notifications as a categorical EVENT row.
--
-- HealthKit `HKCategoryTypeIdentifierHypertensionEvent` (iOS 26) is one more
-- device-flagged notification in the shape migration 0105 set up for the
-- heart-rhythm events: `value` is always 1, the device's verdict rides in
-- `rhythm_classification` (always FIRED here), and HealthLog never
-- re-classifies it.
--
-- Three steps, each safe to run again, so the file is marked for the boot's
-- lock-timeout retry:
--
--   1. the new `measurement_type` value;
--   2. the CHECK that limits `rhythm_classification` to the EVENT types,
--      re-created NOT VALID with the new type in its list (no scan under the
--      table lock). The new value is compared as text, because Postgres does
--      not allow an enum value to be used in the transaction that adds it;
--   3. the CHECK validated. The new list only widens the old one, so every
--      existing row passes.
--
-- Reversibility: delete the HYPERTENSION_EVENT rows and re-create the CHECK
-- without it. Postgres cannot remove an enum value; with no rows carrying it
-- the value is inert.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'HYPERTENSION_EVENT';
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
                'HYPERTENSION_EVENT'
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
