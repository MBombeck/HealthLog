-- The rows a measurement token carried (#1272): walked by the
-- `measurementMirror` domain of `/api/sync/changes` in id order, and looked up
-- by the foreign key's SET NULL. Built CONCURRENTLY so writes to
-- `measurements` carry on during the build; a concurrent build must be the
-- only statement in its file. Most rows have no token, so the index stays
-- small.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "measurements_ingest_token_id_id_idx"
  ON "measurements" ("ingest_token_id", "id");
