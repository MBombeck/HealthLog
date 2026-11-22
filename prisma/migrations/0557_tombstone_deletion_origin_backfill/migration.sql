-- Who deleted the Apple Health tombstones written before 0546 recorded it.
--
-- 0546 left every existing tombstone with `apple_health_deleted_at` NULL,
-- which reads as deleted in HealthLog: a re-post of the sample is refused.
-- That is the safe side for a deletion the person made (the dose stays
-- deleted and takes no stock again), and the wrong side for one the phone
-- reported through `DELETE /api/<domain>/by-external-ids`: a sample that is
-- in Apple Health again would be refused until the tombstone is purged.
--
-- Those deletes left a trace. Each request wrote its tombstones and then one
-- audit row, `<domain>.delete.by_external_ids`, with the number it deleted
-- (`details.deleted`). A tombstone is stamped as Apple Health's when it lies
-- in such a request's window, the ten minutes up to five seconds past the
-- audit row and after the account's previous request of the same domain,
-- and the window holds exactly as many unstamped Apple Health tombstones as
-- the request deleted. Any other count (a deletion the person made in the
-- same minutes, a row deleted again since) leaves the whole window as it is,
-- refused. Only requests from before 0546 count: from then on the deletes
-- stamp the origin themselves, and an unstamped tombstone is the person's.
--
-- The candidates are the rows those deletes could touch, `source =
-- 'APPLE_HEALTH'` with an `external_id`. Nothing but the origin column is
-- written: `updated_at` and `sync_version` stay, so no tombstone goes down
-- the sync feed again. A rerun stamps nothing new.
--
-- Reversibility: set the column back to NULL (every tombstone refused again).
--
-- One transaction (the DO block); the statement timeout bounds the backfill.
--
-- @retry-on-lock-timeout

SET LOCAL statement_timeout = '10min';

