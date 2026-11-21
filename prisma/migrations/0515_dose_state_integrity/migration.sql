-- Dose-state integrity: a recorded outcome is never an auto-miss, a take
-- records where it came from, and a Live Activity token names its medication.
--
-- A recorded outcome is never an auto-miss.
--
-- The hourly auto-miss pass stamps `auto_missed = true` on a scheduled dose
-- nobody acted on. When the person later records that dose as taken, or
-- skips it deliberately, the stamp has to go: the dose history, the compliance
-- rate and the today list read the take or the skip, but the cadence timeline,
-- the miss-free streak and the achievements read the stamp first, so the same
-- dose read as taken in one place and missed in another. Only one of the write
-- paths cleared it (the canonical slot write, and only on a take); the status
-- route, the event edit, a skip through the per-medication route, the bulk
-- route, Telegram and the ingest hook all left it standing.
--
-- 1. A row trigger clears `auto_missed` on every insert or update that leaves
--    the row taken (`taken_at IS NOT NULL`) or skipped. It holds for every
--    writer, present and future, so the invariant does not depend on each
--    call site remembering it. The pass itself only ever stamps rows that are
--    neither, so it is unaffected.
-- 2. Rows that already carry both are repaired, with `sync_version` and `updated_at`
--    moved so paired clients pick the change up from the delta feed.
--
-- `CREATE TRIGGER` takes SHARE ROW EXCLUSIVE on the table and the repair
-- takes row locks, so both run in one `DO` block with a bounded lock wait.
-- The function before it is `CREATE OR REPLACE` and harmless to run again; a
-- second run finds no row left to repair. Marked for the boot's lock-timeout
-- retry.
--
-- @retry-on-lock-timeout

CREATE OR REPLACE FUNCTION "medication_intake_events_outcome_clears_auto_missed"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."auto_missed" AND (NEW."taken_at" IS NOT NULL OR NEW."skipped") THEN
        NEW."auto_missed" := false;
    END IF;
    RETURN NEW;
END;
$$;

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '10s', true);

    DROP TRIGGER IF EXISTS "medication_intake_events_outcome_clears_auto_missed"
        ON "medication_intake_events";
    CREATE TRIGGER "medication_intake_events_outcome_clears_auto_missed"
        BEFORE INSERT OR UPDATE ON "medication_intake_events"
        FOR EACH ROW
        EXECUTE FUNCTION "medication_intake_events_outcome_clears_auto_missed"();

    UPDATE "medication_intake_events"
    SET "auto_missed" = false,
        "sync_version" = "sync_version" + 1,
        "updated_at" = now()
    WHERE "auto_missed"
      AND ("taken_at" IS NOT NULL OR "skipped");
END
$migration$;

-- 3. Where a take came from. `source` names the writer that created the row,
--    and a projected or reminder slot is created by the server, so a take that
--    later converges onto it kept `REMINDER` whatever recorded it. The new
--    nullable `taken_via` holds the origin of the take itself (web, app,
--    integration, Telegram, Apple Health, import, auto-take). Existing rows
--    stay null: their origin was never recorded.
-- 4. A device's running Live Activities, one row each with the dose it
--    shows (`live_activity_tokens`), so the end push goes to exactly the
--    Activity whose dose was answered. The single device-level token stays
--    for clients that send only that.
--
-- Additive and nullable, so no row is rewritten; each statement is idempotent.

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '10s', true);

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'intake_taken_via') THEN
        CREATE TYPE "intake_taken_via" AS ENUM (
            'WEB', 'APP', 'INTEGRATION', 'TELEGRAM', 'APPLE_HEALTH', 'IMPORT', 'AUTO'
        );
    END IF;

    ALTER TABLE "medication_intake_events"
        ADD COLUMN IF NOT EXISTS "taken_via" "intake_taken_via";

    CREATE TABLE IF NOT EXISTS "live_activity_tokens" (
        "id" TEXT NOT NULL,
        "device_id" TEXT NOT NULL,
        "push_token" TEXT NOT NULL,
        "medication_id" TEXT NOT NULL,
        "slot_instant" TIMESTAMP(3),
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL,
        CONSTRAINT "live_activity_tokens_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "live_activity_tokens_device_id_fkey" FOREIGN KEY ("device_id")
            REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "live_activity_tokens_device_id_push_token_key"
        ON "live_activity_tokens" ("device_id", "push_token");
    CREATE INDEX IF NOT EXISTS "live_activity_tokens_device_id_idx"
        ON "live_activity_tokens" ("device_id");
END
$migration$;

-- 5. One live row per slot. The live-row unique index of migration 0121 held
--    `(user_id, medication_id, scheduled_for, source)`, so two writers of
--    different sources (a pill box through the ingest hook and a Telegram
--    button) that both found the slot empty each inserted a row, and the slot
--    carried two doses. The slot write now serialises on a per-slot lock, and
--    the index drops `source`, so the database refuses a second live row for
--    one slot from any writer.
--
--    Existing duplicates are merged first: of each slot's live rows the one
--    that records a take is kept (else a skip, else the oldest pending row,
--    ties by creation time and id), and the rest are soft-deleted, with
--    `sync_version` and `updated_at` moved so paired clients drop them. A
--    tombstone keeps its identity; clearing `deleted_at` restores a row.
--    The merge and the index swap run in one DO block, so a lock timeout
--    leaves the file safe to run again.

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '10s', true);

    WITH ranked AS (
        SELECT
            "id",
            ROW_NUMBER() OVER (
                PARTITION BY "user_id", "medication_id", "scheduled_for"
                ORDER BY
                    ("taken_at" IS NOT NULL AND NOT "skipped") DESC,
                    "skipped" DESC,
                    "created_at" ASC,
                    "id" ASC
            ) AS rn
        FROM "medication_intake_events"
        WHERE "deleted_at" IS NULL
    )
    UPDATE "medication_intake_events" e
    SET "deleted_at" = now(),
        "sync_version" = e."sync_version" + 1,
        "updated_at" = now()
    FROM ranked r
    WHERE e."id" = r."id" AND r.rn > 1;

    DROP INDEX IF EXISTS "medication_intake_events_user_med_slot_source_live_key";
    CREATE UNIQUE INDEX IF NOT EXISTS "medication_intake_events_user_med_slot_live_key"
        ON "medication_intake_events" ("user_id", "medication_id", "scheduled_for")
        WHERE "deleted_at" IS NULL;
END
$migration$;
