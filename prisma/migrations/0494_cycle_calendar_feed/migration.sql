-- Subscribable cycle forecast (#1350): one table holding the calendar-feed
-- credential of a record, and the enum for how its events are titled.
--
-- The row is a URL credential. Only the HMAC of the raw `hlf_` token is
-- stored; the forecast itself is computed on every fetch and never persisted.
-- Revocation stamps `revoked_at` and never deletes, so the uniqueness that
-- matters (at most one LIVE feed per record) is a partial index, the shape
-- `account_grants_live_pair_key` uses. Prisma cannot express it, so it lives
-- here only.
--
-- Both foreign keys cascade: deleting the record ends its feed, and deleting
-- the carrier who minted it does too, so a delegate's account going away
-- cannot leave a link behind that nobody can revoke.
--
-- One DO block, so the file is one statement that rolls back whole and the
-- foreign keys' lock wait on `users` is bounded. Only the new table and the
-- new type are created; nothing existing changes shape. Reversibility:
-- dropping the table and the type ends every feed URL; subscribers see 404 and
-- the owner mints again.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    IF NOT EXISTS (
        SELECT 1 FROM pg_type WHERE typname = 'cycle_calendar_feed_title_mode'
    ) THEN
        CREATE TYPE "cycle_calendar_feed_title_mode" AS ENUM ('DISCREET', 'DESCRIPTIVE');
    END IF;

    CREATE TABLE IF NOT EXISTS "cycle_calendar_feeds" (
        "id"                 TEXT NOT NULL,
        "user_id"            TEXT NOT NULL,
        "created_by_id"      TEXT NOT NULL,
        "token_hash"         TEXT NOT NULL,
        "token_prefix"       TEXT NOT NULL,
        "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "revoked_at"         TIMESTAMP(3),
        "last_fetched_at"    TIMESTAMP(3),
        "fetch_count"        INTEGER NOT NULL DEFAULT 0,
        "last_fetcher_ua"    TEXT,
        "body_hash"          TEXT,
        "content_changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "horizon_cycles"     INTEGER NOT NULL DEFAULT 3,
        "history_cycles"     INTEGER NOT NULL DEFAULT 0,
        "include_fertile"    BOOLEAN NOT NULL DEFAULT false,
        "title_mode"         "cycle_calendar_feed_title_mode" NOT NULL DEFAULT 'DISCREET',

        CONSTRAINT "cycle_calendar_feeds_pkey" PRIMARY KEY ("id"),
        -- The ranges the options route validates, held again by the table so a
        -- write that bypassed the route cannot widen the horizon.
        CONSTRAINT "cycle_calendar_feeds_horizon_check"
            CHECK ("horizon_cycles" BETWEEN 1 AND 6),
        CONSTRAINT "cycle_calendar_feeds_history_check"
            CHECK ("history_cycles" BETWEEN 0 AND 12)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS "cycle_calendar_feeds_token_hash_key"
        ON "cycle_calendar_feeds" ("token_hash");

    CREATE INDEX IF NOT EXISTS "cycle_calendar_feeds_user_id_created_at_idx"
        ON "cycle_calendar_feeds" ("user_id", "created_at" DESC);

    CREATE INDEX IF NOT EXISTS "cycle_calendar_feeds_created_by_id_idx"
        ON "cycle_calendar_feeds" ("created_by_id");

    -- At most one live feed per record. Revoked rows fall out of the index, so a
    -- rotate (revoke, then mint, in one transaction) never collides with itself.
    CREATE UNIQUE INDEX IF NOT EXISTS "cycle_calendar_feeds_live_user_key"
        ON "cycle_calendar_feeds" ("user_id")
        WHERE "revoked_at" IS NULL;

    ALTER TABLE "cycle_calendar_feeds"
        ADD CONSTRAINT "cycle_calendar_feeds_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;

    ALTER TABLE "cycle_calendar_feeds"
        ADD CONSTRAINT "cycle_calendar_feeds_created_by_id_fkey"
        FOREIGN KEY ("created_by_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
END
$migration$;
