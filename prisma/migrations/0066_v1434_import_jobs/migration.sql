-- v1.4.34 — Apple Health export.zip import jobs
--
-- Additive-only — one new table mirroring the lifecycle of a pg-boss
-- `apple-health-import` job. The polling endpoint reads from this
-- table so the operator sees live per-phase progress rather than the
-- one-shot terminal `output` column on `pg_boss.job` (v12 contract).
--
-- `pg_boss_job_id` is nullable so the `INSERT` can land before the
-- kick-off route gets the boss id back from `boss.send`. The unique
-- index covers the populated rows; NULL values are distinct under
-- the default Postgres semantics so two pre-send rows never collide.
--
-- Locks per `.planning/research/v1434-r-1-xml-import.md` §5.2.

CREATE TABLE IF NOT EXISTS "import_jobs" (
    "id"                    TEXT NOT NULL,
    "user_id"               TEXT NOT NULL,
    "triggered_by_admin_id" TEXT,
    "pg_boss_job_id"        TEXT,
    "status"                TEXT NOT NULL DEFAULT 'queued',
    "failure_reason"        TEXT,
    "upload_bytes"          INTEGER NOT NULL,
    "upload_sha256"         TEXT,
    "exported_at"           TIMESTAMP(3),
    "started_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at"          TIMESTAMP(3),
    "progress"              JSONB NOT NULL DEFAULT '{}'::jsonb,
    "result"                JSONB,

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "import_jobs_pg_boss_job_id_key"
    ON "import_jobs" ("pg_boss_job_id");

CREATE INDEX IF NOT EXISTS "import_jobs_user_id_started_at_idx"
    ON "import_jobs" ("user_id", "started_at");

CREATE INDEX IF NOT EXISTS "import_jobs_status_idx"
    ON "import_jobs" ("status");

ALTER TABLE "import_jobs"
    ADD CONSTRAINT "import_jobs_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
