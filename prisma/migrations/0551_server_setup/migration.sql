-- The first-admin server setup (1.49): a short guided pass over the server's
-- decisions (accounts, notifications, AI, privacy, setup health), each step
-- skippable, re-openable from Admin.
--
-- `app_settings.server_setup_completed_at`: when the setup was finished, NULL
-- while it is still offered. `app_settings.server_setup_steps_json`: each
-- step's state (`[{ id, status }]`), NULL before the first step is answered.
--
-- An instance that already has accounts was set up before the setup existed,
-- so it is stamped as finished here: an upgrade never offers the setup to an
-- operator who has run the server for months. A fresh install has no account
-- when this runs and keeps NULL, so its first admin is offered the setup.
--
-- Two nullable columns plus one single-row UPDATE: no rewrite. IF NOT EXISTS
-- and the NULL guard keep a replay harmless. Reversibility: drop both columns.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    ALTER TABLE "app_settings"
        ADD COLUMN IF NOT EXISTS "server_setup_completed_at" TIMESTAMP(3);

    ALTER TABLE "app_settings"
        ADD COLUMN IF NOT EXISTS "server_setup_steps_json" JSONB;

    UPDATE "app_settings"
        SET "server_setup_completed_at" = CURRENT_TIMESTAMP
        WHERE "server_setup_completed_at" IS NULL
          AND EXISTS (SELECT 1 FROM "users");
END
$migration$;
