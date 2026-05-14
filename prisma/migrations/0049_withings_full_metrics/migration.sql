-- v1.4.25 W5d — Withings full coverage. Adds seven new
-- MeasurementType enum values so the Withings ingest path can land
-- body composition (Body+, Body Cardio, Body Comp, Body Scan),
-- skin temperature (ScanWatch dermal reading — DISTINCT from core
-- body temperature; sharing the bucket would corrupt analytics
-- because surface temps run ~32 °C and core ~37 °C), pulse-wave
-- velocity + vascular age (Body Cardio / Body Scan exclusives), and
-- visceral fat (Body Comp / Body Scan rating).
--
-- See `.planning/research/withings-api-coverage.md` §3 for the gap
-- scoring + the rationale of which meastypes ship in v1.4.25 vs
-- defer to v1.5.
--
-- Additive only, forward-only — every new enum value is unconditional
-- and no existing row needs to be backfilled. The Withings client
-- starts emitting these values once `src/lib/withings/client.ts`
-- gains the meastype → enum mapping (separate commit).

ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'FAT_FREE_MASS';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'FAT_MASS';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'MUSCLE_MASS';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'SKIN_TEMPERATURE';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'PULSE_WAVE_VELOCITY';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'VASCULAR_AGE';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'VISCERAL_FAT';