DO $migration$
DECLARE
    cutoff TIMESTAMP(3);
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    IF to_regclass('"_prisma_migrations"') IS NOT NULL THEN
        EXECUTE $q$
            SELECT min("finished_at") FROM "_prisma_migrations"
            WHERE "migration_name" = '0546_tombstone_deletion_origin'
              AND "rolled_back_at" IS NULL
        $q$ INTO cutoff;
    END IF;
    cutoff := COALESCE(cutoff, now());

    CREATE TEMP TABLE "apple_health_delete_windows" ON COMMIT DROP AS
    WITH requests AS (
        SELECT a."user_id",
               a."action",
               a."created_at",
               substring(a."details" from '"deleted":\s*(\d+)')::int AS "deleted",
               lag(a."created_at") OVER (
                   PARTITION BY a."user_id", a."action"
                   ORDER BY a."created_at", a."id"
               ) AS "previous_at"
        FROM "audit_logs" a
        WHERE a."action" IN (
                'measurement.delete.by_external_ids',
                'mood.delete.by_external_ids',
                'symptoms.delete.by_external_ids',
                'medication.intake.delete.by_external_ids',
                'cycle.day-log.delete.by_external_ids'
              )
          AND a."user_id" IS NOT NULL
          AND a."created_at" < cutoff
    )
    SELECT "user_id",
           "action",
           "deleted",
           GREATEST(
               "created_at" - interval '10 minutes',
               COALESCE("previous_at" + interval '5 seconds', '-infinity')
           ) AS "lo",
           "created_at" + interval '5 seconds' AS "hi"
    FROM requests
    WHERE "deleted" > 0;

    UPDATE "measurements" t SET "apple_health_deleted_at" = t."deleted_at"
    FROM "apple_health_delete_windows" w
    WHERE w."action" = 'measurement.delete.by_external_ids'
      AND t."user_id" = w."user_id"
      AND t."deleted_at" > w."lo" AND t."deleted_at" <= w."hi"
      AND t."apple_health_deleted_at" IS NULL
      AND t."external_id" IS NOT NULL
      AND t."source"::text = 'APPLE_HEALTH'
      AND w."deleted" = (
          SELECT count(*) FROM "measurements" c
          WHERE c."user_id" = w."user_id"
            AND c."deleted_at" > w."lo" AND c."deleted_at" <= w."hi"
            AND c."apple_health_deleted_at" IS NULL
            AND c."external_id" IS NOT NULL
            AND c."source"::text = 'APPLE_HEALTH'
      );

    UPDATE "mood_entries" t SET "apple_health_deleted_at" = t."deleted_at"
    FROM "apple_health_delete_windows" w
    WHERE w."action" = 'mood.delete.by_external_ids'
      AND t."user_id" = w."user_id"
      AND t."deleted_at" > w."lo" AND t."deleted_at" <= w."hi"
      AND t."apple_health_deleted_at" IS NULL
      AND t."external_id" IS NOT NULL
      AND t."source"::text = 'APPLE_HEALTH'
      AND w."deleted" = (
          SELECT count(*) FROM "mood_entries" c
          WHERE c."user_id" = w."user_id"
            AND c."deleted_at" > w."lo" AND c."deleted_at" <= w."hi"
            AND c."apple_health_deleted_at" IS NULL
            AND c."external_id" IS NOT NULL
            AND c."source"::text = 'APPLE_HEALTH'
      );

    UPDATE "symptom_events" t SET "apple_health_deleted_at" = t."deleted_at"
    FROM "apple_health_delete_windows" w
    WHERE w."action" = 'symptoms.delete.by_external_ids'
      AND t."user_id" = w."user_id"
      AND t."deleted_at" > w."lo" AND t."deleted_at" <= w."hi"
      AND t."apple_health_deleted_at" IS NULL
      AND t."external_id" IS NOT NULL
      AND t."source"::text = 'APPLE_HEALTH'
      AND w."deleted" = (
          SELECT count(*) FROM "symptom_events" c
          WHERE c."user_id" = w."user_id"
            AND c."deleted_at" > w."lo" AND c."deleted_at" <= w."hi"
            AND c."apple_health_deleted_at" IS NULL
            AND c."external_id" IS NOT NULL
            AND c."source"::text = 'APPLE_HEALTH'
      );

    UPDATE "medication_intake_events" t SET "apple_health_deleted_at" = t."deleted_at"
    FROM "apple_health_delete_windows" w
    WHERE w."action" = 'medication.intake.delete.by_external_ids'
      AND t."user_id" = w."user_id"
      AND t."deleted_at" > w."lo" AND t."deleted_at" <= w."hi"
      AND t."apple_health_deleted_at" IS NULL
      AND t."external_id" IS NOT NULL
      AND t."source"::text = 'APPLE_HEALTH'
      AND w."deleted" = (
          SELECT count(*) FROM "medication_intake_events" c
          WHERE c."user_id" = w."user_id"
            AND c."deleted_at" > w."lo" AND c."deleted_at" <= w."hi"
            AND c."apple_health_deleted_at" IS NULL
            AND c."external_id" IS NOT NULL
            AND c."source"::text = 'APPLE_HEALTH'
      );

    UPDATE "cycle_day_logs" t SET "apple_health_deleted_at" = t."deleted_at"
    FROM "apple_health_delete_windows" w
    WHERE w."action" = 'cycle.day-log.delete.by_external_ids'
      AND t."user_id" = w."user_id"
      AND t."deleted_at" > w."lo" AND t."deleted_at" <= w."hi"
      AND t."apple_health_deleted_at" IS NULL
      AND t."external_id" IS NOT NULL
      AND t."source"::text = 'APPLE_HEALTH'
      AND w."deleted" = (
          SELECT count(*) FROM "cycle_day_logs" c
          WHERE c."user_id" = w."user_id"
            AND c."deleted_at" > w."lo" AND c."deleted_at" <= w."hi"
            AND c."apple_health_deleted_at" IS NULL
            AND c."external_id" IS NOT NULL
            AND c."source"::text = 'APPLE_HEALTH'
      );
END
$migration$;
