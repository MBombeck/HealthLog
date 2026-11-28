-- Pairing for the Android Health Connect sync (v1.50).
--
-- `health_connect_pairings` holds the one-time codes the web shows as a QR
-- code; only their hash is stored. `devices.api_token_id` links an Android
-- device to the `health-connect:write` token it was paired with, so deleting
-- the device revokes the token, and the batch route finds the device from
-- the token.
--
-- Both additive: the previous image never reads them. Reversibility: drop
-- the table and the column.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    CREATE TABLE IF NOT EXISTS "health_connect_pairings" (
        "id" TEXT NOT NULL,
        "user_id" TEXT NOT NULL,
        "code_hash" TEXT NOT NULL,
        "expires_at" TIMESTAMP(3) NOT NULL,
        "consumed_at" TIMESTAMP(3),
        "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "health_connect_pairings_pkey" PRIMARY KEY ("id")
    );

    CREATE UNIQUE INDEX IF NOT EXISTS "health_connect_pairings_code_hash_key" ON "health_connect_pairings"("code_hash");

    CREATE INDEX IF NOT EXISTS "health_connect_pairings_user_id_idx" ON "health_connect_pairings"("user_id");

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'health_connect_pairings_user_id_fkey') THEN
        ALTER TABLE "health_connect_pairings"
            ADD CONSTRAINT "health_connect_pairings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    ALTER TABLE "devices"
        ADD COLUMN IF NOT EXISTS "api_token_id" TEXT;

    CREATE UNIQUE INDEX IF NOT EXISTS "devices_api_token_id_key" ON "devices"("api_token_id");

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'devices_api_token_id_fkey') THEN
        ALTER TABLE "devices"
            ADD CONSTRAINT "devices_api_token_id_fkey" FOREIGN KEY ("api_token_id") REFERENCES "api_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END
$migration$;
