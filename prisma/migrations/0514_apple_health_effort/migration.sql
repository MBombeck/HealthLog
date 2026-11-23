-- Apple workout effort and physical effort.
--
--   WORKOUT_EFFORT_SCORE            <- HKQuantityTypeIdentifierWorkoutEffortScore
--                                      (the score the person logged, 0–10)
--   ESTIMATED_WORKOUT_EFFORT_SCORE  <- HKQuantityTypeIdentifierEstimatedWorkoutEffortScore
--                                      (the watch's estimate, 0–10)
--   PHYSICAL_EFFORT                 <- HKQuantityTypeIdentifierPhysicalEffort
--                                      (kcal/(hr·kg))
--
-- The logged score and the estimate are different readings, so they are
-- different types: a day mean of one type cannot blend them. Physical effort
-- is a rate, never added to active or resting energy.
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
    ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'WORKOUT_EFFORT_SCORE';
    ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'ESTIMATED_WORKOUT_EFFORT_SCORE';
    ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'PHYSICAL_EFFORT';
END
$migration$;
