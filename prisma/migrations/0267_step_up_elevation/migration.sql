-- v1.30.34 — token-bound step-up elevations.
--
-- The Bearer-transport equivalent of `sessions.mfa_verified_at`. A row is
-- minted only after a password or primary-passkey re-proof, is bound to the
-- exact API token that re-proved, is single-use (`consumed_at`), and expires
-- within minutes. Only the HMAC of the opaque secret is stored.

CREATE TABLE "step_up_elevations" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "api_token_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "step_up_elevations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "step_up_elevations_token_hash_key" ON "step_up_elevations"("token_hash");

-- At most ONE redeemable elevation per token, enforced by the database rather
-- than by the mint's delete-then-create ordering. Without it two concurrent
-- mints can interleave so that both rows survive, or the second mint's delete
-- strands the value the first mint already handed to the client.
CREATE UNIQUE INDEX "step_up_elevations_live_per_token_key"
    ON "step_up_elevations"("api_token_id") WHERE "consumed_at" IS NULL;

CREATE INDEX "step_up_elevations_user_id_idx" ON "step_up_elevations"("user_id");
CREATE INDEX "step_up_elevations_api_token_id_idx" ON "step_up_elevations"("api_token_id");
CREATE INDEX "step_up_elevations_expires_at_idx" ON "step_up_elevations"("expires_at");

ALTER TABLE "step_up_elevations" ADD CONSTRAINT "step_up_elevations_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Cascade on the token binding: revoking or deleting a token must never leave a
-- redeemable elevation behind.
ALTER TABLE "step_up_elevations" ADD CONSTRAINT "step_up_elevations_api_token_id_fkey"
    FOREIGN KEY ("api_token_id") REFERENCES "api_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;
