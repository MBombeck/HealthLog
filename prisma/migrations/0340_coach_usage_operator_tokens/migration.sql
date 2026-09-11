-- v1.38.19 — the daily coach ledger gains a cost-owner dimension.
--
-- `coach_usage` counted one number per (user, day), so tokens the USER's own
-- plan paid for (a `codex` fallback hop after the operator's shared key
-- answered 500) were charged against the operator-cost cap and locked the
-- interactive chat out every morning. `operator_tokens` is the share of
-- `total_tokens` served by an operator-funded provider (`admin-openai` /
-- `admin-codex`); the operator cap is enforced against it, the user-plan cap
-- against `total_tokens`.
--
-- Existing rows start at 0: their owner split is unknown and 0 is the side
-- that cannot lock a user out of a chat the operator never paid for. The
-- counter is exact from the first turn after deploy.
ALTER TABLE "coach_usage"
  ADD COLUMN IF NOT EXISTS "operator_tokens" INTEGER NOT NULL DEFAULT 0;
