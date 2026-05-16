-- v1.4.30 — extend `measurement_type` enum (R-F T1.4 + T1.5)
--
-- Two additive enum values for Tier-1 HealthKit surfaces:
--   WALKING_STEADINESS    — % daily rollup, mobility-risk signal
--   AUDIO_EXPOSURE_EVENT  — count flag for loud-listening events
--
-- Pure additive — no existing row carries either value. Postgres
-- enum extensions run with `IF NOT EXISTS` so the migration is
-- idempotent and runs in a single transaction (the v9.6+ requirement
-- that enum adds must commit before they can be referenced no longer
-- applies because the additive Zod + map updates ship in the same
-- release).

ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'WALKING_STEADINESS';
ALTER TYPE "measurement_type" ADD VALUE IF NOT EXISTS 'AUDIO_EXPOSURE_EVENT';
