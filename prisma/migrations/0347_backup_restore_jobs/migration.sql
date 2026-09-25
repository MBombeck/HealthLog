-- Backup restores run as a background job.
--
-- A restore used to run inside the request that asked for it. On a large
-- account that request outlived a reverse proxy's 60-second limit, so the
-- operator saw an error while the restore went on to finish. The request now
-- writes one of these rows and answers 202; the worker records progress and
-- the outcome here. Additive: nothing existing changes.

-- CreateTable
CREATE TABLE "backup_restore_jobs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "backup_id" TEXT NOT NULL,
    "backup_digest" TEXT NOT NULL,
    "restore_instance_settings" BOOLEAN NOT NULL DEFAULT false,
    "pg_boss_job_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "phase" TEXT,
    "progress" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "failure" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "heartbeat_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "backup_restore_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "backup_restore_jobs_user_id_created_at_idx" ON "backup_restore_jobs"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "backup_restore_jobs_status_heartbeat_at_idx" ON "backup_restore_jobs"("status", "heartbeat_at");

-- One queued or running restore per account. A second request for the same
-- account is refused with 409 by the insert this index rejects, so two
-- concurrent requests cannot both pass a read-then-write check.
CREATE UNIQUE INDEX "backup_restore_jobs_one_active_per_user"
  ON "backup_restore_jobs" ("user_id")
  WHERE "status" IN ('queued', 'running');

-- AddForeignKey
ALTER TABLE "backup_restore_jobs" ADD CONSTRAINT "backup_restore_jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
