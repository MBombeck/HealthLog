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
