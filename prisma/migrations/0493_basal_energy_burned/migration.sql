-- Extend `measurement_type` with resting energy, which sat in the deferred
-- list until now:
--
--   BASAL_ENERGY_BURNED  <- HKQuantityTypeIdentifierBasalEnergyBurned (kcal)
--
-- Purely additive: no existing row carries the value. IF NOT EXISTS keeps a
-- replay on a partially applied database harmless. Enum values cannot be
-- dropped in PostgreSQL, so there is no down path.

ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'BASAL_ENERGY_BURNED';
