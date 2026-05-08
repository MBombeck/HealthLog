-- 0025_refresh_tokens
-- Native-client short-lived access + rotating refresh tokens (v1.4 G4).
-- Forward-compatible: this migration only ADDS a table. No DROP COLUMN, no
-- type changes on existing tables. To roll back, the down migration in
-- docs/ops/migrations/0025-down.sql DROPs the table.
--
-- All statements use IF NOT EXISTS so a partial-deploy retry is a no-op
-- instead of "relation already exists". Wrapped in a single transaction
-- so a mid-statement failure leaves no half-built table behind.

BEGIN;

CREATE TABLE IF NOT EXISTS "refresh_tokens" (
  "id"                TEXT        NOT NULL,
  "user_id"           TEXT        NOT NULL,
  "token_hash"        TEXT        NOT NULL,
  "device_id"         TEXT,
  "access_token_hash" TEXT,
  "expires_at"        TIMESTAMP(3) NOT NULL,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at"        TIMESTAMP(3),
  "used_at"           TIMESTAMP(3),
  "replaced_by_id"    TEXT,
  "user_agent"        TEXT,
  "ip_address"        TEXT,
  CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");
CREATE INDEX IF NOT EXISTS "refresh_tokens_user_id_idx"             ON "refresh_tokens"("user_id");
CREATE INDEX IF NOT EXISTS "refresh_tokens_user_id_device_id_idx"   ON "refresh_tokens"("user_id", "device_id");
CREATE INDEX IF NOT EXISTS "refresh_tokens_expires_at_idx"          ON "refresh_tokens"("expires_at");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'refresh_tokens_user_id_fkey'
  ) THEN
    ALTER TABLE "refresh_tokens"
      ADD CONSTRAINT "refresh_tokens_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

COMMIT;
