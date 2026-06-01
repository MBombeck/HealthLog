-- v1.5.5 — extend `measurement_type` enum for the two remaining iOS
-- mobility identifiers (gait step length + walking speed).
--
-- Background: 0083 wired six previously-deferred Apple Health
-- identifiers. The iOS team flagged two more gait metrics they need
-- mapped before they can flip them client-side:
--
--   WALKING_STEP_LENGTH  ← HKQuantityTypeIdentifierWalkingStepLength
--   WALKING_SPEED        ← HKQuantityTypeIdentifierWalkingSpeed
--
-- Crucial unit convention: both ship raw SI units on the wire
-- (metres and metres-per-second respectively). The ×100 server-side
-- scaling the percent gait metrics use (`WALKING_ASYMMETRY`,
-- `WALKING_DOUBLE_SUPPORT`, `WALKING_STEADINESS`) does NOT apply to
-- these two — they pass through `convertToDbUnit` as identity. The
-- convention block at the top of
-- `src/lib/measurements/apple-health-mapping.ts` spells the split
-- out so a future contributor adding a new gait metric picks the
-- right path.
--
-- Pure additive — no existing row carries either of these values.
-- The `IF NOT EXISTS` guard keeps the migration idempotent and lets
-- the runner replay it on a partially-applied environment without
-- failing on the duplicate-enum-value error code.

ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'WALKING_STEP_LENGTH';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'WALKING_SPEED';
