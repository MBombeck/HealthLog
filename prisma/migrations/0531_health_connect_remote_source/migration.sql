-- The WebDAV or Nextcloud folder a scheduled Health Connect export lands in.
--
-- `health_connect_remote_sources` holds at most one folder per account: its
-- URL, the export's file name, the sealed WebDAV credentials, and the fetch
-- schedule with its last outcome. A new, empty table: nothing is copied and
-- nothing runs until a person saves a folder. Reversibility: drop the table;
-- the scheduled fetch then finds nothing to do and uploads work as before.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    CREATE TABLE IF NOT EXISTS "health_connect_remote_sources" (
        "id" TEXT NOT NULL,
        "user_id" TEXT NOT NULL,
        "folder_url" TEXT NOT NULL,
        "file_name" TEXT NOT NULL DEFAULT 'Health Connect.zip',
        "credentials_encrypted" TEXT NOT NULL,
        "enabled" BOOLEAN NOT NULL DEFAULT true,
        "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "last_attempt_at" TIMESTAMP(3),
        "last_outcome" TEXT,
        "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
        "last_etag" TEXT,
        "last_file_sha256" TEXT,
        "last_import_job_id" TEXT,
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updated_at" TIMESTAMP(3) NOT NULL,
        CONSTRAINT "health_connect_remote_sources_pkey" PRIMARY KEY ("id")
    );

    CREATE UNIQUE INDEX IF NOT EXISTS "health_connect_remote_sources_user_id_key"
        ON "health_connect_remote_sources" ("user_id");
    CREATE INDEX IF NOT EXISTS "health_connect_remote_sources_enabled_next_attempt_at_idx"
        ON "health_connect_remote_sources" ("enabled", "next_attempt_at");

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'health_connect_remote_sources_user_id_fkey'
    ) THEN
        ALTER TABLE "health_connect_remote_sources"
            ADD CONSTRAINT "health_connect_remote_sources_user_id_fkey"
            FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$migration$;
