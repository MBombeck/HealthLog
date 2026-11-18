-- Google turned the Fitbit Web API off on 30 October 2026, and the Fitbit
-- integration is removed. What goes is what only the integration used: the
-- connection rows with their sealed OAuth tokens, the OAuth state ledger, the
-- per-account Fitbit app credentials, and the integration's status and
-- watchdog rows. No imported reading lives in any of them: measurements and
-- workouts keep `source = 'FITBIT'`, and the enum value stays.
--
-- An account that still held a Fitbit connection is marked first, so
-- Settings > Integrations can tell that person once what happened
-- (`users.fitbit_removal_notice_at`, cleared when the note is dismissed).
--
-- One DO block: it commits whole or not at all. Every statement in it is
-- guarded, so a replay after a lock timeout, or on a database that already ran
-- it, changes nothing. Reversibility: the tokens are gone by design and cannot
-- be restored; a person reconnects through Google Health instead.
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

    DROP TABLE IF EXISTS "fitbit_oauth_states";
    DROP TABLE IF EXISTS "fitbit_connections";

    ALTER TABLE "users"
        DROP COLUMN IF EXISTS "fitbit_client_id_encrypted",
        DROP COLUMN IF EXISTS "fitbit_client_secret_encrypted";

    DELETE FROM "integration_statuses" WHERE "integration" = 'fitbit';
    DELETE FROM "integration_watches" WHERE "integration" = 'fitbit';
END
$migration$;
