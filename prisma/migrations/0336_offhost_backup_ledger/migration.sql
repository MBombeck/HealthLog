-- One row per account, written by the nightly off-host backup job when an
-- object lands in the bucket. The admin console reads it to say, per account,
-- whether the newest off-host copy is as fresh as the schedule promises,
-- without the page ever talking to the bucket.
CREATE TABLE "offhost_backup_state" (
    "user_id" TEXT NOT NULL,
    "last_success_at" TIMESTAMP(3) NOT NULL,
    "size_bytes" INTEGER NOT NULL,

    CONSTRAINT "offhost_backup_state_pkey" PRIMARY KEY ("user_id")
);

ALTER TABLE "offhost_backup_state"
    ADD CONSTRAINT "offhost_backup_state_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
