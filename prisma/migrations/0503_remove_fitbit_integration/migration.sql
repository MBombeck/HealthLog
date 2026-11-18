-- Google turned the Fitbit Web API off on 30 October 2026, and the Fitbit
-- integration is removed. What goes is what only the integration held: the
-- connection rows with their sealed OAuth tokens, the OAuth state ledger, the
-- per-account Fitbit app credentials, and the integration's status and
-- watchdog rows. No imported reading lives in any of them: measurements and
-- workouts keep `source = 'FITBIT'`, and the enum value stays.
--
-- The rows are deleted, the shape is not. `fitbit_connections`,
-- `fitbit_oauth_states` and the two credential columns on `users` stay,
-- empty, for one release: the v1.47.6 image reads them on every full user
-- read, so an old container still serving during the switchover, or a
-- rollback to v1.47.6, keeps working. The next minor release drops them.
--
-- An account that still held a Fitbit connection is marked first, so
-- Settings > Integrations can tell that person once what happened
-- (`users.fitbit_removal_notice_at`, cleared when the note is dismissed).
--
-- One DO block: it commits whole or not at all. Every statement in it is
-- guarded, so a replay after a lock timeout, or on a database that already ran
-- it, changes nothing. Reversibility: the schema is unchanged apart from the
-- notice column, which the previous image ignores; the tokens and
-- credentials are gone by design and cannot be restored, and a person
-- reconnects through Google Health instead.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "fitbit_removal_notice_at" TIMESTAMP(3);

    IF to_regclass('fitbit_connections') IS NOT NULL THEN
        EXECUTE $mark$
            UPDATE "users" AS u
               SET "fitbit_removal_notice_at" = CURRENT_TIMESTAMP
             WHERE u."fitbit_removal_notice_at" IS NULL
               AND EXISTS (
                   SELECT 1 FROM "fitbit_connections" AS c
                    WHERE c."user_id" = u."id"
               )
        $mark$;
    END IF;

    IF to_regclass('fitbit_oauth_states') IS NOT NULL THEN
        EXECUTE 'DELETE FROM "fitbit_oauth_states"';
    END IF;
    IF to_regclass('fitbit_connections') IS NOT NULL THEN
        EXECUTE 'DELETE FROM "fitbit_connections"';
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'users'
           AND column_name = 'fitbit_client_id_encrypted'
    ) THEN
        EXECUTE $clear$
            UPDATE "users"
               SET "fitbit_client_id_encrypted" = NULL,
                   "fitbit_client_secret_encrypted" = NULL
             WHERE "fitbit_client_id_encrypted" IS NOT NULL
                OR "fitbit_client_secret_encrypted" IS NOT NULL
        $clear$;
    END IF;

    DELETE FROM "integration_statuses" WHERE "integration" = 'fitbit';
    DELETE FROM "integration_watches" WHERE "integration" = 'fitbit';
END
$migration$;
