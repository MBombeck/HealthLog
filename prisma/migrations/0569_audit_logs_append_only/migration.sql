-- The audit log is append-only for the app's database role (v1.50).
--
-- The role the app connects as (scripts/db-app-role.mjs) could update and
-- delete any row of `audit_logs`, so a compromised app process could rewrite
-- or erase the trail of what it did. From here on:
--
--   * a trigger refuses, for every role but the table's owner, a DELETE or a
--     TRUNCATE, and an UPDATE except the three the app makes: filling a row's
--     location fields once (the geolocation of a sign-in, resolved after the
--     insert), the per-day counter of a delegated access, and rewriting the
--     details of the two actions whose details a later step completes or
--     scrubs (`practitioner.contact.update`, the Apple Health distance
--     repair). Who, what, when and from where never change;
--   * the three deletions the app does make go through functions that run as
--     the owner and check their own narrow condition: the retention sweep
--     (rows older than the cutoff, and never a cutoff less than 6 days ago, a
--     day under the shortest retention the app accepts), the erasure of an account
--     being deleted (only one whose `deletion_requested_at` is set), and the
--     erasure of an account's cycle trail (only `cycle.*` and the cycle
--     preferences rows), which a person's own "delete all cycle data" asks
--     for;
--   * the role's DELETE grant on the table is taken back at every start
--     (db-app-role.mjs), so a direct DELETE fails before the trigger.
--
-- The owner is not held: migrations, a restore, the demo seed and an install
-- that runs the app as the owner (DB_APP_ROLE=off) work as before, and an
-- owner can drop the trigger anyway. Referential actions (the user FK's
-- ON DELETE SET NULL) run as the owner too. The test that UPDATE and DELETE
-- fail for the app role is in tests/integration/db-app-role.test.ts.
--
-- Reversibility: drop the trigger, the four functions; the next start grants
-- DELETE back only if the script's append-only list is emptied.
--
-- The deletions below are function bodies, not work this file runs; the
-- statement bound is there because the guard cannot tell the two apart.
--
-- @retry-on-lock-timeout

SET LOCAL statement_timeout = '1min';

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    CREATE OR REPLACE FUNCTION "audit_logs_append_only"() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
        IF pg_has_role(
            current_user,
            (SELECT c.relowner FROM pg_class c WHERE c.oid = TG_RELID),
            'USAGE'
        ) THEN
            IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
            RETURN NEW;
        END IF;

        IF TG_OP = 'UPDATE' THEN
            IF NEW.id = OLD.id
               AND NEW.action = OLD.action
               AND NEW.created_at = OLD.created_at
               AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
               AND NEW.actor_user_id IS NOT DISTINCT FROM OLD.actor_user_id
               AND NEW.ip_address IS NOT DISTINCT FROM OLD.ip_address
               AND (OLD.location IS NULL OR NEW.location IS NOT DISTINCT FROM OLD.location)
               AND (OLD.asn IS NULL OR NEW.asn IS NOT DISTINCT FROM OLD.asn)
               AND (OLD.carrier IS NULL OR NEW.carrier IS NOT DISTINCT FROM OLD.carrier)
               AND (
                   NEW.details IS NOT DISTINCT FROM OLD.details
                   OR OLD.action IN (
                       'sharing.record.accessed',
                       'practitioner.contact.update',
                       'measurement.apple_health_distance.repaired'
                   )
               )
            THEN
                RETURN NEW;
            END IF;
        END IF;

        RAISE EXCEPTION 'audit_logs is append-only: % refused', TG_OP
            USING ERRCODE = 'insufficient_privilege';
    END
    $fn$;

    DROP TRIGGER IF EXISTS "audit_logs_append_only_rows" ON "audit_logs";
    CREATE TRIGGER "audit_logs_append_only_rows"
        BEFORE UPDATE OR DELETE ON "audit_logs"
        FOR EACH ROW EXECUTE FUNCTION "audit_logs_append_only"();

    DROP TRIGGER IF EXISTS "audit_logs_append_only_truncate" ON "audit_logs";
    CREATE TRIGGER "audit_logs_append_only_truncate"
        BEFORE TRUNCATE ON "audit_logs"
        FOR EACH STATEMENT EXECUTE FUNCTION "audit_logs_append_only"();

    -- Retention: the given rows, only where older than the cutoff, and only a
    -- cutoff at least 6 days back (a day under the shortest retention the app
    -- accepts, so clock skew never refuses a sweep). Answers how many it
    -- deleted.
    CREATE OR REPLACE FUNCTION "audit_logs_purge"(ids text[], cutoff timestamp(3))
    RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $fn$
    DECLARE
        removed integer;
    BEGIN
        IF cutoff > (now() AT TIME ZONE 'UTC') - interval '6 days' THEN
            RAISE EXCEPTION 'audit_logs_purge: cutoff % is less than 6 days back', cutoff
                USING ERRCODE = 'invalid_parameter_value';
        END IF;
        DELETE FROM "audit_logs" WHERE id = ANY(ids) AND created_at < cutoff;
        GET DIAGNOSTICS removed = ROW_COUNT;
        RETURN removed;
    END
    $fn$;

    -- Account erasure: every row of an account that is being deleted.
    CREATE OR REPLACE FUNCTION "audit_logs_erase_account"(account_id text)
    RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $fn$
    DECLARE
        removed integer;
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM "users"
             WHERE id = account_id AND deletion_requested_at IS NOT NULL
        ) THEN
            RAISE EXCEPTION 'audit_logs_erase_account: % is not being deleted', account_id
                USING ERRCODE = 'insufficient_privilege';
        END IF;
        DELETE FROM "audit_logs" WHERE user_id = account_id;
        GET DIAGNOSTICS removed = ROW_COUNT;
        RETURN removed;
    END
    $fn$;

    -- Cycle erasure: an account's cycle rows, which carry dated
    -- reproductive-adjacent details, when its cycle data is deleted.
    CREATE OR REPLACE FUNCTION "audit_logs_erase_cycle"(account_id text)
    RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER SET search_path FROM CURRENT AS $fn$
    DECLARE
        removed integer;
    BEGIN
        DELETE FROM "audit_logs"
         WHERE user_id = account_id
           AND (action LIKE 'cycle.%' OR action = 'user.cycle-prefs.update');
        GET DIAGNOSTICS removed = ROW_COUNT;
        RETURN removed;
    END
    $fn$;

    REVOKE ALL ON FUNCTION "audit_logs_purge"(text[], timestamp) FROM PUBLIC;
    REVOKE ALL ON FUNCTION "audit_logs_erase_account"(text) FROM PUBLIC;
    REVOKE ALL ON FUNCTION "audit_logs_erase_cycle"(text) FROM PUBLIC;
END
$migration$;
