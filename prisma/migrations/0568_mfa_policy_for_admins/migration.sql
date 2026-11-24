-- Second-factor policy for administrators, and its grace period (v1.50).
--
-- `app_settings` gains the admin policy (on by default, for existing installs
-- too), the grace period in days (14) and the instant the policies last took
-- effect, which this migration sets to its own run: an admin of an existing
-- install without a second factor has the grace period from the update on,
-- and is asked to enrol in the meantime. `sessions` gains the instant its
-- account has to have a factor by; it is filled by the app at sign-in and on
-- the next account read, so existing sessions start NULL.
--
-- The instant is written as UTC explicitly: the column is a zone-less UTC
-- timestamp and a bare `now()` would be converted through whatever time zone
-- the migrating connection carries. One DO block that rolls back whole; every
-- step is guarded, so a replay after a lock timeout finishes what is missing.
-- `app_settings` holds one row and `sessions` gets a nullable column without
-- a default, so nothing is rewritten. Reversibility: drop the four columns.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    ALTER TABLE "app_settings"
        ADD COLUMN IF NOT EXISTS "mfa_required_for_admins" BOOLEAN NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS "mfa_grace_days" INTEGER NOT NULL DEFAULT 14,
        ADD COLUMN IF NOT EXISTS "mfa_policy_since" TIMESTAMP(3);

    UPDATE "app_settings"
       SET "mfa_policy_since" = (now() AT TIME ZONE 'UTC')
     WHERE "mfa_policy_since" IS NULL;

    ALTER TABLE "app_settings"
        ALTER COLUMN "mfa_policy_since" SET DEFAULT CURRENT_TIMESTAMP,
        ALTER COLUMN "mfa_policy_since" SET NOT NULL;

    ALTER TABLE "sessions"
        ADD COLUMN IF NOT EXISTS "mfa_enrollment_due_at" TIMESTAMP(3);
END
$migration$;
