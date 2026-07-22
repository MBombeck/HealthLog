-- Durable medication-intake imports keep the validated payload and monotonic
-- progress in Postgres so queue retries and process restarts cannot duplicate
-- intake or inventory side effects. This is additive and preserves all rows.
CREATE TABLE "medication_intake_import_jobs" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "medication_id" TEXT NOT NULL,
  "pg_boss_job_id" TEXT,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "payload" JSONB NOT NULL,
  "progress" JSONB NOT NULL DEFAULT '{}',
  "result" JSONB,
  "failure_reason" TEXT,
  "heartbeat_at" TIMESTAMP(3),
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "medication_intake_import_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "medication_intake_import_jobs_status_check"
    CHECK ("status" IN ('queued', 'running', 'done', 'failed')),
  CONSTRAINT "medication_intake_import_jobs_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "medication_intake_import_jobs_medication_id_fkey"
    FOREIGN KEY ("medication_id") REFERENCES "medications"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "medication_intake_import_jobs_pg_boss_job_id_key"
  ON "medication_intake_import_jobs"("pg_boss_job_id");
CREATE INDEX "medication_intake_import_jobs_user_id_created_at_idx"
  ON "medication_intake_import_jobs"("user_id", "created_at");
CREATE INDEX "medication_intake_import_jobs_medication_id_created_at_idx"
  ON "medication_intake_import_jobs"("medication_id", "created_at");
CREATE INDEX "medication_intake_import_jobs_status_heartbeat_at_idx"
  ON "medication_intake_import_jobs"("status", "heartbeat_at");
