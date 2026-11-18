-- Named provider chains, attachable per AI capability (#1404). One JSON value
-- per account next to the existing main chain: the named chains (each an
-- ordered list of provider types), which of them is the default, and which
-- capability is attached to which chain.
--
-- Metadata only, like `ai_provider_chain`: credentials stay in their own
-- encrypted columns. Nullable, no default: every existing account reads as
-- "no named chains", so every capability keeps reading the main chain under
-- today's rules and adding the column rewrites nothing. IF NOT EXISTS keeps a
-- replay harmless. Reversibility: dropping the column restores the previous
-- schema and the previous behaviour.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);
    ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "ai_named_chains" JSONB;
END
$migration$;
