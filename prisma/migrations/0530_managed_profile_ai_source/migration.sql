-- Where a managed profile's AI work gets its provider.
--
-- `users.managed_ai_source` is `INSTANCE` (the operator's key, the only
-- behaviour before this column), `NONE` (no provider), or `GUARDIAN` (a chain
-- the guardian in `managed_ai_guardian_id` configured on their own account,
-- `managed_ai_chain_id` naming a named chain or NULL for their default chain).
-- The columns are read only while `managed_profile_at` is set.
--
-- The default keeps every existing account exactly as it was; nothing is
-- copied. Reversibility: drop the three columns and the type; managed profiles
-- go back to the operator's key.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'managed_ai_source') THEN
        CREATE TYPE "managed_ai_source" AS ENUM ('INSTANCE', 'NONE', 'GUARDIAN');
    END IF;

    ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "managed_ai_source" "managed_ai_source" NOT NULL DEFAULT 'INSTANCE',
        ADD COLUMN IF NOT EXISTS "managed_ai_guardian_id" TEXT,
        ADD COLUMN IF NOT EXISTS "managed_ai_chain_id" TEXT;
END
$migration$;
