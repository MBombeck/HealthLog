-- Why the latest background AI work of one kind stopped for a record: one row
-- per record, job kind and subject (a document id, or '' for work without
-- one). The shared reporter writes closed codes only; a later success deletes
-- the row. The person reads it on the document and under Settings, AI.
--
-- One DO block, so the file is one statement that rolls back whole and the
-- foreign key's lock wait on `users` is bounded. Every step is guarded, so a
-- replay after a lock timeout finishes what is missing. Only the new table is
-- created. Reversibility: drop the table; the reasons are gone and the next
-- failure writes them again.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    CREATE TABLE IF NOT EXISTS "ai_job_failures" (
        "id"              TEXT NOT NULL,
        "user_id"         TEXT NOT NULL,
        "job"             TEXT NOT NULL,
        "subject_id"      TEXT NOT NULL DEFAULT '',
        "code"            TEXT NOT NULL,
        "provider_type"   TEXT,
        "fail_count"      INTEGER NOT NULL DEFAULT 1,
        "first_failed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "last_failed_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

        CONSTRAINT "ai_job_failures_pkey" PRIMARY KEY ("id")
    );

    CREATE UNIQUE INDEX IF NOT EXISTS "ai_job_failures_user_id_job_subject_id_key"
        ON "ai_job_failures" ("user_id", "job", "subject_id");

    CREATE INDEX IF NOT EXISTS "ai_job_failures_user_id_last_failed_at_idx"
        ON "ai_job_failures" ("user_id", "last_failed_at");

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'ai_job_failures_user_id_fkey'
    ) THEN
        ALTER TABLE "ai_job_failures"
            ADD CONSTRAINT "ai_job_failures_user_id_fkey"
            FOREIGN KEY ("user_id") REFERENCES "users"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$migration$;
