-- Silent wakes beside the medication sync: DATA_CHANGED, when a server-side
-- sync stored new readings, and HEALTHKIT_CATCH_UP, when a device's Apple
-- Health upload fell behind.
--
-- 1. `push_data_changes` holds the wake owed to one device: the merged
--    domains and the last three wakes, which bound it to one wake per five
--    minutes and three per hour.
-- 2. `push_wakes` records every silent wake sent to a device, for the
--    shared hourly budget and the catch-up's daily limit.
--
-- Both are new tables; nothing existing changes. One DO block, every
-- statement guarded, so a replay after a lock timeout changes nothing.
-- Reversibility: drop both tables.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    CREATE TABLE IF NOT EXISTS "push_data_changes" (
        "device_id" TEXT NOT NULL,
        "domains" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        "sent_at" TIMESTAMP(3)[] NOT NULL DEFAULT ARRAY[]::TIMESTAMP(3)[],
        "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "push_data_changes_pkey" PRIMARY KEY ("device_id"),
        CONSTRAINT "push_data_changes_device_id_fkey" FOREIGN KEY ("device_id")
            REFERENCES "devices" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );

    CREATE TABLE IF NOT EXISTS "push_wakes" (
        "id" TEXT NOT NULL,
        "device_id" TEXT NOT NULL,
        "kind" TEXT NOT NULL,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "push_wakes_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "push_wakes_device_id_fkey" FOREIGN KEY ("device_id")
            REFERENCES "devices" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );
    CREATE INDEX IF NOT EXISTS "push_wakes_device_id_kind_created_at_idx"
        ON "push_wakes" ("device_id", "kind", "created_at");
    CREATE INDEX IF NOT EXISTS "push_wakes_created_at_idx"
        ON "push_wakes" ("created_at");

END
$migration$;
