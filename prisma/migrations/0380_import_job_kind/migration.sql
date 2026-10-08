-- Which importer owns an `import_jobs` row (#972).
--
-- Until now every row was an Apple Health export; the Health Connect importer
-- shares the table. The reconcile cron and the staged-file sweep scope by
-- `kind` so one importer never fails or deletes the other's running job.
-- Every existing row is an Apple Health job, which the default records.
ALTER TABLE "import_jobs" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'apple_health';

CREATE INDEX "import_jobs_user_id_kind_started_at_idx" ON "import_jobs"("user_id", "kind", "started_at");
