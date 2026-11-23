-- The switch for the navigation counts (#1113): whether the sidebar and the
-- More sheet show the doses due on Medications and the check-ups due on
-- Checkups.
--
-- `users.show_nav_counts`: on by default, which is how the counts behaved
-- before the switch existed, so every existing account keeps them.
--
-- A NOT NULL column with a constant default: metadata-only since Postgres 11,
-- no rewrite. IF NOT EXISTS keeps a replay harmless. Reversibility: drop the
-- column.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "show_nav_counts" BOOLEAN NOT NULL DEFAULT true;
END
$migration$;
