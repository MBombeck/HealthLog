-- The operator's answer to "Send push notifications through the HealthLog
-- relay?" (1.49), once for the whole server.
--
-- `app_settings.push_relay_decision`: `on` once the registration at the relay
-- succeeded, `off` once an admin said no or switched the relay off, NULL while
-- nobody answered. NULL is what the admin is asked about; `off` is never asked
-- again.
--
-- A server already registered at the relay before this column existed was
-- answered then: it is stamped `on` here, so its admin is not asked a question
-- the switch already answered.
--
-- One nullable column, a CHECK on it and one single-row UPDATE: no rewrite.
-- IF NOT EXISTS, the constraint guard and the NULL guard keep a replay
-- harmless. Reversibility: drop the column.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    ALTER TABLE "app_settings"
        ADD COLUMN IF NOT EXISTS "push_relay_decision" TEXT;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'app_settings_push_relay_decision_check'
    ) THEN
        ALTER TABLE "app_settings"
            ADD CONSTRAINT "app_settings_push_relay_decision_check"
            CHECK ("push_relay_decision" IS NULL
                OR "push_relay_decision" IN ('on', 'off'));
    END IF;

    UPDATE "app_settings"
        SET "push_relay_decision" = 'on'
        WHERE "push_relay_decision" IS NULL
          AND EXISTS (
              SELECT 1 FROM "push_relay_registrations"
              WHERE "instance_id" IS NOT NULL
                AND "state" <> 'deleting'
          );
END
$migration$;
