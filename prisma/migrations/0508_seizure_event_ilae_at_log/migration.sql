-- A seizure keeps the ILAE class its type had when it was logged. Events
-- with a type stored no class of their own and read the type's current one,
-- so re-classifying a type after a new diagnosis rewrote every past seizure
-- and changed the monthly and per-class counts of an earlier doctor report.
-- `ilae_type_at_log` holds the class at logging (or when the seizure was
-- moved to the type); the per-event override still comes first.
--
-- Existing events take their type's class as it stands now, the best record
-- of the class they were logged under. The column is nullable with no
-- default, so adding it rewrites nothing; the backfill touches only events
-- with a type and runs once (a replay finds nothing left to fill).
-- Reversibility: drop the column.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    ALTER TABLE "seizure_events"
        ADD COLUMN IF NOT EXISTS "ilae_type_at_log" "seizure_ilae_type";

    UPDATE "seizure_events" AS e
       SET "ilae_type_at_log" = p."ilae_type"
      FROM "seizure_type_profiles" AS p
     WHERE e."type_profile_id" = p."id"
       AND e."ilae_type_at_log" IS NULL;
END
$migration$;
