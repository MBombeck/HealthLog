-- The emergency card's "Wallet needs the push relay" prompt, dismissed per
-- account (v1.50).
--
-- On a server that signs Wallet passes over the push relay and has not
-- switched it on, "Add to Apple Wallet" explains what is missing. A person
-- who answered no is not prompted again on the card; the action stays.
--
-- Not null with a default, so the previous image ignores it after a
-- rollback. Reversibility: drop the column.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);

    ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "wallet_relay_hint_dismissed" BOOLEAN NOT NULL DEFAULT false;
END
$migration$;
