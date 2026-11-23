-- Pregnancy and postpartum as a cycle state.
--
-- `cycle_profiles` gains the state (`reproductive_state`, NULL is the
-- ordinary cycle), three calendar days as `YYYY-MM-DD` text like every other
-- cycle date, and how many weeks the postpartum state lasts. Every existing
-- row reads NULL, so nothing changes for anyone until they set a state, and
-- nothing is copied.
--
-- The three days carry the same shape check 0517 gave every other text day
-- key (`<table>_<column>_day_key_shape`; NULL passes). The backup copies them
-- verbatim and its schema reads them as day keys, so a column that took any
-- text could hold a value that made the writer's own copy fail its preview
-- and its restore.
--
-- One DO block, every step guarded, so a replay after a lock timeout finishes
-- what is missing. Reversibility: drop the five columns and the type; the
-- forecast runs again for anyone who had set a state. The checks go with the
-- columns.
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

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'cycle_profiles_pregnancy_start_date_day_key_shape'
    ) THEN
        ALTER TABLE "cycle_profiles"
            ADD CONSTRAINT "cycle_profiles_pregnancy_start_date_day_key_shape"
            CHECK ("pregnancy_start_date" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$');
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'cycle_profiles_pregnancy_due_date_day_key_shape'
    ) THEN
        ALTER TABLE "cycle_profiles"
            ADD CONSTRAINT "cycle_profiles_pregnancy_due_date_day_key_shape"
            CHECK ("pregnancy_due_date" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$');
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'cycle_profiles_delivery_date_day_key_shape'
    ) THEN
        ALTER TABLE "cycle_profiles"
            ADD CONSTRAINT "cycle_profiles_delivery_date_day_key_shape"
            CHECK ("delivery_date" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$');
    END IF;
END
$migration$;
