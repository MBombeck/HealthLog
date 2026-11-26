-- "Your emergency card is ready for Wallet", pushed once (v1.50).
--
-- `wallet_passes.ready_push_sent_at` is the per-pass claim of the push,
-- taken by a conditional update so two workers send once.
-- `users.wallet_ready_push_dismissed` is the person's no, reported by the
-- app; once set the push is never sent again.
--
-- Both nullable or defaulted, so the previous image ignores them after a
-- rollback. Reversibility: drop both columns.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    ALTER TABLE "wallet_passes"
        ADD COLUMN IF NOT EXISTS "ready_push_sent_at" TIMESTAMP(3);

    ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "wallet_ready_push_dismissed" BOOLEAN NOT NULL DEFAULT false;
END
$migration$;
