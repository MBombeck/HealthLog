-- Managed profile handover links (#959).
--
-- A guardian mints a one-time link that hands a managed profile over to the
-- person it describes. Only the HMAC-SHA256 hash of the token is stored.
-- `proposals_json` carries the guardian-side proposal per guardian (end,
-- read, manage) that the new owner confirms when claiming. The partial
-- unique index allows at most one open (unused, unrevoked) link per profile.
CREATE TABLE "managed_profile_handovers" (
    "id" TEXT NOT NULL,
    "profile_id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "proposals_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "managed_profile_handovers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "managed_profile_handovers_token_hash_key" ON "managed_profile_handovers"("token_hash");

CREATE INDEX "managed_profile_handovers_profile_id_idx" ON "managed_profile_handovers"("profile_id");

CREATE UNIQUE INDEX "managed_profile_handovers_open_idx"
    ON "managed_profile_handovers"("profile_id")
    WHERE "used_at" IS NULL AND "revoked_at" IS NULL;

ALTER TABLE "managed_profile_handovers" ADD CONSTRAINT "managed_profile_handovers_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "managed_profile_handovers" ADD CONSTRAINT "managed_profile_handovers_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
