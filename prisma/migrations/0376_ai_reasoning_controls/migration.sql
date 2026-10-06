-- The operator's reasoning controls on the instance row. Both columns carry a
-- default, so the singleton row reads "reasoning allowed, no cap" the moment
-- the migration lands and an upgrade needs no admin action.
ALTER TABLE "app_settings"
    ADD COLUMN "ai_reasoning_enabled" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "ai_reasoning_max_effort" TEXT NOT NULL DEFAULT 'high';
