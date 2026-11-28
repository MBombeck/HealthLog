-- The country an insurance number follows, and the group number beside a
-- US member ID. Both nullable: a NULL country reads as DE, which every
-- number stored before this column is, so there is no backfill.
--
-- The previous image ignores both columns after a rollback.
-- Reversibility: drop the two columns.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "insurance_number_country" TEXT,
        ADD COLUMN IF NOT EXISTS "insurance_group_number" TEXT;
END
$migration$;
