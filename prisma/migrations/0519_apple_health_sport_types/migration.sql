-- Apple sport quantities that were deferred until now (#1415).
--
--   CYCLING_DISTANCE              <- HKQuantityTypeIdentifierDistanceCycling (m, day sum)
--   ROWING_DISTANCE               <- HKQuantityTypeIdentifierDistanceRowing (m, day sum)
--   ROWING_SPEED                  <- HKQuantityTypeIdentifierRowingSpeed (m/s, mean)
--   RUNNING_SPEED                 <- HKQuantityTypeIdentifierRunningSpeed (m/s, mean)
--   RUNNING_POWER                 <- HKQuantityTypeIdentifierRunningPower (W, mean)
--   RUNNING_GROUND_CONTACT_TIME   <- HKQuantityTypeIdentifierRunningGroundContactTime (ms, mean)
--   RUNNING_VERTICAL_OSCILLATION  <- HKQuantityTypeIdentifierRunningVerticalOscillation (cm, mean)
--   RUNNING_STRIDE_LENGTH         <- HKQuantityTypeIdentifierRunningStrideLength (m, mean)
--
-- Purely additive: no existing row carries the values, and nothing in this
-- file uses them, so a value added here is not read in the same transaction.
-- IF NOT EXISTS keeps a replay after a lock timeout harmless. Enum values
-- cannot be dropped in PostgreSQL, so there is no down path.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);
    ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'CYCLING_DISTANCE';
    ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'ROWING_DISTANCE';
    ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'ROWING_SPEED';
    ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'RUNNING_SPEED';
    ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'RUNNING_POWER';
    ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'RUNNING_GROUND_CONTACT_TIME';
    ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'RUNNING_VERTICAL_OSCILLATION';
    ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'RUNNING_STRIDE_LENGTH';
END
$migration$;
