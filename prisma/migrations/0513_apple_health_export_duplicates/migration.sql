-- Apple Health export duplicates (#1414, #1421).
--
--   1. Workouts. An export workout's identity hashed the raw attribute
--      strings (`activity|duration|startDate|endDate`). The same workout comes
--      back from a later export with its dates in another offset form and its
--      duration at another precision, so every re-import inserted it again.
--      The importer now keys it on the activity type and the UTC start and
--      end instants: `workout:` + the first 28 hex characters of
--      sha256(`activity|startMs|endMs`), the empty activity read as
--      `Workout` (`workoutExternalId` in
--      src/lib/measurements/import-apple-health-export.ts; the two formulas
--      must stay equal). Here every export workout that carries its activity
--      type in `metadata` is grouped under that key per account. Each group
--      keeps its oldest row; a route, a heart-rate series or an insight the
--      kept row lacks moves over from the oldest copy that has one, an empty
--      total is filled from the copies, personal records naming a copy name
--      the kept row, the copies are deleted (workout deletes are hard
--      deletes; their own routes, series and insights cascade), and the kept
--      row takes the new key, so the next export updates it. A row without
--      the activity type is left as it is; the importer still recognises its
--      old key. The Apple Health tombstone ledger holds HealthKit ids from the
--      phone, never an export key, so nothing here touches it.
--   2. Lab results. A censored result (`<5`, `>90`) arrived from Health
--      Records as text while the record held the same reading as the number,
--      and the duplicate check compared text with text and number with number,
--      so the export wrote it a second time. Of each such pair on one marker
--      and one reading day the newer row is soft-deleted when Apple Health
--      wrote it; its tombstone keeps its identity, so the next export does not
--      write it again. The reading day follows `labReadingDay`: a date-only
--      reading (stored at UTC midnight or noon) is its UTC date, any other is
--      the day in the account's time zone.
--
-- Each part is one DO block, so it applies whole or not at all, and a second
-- run finds nothing left to change. Marked for the boot's lock-timeout retry.
--
-- Reversibility: the deleted workout copies are gone (restore from a backup
-- if one is needed; the kept row holds the same session). The lab rows are
-- soft-deleted and come back by clearing `deleted_at`.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    CREATE TEMP TABLE "_export_workouts" ON COMMIT DROP AS
    SELECT
        w."id",
        w."user_id",
        w."external_id",
        w."created_at",
        'workout:' || left(encode(sha256(convert_to(
            coalesce(nullif(w."metadata" ->> 'activityType', ''), 'Workout')
            || '|' || round(extract(epoch FROM w."started_at") * 1000)::bigint::text
            || '|' || round(extract(epoch FROM w."ended_at") * 1000)::bigint::text,
            'UTF8')), 'hex'), 28) AS "new_key"
    FROM "workouts" w
    WHERE w."source" = 'APPLE_HEALTH'
      AND (w."external_id" LIKE 'sample:%' OR w."external_id" LIKE 'workout:%')
      AND w."metadata" ->> 'activityType' IS NOT NULL;

    CREATE TEMP TABLE "_export_workout_groups" ON COMMIT DROP AS
    SELECT
        e.*,
        first_value(e."id") OVER (
            PARTITION BY e."user_id", e."new_key"
            ORDER BY e."created_at", e."id"
        ) AS "keep_id"
    FROM "_export_workouts" e;

    -- Children the kept row lacks, from the oldest copy that has them.
    UPDATE "workout_routes" r
    SET "workout_id" = m."keep_id"
    FROM (
        SELECT DISTINCT ON (g."keep_id") g."keep_id", c."id" AS "child_id"
        FROM "_export_workout_groups" g
        JOIN "workout_routes" c ON c."workout_id" = g."id"
        WHERE g."id" <> g."keep_id"
          AND NOT EXISTS (
              SELECT 1 FROM "workout_routes" k WHERE k."workout_id" = g."keep_id"
          )
        ORDER BY g."keep_id", g."created_at", g."id"
    ) m
    WHERE r."id" = m."child_id";

    UPDATE "workout_samples" s
    SET "workout_id" = m."keep_id"
    FROM (
        SELECT DISTINCT ON (g."keep_id") g."keep_id", c."id" AS "child_id"
        FROM "_export_workout_groups" g
        JOIN "workout_samples" c ON c."workout_id" = g."id"
        WHERE g."id" <> g."keep_id"
          AND NOT EXISTS (
              SELECT 1 FROM "workout_samples" k WHERE k."workout_id" = g."keep_id"
          )
        ORDER BY g."keep_id", g."created_at", g."id"
    ) m
    WHERE s."id" = m."child_id";

    UPDATE "workout_insights" i
    SET "workout_id" = m."keep_id"
    FROM (
        SELECT DISTINCT ON (g."keep_id") g."keep_id", c."id" AS "child_id"
        FROM "_export_workout_groups" g
        JOIN "workout_insights" c ON c."workout_id" = g."id"
        WHERE g."id" <> g."keep_id"
          AND NOT EXISTS (
              SELECT 1 FROM "workout_insights" k WHERE k."workout_id" = g."keep_id"
          )
        ORDER BY g."keep_id", g."created_at", g."id"
    ) m
    WHERE i."id" = m."child_id";

    -- An empty total on the kept row, from the oldest copy that states it.
    UPDATE "workouts" k
    SET "total_energy_kcal" = coalesce(k."total_energy_kcal", f."energy"),
        "total_distance_m" = coalesce(k."total_distance_m", f."distance"),
        "avg_heart_rate" = coalesce(k."avg_heart_rate", f."avg_hr"),
        "min_heart_rate" = coalesce(k."min_heart_rate", f."min_hr"),
        "max_heart_rate" = coalesce(k."max_heart_rate", f."max_hr"),
        "updated_at" = now()
    FROM (
        SELECT
            g."keep_id",
            (array_agg(w."total_energy_kcal" ORDER BY g."created_at", g."id")
                FILTER (WHERE w."total_energy_kcal" IS NOT NULL))[1] AS "energy",
            (array_agg(w."total_distance_m" ORDER BY g."created_at", g."id")
                FILTER (WHERE w."total_distance_m" IS NOT NULL))[1] AS "distance",
            (array_agg(w."avg_heart_rate" ORDER BY g."created_at", g."id")
                FILTER (WHERE w."avg_heart_rate" IS NOT NULL))[1] AS "avg_hr",
            (array_agg(w."min_heart_rate" ORDER BY g."created_at", g."id")
                FILTER (WHERE w."min_heart_rate" IS NOT NULL))[1] AS "min_hr",
            (array_agg(w."max_heart_rate" ORDER BY g."created_at", g."id")
                FILTER (WHERE w."max_heart_rate" IS NOT NULL))[1] AS "max_hr"
        FROM "_export_workout_groups" g
        JOIN "workouts" w ON w."id" = g."id"
        WHERE g."id" <> g."keep_id"
        GROUP BY g."keep_id"
    ) f
    WHERE k."id" = f."keep_id"
      AND (
          (k."total_energy_kcal" IS NULL AND f."energy" IS NOT NULL)
          OR (k."total_distance_m" IS NULL AND f."distance" IS NOT NULL)
          OR (k."avg_heart_rate" IS NULL AND f."avg_hr" IS NOT NULL)
          OR (k."min_heart_rate" IS NULL AND f."min_hr" IS NOT NULL)
          OR (k."max_heart_rate" IS NULL AND f."max_hr" IS NOT NULL)
      );

    -- A personal record names its workout by key; it follows the kept row.
    UPDATE "personal_records" p
    SET "external_id" = g."new_key"
    FROM "_export_workout_groups" g
    WHERE p."user_id" = g."user_id"
      AND p."source" = 'APPLE_HEALTH'
      AND p."external_id" = g."external_id"
      AND p."external_id" <> g."new_key";

    DELETE FROM "workouts" w
    USING "_export_workout_groups" g
    WHERE w."id" = g."id"
      AND g."id" <> g."keep_id";

    UPDATE "workouts" w
    SET "external_id" = g."new_key",
        "updated_at" = now()
    FROM "_export_workout_groups" g
    WHERE w."id" = g."id"
      AND g."id" = g."keep_id"
      AND w."external_id" <> g."new_key";
END
$migration$;

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    CREATE TEMP TABLE "_lab_reading_days" ON COMMIT DROP AS
    SELECT
        r."id",
        r."user_id",
        r."biomarker_id",
        r."source",
        r."created_at",
        r."value",
        r."source_value",
        lower(trim(r."source_unit")) AS "source_unit",
        CASE
            WHEN r."value" IS NULL THEN
                substring(r."value_text" FROM '^\s*(?:<=|>=|≤|≥|<|>)\s*(-?[0-9]+(?:\.[0-9]+)?)(?:\s|$)')::float8
        END AS "censored",
        CASE
            WHEN r."value" IS NULL THEN
                lower(trim(substring(r."value_text" FROM '^\s*(?:<=|>=|≤|≥|<|>)\s*-?[0-9]+(?:\.[0-9]+)?\s+(.+)$')))
        END AS "censored_unit",
        CASE
            WHEN r."taken_at"::time IN (TIME '00:00', TIME '12:00') THEN r."taken_at"::date
            ELSE (r."taken_at" AT TIME ZONE 'UTC' AT TIME ZONE coalesce(
                (SELECT z."name" FROM pg_timezone_names z WHERE z."name" = u."timezone" LIMIT 1),
                'Europe/Berlin'))::date
        END AS "day"
    FROM "lab_results" r
    JOIN "users" u ON u."id" = r."user_id"
    WHERE r."deleted_at" IS NULL
      AND r."biomarker_id" IS NOT NULL
      AND r."user_id" IN (
          SELECT c."user_id"
          FROM "lab_results" c
          WHERE c."deleted_at" IS NULL
            AND c."value" IS NULL
            AND c."value_text" ~ '^\s*(<=|>=|≤|≥|<|>)\s*-?[0-9]'
      );

    UPDATE "lab_results" d
    SET "deleted_at" = now(),
        "updated_at" = now()
    FROM (
        SELECT DISTINCT
            CASE
                WHEN (t."created_at", t."id") > (n."created_at", n."id") THEN t."id"
                ELSE n."id"
            END AS "id",
            CASE
                WHEN (t."created_at", t."id") > (n."created_at", n."id") THEN t."source"
                ELSE n."source"
            END AS "source"
        FROM "_lab_reading_days" t
        JOIN "_lab_reading_days" n
          ON n."user_id" = t."user_id"
         AND n."biomarker_id" = t."biomarker_id"
         AND n."day" = t."day"
         AND n."id" <> t."id"
         AND n."value" IS NOT NULL
         AND (
             n."value" = t."censored"
             OR (
                 n."source_value" = t."censored"
                 AND t."censored_unit" IS NOT NULL
                 AND n."source_unit" = t."censored_unit"
             )
         )
        WHERE t."censored" IS NOT NULL
    ) newer
    WHERE d."id" = newer."id"
      AND newer."source" = 'APPLE_HEALTH'
      AND d."deleted_at" IS NULL;
END
$migration$;
