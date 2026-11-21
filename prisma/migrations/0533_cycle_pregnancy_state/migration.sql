-- Pregnancy and postpartum as a cycle state.
--
-- `cycle_profiles` gains the state (`reproductive_state`, NULL is the
-- ordinary cycle), three calendar days as `YYYY-MM-DD` text like every other
-- cycle date, and how many weeks the postpartum state lasts. Every existing
-- row reads NULL, so nothing changes for anyone until they set a state, and
-- nothing is copied.
--
-- One DO block, every step guarded, so a replay after a lock timeout finishes
-- what is missing. Reversibility: drop the five columns and the type; the
-- forecast runs again for anyone who had set a state.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    IF NOT EXISTS (
        SELECT 1 FROM pg_type WHERE typname = 'cycle_reproductive_state'
    ) THEN
        CREATE TYPE "cycle_reproductive_state" AS ENUM ('PREGNANT', 'POSTPARTUM');
    END IF;

    ALTER TABLE "cycle_profiles"
        ADD COLUMN IF NOT EXISTS "reproductive_state" "cycle_reproductive_state",
        ADD COLUMN IF NOT EXISTS "pregnancy_start_date" TEXT,
        ADD COLUMN IF NOT EXISTS "pregnancy_due_date" TEXT,
        ADD COLUMN IF NOT EXISTS "delivery_date" TEXT,
        ADD COLUMN IF NOT EXISTS "postpartum_weeks" INTEGER NOT NULL DEFAULT 12;
END
$migration$;
