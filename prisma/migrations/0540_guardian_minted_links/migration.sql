-- Who minted a care calendar feed or an emergency card link.
--
-- Both were the owner's alone. A managed profile (a child, a parent with
-- dementia) has nobody who signs in, so its guardian now makes them for it,
-- the way the cycle feed already allowed. A link a guardian made must end
-- when the guardian's MANAGE grant ends or the profile is handed over, so
-- each row names who made it, and the serve path re-checks that person's
-- grant on every fetch or scan, as the cycle feed does with its
-- `created_by_id`.
--
-- Every existing row was made by its owner, so the backfill is `user_id`.
-- One DO block, every step guarded, so a replay after a lock timeout
-- finishes what is missing.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    ALTER TABLE "care_calendar_feeds"
        ADD COLUMN IF NOT EXISTS "created_by_id" TEXT;
    UPDATE "care_calendar_feeds" SET "created_by_id" = "user_id"
     WHERE "created_by_id" IS NULL;
    ALTER TABLE "care_calendar_feeds"
        ALTER COLUMN "created_by_id" SET NOT NULL;
    CREATE INDEX IF NOT EXISTS "care_calendar_feeds_created_by_id_idx"
        ON "care_calendar_feeds" ("created_by_id");
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'care_calendar_feeds_created_by_id_fkey'
    ) THEN
        ALTER TABLE "care_calendar_feeds"
            ADD CONSTRAINT "care_calendar_feeds_created_by_id_fkey"
            FOREIGN KEY ("created_by_id") REFERENCES "users"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    ALTER TABLE "emergency_card_links"
        ADD COLUMN IF NOT EXISTS "created_by_id" TEXT;
    UPDATE "emergency_card_links" SET "created_by_id" = "user_id"
     WHERE "created_by_id" IS NULL;
    ALTER TABLE "emergency_card_links"
        ALTER COLUMN "created_by_id" SET NOT NULL;
    CREATE INDEX IF NOT EXISTS "emergency_card_links_created_by_id_idx"
        ON "emergency_card_links" ("created_by_id");
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'emergency_card_links_created_by_id_fkey'
    ) THEN
        ALTER TABLE "emergency_card_links"
            ADD CONSTRAINT "emergency_card_links_created_by_id_fkey"
            FOREIGN KEY ("created_by_id") REFERENCES "users"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END
$migration$;
