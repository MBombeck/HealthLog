-- One-time admin notices, dismissed per admin account.
--
-- The first is `push_relay_available`: after the update every admin sees
-- once that the push relay exists, what it does and what it sees, until they
-- dismiss it. The dismissal is kept per account as an id in this array, so a
-- later notice needs no new column.
--
-- Nullable-free with a default, so the previous image ignores it after a
-- rollback. Reversibility: drop the column.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "admin_notices_dismissed" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
END
$migration$;
