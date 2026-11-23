-- Subscribable care dates: one table holding the calendar-feed credential of a
-- record (booked visits, check-ups and vaccination boosters coming due), and
-- the enum for how its events are titled.
--
-- Built like `cycle_calendar_feeds` (migration 0494). Only the HMAC of the raw
-- `hlf_` token is stored; the dates are computed on every fetch and never
-- persisted. Revocation stamps `revoked_at` and never deletes, so "at most one
-- live feed per record" is a partial index, which Prisma cannot express.
--
-- The foreign key cascades: deleting the record ends its feed.
--
-- One DO block, so the file is one statement that rolls back whole and the
-- foreign key's lock wait on `users` is bounded. Every step is guarded, so a
-- replay after a lock timeout finishes what is missing. Only the new table
-- and the new type are created. Reversibility: drop the table and the type;
-- subscribers see 404 and the owner turns the feed on again.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    IF NOT EXISTS (
        SELECT 1 FROM pg_type WHERE typname = 'care_calendar_feed_title_mode'
    ) THEN
        CREATE TYPE "care_calendar_feed_title_mode" AS ENUM ('DISCREET', 'DESCRIPTIVE');
    END IF;

    CREATE TABLE IF NOT EXISTS "care_calendar_feeds" (
        "id"                   TEXT NOT NULL,
        "user_id"              TEXT NOT NULL,
        "token_hash"           TEXT NOT NULL,
        "token_prefix"         TEXT NOT NULL,
        "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "revoked_at"           TIMESTAMP(3),
        "last_fetched_at"      TIMESTAMP(3),
        "fetch_count"          INTEGER NOT NULL DEFAULT 0,
        "last_fetcher_ua"      TEXT,
        "body_hash"            TEXT,
        "content_changed_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "include_visits"       BOOLEAN NOT NULL DEFAULT true,
        "include_checkups"     BOOLEAN NOT NULL DEFAULT true,
        "include_vaccinations" BOOLEAN NOT NULL DEFAULT true,
        "title_mode"           "care_calendar_feed_title_mode" NOT NULL DEFAULT 'DISCREET',

        CONSTRAINT "care_calendar_feeds_pkey" PRIMARY KEY ("id")
    );

    CREATE UNIQUE INDEX IF NOT EXISTS "care_calendar_feeds_token_hash_key"
        ON "care_calendar_feeds" ("token_hash");

    CREATE INDEX IF NOT EXISTS "care_calendar_feeds_user_id_created_at_idx"
        ON "care_calendar_feeds" ("user_id", "created_at" DESC);

    -- At most one live feed per record. Revoked rows fall out of the index.
    CREATE UNIQUE INDEX IF NOT EXISTS "care_calendar_feeds_live_user_key"
        ON "care_calendar_feeds" ("user_id")
        WHERE "revoked_at" IS NULL;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'care_calendar_feeds_user_id_fkey'
    ) THEN
        ALTER TABLE "care_calendar_feeds"
            ADD CONSTRAINT "care_calendar_feeds_user_id_fkey"
            FOREIGN KEY ("user_id") REFERENCES "users"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$migration$;
