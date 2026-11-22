-- Who deleted a tombstoned Apple Health row. A re-post of a sample the
-- person deleted in HealthLog is refused; a re-post after the phone reported
-- the sample deleted in Apple Health (it came back in HealthKit) may write
-- it again. The `by-external-ids` deletes stamp `apple_health_deleted_at`
-- with the same instant as `deleted_at`; any other deletion leaves the two
-- unequal, so no other delete or revive path has to know about the column.
-- Existing tombstones get NULL, which reads as deleted in HealthLog: the
-- safe side, since it keeps them refused.
--
-- The workout and ECG ledger (`apple_health_tombstones`, 0511) goes. Those
-- rows are hard-deleted and a person cannot delete an Apple Health workout
-- or recording in HealthLog, so every line it held is an Apple Health
-- deletion, and those no longer block a re-post.
--
-- Nullable columns without a default: metadata-only, no rewrite.
-- Reversibility: drop the columns; recreate the ledger from 0511 (empty).
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    ALTER TABLE "measurements"
        ADD COLUMN IF NOT EXISTS "apple_health_deleted_at" TIMESTAMP(3);
    ALTER TABLE "mood_entries"
        ADD COLUMN IF NOT EXISTS "apple_health_deleted_at" TIMESTAMP(3);
    ALTER TABLE "symptom_events"
        ADD COLUMN IF NOT EXISTS "apple_health_deleted_at" TIMESTAMP(3);
    ALTER TABLE "medication_intake_events"
        ADD COLUMN IF NOT EXISTS "apple_health_deleted_at" TIMESTAMP(3);
    ALTER TABLE "cycle_day_logs"
        ADD COLUMN IF NOT EXISTS "apple_health_deleted_at" TIMESTAMP(3);

    DROP TABLE IF EXISTS "apple_health_tombstones";
END
$migration$;
