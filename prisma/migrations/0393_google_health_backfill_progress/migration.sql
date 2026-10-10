-- The collections an in-flight Google Health history backfill has already
-- walked to the end, so a retried attempt resumes with the collections it did
-- not reach instead of starting over. Null when no backfill is in flight.
ALTER TABLE "google_health_connections" ADD COLUMN "backfill_progress" JSONB;
