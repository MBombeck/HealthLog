-- What request a replay-cache cell answered, as a SHA-256 of the canonical
-- request body scoped by method and path. A request that reuses a key with a
-- different body is executed instead of being handed the first body's cached
-- response. The body itself is never stored. Nullable: rows written before
-- this release carry none, and a null never matches, so they stop replaying
-- for anything but their own retries already in flight (they expire within
-- 24 hours either way).
ALTER TABLE "idempotency_keys" ADD COLUMN IF NOT EXISTS "request_fingerprint" TEXT;
