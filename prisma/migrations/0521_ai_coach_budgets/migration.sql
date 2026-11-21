-- The Coach budget of each self-hosted provider.
--
-- `users.ai_coach_budgets` holds, per provider that points at a host the
-- person chose (Local and the OpenAI-compatible gateway), how large the data
-- snapshot in the prompt may grow and how many tokens, rounds and seconds one
-- turn may spend: `{ "local": { "snapshotChars": 6000 }, ... }`. NULL keeps
-- the built-in limits, which is every existing account, so nothing is copied.
--
-- One DO block, guarded: a replay after a lock timeout changes nothing.
-- Reversibility: drop the column.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "ai_coach_budgets" JSONB;
END
$migration$;
