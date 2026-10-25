-- The nightly whole-database dump records each run: whether a dump was
-- written in DB_BACKUP_DIR and copied to the off-host bucket, and why not.
-- Instance metadata with no account; the admin backups card and the backup
-- alerts read the newest rows.
--
-- The table is new, so nothing waits on its lock in practice; the wait is
-- bounded in a DO block anyway, and every statement is safe to run again, so
-- the boot retries the file on a lock timeout.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);
    CREATE TABLE IF NOT EXISTS "database_backup_runs" (
        "id" TEXT NOT NULL,
        "started_at" TIMESTAMP(3) NOT NULL,
        "finished_at" TIMESTAMP(3),
        "status" TEXT NOT NULL,
        "file_name" TEXT,
        "dump_bytes" BIGINT,
        "local_result" TEXT NOT NULL,
        "offhost_result" TEXT NOT NULL,
        "error" TEXT,
        CONSTRAINT "database_backup_runs_pkey" PRIMARY KEY ("id")
    );
    CREATE INDEX IF NOT EXISTS "database_backup_runs_started_at_idx"
        ON "database_backup_runs"("started_at");
END
$migration$;
