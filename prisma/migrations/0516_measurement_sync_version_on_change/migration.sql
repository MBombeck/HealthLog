-- Bump `measurements.sync_version` on every update that changes the row.
--
-- The column is documented as raised on every server-side mutation, and paired
-- clients read it for last-writer-wins. Raising it was left to each caller.
-- Several did not: an edit through `PUT /api/measurements/[id]`, the stale
-- sleep-segment sweep, and the Oura and Garmin tombstones moved `updated_at`
-- (so the feed sent the row again) but left the version where it was.
--
-- The row trigger from 0412 already compares the old and new row. It now
-- also raises the version by one when the row changed and the update did not
-- move the version itself, so a caller that writes `sync_version + 1` still
-- raises it once, a caller that forgets it is covered, and an update that
-- changes nothing keeps both stamps as before.
--
-- `CREATE OR REPLACE FUNCTION` takes no lock on the table and is harmless to
-- run again. It runs inside a `DO` block with a bounded lock wait like the
-- other measurement migrations, and is marked for the boot's retry.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    CREATE OR REPLACE FUNCTION "measurements_keep_stamps_on_noop"() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
        IF (to_jsonb(NEW) - 'updated_at' - 'sync_version')
           = (to_jsonb(OLD) - 'updated_at' - 'sync_version') THEN
            NEW."updated_at" := OLD."updated_at";
            NEW."sync_version" := OLD."sync_version";
        ELSIF NEW."sync_version" = OLD."sync_version" THEN
            NEW."sync_version" := OLD."sync_version" + 1;
        END IF;
        RETURN NEW;
    END;
    $fn$;
END
$migration$;
