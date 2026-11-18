-- The sync handshake's tombstone count (`GET /api/sync/state`) answers for one
-- account. The only index over tombstones, `measurements_tombstone_purge_idx`
-- (0276), leads on `deleted_at` alone, so the count walked every account's
-- tombstones to find one account's. This partial index leads on `user_id`
-- and holds tombstones only, so the count reads that account's rows and
-- nothing else. Built CONCURRENTLY so writes to `measurements` carry on during
-- the build; a concurrent build must be the only statement in its file.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "measurements_user_id_deleted_at_tombstone_idx"
  ON "measurements" ("user_id", "deleted_at")
  WHERE "deleted_at" IS NOT NULL;
