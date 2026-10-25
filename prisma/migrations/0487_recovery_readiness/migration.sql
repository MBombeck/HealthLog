-- Recovery readiness: what the admins were last told, what the restore drill
-- last found, and the recovery kit confirmation.
--
-- `recovery_readiness_notices` holds, per readiness signal, the state the
-- admins were last notified about and when. It is the whole memory of the
-- hourly evaluation: a state change notifies once, a failing signal is
-- reminded at most once a day, and a recovery is announced once. It also
-- remembers since when a signal has applied, so a dump switched on by an
-- upgrade is not called failing before its first run had a chance.
--
-- `restore_drill_outcomes` keeps the monthly drill's last result for as long
-- as it is the last one. pg-boss forgets a failed run after seven days and
-- the admin failing-jobs card looks back 72 hours, so a failed monthly drill
-- was on screen three days in thirty.
--
-- `recovery_kit_confirmations` replaces the four `encryption_key_backup_*`
-- columns on `app_settings`. Those confirmed one key, the active application
-- key; the kit confirms the set of every key a restore needs, by id and
-- fingerprint. A confirmation given under the old step is carried over as a
-- kit that holds that one key, so an operator who confirmed the active key
-- keeps that part confirmed and is asked only for what the old step never
-- covered.
--
-- A backup file written by a release that still had the four columns carries
-- them in its instance settings; the restore writes an explicit list of
-- settings and ignores them.
--
-- The whole file is one statement, so it applies whole or not at all, and
-- running it again changes nothing. The drop takes an ACCESS EXCLUSIVE lock
-- on `app_settings` for a catalogue update only; the wait is bounded.
--
-- Reversibility: re-adding the four nullable columns restores the old shape;
-- the old step then reads as due until it is confirmed again.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    CREATE TABLE IF NOT EXISTS "recovery_readiness_notices" (
        "signal" TEXT NOT NULL,
        "notified_state" TEXT,
        "notified_at" TIMESTAMP(3),
        "watched_since" TIMESTAMP(3),
        CONSTRAINT "recovery_readiness_notices_pkey" PRIMARY KEY ("signal"),
        CONSTRAINT "recovery_readiness_notices_state_check"
            CHECK ("notified_state" IS NULL OR "notified_state" IN ('ok', 'attention', 'failing'))
    );

    CREATE TABLE IF NOT EXISTS "restore_drill_outcomes" (
        "id" TEXT NOT NULL DEFAULT 'singleton',
        "last_run_at" TIMESTAMP(3) NOT NULL,
        "last_success_at" TIMESTAMP(3),
        "last_failure_at" TIMESTAMP(3),
        "last_failure_reason" TEXT,
        "accounts_checked" INTEGER NOT NULL DEFAULT 0,
        "accounts_failed" INTEGER NOT NULL DEFAULT 0,
        CONSTRAINT "restore_drill_outcomes_pkey" PRIMARY KEY ("id")
    );

    CREATE TABLE IF NOT EXISTS "recovery_kit_confirmations" (
        "id" TEXT NOT NULL DEFAULT 'singleton',
        "confirmed_at" TIMESTAMP(3) NOT NULL,
        "confirmed_by_user_id" TEXT,
        "entries" JSONB NOT NULL,
        CONSTRAINT "recovery_kit_confirmations_pkey" PRIMARY KEY ("id")
    );

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'app_settings'
          AND column_name = 'encryption_key_backup_confirmed_at'
    ) THEN
        INSERT INTO "recovery_kit_confirmations"
            ("id", "confirmed_at", "confirmed_by_user_id", "entries")
        SELECT
            'singleton',
            "encryption_key_backup_confirmed_at",
            "encryption_key_backup_confirmed_by_user_id",
            jsonb_build_array(jsonb_build_object(
                'kind', 'application',
                'id', "encryption_key_backup_confirmed_key_id",
                'fingerprint', "encryption_key_backup_confirmed_fingerprint"
            ))
        FROM "app_settings"
        WHERE "id" = 'singleton'
          AND "encryption_key_backup_confirmed_at" IS NOT NULL
          AND "encryption_key_backup_confirmed_key_id" IS NOT NULL
          AND "encryption_key_backup_confirmed_fingerprint" IS NOT NULL
        ON CONFLICT ("id") DO NOTHING;

        ALTER TABLE "app_settings"
            DROP COLUMN IF EXISTS "encryption_key_backup_confirmed_at",
            DROP COLUMN IF EXISTS "encryption_key_backup_confirmed_key_id",
            DROP COLUMN IF EXISTS "encryption_key_backup_confirmed_fingerprint",
            DROP COLUMN IF EXISTS "encryption_key_backup_confirmed_by_user_id";
    END IF;
END
$migration$;
