-- Which write a cycle day's symptom link came from. An Apple Health day write
-- replaces only the links Apple Health wrote, so a symptom the person logged
-- by hand on the same day stays.
--
-- Backfill: every write used to replace a day's whole set, so the links of a
-- day hold what its last writer sent. The day's own source is the best
-- record of that writer there is: links of a day imported from Apple Health
-- or Health Connect take that source, every other link stays MANUAL.
--
-- ADD COLUMN with a constant default is a catalog change on Postgres 11+, no
-- rewrite. The backfill touches only the links of imported days. Guarded, so
-- a replay after a lock timeout changes nothing. Reversibility: drop the
-- column.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    ALTER TABLE "cycle_symptom_links"
        ADD COLUMN IF NOT EXISTS "source" "measurement_source" NOT NULL DEFAULT 'MANUAL';

    UPDATE "cycle_symptom_links" AS l
       SET "source" = d."source"
      FROM "cycle_day_logs" AS d
     WHERE d."id" = l."day_log_id"
       AND d."source" <> 'MANUAL'
       AND l."source" = 'MANUAL';

END
$migration$;
