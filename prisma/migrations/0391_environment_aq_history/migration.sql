-- Progress of the air-quality history backfill (days covered of days the
-- source can serve). Written by the background job only; null until its
-- first run.
ALTER TABLE "users" ADD COLUMN "environment_aq_history_json" JSONB;
