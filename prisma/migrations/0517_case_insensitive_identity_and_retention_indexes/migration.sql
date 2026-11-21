-- Identity, retention and day-key hygiene.
--
--   1. E-mail address and username are unique regardless of case. Sign-in
--      and SSO linking already look both up case-insensitively, but the
--      unique keys compared them exactly, so "Name@host" and "name@host"
--      could be two accounts, and a sign-in resolved to either one. Before
--      building the case-blind keys this block counts the addresses and
--      names that two accounts already share when case is ignored, and stops
--      with an error naming the count when there are any: such accounts are
--      never merged here. The operator resolves them (rename one of each
--      pair; the query is in docs/ops/deploy.md, "Accounts that differ only
--      in case") and starts the container again. `users` is small, so the
--      keys are built in place.
--   2. Six indexes that only repeat another one in descending order are
--      dropped. A B-tree is read backwards as well as forwards, so each one
--      served no query its twin did not, and every write paid for both;
--      `measurement_rollups` is written on every ingest.
--   3. Indexes for the retention purges: the Apple Health tombstone purge
--      (per account, by age), the Coach message purge (by age), and the two
--      new ledger purges, Telegram reminder messages (by send time) and Coach
--      usage days (by last write). Each purge read its table in full before.
--   4. Day keys stored as text (`YYYY-MM-DD`) get a CHECK on their shape. A
--      writer that wrote `2026-1-5` would have broken their sort order and
--      their per-day unique keys without an error. A column whose rows all
--      fit is checked at once; one that holds a row that does not gets the
--      constraint NOT VALID, which binds every new write, and the count is
--      logged for the operator.
--
-- The file is one transaction (its DO blocks make it so): it applies whole
-- or not at all, every lock below is held until it ends, and every table it
-- touches is small next to `measurements`. Each block bounds its lock wait;
-- the file is marked for the boot's lock-timeout retry, and every block is
-- idempotent, so a second run finds nothing to do.
--
-- Reversibility: DROP the new indexes and constraints; the dropped indexes
-- come back with the CREATE INDEX statements of 0067, 0070, 0109, 0283, 0284
-- and 0290.
--
-- @retry-on-lock-timeout

DO $identity$
DECLARE
    email_clashes integer;
    username_clashes integer;
BEGIN
    PERFORM set_config('lock_timeout', '10s', true);

    SELECT count(*) INTO email_clashes FROM (
        SELECT lower("email") FROM "users"
         WHERE "email" IS NOT NULL
         GROUP BY lower("email") HAVING count(*) > 1
    ) AS clashes;
    SELECT count(*) INTO username_clashes FROM (
        SELECT lower("username") FROM "users"
         GROUP BY lower("username") HAVING count(*) > 1
    ) AS clashes;

    IF email_clashes > 0 OR username_clashes > 0 THEN
        RAISE EXCEPTION
            'HealthLog 0517: % e-mail address(es) and % username(s) belong to more than one account when case is ignored; no account was changed.',
            email_clashes, username_clashes
            USING HINT = 'Give one account of each pair another address or name, then start again. The query that lists them is in docs/ops/deploy.md, "Accounts that differ only in case".';
    END IF;

    CREATE UNIQUE INDEX IF NOT EXISTS "users_email_lower_key"
        ON "users" (lower("email"));
    CREATE UNIQUE INDEX IF NOT EXISTS "users_username_lower_key"
        ON "users" (lower("username"));
END
$identity$;

DO $duplicates$
BEGIN
    PERFORM set_config('lock_timeout', '10s', true);

    DROP INDEX IF EXISTS "measurement_rollups_user_type_granularity_bucket_desc_idx";
    DROP INDEX IF EXISTS "mood_entry_rollups_user_granularity_bucket_desc_idx";
    DROP INDEX IF EXISTS "strain_trimp_cache_user_id_day_idx";
    DROP INDEX IF EXISTS "intraday_cumulative_profiles_user_type_date_desc_idx";
    DROP INDEX IF EXISTS "health_profile_fact_revisions_user_kind_valid_from_desc_idx";
    DROP INDEX IF EXISTS "health_score_records_user_id_day_key_desc_idx";
END
$duplicates$;

DO $retention$
BEGIN
    PERFORM set_config('lock_timeout', '10s', true);
    -- Plain builds, held until the file ends: bound how long they may take.
    PERFORM set_config('statement_timeout', '5min', true);

    CREATE INDEX IF NOT EXISTS "apple_health_tombstones_user_id_created_at_idx"
        ON "apple_health_tombstones" ("user_id", "created_at");
    CREATE INDEX IF NOT EXISTS "coach_messages_created_at_idx"
        ON "coach_messages" ("created_at");
    CREATE INDEX IF NOT EXISTS "telegram_reminder_messages_sent_at_idx"
        ON "telegram_reminder_messages" ("sent_at");
    CREATE INDEX IF NOT EXISTS "coach_usage_updated_at_idx"
        ON "coach_usage" ("updated_at");
END
$retention$;

DO $day_keys$
DECLARE
    target record;
    misfits bigint;
    constraint_name text;
BEGIN
    PERFORM set_config('lock_timeout', '10s', true);

    FOR target IN
        SELECT * FROM (VALUES
            ('mood_entries', 'date'),
            ('mood_predictions', 'date'),
            ('mood_reminder_dispatches', 'date'),
            ('cycle_day_logs', 'date'),
            ('menstrual_cycles', 'start_date'),
            ('menstrual_cycles', 'end_date'),
            ('menstrual_cycles', 'period_end_date'),
            ('menstrual_cycles', 'ovulation_date'),
            ('illness_day_logs', 'date'),
            ('nutrient_intake_days', 'day'),
            ('strain_trimp_cache', 'day'),
            ('health_score_records', 'day_key'),
            ('intraday_cumulative_profiles', 'date_key'),
            ('coach_usage', 'date_key'),
            ('dawarich_days', 'date'),
            ('environment_contexts', 'date')
        ) AS t (table_name, column_name)
    LOOP
        constraint_name := target.table_name || '_' || target.column_name || '_day_key_shape';
        CONTINUE WHEN EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = constraint_name
        );
        EXECUTE format(
            'SELECT count(*) FROM %I WHERE %I !~ ''^[0-9]{4}-[0-9]{2}-[0-9]{2}$''',
            target.table_name, target.column_name
        ) INTO misfits;
        EXECUTE format(
            'ALTER TABLE %I ADD CONSTRAINT %I CHECK (%I ~ ''^[0-9]{4}-[0-9]{2}-[0-9]{2}$'')%s',
            target.table_name, constraint_name, target.column_name,
            CASE WHEN misfits > 0 THEN ' NOT VALID' ELSE '' END
        );
        IF misfits > 0 THEN
            RAISE WARNING 'HealthLog 0517: %.% holds % row(s) that are not a YYYY-MM-DD day; the check binds new writes only.',
                target.table_name, target.column_name, misfits;
        END IF;
    END LOOP;
END
$day_keys$;
