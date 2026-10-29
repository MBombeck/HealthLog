-- System job alert: what the admins were last told about a background job of
-- the instance that keeps failing.
--
-- `system_job_alert_notices` holds, per pg-boss queue, the state the admins
-- were last notified about and when. It is the whole memory of the hourly
-- evaluation (`src/lib/jobs/system-job-alert.ts`): a queue that has failed
-- three runs in a row notifies once, is reminded at most once a day while it
-- keeps failing, and its first successful run after that is announced once.
-- A row exists only for a queue something was announced about.
--
-- One new table, nothing else touched, so the migration takes no lock on an
-- existing table and running it again changes nothing.
--
-- Reversibility: dropping the table loses only the memory of what was
-- announced; the next evaluation announces a still-failing queue once more.

CREATE TABLE IF NOT EXISTS "system_job_alert_notices" (
    "queue" TEXT NOT NULL,
    "notified_state" TEXT,
    "notified_at" TIMESTAMP(3),
    CONSTRAINT "system_job_alert_notices_pkey" PRIMARY KEY ("queue"),
    CONSTRAINT "system_job_alert_notices_state_check"
        CHECK ("notified_state" IS NULL OR "notified_state" IN ('ok', 'failing'))
);
