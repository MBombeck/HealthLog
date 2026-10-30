-- Google Health user id repair.
--
-- `google_health_connections.google_user_id` held the last path segment of
-- the profile's resource name `users/{user}/profile`, which is the constant
-- `profile` for every account. Since the one-account-per-record check every
-- connection therefore looked like the same Google account, and a second
-- record on the instance could not connect or reconnect (`already_linked`).
--
-- The column becomes nullable (null = id unknown, which the check treats as
-- no evidence of a second holder) and the placeholder values are cleared. The
-- next connect of each record stores the real id. The table holds one row per
-- connected record, so the update is small; the lock wait is bounded.
--
-- Reversibility: the cleared values were the same constant on every row and
-- identified nothing; restoring NOT NULL needs a value on every row first.
--
-- Both statements are repeatable, so a run stopped by the lock timeout is
-- safe to retry.
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);
    ALTER TABLE "google_health_connections"
        ALTER COLUMN "google_user_id" DROP NOT NULL;
    UPDATE "google_health_connections"
    SET "google_user_id" = NULL
    WHERE "google_user_id" IN ('profile', 'me', '');
END
$migration$;
