-- Where a Coach fact came from, when it was last used in a turn, and the
-- message it came out of. Every row written before this migration came from
-- the background extraction or the deterministic matcher, which could not be
-- told apart, so they all read as `extracted`.
ALTER TABLE "coach_facts"
    ADD COLUMN "source" TEXT NOT NULL DEFAULT 'extracted',
    ADD COLUMN "last_used_at" TIMESTAMP(3),
    ADD COLUMN "source_message_id" TEXT;
