-- v1.4.40 SB-10 — per-user AI consent receipts.
--
-- Append-only audit trail backing the iOS onboarding consent flow plus
-- the operator's GDPR Art. 7 + App-Store Guideline 5.1.2(i) burden of
-- proof for "data-collection consent is verifiable". A user revoking +
-- re-granting consent mints a fresh row; the latest non-revoked row
-- per (user, kind) is the source of truth for "is AI active right
-- now".
--
-- Additive only. Idempotent guards mirror 0067 / 0070 / 0071.

CREATE TABLE IF NOT EXISTS "consent_receipts" (
    "id"         TEXT            NOT NULL,
    "user_id"    TEXT            NOT NULL,
    "kind"       TEXT            NOT NULL,
    "artefact"   TEXT            NOT NULL,
    "signed_at"  TIMESTAMP(3)    NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_receipts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "consent_receipts_user_id_created_at_idx"
    ON "consent_receipts" ("user_id", "created_at" DESC);

DO $$ BEGIN
    ALTER TABLE "consent_receipts"
        ADD CONSTRAINT "consent_receipts_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
