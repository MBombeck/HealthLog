-- Live Activity starts by their id (1.50).
--
-- A relay start is one row of `push_relay_deliveries` (event
-- `LIVE_ACTIVITY_START`): its `ref` is the start id the relay writes into the
-- Activity's attributes, and `medication_id` / `slot_instant` name its dose.
-- That row is now the only record of a start. The device-level copy of the
-- last start (`devices.la_start_ref`, `la_started_medication_id`,
-- `la_started_slot`, `la_started_at`) goes.
--
-- `push_relay_deliveries.la_reported_at`: when the device first registered
-- the Activity a start began. Only a start not reported yet can hold another
-- start back. Backfill, so the rows read as the device columns did: every
-- start but the device's last one is over (1.49 ran one relay-started
-- Activity per device), and the last one too when the device already
-- registered a relay-started Activity or forgot the start.
--
-- `devices.la_start_ids_at`: when the app last reported a relay-started
-- Activity with its start id. Null for every device now.
--
-- Nullable columns, no default: no rewrite. Every step is guarded, so a
-- replay after a lock timeout finishes what is missing. Reversibility: the
-- dropped columns come back empty, which reads as "no start on record"; the
-- start rows still hold each dose.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    ALTER TABLE "push_relay_deliveries"
        ADD COLUMN IF NOT EXISTS "la_reported_at" TIMESTAMP(3);

    ALTER TABLE "devices"
        ADD COLUMN IF NOT EXISTS "la_start_ids_at" TIMESTAMP(3);

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'devices' AND column_name = 'la_start_ref'
    ) THEN
        UPDATE "push_relay_deliveries" AS d
            SET "la_reported_at" = (now() AT TIME ZONE 'UTC')
            FROM "devices" AS v
            WHERE d."device_id" = v."id"
              AND d."event_type" = 'LIVE_ACTIVITY_START'
              AND d."la_reported_at" IS NULL
              AND (
                  v."la_start_ref" IS NULL
                  OR d."ref" <> v."la_start_ref"
                  OR EXISTS (
                      SELECT 1 FROM "live_activity_tokens" AS t
                      WHERE t."device_id" = v."id" AND t."relay_started"
                  )
              );

        ALTER TABLE "devices"
            DROP COLUMN IF EXISTS "la_start_ref",
            DROP COLUMN IF EXISTS "la_started_medication_id",
            DROP COLUMN IF EXISTS "la_started_slot",
            DROP COLUMN IF EXISTS "la_started_at";
    END IF;
END
$migration$;
