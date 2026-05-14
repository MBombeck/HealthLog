-- v1.4.25 W5e — cross-source dedup architecture (foundation).
--
-- Adds a nullable JSON column on `users` that records per-metric-class
-- source priority. Shape matches `src/lib/validations/source-priority.ts`:
--   { "steps": ["APPLE_HEALTH", "WITHINGS", "MANUAL"],
--     "weight": ["WITHINGS", "APPLE_HEALTH", "MANUAL"],
--     ... }
-- NULL = the user has never adjusted the defaults; the analytics
-- aggregator reads `DEFAULT_SOURCE_PRIORITY` from validation code.
--
-- Why a single Json column instead of a side-table:
--   - One row per user per metric-class would mean ~15 rows per user
--     for a setting most users never touch. The Json blob keeps the
--     read-path one column lookup with no JOIN.
--   - Schema evolution is additive — adding a new metric class
--     (Apple Health workouts in v1.5, for instance) requires no
--     migration: the Zod schema gains a key, defaults carry the
--     existing priority list, and rows with the old shape continue
--     to parse with the new key falling back to its default.
--
-- Forward-only, additive. No backfill needed: existing rows keep
-- NULL and read code falls through to the documented defaults.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "source_priority_json" JSONB;
