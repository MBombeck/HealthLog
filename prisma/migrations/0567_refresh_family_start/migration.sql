-- When a native app's refresh-token family signed in (v1.50).
--
-- A refresh token slides 60 days with every rotation, so a phone in daily use
-- stayed signed in for ever. Each row now carries the instant its family
-- signed in, handed on by every rotation, and the family ends a fixed time
-- after it (REFRESH_TOKEN_MAX_LIFETIME_DAYS, 180 by default) however often it
-- rotates.
--
-- Rows already stored get their own `created_at`, the moment of their last
-- rotation: the chain back to the sign-in is not kept, and dating the family
-- from its last rotation signs nobody out at the update. A family in use
-- reaches the limit within the limit's length of the update at the latest.
--
-- The column is added nullable, filled, then made NOT NULL with its default,
-- all inside one DO block that rolls back whole. The table holds one live row
-- per signed-in device and its consumed predecessors for a few weeks, so the
-- fill is small. Reversibility: drop the column.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    ALTER TABLE "refresh_tokens"
        ADD COLUMN IF NOT EXISTS "family_started_at" TIMESTAMP(3);

    UPDATE "refresh_tokens"
       SET "family_started_at" = "created_at"
     WHERE "family_started_at" IS NULL;

    ALTER TABLE "refresh_tokens"
        ALTER COLUMN "family_started_at" SET DEFAULT CURRENT_TIMESTAMP,
        ALTER COLUMN "family_started_at" SET NOT NULL;
END
$migration$;
