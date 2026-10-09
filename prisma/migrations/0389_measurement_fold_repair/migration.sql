-- One row per account once the fold repair has recomputed the daily and
-- hourly means an older release folded in two runs. The compaction-tombstone
-- purge waits for it, because the tombstones it deletes are what the repair
-- reads. Holds no health data; the account's deletion takes it along.
CREATE TABLE "measurement_fold_repairs" (
    "user_id" TEXT NOT NULL,
    "completed_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "measurement_fold_repairs_pkey" PRIMARY KEY ("user_id")
);

ALTER TABLE "measurement_fold_repairs" ADD CONSTRAINT "measurement_fold_repairs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
