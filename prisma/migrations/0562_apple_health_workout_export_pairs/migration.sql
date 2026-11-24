-- Apple Health workouts stored twice: once by the iPhone app, once by an
-- export import (#1414).
--
-- The app keys a workout on its HealthKit UUID. An `export.xml` carries no
-- UUID, so the export importer keyed the same session on its activity type
-- and its start and end (`workout:…`, `sample:…` before migration 0513), and
-- both rows were stored. The reads counted the pair once; since this release
-- the writes merge it (src/lib/workouts/export-healthkit-twins.ts), and this
-- migration merges the pairs already stored, by the same rules:
--
--   - A pair is the same session as the reads define it
--     (`workoutSessionKey` in
--     src/lib/measurements/pick-canonical-workout-rows.ts): source
--     APPLE_HEALTH, the same sport, the same start and the same duration in
--     seconds. One side is keyed `workout:` / `sample:` (the export), the
--     other on anything else (a HealthKit UUID).
--   - The session's oldest HealthKit row (by `created_at`, then `id`) is
--     kept, and keeps its key: the phone reports a deletion by that UUID.
--   - Each column it leaves empty (`FOLDED_WORKOUT_COLUMNS`: energy,
--     distance, average/minimum/maximum heart rate, steps, climb, pauses,
--     source version) is filled from the oldest export row that states it; a
--     GPS track, a heart-rate series and a workout insight move over from the
--     oldest export row that has one when the kept row has none; personal
--     records naming an export row name the kept row.
--   - The export rows are deleted (workout deletes are hard deletes; what
--     they still own cascades). Their `metadata` (the export's activity type,
--     source name and units) goes with them; nothing reads it.
--
-- An export row whose session has no HealthKit row is left as it is. One
-- block, so it applies whole or not at all; a second run finds no pair. The
-- count of merged rows is raised as a NOTICE. Workouts are a small table (a
-- daily workout for twenty years is about 7,300 rows per account), and the
-- pair lookup rides `workouts_user_sport_started_idx`, so one pass is the
-- whole job; the statement timeout bounds it anyway.
--
-- To see beforehand what an instance holds, the same lookup as a count:
--
--   SELECT count(*) FROM workouts e
--   WHERE e.source = 'APPLE_HEALTH'
--     AND (e.external_id LIKE 'workout:%' OR e.external_id LIKE 'sample:%')
--     AND EXISTS (
--       SELECT 1 FROM workouts h
--       WHERE h.user_id = e.user_id AND h.source = 'APPLE_HEALTH'
--         AND h.sport_type = e.sport_type AND h.started_at = e.started_at
--         AND h.duration_sec = e.duration_sec
--         AND h.external_id <> ''
--         AND h.external_id NOT LIKE 'workout:%'
--         AND h.external_id NOT LIKE 'sample:%');
--
-- Reversibility: the deleted export rows are gone (restore from a backup if
-- one is needed; a restore of a backup written before this release merges
-- the same pairs, so the kept row is what comes back).
--
-- @retry-on-lock-timeout

SET LOCAL statement_timeout = '10min';

DO $migration$
DECLARE
    merged integer;
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    CREATE TEMP TABLE "_export_healthkit_pairs" ON COMMIT DROP AS
    SELECT
        e."id",
        e."user_id",
        e."external_id",
        e."created_at",
        k."id" AS "keep_id",
        k."external_id" AS "keep_key"
    FROM "workouts" e
    CROSS JOIN LATERAL (
        SELECT h."id", h."external_id"
        FROM "workouts" h
        WHERE h."user_id" = e."user_id"
          AND h."source" = 'APPLE_HEALTH'
          AND h."sport_type" = e."sport_type"
          AND h."started_at" = e."started_at"
          AND h."duration_sec" = e."duration_sec"
          AND h."external_id" <> ''
          AND h."external_id" NOT LIKE 'workout:%'
          AND h."external_id" NOT LIKE 'sample:%'
        ORDER BY h."created_at", h."id"
        LIMIT 1
    ) k
    WHERE e."source" = 'APPLE_HEALTH'
      AND (e."external_id" LIKE 'workout:%' OR e."external_id" LIKE 'sample:%');

    -- Children the kept row lacks, from the oldest export row that has them.
    UPDATE "workout_routes" r
    SET "workout_id" = m."keep_id"
    FROM (
        SELECT DISTINCT ON (p."keep_id") p."keep_id", c."id" AS "child_id"
        FROM "_export_healthkit_pairs" p
        JOIN "workout_routes" c ON c."workout_id" = p."id"
        WHERE NOT EXISTS (
            SELECT 1 FROM "workout_routes" k WHERE k."workout_id" = p."keep_id"
        )
        ORDER BY p."keep_id", p."created_at", p."id"
    ) m
    WHERE r."id" = m."child_id";

    UPDATE "workout_samples" s
    SET "workout_id" = m."keep_id"
    FROM (
        SELECT DISTINCT ON (p."keep_id") p."keep_id", c."id" AS "child_id"
        FROM "_export_healthkit_pairs" p
        JOIN "workout_samples" c ON c."workout_id" = p."id"
        WHERE NOT EXISTS (
            SELECT 1 FROM "workout_samples" k WHERE k."workout_id" = p."keep_id"
        )
        ORDER BY p."keep_id", p."created_at", p."id"
    ) m
    WHERE s."id" = m."child_id";

    UPDATE "workout_insights" i
    SET "workout_id" = m."keep_id"
    FROM (
        SELECT DISTINCT ON (p."keep_id") p."keep_id", c."id" AS "child_id"
        FROM "_export_healthkit_pairs" p
        JOIN "workout_insights" c ON c."workout_id" = p."id"
        WHERE NOT EXISTS (
            SELECT 1 FROM "workout_insights" k WHERE k."workout_id" = p."keep_id"
        )
        ORDER BY p."keep_id", p."created_at", p."id"
    ) m
    WHERE i."id" = m."child_id";

    -- An empty column on the kept row, from the oldest export row that states it.
    UPDATE "workouts" k
    SET "total_energy_kcal" = coalesce(k."total_energy_kcal", f."energy"),
        "total_distance_m" = coalesce(k."total_distance_m", f."distance"),
        "avg_heart_rate" = coalesce(k."avg_heart_rate", f."avg_hr"),
        "min_heart_rate" = coalesce(k."min_heart_rate", f."min_hr"),
        "max_heart_rate" = coalesce(k."max_heart_rate", f."max_hr"),
        "step_count" = coalesce(k."step_count", f."steps"),
        "elevation_m" = coalesce(k."elevation_m", f."elevation"),
        "pause_duration_sec" = coalesce(k."pause_duration_sec", f."pause"),
        "external_source_version" = coalesce(k."external_source_version", f."version"),
        "updated_at" = now()
    FROM (
        SELECT
            p."keep_id",
            (array_agg(w."total_energy_kcal" ORDER BY p."created_at", p."id")
                FILTER (WHERE w."total_energy_kcal" IS NOT NULL))[1] AS "energy",
            (array_agg(w."total_distance_m" ORDER BY p."created_at", p."id")
                FILTER (WHERE w."total_distance_m" IS NOT NULL))[1] AS "distance",
            (array_agg(w."avg_heart_rate" ORDER BY p."created_at", p."id")
                FILTER (WHERE w."avg_heart_rate" IS NOT NULL))[1] AS "avg_hr",
            (array_agg(w."min_heart_rate" ORDER BY p."created_at", p."id")
                FILTER (WHERE w."min_heart_rate" IS NOT NULL))[1] AS "min_hr",
            (array_agg(w."max_heart_rate" ORDER BY p."created_at", p."id")
                FILTER (WHERE w."max_heart_rate" IS NOT NULL))[1] AS "max_hr",
            (array_agg(w."step_count" ORDER BY p."created_at", p."id")
                FILTER (WHERE w."step_count" IS NOT NULL))[1] AS "steps",
            (array_agg(w."elevation_m" ORDER BY p."created_at", p."id")
                FILTER (WHERE w."elevation_m" IS NOT NULL))[1] AS "elevation",
            (array_agg(w."pause_duration_sec" ORDER BY p."created_at", p."id")
                FILTER (WHERE w."pause_duration_sec" IS NOT NULL))[1] AS "pause",
            (array_agg(w."external_source_version" ORDER BY p."created_at", p."id")
                FILTER (WHERE w."external_source_version" IS NOT NULL))[1] AS "version"
        FROM "_export_healthkit_pairs" p
        JOIN "workouts" w ON w."id" = p."id"
        GROUP BY p."keep_id"
    ) f
    WHERE k."id" = f."keep_id"
      AND (
          (k."total_energy_kcal" IS NULL AND f."energy" IS NOT NULL)
          OR (k."total_distance_m" IS NULL AND f."distance" IS NOT NULL)
          OR (k."avg_heart_rate" IS NULL AND f."avg_hr" IS NOT NULL)
          OR (k."min_heart_rate" IS NULL AND f."min_hr" IS NOT NULL)
          OR (k."max_heart_rate" IS NULL AND f."max_hr" IS NOT NULL)
          OR (k."step_count" IS NULL AND f."steps" IS NOT NULL)
          OR (k."elevation_m" IS NULL AND f."elevation" IS NOT NULL)
          OR (k."pause_duration_sec" IS NULL AND f."pause" IS NOT NULL)
          OR (k."external_source_version" IS NULL AND f."version" IS NOT NULL)
      );

    -- A personal record names its workout by key; it follows the kept row.
    UPDATE "personal_records" r
    SET "external_id" = p."keep_key"
    FROM "_export_healthkit_pairs" p
    WHERE r."user_id" = p."user_id"
      AND r."source" = 'APPLE_HEALTH'
      AND r."external_id" = p."external_id";

    DELETE FROM "workouts" w
    USING "_export_healthkit_pairs" p
    WHERE w."id" = p."id";

    GET DIAGNOSTICS merged = ROW_COUNT;
    RAISE NOTICE 'HealthLog 0562: merged % Apple Health export workout(s) into the HealthKit workout of their session', merged;
END
$migration$;
