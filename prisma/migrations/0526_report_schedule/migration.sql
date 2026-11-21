-- The scheduled doctor report.
--
-- `users.report_schedule_json` holds whether and how often the doctor report
-- is filed into the document vault on its own, and the last period it filed:
-- `{ "v": 1, "cadence": "MONTHLY", "window": "PERIOD", "lastPeriod": "2026-10",
-- "lastOutcome": "stored", "lastRunAt": "..." }`. NULL is off, which is every
-- existing account, so nothing is copied and nothing runs until the owner
-- turns it on.
--
-- One DO block, guarded: a replay after a lock timeout changes nothing.
-- Reversibility: drop the column; the schedule is off again and the reports
-- already filed stay in the vault as ordinary documents.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "report_schedule_json" JSONB;
END
$migration$;
