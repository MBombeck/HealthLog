-- Per-HealthKit-type arrival ledger (#1173).
--
-- One row per (user, type), upserted by the measurement batch route: when the
-- type last arrived, under which `syncTrigger`, and when it last brought a new
-- or updated sample. Diagnostic state the next sync rebuilds; not backed up.
CREATE TABLE "healthkit_type_syncs" (
    "user_id" TEXT NOT NULL,
    "type" "measurement_type" NOT NULL,
    "last_received_at" TIMESTAMP(3) NOT NULL,
    "last_trigger" TEXT,
    "last_new_sample_at" TIMESTAMP(3),

    CONSTRAINT "healthkit_type_syncs_pkey" PRIMARY KEY ("user_id","type")
);

ALTER TABLE "healthkit_type_syncs" ADD CONSTRAINT "healthkit_type_syncs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
