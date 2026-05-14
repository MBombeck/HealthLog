-- v1.4.25 W8d — Workout + WorkoutRoute schema.
--
-- Locks the workout-ingest contract before the v1.5 iOS-Swift session
-- so the iOS DTO can be generated against the table layout from day
-- one. v1.4.25 ships no UI surface for workouts beyond the VO2-max
-- tile (Migration 0052 + W8d.5); the ingest endpoint + chart row
-- land in a later release.
--
-- Shape rationale (see .planning/research/w8d-implementation-outline.md
-- §4):
--   * HKWorkout-aligned typed columns for every metric the analytics
--     / doctor-PDF / Coach evidence pipeline reads on the hot path.
--   * `metadata` JSONB blob for the long-tail (HK metadata key/value
--     pairs, Withings hr_zone_0..3, device bundle id) — keeps the
--     table thin while preserving the source representation.
--   * `sport_type` as TEXT (not a Postgres enum) — Apple alone has
--     70+ HKWorkoutActivityType values; managing them as a Postgres
--     enum would force a migration for every new sport. The Zod
--     boundary in src/lib/validations/* keeps the surface tight.
--   * Dedup on (user_id, source, external_id) — Postgres treats NULL
--     external_id as distinct so manual entries never collide.
--
-- Route geometry uses GeoJSON LineString stored as JSONB rather than
-- Postgres `point[]` or PostGIS `geometry`. v1.4.20 set the same
-- precedent for correlations: no extension dependency on every
-- self-hosted Postgres install. JSONB also matches the GPX-import
-- target shape and Leaflet / MapLibre consume it directly.

CREATE TABLE "workouts" (
  "id"                       TEXT PRIMARY KEY,
  "user_id"                  TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "sport_type"               TEXT NOT NULL,
  "started_at"               TIMESTAMP(3) NOT NULL,
  "ended_at"                 TIMESTAMP(3) NOT NULL,
  "duration_sec"             INTEGER NOT NULL,
  "total_energy_kcal"        DOUBLE PRECISION,
  "total_distance_m"         DOUBLE PRECISION,
  "avg_heart_rate"           INTEGER,
  "max_heart_rate"           INTEGER,
  "min_heart_rate"           INTEGER,
  "step_count"               INTEGER,
  "elevation_m"              DOUBLE PRECISION,
  "pause_duration_sec"       INTEGER,
  "source"                   "measurement_source" NOT NULL DEFAULT 'MANUAL',
  "external_id"              TEXT,
  "external_source_version"  TEXT,
  "metadata"                 JSONB,
  "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"               TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX "workouts_user_source_external_key"
  ON "workouts" ("user_id", "source", "external_id");
CREATE INDEX "workouts_user_started_idx"
  ON "workouts" ("user_id", "started_at");
CREATE INDEX "workouts_user_sport_started_idx"
  ON "workouts" ("user_id", "sport_type", "started_at");

CREATE TABLE "workout_routes" (
  "id"          TEXT PRIMARY KEY,
  "workout_id"  TEXT NOT NULL UNIQUE REFERENCES "workouts"("id") ON DELETE CASCADE,
  -- GeoJSON LineString: { type: "LineString", coordinates: [[lon, lat, alt?], ...] }
  "geometry"    JSONB NOT NULL,
  -- Per-sample ISO timestamps + optional speeds / HR, one entry per
  -- coordinate in `geometry`. NULL when the source only ships static
  -- GPX (e.g. Withings).
  "sample_timestamps" JSONB,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
