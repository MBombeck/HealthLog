-- v1.4.25 W8d — Apple Health server-contract prep. Three new
-- MeasurementType enum values close the iOS-17/18 HK coverage gap
-- before the v1.5 iOS-Swift session:
--   * AUDIO_EXPOSURE_ENV       — HK `environmentalAudioExposure`
--     (ambient noise; dBA SPL). Watch + iPhone microphone samples.
--   * AUDIO_EXPOSURE_HEADPHONE — HK `headphoneAudioExposure`
--     (AirPods listening-volume sampling; dBA SPL).
--   * TIME_IN_DAYLIGHT         — HK `timeInDaylight` (iOS 17+;
--     minutes/day). Mood + sleep correlate.
--
-- The previous task brief listed a fourth value, `WORKOUT_ROUTE`. It
-- has been dropped: workouts are first-class entities with their own
-- `Workout` table (Migration 0053) and the GPS route geometry lives
-- in `WorkoutRoute`. Apple HealthKit also separates `HKWorkout` from
-- `HKQuantitySample`. Carrying a sentinel enum value on the
-- Measurement table when no real Measurement row will ever be of
-- that type would be a dead slot that confuses every downstream
-- code path (analytics summariser, doctor-PDF allow-list, chart
-- registry). Forward-additive — a future analytics rollup row can
-- still be carried on a fresh enum value if the use case ever
-- materialises.
--
-- Additive only, forward-only — every new enum value is unconditional
-- and no existing row needs to be backfilled. The Apple Health
-- mapping (`src/lib/measurements/apple-health-mapping.ts`) gains the
-- corresponding HK identifier rows in the same release.

ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'AUDIO_EXPOSURE_ENV';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'AUDIO_EXPOSURE_HEADPHONE';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'TIME_IN_DAYLIGHT';
