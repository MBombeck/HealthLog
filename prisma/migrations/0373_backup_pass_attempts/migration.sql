-- One row per account and backup pass, written when the pass starts the
-- account and again when it gets past it. A start newer than the finish with
-- no run active is an attempt the process died under; the pass takes that
-- account last, and the admin backups page names it.
CREATE TABLE "backup_pass_attempts" (
    "user_id" TEXT NOT NULL,
    -- The pass's queue name: data-backup or data-backup-offhost.
    "pass" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    -- NULL until the pass has once got past this account.
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "backup_pass_attempts_pkey" PRIMARY KEY ("user_id", "pass")
);

ALTER TABLE "backup_pass_attempts"
    ADD CONSTRAINT "backup_pass_attempts_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
