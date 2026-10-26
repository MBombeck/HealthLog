-- Account deletion, data wipe and managed-profile deletion keep the record
-- for a grace window before anything is erased.
--
-- `users.deletion_requested_at` marks an account as pending deletion: it is
-- locked at once and skipped by every background pass, and an admin can undo
-- the deletion until `deletion_purge_at`, when the purge job erases it the
-- way the immediate deletion did before. `deletion_requested_by_id` names who
-- asked (the account itself or a Guardian), as a plain id.
--
-- `offhost_purge_requests.not_before` lets a data wipe write its request
-- with the window's end, so the off-host copies from before the wipe stay
-- until then.
--
-- Nullable, no default, no backfill: no existing account is pending deletion
-- and every existing request is due now. Reversibility: dropping the columns
-- and the index restores the immediate behaviour's schema.
--
-- @retry-on-lock-timeout

DO $migration$
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);
    ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "deletion_requested_at" TIMESTAMP(3),
        ADD COLUMN IF NOT EXISTS "deletion_purge_at" TIMESTAMP(3),
        ADD COLUMN IF NOT EXISTS "deletion_requested_by_id" TEXT;
    ALTER TABLE "offhost_purge_requests"
        ADD COLUMN IF NOT EXISTS "not_before" TIMESTAMP(3);
    CREATE INDEX IF NOT EXISTS "users_deletion_purge_at_idx"
        ON "users" ("deletion_purge_at");
END
$migration$;
