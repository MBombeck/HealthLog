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
--
-- `seizure_cluster_alerts` records each cluster the "Seizure cluster"
-- notification was sent for, under a unique (user, first seizure) key. Two
-- seizures that form a cluster together, logged from two devices at once,
-- each saw the other and both sent the alert; the notifier now claims the
-- cluster here first and only the claim that inserts the row sends. A new,
-- empty table; a row goes with its account.
--
-- Reversibility: drop the column and the table.
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

    CREATE TABLE IF NOT EXISTS "seizure_cluster_alerts" (
        "id" TEXT NOT NULL,
        "user_id" TEXT NOT NULL,
        "anchor_event_id" TEXT NOT NULL,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "seizure_cluster_alerts_pkey" PRIMARY KEY ("id")
    );

    CREATE UNIQUE INDEX IF NOT EXISTS "seizure_cluster_alerts_user_id_anchor_event_id_key"
        ON "seizure_cluster_alerts" ("user_id", "anchor_event_id");

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'seizure_cluster_alerts_user_id_fkey'
    ) THEN
        ALTER TABLE "seizure_cluster_alerts"
            ADD CONSTRAINT "seizure_cluster_alerts_user_id_fkey"
            FOREIGN KEY ("user_id") REFERENCES "users"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$migration$;
