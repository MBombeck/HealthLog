-- v1.4.47 W6 — Withings OAuth state nonce ledger.
--
-- The v1.4.43 security audit (L-1) flagged the legacy state shape
-- `${user.id}:${random16}` as cosmetic-but-fragile: the user id is
-- recoverable from any request log entry where the cookie isn't
-- redacted, and from a network-traffic capture of the redirect. The
-- cookie is `httpOnly` + `Secure` + `sameSite:lax` today so the XSS
-- exfiltration surface is closed — but a future refactor that flips
-- the cookie to a non-httpOnly variant would silently expose the user
-- id. Audit recommendation was to switch the state to a fully-random
-- 16-byte nonce backed by a short-lived `(nonce → userId)` row.
--
-- This table is that ledger. Each `withings/connect` mint persists one
-- row; `withings/callback` looks it up, asserts `expiresAt > now()`,
-- and DELETEs the row in a single transaction so a replay of the same
-- state nonce against a fresh user session fails the CSRF check (the
-- row is gone after first consumption). A daily cron sweeps any
-- abandoned rows whose `expiresAt` has passed (user closed the
-- Withings tab without completing the handshake).
--
-- Schema choices:
--
--   * `nonce` is the primary key — it's already random and
--     22-character base64url, so a dedicated `id` column would just
--     duplicate the key without buying anything.
--   * `userId` carries `ON DELETE CASCADE` so removing a user cleans
--     up their in-flight nonces atomically.
--   * `expiresAt` is indexed for the cleanup sweep — without it the
--     daily `DELETE … WHERE expiresAt < now()` would seq-scan the
--     entire table once a day even though the typical row count is
--     bounded by `users × concurrent in-flight handshakes`.
--
-- Idempotent guards (`IF NOT EXISTS`) match the 0067 / 0070 / 0071 /
-- 0074 / 0075 pattern so reruns are safe.
--
-- Reversibility: down migration is `DROP TABLE IF EXISTS
-- "withings_oauth_states"`. Additive-only; no existing row is
-- touched.

CREATE TABLE IF NOT EXISTS "withings_oauth_states" (
    "nonce"      TEXT            NOT NULL,
    "user_id"    TEXT            NOT NULL,
    "created_at" TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3)    NOT NULL,

    CONSTRAINT "withings_oauth_states_pkey" PRIMARY KEY ("nonce")
);

CREATE INDEX IF NOT EXISTS "withings_oauth_states_expires_at_idx"
    ON "withings_oauth_states" ("expires_at");

DO $$ BEGIN
    ALTER TABLE "withings_oauth_states"
        ADD CONSTRAINT "withings_oauth_states_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
