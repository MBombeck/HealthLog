-- The sync stall notice (v1.50): tell a person once when a source that
-- delivers daily has gone quiet.
--
-- Per iOS device: when it last delivered Apple Health data of a background
-- type, the hours it delivered in (the cadence history), and the stall state.
-- Per integration: when the owner was told about the watchdog's silence flag.
--
-- Nullable columns without a default and a new table, so nothing is
-- rewritten. One DO block that rolls back whole; every step is guarded, so a
-- replay after a lock timeout finishes what is missing. Reversibility: drop
-- the four columns and the table.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    ALTER TABLE "devices"
        ADD COLUMN IF NOT EXISTS "health_ingest_at" TIMESTAMP(3),
        ADD COLUMN IF NOT EXISTS "health_quiet_since" TIMESTAMP(3),
        ADD COLUMN IF NOT EXISTS "health_quiet_notified_at" TIMESTAMP(3);

    ALTER TABLE "integration_watches"
        ADD COLUMN IF NOT EXISTS "owner_notified_at" TIMESTAMP(3);

    CREATE TABLE IF NOT EXISTS "device_health_ingest_hours" (
        "device_id" TEXT NOT NULL,
        "hour" TIMESTAMP(3) NOT NULL,
        CONSTRAINT "device_health_ingest_hours_pkey" PRIMARY KEY ("device_id", "hour"),
        CONSTRAINT "device_health_ingest_hours_device_id_fkey"
            FOREIGN KEY ("device_id") REFERENCES "devices"("id")
            ON DELETE CASCADE ON UPDATE CASCADE
    );

    CREATE INDEX IF NOT EXISTS "device_health_ingest_hours_hour_idx"
        ON "device_health_ingest_hours" ("hour");
END
$migration$;
