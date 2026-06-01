-- v1.5.5 — extend `measurement_type` enum for the six iOS-side
-- deferred identifiers.
--
-- Each HK identifier in this set used to land in
-- `HK_QUANTITY_TYPE_DEFERRED` in `src/lib/measurements/apple-health-mapping.ts`.
-- The batch ingest returned HTTP 200 with a per-entry
-- `skipped:"unmappable_identifier"`; the iOS client read that as
-- success and advanced its sync anchor, so any sample carrying one
-- of these identifiers was lost forever. The mapping now wires them
-- end-to-end:
--
--   RESPIRATORY_RATE          ← HKQuantityTypeIdentifierRespiratoryRate
--   BODY_MASS_INDEX           ← HKQuantityTypeIdentifierBodyMassIndex
--   LEAN_BODY_MASS            ← HKQuantityTypeIdentifierLeanBodyMass
--   WALKING_HEART_RATE_AVERAGE ← HKQuantityTypeIdentifierWalkingHeartRateAverage
--   WALKING_ASYMMETRY         ← HKQuantityTypeIdentifierWalkingAsymmetryPercentage
--   WALKING_DOUBLE_SUPPORT    ← HKQuantityTypeIdentifierWalkingDoubleSupportPercentage
--
-- Pure additive — no existing row carries any of these values. The
-- `IF NOT EXISTS` guard keeps the migration idempotent and lets the
-- runner replay it on a partially-applied environment without
-- failing on the duplicate-enum-value error code.

ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'RESPIRATORY_RATE';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'BODY_MASS_INDEX';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'LEAN_BODY_MASS';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'WALKING_HEART_RATE_AVERAGE';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'WALKING_ASYMMETRY';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'WALKING_DOUBLE_SUPPORT';
